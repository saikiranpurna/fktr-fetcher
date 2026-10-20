"""invoice_docs: pick each shipment's tax invoice out of an order's invoice bundle.

The bundles are real (tiny) PDFs built here, shaped like Flipkart's (verified 2026-10-20): the tax
invoice names the product's FSN, fee / service invoices don't, and the transport document is
headed "Consignor details". Values are fabricated."""

from __future__ import annotations

from app import invoice_docs


def _pdf(*lines: str) -> bytes:
    """A minimal one-page PDF whose text is ``lines`` (Helvetica, so pypdf can extract it)."""
    content = "BT /F1 10 Tf 20 160 Td " + " ".join(f"({line}) Tj 0 -14 Td" for line in lines) + " ET"
    objects = [
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 200] /Contents 4 0 R"
        " /Resources << /Font << /F1 5 0 R >> >> >>",
        f"<< /Length {len(content)} >>\nstream\n{content}\nendstream",
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    out = b"%PDF-1.4\n"
    offsets = []
    for number, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += f"{number} 0 obj\n{body}\nendobj\n".encode()
    xref = len(out)
    out += f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode()
    out += "".join(f"{offset:010d} 00000 n \n" for offset in offsets).encode()
    out += f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    return out


def _tax(fsn: str, serial: str) -> bytes:
    return _pdf("Tax Invoice", f"FSN: {fsn}", f"IMEI/Serial No: {serial}")


def _row(unit: str, fsn: str, tracking: str) -> dict:
    return {"orderId": "OD900000000000000099", "unitId": unit, "fsn": fsn, "trackingId": tracking}


def test_reads_the_first_page_text():
    assert "FSN: SPKA" in invoice_docs.pdf_text(_tax("SPKA", "S1"))
    assert invoice_docs.pdf_text(b"%PDF-1.4 cut short") == ""  # unreadable: skipped, never a crash


def test_each_shipment_gets_one_tax_invoice_by_product_in_a_fixed_order():
    bundle = [
        ("file_1.pdf", _pdf("Consignor details", "FSN: SPKA")),  # transport doc naming the FSN
        ("file_2.pdf", _tax("SPKA", "S1")),
        ("file_3.pdf", _pdf("Contact Flipkart", "SAC 998599")),  # Flipkart fee / service invoice
        ("file_4.pdf", _tax("BUDB", "B1")),
        ("file_5.pdf", _tax("SPKA", "S2")),
    ]
    rows = [
        _row("U2", "SPKA", "FMPP0000000002"),
        _row("U1", "SPKA", "FMPP0000000001"),
        _row("U3", "BUDB", "FMPP0000000003"),
        _row("U4", "BUDB", ""),  # never shipped: no invoice
    ]
    got = invoice_docs.tax_invoices_by_shipment(bundle, rows)
    # Identical units: shipments in tracking-id order take that product's invoices in bundle order.
    assert got == {"FMPP0000000001": bundle[1][1], "FMPP0000000002": bundle[4][1], "FMPP0000000003": bundle[3][1]}
    # The same rows always pair the same way, whatever order they arrive in.
    assert invoice_docs.tax_invoices_by_shipment(bundle, list(reversed(rows))) == got


def test_units_of_one_shipment_share_its_invoice_and_extra_shipments_get_none():
    bundle = [("file_1.pdf", _tax("SPKA", "S1"))]
    rows = [
        _row("U1", "SPKA", "FMPP0000000001"),
        _row("U2", "SPKA", "FMPP0000000001"),  # same shipment as U1
        _row("U3", "SPKA", "FMPP0000000009"),  # no invoice left for it
    ]
    assert invoice_docs.tax_invoices_by_shipment(bundle, rows) == {"FMPP0000000001": bundle[0][1]}
