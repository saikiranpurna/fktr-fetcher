"""Fetch + parse one account's orders (for the background poller), serve the aggregated cache, and
fetch order invoices on demand. Filtering and CSV happen on the client."""

from __future__ import annotations

import io
import logging
import time
import zipfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from concurrent.futures import TimeoutError as FuturesTimeout
from dataclasses import dataclass, field
from typing import IO

from . import flipkart, invoice_docs, parser, store
from .config import config
from .errors import AppError, config_error, invoice_unavailable, parse_error

log = logging.getLogger("service")

# Safety cap on OTP-bearing (out-for-delivery / arriving) detail calls per account.
_ACTIVE_CAP = 300
_DAY_MS = 24 * 60 * 60 * 1000


@dataclass
class Enrichment:
    """Per-account detail-page results, keyed {orderId: {unitId: ...}}.

    ``state`` holds "ok" | "failed" | "skipped" for EVERY unit, so a blank address/OTP/lifecycle
    date can be told apart as "none" (ok) vs "unknown" (failed / skipped)."""

    details: dict[str, dict] = field(default_factory=dict)  # {address, otp, gst}
    timelines: dict[str, dict] = field(default_factory=dict)  # {created|cancelled|delivered|refund}
    state: dict[str, dict[str, str]] = field(default_factory=dict)
    failed: int = 0  # detail calls attempted that failed (surfaced per account as detailFailed)


def _detail_targets(raw_orders: list[dict]) -> list[tuple[str, str, str]]:
    """(orderId, unitId, shareToken) to fetch, in priority order:

    1. every active (out-for-delivery / arriving) unit — its own call carries its live OTP;
    2. one call per order placed within FLIPKART_HISTORY_DAYS that has a cancelled / refunded /
       replaced unit — one call returns EVERY unit's timeline, which is where cancellation and
       replacement dates live;
    3. one call per remaining order for its delivery address, up to FLIPKART_MAX_DETAILS.
    An order with an active unit needs no history/address call: the active call covers it."""
    cutoff = (time.time() * 1000 - config.history_days * _DAY_MS) if config.history_days > 0 else None
    active: list[tuple[str, str, str]] = []
    history: list[tuple[str, str, str]] = []
    address_only: list[tuple[str, str, str]] = []
    for order in raw_orders:
        order_id = str(parser.get(order, "orderMetaData.orderId") or "").strip()
        units = parser.get(order, "units")
        if not order_id or not isinstance(units, dict):
            continue
        share = str(parser.get(order, "accessToOrderDataBag.endUser.id") or "").strip()
        first_uid = lifecycle_uid = None
        has_active = False
        for unit_id, u in units.items():
            if parser.is_addon(u):
                continue
            first_uid = first_uid or unit_id
            status = parser.map_status(str(parser.get(u, "metaData.moRedesignHeading") or ""))
            if status in ("OUT_FOR_DELIVERY", "ARRIVING"):
                active.append((order_id, unit_id, share))
                has_active = True
            elif lifecycle_uid is None and parser.is_lifecycle_unit(u):
                lifecycle_uid = unit_id
        if has_active or not first_uid:
            continue
        try:
            placed = float(parser.get(order, "orderMetaData.orderDate") or 0)  # epoch ms
        except (TypeError, ValueError):
            placed = 0.0
        if lifecycle_uid and cutoff is not None and placed >= cutoff:
            history.append((order_id, lifecycle_uid, share))
        else:
            address_only.append((order_id, first_uid, share))
    return active[:_ACTIVE_CAP] + history[: config.max_history_details] + address_only[: config.max_details]


def _enrich_details(cookies: dict, raw_orders: list[dict], deadline: float | None = None) -> Enrichment:
    """Run the detail calls (bounded pool, per-account deadline). A failed call is recorded — never
    turned into empty data — and the rest keep going (the batch owns resilience, not the helper)."""
    result = Enrichment()
    attempted: dict[str, dict[str, str]] = {}
    targets = _detail_targets(raw_orders)
    if targets:
        pool = ThreadPoolExecutor(max_workers=8)
        try:
            futures = []
            for order_id, unit_id, share in targets:
                if deadline is not None and time.monotonic() > deadline:
                    break  # per-account budget spent; the rest stay "skipped"
                futures.append((order_id, unit_id, pool.submit(flipkart.fetch_detail_raw, cookies, order_id, unit_id, share)))
            for order_id, unit_id, fut in futures:
                remaining = None if deadline is None else max(0.0, deadline - time.monotonic())
                try:
                    detail = parser.extract_detail(fut.result(timeout=remaining))
                except FuturesTimeout:
                    # Our per-account budget ran out while this call was queued or in flight: not an
                    # upstream failure, so it stays "skipped" and isn't counted in detailFailed.
                    continue
                except Exception as err:  # noqa: BLE001 - fetch_detail_raw already logged the upstream body
                    attempted.setdefault(order_id, {})[unit_id] = "failed"
                    result.failed += 1
                    log.debug("detail %s/%s not used: %s", order_id, unit_id, err)
                    continue
                attempted.setdefault(order_id, {})[unit_id] = "ok"
                result.details.setdefault(order_id, {})[unit_id] = {
                    "address": detail["address"], "otp": detail["otp"], "gst": detail["gst"],
                }
                result.timelines.setdefault(order_id, {}).update(detail["timelines"])
        finally:
            pool.shutdown(wait=False, cancel_futures=True)

    # Per-unit state: a targeted unit reports its own call; any other unit is covered when some call
    # for its order succeeded (the address and every unit's timeline are order-level).
    for order in raw_orders:
        order_id = str(parser.get(order, "orderMetaData.orderId") or "").strip()
        units = parser.get(order, "units")
        if not order_id or not isinstance(units, dict):
            continue
        tried = attempted.get(order_id, {})
        covered = "ok" if "ok" in tried.values() else ("failed" if "failed" in tried.values() else "skipped")
        result.state[order_id] = {unit_id: tried.get(unit_id, covered) for unit_id in units}
    return result


def fetch_account_orders(label: str, cookies: dict) -> tuple[list[dict], dict]:
    """Fetch + parse one account's orders, tagged with its label, plus ``{"partial", "detailFailed"}``
    (history truncated / detail calls that failed). Raises when page 1 fails (the background poller
    records it per account) — never swallows it. Bounded by config.account_deadline_s so one slow
    account can't hold a worker indefinitely."""
    deadline = time.monotonic() + config.account_deadline_s
    raw, partial = flipkart.fetch_orders(cookies, deadline=deadline)
    enriched = _enrich_details(cookies, raw, deadline=deadline)
    parsed = parser.parse_orders(raw, enriched.details, enriched.timelines, enriched.state)
    return [{**o, "account": label} for o in parsed], {"partial": partial, "detailFailed": enriched.failed}


# Concurrent invoice downloads per bulk ZIP; each still takes a slot of flipkart's global cap.
_INVOICE_WORKERS = 4


def _account_cookies(account_id: str) -> dict:
    from . import poller  # lazy import avoids a module-load cycle (poller imports service)

    cookies = poller.instance.cookies_for(account_id)
    if not cookies:
        raise config_error("Unknown or paused account: refresh the page and try again.")
    return cookies


def _invoice_files(raw: bytes) -> list[tuple[str, bytes]]:
    """(name, bytes) for each file in Flipkart's invoice ZIP (a bare PDF is one "invoice.pdf")."""
    if raw[:5] == b"%PDF-":
        return [("invoice.pdf", raw)]
    try:
        with zipfile.ZipFile(io.BytesIO(raw)) as zf:
            return [(info.filename.rsplit("/", 1)[-1], zf.read(info)) for info in zf.infolist() if not info.is_dir()]
    except zipfile.BadZipFile as err:
        raise parse_error("Flipkart's invoice file was not a readable ZIP.") from err


# Failures that are about the ACCOUNT, not the order (paused / removed account, expired session): an
# order shared between accounts may still be fetched through another of them.
_ACCOUNT_FAILURES = frozenset({"CONFIG_ERROR", "AUTH_EXPIRED"})


def _order_bundle(account_ids: list[str], order_id: str) -> tuple[str, list[tuple[str, bytes]]]:
    """(account that fetched it, the files of the order's invoice bundle), through the first of the
    order's accounts that can fetch it. An order-level answer (no invoice yet, an upstream fault) ends
    the search: another account would get the same one."""
    last = config_error("No account to fetch this order's invoices with.")
    for account_id in account_ids:
        try:
            return account_id, _invoice_files(flipkart.fetch_invoice(_account_cookies(account_id), order_id))
        except AppError as err:
            if err.code not in _ACCOUNT_FAILURES:
                raise
            last = err
    raise last


def _order_rows(account_ids: list[str], order_id: str) -> list[dict]:
    """The order's cached dashboard rows, from the first of its accounts that has them. Pairing uses
    EVERY shipment of the order, not just the requested ones, so a card's invoice never depends on
    what else was selected."""
    from . import poller

    for account_id in account_ids:
        rows = poller.instance.order_rows(account_id, order_id)
        if rows:
            return rows
    return []


def _not_listed() -> AppError:
    return config_error("This shipment isn't in the current order list: refresh the page and try again.")


def _not_shipped() -> AppError:
    return invoice_unavailable("This shipment hasn't shipped yet, so it has no invoice.")


def _no_tax_invoice() -> AppError:
    return invoice_unavailable(
        "Flipkart's invoices for this order don't include a tax invoice for this shipment yet. Try again later."
    )


def fetch_invoice(account_id: str, order_id: str, unit_id: str) -> tuple[bytes, str]:
    """One card's tax invoice as (pdf, trackingId), picked out of the order's bundle (see
    invoice_docs: Flipkart serves invoices only per order)."""
    from . import poller

    rows = poller.instance.order_rows(account_id, order_id)
    card = next((r for r in rows if r.get("unitId") == unit_id), None)
    if card is None:
        raise _not_listed()
    tracking = (card.get("trackingId") or "").strip()
    if not tracking:
        raise _not_shipped()
    _, files = _order_bundle([account_id], order_id)
    pdf = invoice_docs.tax_invoices_by_shipment(files, rows).get(tracking)
    if pdf is None:
        raise _no_tax_invoice()
    return pdf, tracking


def _order_invoices(order_id: str, account_ids: list[str], unit_ids: list[str]) -> tuple[dict, list]:
    """({trackingId: pdf}, [(shipment or unit, AppError)]) for the requested units of one order."""
    used, files = _order_bundle(account_ids, order_id)
    rows = _order_rows([used, *account_ids], order_id)
    by_unit = {r.get("unitId"): r for r in rows}
    shipments = invoice_docs.tax_invoices_by_shipment(files, rows)
    found: dict[str, bytes] = {}
    absent: list[tuple[str, AppError]] = []
    for unit_id in unit_ids:
        row = by_unit.get(unit_id)
        tracking = (row.get("trackingId") or "").strip() if row else ""
        if row is None:
            absent.append((unit_id, _not_listed()))
        elif not tracking:
            absent.append((unit_id, _not_shipped()))
        elif tracking in shipments:
            found[tracking] = shipments[tracking]  # units of one shipment share its invoice
        else:
            absent.append((tracking, _no_tax_invoice()))
    return found, absent


def build_invoices_zip(orders: list[dict], dest: IO[bytes]) -> dict:
    """Write the tax invoice of every requested card into ONE ZIP at ``dest``:
    <orderId>/<trackingId>.pdf, plus a missing.txt naming each card without one and why (ids + error
    text only, no customer data). ``orders`` are the filtered cards grouped by order:
    [{orderId, accountIds, unitIds}]; each order's bundle is fetched once, through the first of its
    accounts that can. Returns {"files", "missing"}. Raises when nothing could be saved: an empty ZIP
    would read as "these shipments have no invoices"."""
    merged: dict[str, dict[str, list[str]]] = {}
    for o in orders:
        entry = merged.setdefault(o["orderId"], {"accounts": [], "units": []})
        for key, values in (("accounts", o["accountIds"]), ("units", o["unitIds"])):
            entry[key] += [v for v in values if v not in entry[key]]
    if not merged:
        raise config_error("No orders selected.")
    if len(merged) > config.invoice_zip_max:
        raise config_error(f"At most {config.invoice_zip_max} orders per invoice ZIP.")

    written = 0
    missing: list[tuple[str, str, AppError]] = []  # (orderId, shipment or unit, why)
    order_errors: dict[str, AppError] = {}
    with zipfile.ZipFile(dest, "w", compression=zipfile.ZIP_STORED) as out:  # PDFs are compressed
        with ThreadPoolExecutor(max_workers=_INVOICE_WORKERS) as pool:
            futures = {
                pool.submit(_order_invoices, order_id, entry["accounts"], entry["units"]): order_id
                for order_id, entry in merged.items()
            }
            for fut in as_completed(futures):
                order_id = futures[fut]
                try:
                    found, absent = fut.result()
                except Exception as err:  # noqa: BLE001 - one order's fault must not sink the ZIP
                    if not isinstance(err, AppError):
                        log.warning("invoice %s failed: %s: %s", order_id, type(err).__name__, err)
                        err = AppError("UNKNOWN", "Unexpected error while fetching the invoices.")
                    order_errors[order_id] = err
                    missing += [(order_id, unit_id, err) for unit_id in merged[order_id]["units"]]
                    continue
                for tracking, pdf in found.items():
                    out.writestr(f"{order_id}/{tracking}.pdf", pdf)
                written += len(found)
                missing += [(order_id, ref, err) for ref, err in absent]
        if not written:
            # The first requested order's own failure if any, deterministically; else "no invoices".
            raise next((order_errors[oid] for oid in merged if oid in order_errors), None) or _no_tax_invoice()
        if missing:
            lines = sorted(f"{oid}\t{ref}\t{err.code}\t{err.message}" for oid, ref, err in missing)
            out.writestr("missing.txt", "Shipments without a tax invoice in this ZIP:\n" + "\n".join(lines) + "\n")
    return {"files": written, "missing": len(missing)}


def get_delivery_orders() -> tuple[list[dict], list[dict], dict]:
    """Serve the aggregated order cache the background poller keeps warm (instant, no live fetch).
    Returns (orders, per-account results, coverage)."""
    from . import poller  # lazy import avoids a module-load cycle (poller imports service)

    snap = poller.instance.snapshot()
    if snap["coverage"]["total"] == 0 and not store.has_accounts():
        raise config_error(
            "No Flipkart accounts. Drop at least one account's cookie .json/.txt file in the Accounts panel."
        )
    return snap["orders"], snap["accounts"], snap["coverage"]
