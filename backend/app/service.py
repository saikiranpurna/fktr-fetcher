"""Aggregate today's orders across every account. Filtering/CSV happen on the client."""

from __future__ import annotations

import time
from concurrent.futures import ThreadPoolExecutor

from . import flipkart, parser, store
from .config import config
from .errors import config_error


def _enrich_details(cookies: dict, raw_orders: list[dict], deadline: float | None = None) -> dict[str, dict]:
    """Fetch per-unit detail (address + live OTP). EVERY active unit (out-for-delivery / arriving)
    gets a call so no live OTP is missed no matter how deep it sits; delivered orders get one call
    each (for the address) up to config.max_details. Returns {orderId: {unitId: {address, otp}}}."""
    if config.max_details <= 0:
        return {}
    active: list[tuple[str, str, str]] = []       # OTP-bearing candidates, any position
    address_only: list[tuple[str, str, str]] = []  # first unit of orders with no active unit
    for order in raw_orders:
        order_id = str(parser.get(order, "orderMetaData.orderId") or "").strip()
        units = parser.get(order, "units")
        if not order_id or not isinstance(units, dict):
            continue
        share = str(parser.get(order, "accessToOrderDataBag.endUser.id") or "").strip()
        first_uid = None
        has_active = False
        for unit_id, u in units.items():
            if parser.get(u, "vasItemDetails") is not None:
                continue
            if first_uid is None:
                first_uid = unit_id
            status = parser.map_status(str(parser.get(u, "metaData.moRedesignHeading") or ""))
            if status in ("OUT_FOR_DELIVERY", "ARRIVING"):
                active.append((order_id, unit_id, share))
                has_active = True
        if first_uid and not has_active:
            address_only.append((order_id, first_uid, share))

    # Active units first (OTP priority, safety-capped), then addresses for recent delivered orders.
    targets = active[:300] + address_only[: config.max_details]
    if not targets:
        return {}
    details: dict[str, dict] = {}
    pool = ThreadPoolExecutor(max_workers=8)
    try:
        futures = []
        for t in targets:
            if deadline is not None and time.monotonic() > deadline:
                break  # per-account budget spent; skip remaining detail lookups
            futures.append((t[0], t[1], pool.submit(flipkart.fetch_detail, cookies, t[0], t[1], t[2])))
        for order_id, unit_id, fut in futures:
            remaining = None if deadline is None else max(0.0, deadline - time.monotonic())
            try:
                detail = fut.result(timeout=remaining)
            except Exception:
                continue  # timed out or failed -> that order simply lacks address/OTP
            if detail:
                details.setdefault(order_id, {})[unit_id] = detail
    finally:
        pool.shutdown(wait=False, cancel_futures=True)
    return details


def fetch_account_orders(label: str, cookies: dict) -> list[dict]:
    """Fetch + parse one account's orders, tagged with its label. Raises on failure (the caller
    — the background poller — records the error per account). Never swallows exceptions here.
    Bounded by config.account_deadline_s so one slow account can't hold a worker indefinitely."""
    deadline = time.monotonic() + config.account_deadline_s
    raw = flipkart.fetch_orders(cookies, deadline=deadline)
    details = _enrich_details(cookies, raw, deadline=deadline)
    parsed = parser.parse_orders(raw, details)
    return [{**o, "account": label} for o in parsed]


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
