"""Flipkart HTTP client built on Scrapling's Fetcher (curl_cffi TLS impersonation).

No headless browser: the internal 'My Orders' APIs answer plain HTTP when given the
account cookies plus Flipkart's custom `x-user-agent` (FKUA) header.
"""

from __future__ import annotations

from urllib.parse import urlencode

from scrapling.fetchers import Fetcher

from .config import config
from .errors import auth_expired, upstream
from .parser import ensure_orders_shape, extract_detail, orders_array


def _headers(extra: dict | None = None) -> dict:
    h = {
        "x-user-agent": config.fkua,
        "user-agent": config.user_agent,
        "accept": "application/json",
        "referer": "https://www.flipkart.com/account/orders",
    }
    if extra:
        h.update(extra)
    return h


def _get(url: str, cookies: dict):
    return Fetcher.get(url, headers=_headers(), cookies=cookies, timeout=config.timeout,
                       impersonate=config.impersonate, stealthy_headers=False)


def fetch_orders(cookies: dict) -> list[dict]:
    """Paginate My Orders (7/page) following `nextCallParams`, up to config.max_pages."""
    base = config.orders_base
    seen: set[str] = set()
    all_orders: list[dict] = []
    url = f"{base}?{urlencode({'page': '1', 'filterType': config.filter_type})}"
    page = 1

    for i in range(config.max_pages):
        res = _get(url, cookies)
        status = getattr(res, "status", 0)
        if status in (401, 403):
            raise auth_expired()
        if status != 200:
            if i == 0:
                raise upstream(f"Flipkart orders request failed (HTTP {status}).")
            break
        body = res.json()
        if i == 0:
            ensure_orders_shape(body)  # first page must look right, else PARSE_ERROR
        view = (body.get("RESPONSE") or {}).get("multipleOrderDetailsView") or {}
        for o in view.get("orders") or []:
            oid = (o.get("orderMetaData") or {}).get("orderId")
            if oid and oid not in seen:
                seen.add(oid)
                all_orders.append(o)

        ncp = view.get("nextCallParams")
        if not view.get("moreOrder") or not isinstance(ncp, list):
            break
        params = {x["key"]: str(x["value"]) for x in ncp if isinstance(x, dict) and "key" in x}
        if not params.get("ot"):
            break
        page += 1
        query = {"page": str(page), "order_before_time_stamp": params["ot"], "filterType": config.filter_type}
        query.update(params)
        url = f"{base}?{urlencode(query)}"

    return all_orders


def fetch_detail(cookies: dict, order_id: str, unit_id: str, share_token: str = "") -> dict:
    """POST the per-order detail page and return {address, otp}; {} on any failure."""
    request_context = {
        "type": "CX_ORDER_DETAIL_PAGE",
        "orderId": order_id,
        "unitId": unit_id,
        "pageView": "",
        "businessCategory": "",
    }
    if share_token:
        request_context["shareToken"] = share_token
    body = {
        "requestContext": request_context,
        "pageType": "CX_ORDER_DETAIL_PAGE",
        "pageUri": "/cx/order_detail_desktop",
        "locationContext": {"pincode": ""},
        "pageContext": {
            "pageHashKey": None, "slotContextMap": None, "paginationContextMap": None,
            "paginatedFetch": False, "pageNumber": 1, "fetchAllPages": False,
            "networkSpeed": 0, "trackingContext": None, "fetchSeoData": False,
        },
    }
    try:
        res = Fetcher.post(
            config.detail_url,
            headers=_headers({"content-type": "application/json"}),
            cookies=cookies,
            json=body,
            timeout=config.timeout,
            impersonate=config.impersonate,
            stealthy_headers=False,
        )
        if getattr(res, "status", 0) != 200:
            return {}
        detail = extract_detail(res.json())
        return detail if (detail.get("address") or detail.get("otp")) else {}
    except Exception:
        # best-effort: a single detail failure just leaves that order without an address
        return {}


# `orders_array` re-exported for callers/tests that want the raw shape helper.
__all__ = ["fetch_orders", "fetch_detail", "orders_array"]
