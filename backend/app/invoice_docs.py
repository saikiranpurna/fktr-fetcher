"""Pick each shipment's tax invoice out of Flipkart's order invoice bundle.

Flipkart serves invoices only per ORDER: a ZIP of every document of every shipment (verified
2026-10-20, unit parameters are ignored). Per shipment it holds the product's tax invoice (names the
product's FSN), Flipkart fee / service invoices (no FSN) and a transport document ("Consignor
details"). None of them names the shipment's tracking ID, so for several identical units in one
order nothing says which tax invoice belongs to which shipment: they are paired in a fixed order
(shipments by tracking ID, invoices in bundle order), so a card always gets the same invoice and no
two shipments share one. The IMEI / serial printed on it may be another unit's of the same order.
"""

from __future__ import annotations

import io
import logging
from typing import Iterable

from pypdf import PdfReader

log = logging.getLogger("invoice_docs")

_TRANSPORT_MARK = "Consignor details"


def pdf_text(data: bytes) -> str:
    """First-page text of a PDF ("" when unreadable). The FSN and the transport-document heading are
    both on page 1; one bulk order's bundle (30 PDFs) reads in about a third of a second."""
    try:
        reader = PdfReader(io.BytesIO(data))
        if not reader.pages:
            return ""
        return reader.pages[0].extract_text() or ""
    except Exception as err:  # noqa: BLE001 - one unreadable document must not sink the bundle
        log.warning("unreadable invoice PDF (%d bytes): %s", len(data), type(err).__name__)
        return ""


def tax_invoices_by_shipment(files: Iterable[tuple[str, bytes]], rows: list[dict]) -> dict[str, bytes]:
    """trackingId -> that shipment's tax invoice PDF, for the order's ``rows`` (the dashboard rows
    of one order: unitId, fsn, trackingId). Rows without a tracking ID never shipped, so have no
    invoice; several units in one shipment share its invoice."""
    shipments: dict[str, list[str]] = {}  # fsn -> its shipments' tracking ids
    for row in rows:
        fsn, tracking = (row.get("fsn") or "").strip(), (row.get("trackingId") or "").strip()
        if fsn and tracking and tracking not in shipments.setdefault(fsn, []):
            shipments[fsn].append(tracking)

    invoices: dict[str, list[bytes]] = {fsn: [] for fsn in shipments}
    for _name, data in files:  # bundle order
        text = pdf_text(data)
        if not text or _TRANSPORT_MARK in text:
            continue
        fsn = next((f for f in shipments if f in text), None)
        if fsn:
            invoices[fsn].append(data)

    out: dict[str, bytes] = {}
    for fsn, trackings in shipments.items():
        for tracking, data in zip(sorted(trackings), invoices[fsn]):
            out[tracking] = data
    return out
