"""Aggregate today's orders across every account. Filtering/CSV happen on the client."""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor

from . import flipkart, parser, store
from .config import config
from .errors import AppError, config_error


def _enrich_details(cookies: dict, raw_orders: list[dict]) -> dict[str, dict]:
    """Fetch per-order detail (address + live OTP) for the most-recent orders, concurrently."""
    if config.max_details <= 0:
        return {}
    targets = []
    for o in raw_orders[: config.max_details]:
        req = parser.detail_request_for(o)
        if req:
            targets.append(req)
    if not targets:
        return {}
    details: dict[str, dict] = {}
    with ThreadPoolExecutor(max_workers=6) as pool:
        results = pool.map(
            lambda t: (t["orderId"], flipkart.fetch_detail(cookies, t["orderId"], t["unitId"], t["shareToken"])),
            targets,
        )
        for order_id, detail in results:
            if detail:
                details[order_id] = detail
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
