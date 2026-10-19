"""Fetch + parse one account's orders (for the background poller) and serve the aggregated cache.
Filtering and CSV happen on the client."""

from __future__ import annotations

import logging
import time
from concurrent.futures import ThreadPoolExecutor
from concurrent.futures import TimeoutError as FuturesTimeout
from dataclasses import dataclass, field

from . import flipkart, parser, store
from .config import config
from .errors import config_error

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
            if parser.get(u, "vasItemDetails") is not None:
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
