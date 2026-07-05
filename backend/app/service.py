"""Aggregate today's orders across every account. Filtering/CSV happen on the client."""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor

from . import flipkart, parser, store
from .config import config
from .errors import AppError, config_error


def _enrich_details(cookies: dict, raw_orders: list[dict]) -> dict[str, dict]:
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
    with ThreadPoolExecutor(max_workers=8) as pool:
        results = pool.map(
            lambda t: (t[0], t[1], flipkart.fetch_detail(cookies, t[0], t[1], t[2])),
            targets,
        )
        for order_id, unit_id, detail in results:
            if detail:
                details.setdefault(order_id, {})[unit_id] = detail
    return details


def _one_account(acct: dict) -> tuple[dict, list[dict], dict | None]:
    try:
        raw = flipkart.fetch_orders(acct["cookies"])
        details = _enrich_details(acct["cookies"], raw)
        parsed = parser.parse_orders(raw, details)
        orders = [{**o, "account": acct["label"]} for o in parsed]
        return acct, orders, None
    except AppError as e:
        return acct, [], {"code": e.code, "message": e.message}
    except Exception as e:  # never let one account blank the others
        return acct, [], {"code": "UNKNOWN", "message": str(e)}


def get_delivery_orders() -> tuple[list[dict], list[dict]]:
    accounts = store.get_active_accounts()
    if not accounts:
        raise config_error("No Flipkart accounts. Drop at least one account's cookie .json file in the Accounts panel.")

    all_orders: list[dict] = []
    account_results: list[dict] = []
    with ThreadPoolExecutor(max_workers=max(1, len(accounts))) as pool:
        for acct, orders, err in pool.map(_one_account, accounts):
            all_orders.extend(orders)
            result = {"id": acct["id"], "label": acct["label"], "ok": err is None, "count": len(orders)}
            if err:
                result["error"] = err
            account_results.append(result)
    return all_orders, account_results
