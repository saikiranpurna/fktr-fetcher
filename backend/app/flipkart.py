"""Flipkart HTTP client built on Scrapling's Fetcher (curl_cffi TLS impersonation).

No headless browser: the internal 'My Orders' APIs answer plain HTTP when given the
account cookies plus Flipkart's custom `x-user-agent` (FKUA) header.

Failure contract: a failed request RAISES (with the upstream body logged), it never returns an
empty result — "Flipkart said nothing" and "the call failed" must stay distinguishable. Callers
that want resilience (per-detail, per-account) catch and record the failure themselves.
"""

from __future__ import annotations

import json
import logging
import threading
import time
from urllib.parse import quote, urlencode

from scrapling.fetchers import Fetcher

from .config import config
from .errors import auth_expired, invoice_unavailable, parse_error, upstream
from .parser import ensure_orders_shape

log = logging.getLogger("flipkart")

# Global cap on concurrent Flipkart HTTP requests across ALL account fetches (list + detail).
# Without it, fetch_concurrency (16) accounts each spinning an 8-worker detail pool would open
# ~144 simultaneous connections and invite rate-limiting/bans. This bounds the real load.
_conn = threading.BoundedSemaphore(config.max_flipkart_conns)


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


def _describe(res) -> str:
    """Status + first 500 chars of the response body, for logs. The body says WHY Flipkart refused
    (expired session, changed contract, rate limit); the status alone doesn't. Never includes
    request headers or cookies."""
    status = getattr(res, "status", "?")
    body = getattr(res, "body", b"")
    if isinstance(body, bytes):
        body = body.decode("utf-8", errors="replace")
    return f"HTTP {status} | body={str(body)[:500]}"


def _get(url: str, cookies: dict):
    with _conn:
        return Fetcher.get(url, headers=_headers(), cookies=cookies, timeout=config.timeout,
                           impersonate=config.impersonate, stealthy_headers=False)


def fetch_orders(cookies: dict, deadline: float | None = None) -> tuple[list[dict], bool]:
    """Paginate My Orders (7/page) following `nextCallParams`, up to config.max_pages.

    Returns ``(orders, partial)``. Page 1 must succeed (else AUTH_EXPIRED / UPSTREAM_ERROR /
    PARSE_ERROR is raised). After that, pagination is best-effort: a failed later page, the
    per-account ``deadline`` (a time.monotonic() value), or the max_pages cap stops early and sets
    ``partial=True`` so callers can show "history incomplete" instead of silently truncating."""
    base = config.orders_base
    seen: set[str] = set()
    all_orders: list[dict] = []
    url = f"{base}?{urlencode({'page': '1', 'filterType': config.filter_type})}"
    page = 1

    for i in range(config.max_pages):
        if i > 0 and deadline is not None and time.monotonic() > deadline:
            return all_orders, True
        try:
            res = _get(url, cookies)
        except Exception as err:  # network error / timeout
            if i == 0:
                raise upstream(f"Flipkart orders request failed ({type(err).__name__}).") from err
            log.warning("orders page %s failed: %s: %s", page, type(err).__name__, err)
            return all_orders, True
        status = getattr(res, "status", 0)
        if status in (401, 403):
            log.warning("orders page %s auth rejected: %s", page, _describe(res))
            raise auth_expired()
        if status != 200:
            log.warning("orders page %s failed: %s", page, _describe(res))
            if i == 0:
                raise upstream(f"Flipkart orders request failed (HTTP {status}).")
            return all_orders, True
        try:
            body = res.json()
        except Exception as err:  # an HTML interstitial / login page answered with 200
            log.warning("orders page %s returned non-JSON: %s", page, _describe(res))
            if i == 0:
                raise parse_error("Unexpected response: not JSON (session likely expired).") from err
            return all_orders, True
        if i == 0:
            ensure_orders_shape(body)  # first page must look right, else PARSE_ERROR
        elif not isinstance(body, dict):
            log.warning("orders page %s returned an unexpected shape: %s", page, _describe(res))
            return all_orders, True
        view = (body.get("RESPONSE") or {}).get("multipleOrderDetailsView") or {}
        for o in view.get("orders") or []:
            oid = (o.get("orderMetaData") or {}).get("orderId")
            if oid and oid not in seen:
                seen.add(oid)
                all_orders.append(o)

        ncp = view.get("nextCallParams")
        if not view.get("moreOrder") or not isinstance(ncp, list):
            return all_orders, False
        params = {x["key"]: str(x["value"]) for x in ncp if isinstance(x, dict) and "key" in x}
        if not params.get("ot"):
            return all_orders, False
        page += 1
        query = {"page": str(page), "order_before_time_stamp": params["ot"], "filterType": config.filter_type}
        query.update(params)
        url = f"{base}?{urlencode(query)}"

    # Hit the max_pages safety cap while Flipkart still reported more orders.
    return all_orders, True


def fetch_detail_raw(cookies: dict, order_id: str, unit_id: str, share_token: str = "") -> dict:
    """POST the per-order detail page and return its raw JSON. RAISES on any failure (non-200,
    network error, non-JSON body) after logging the upstream body — callers decide resilience."""
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
        with _conn:
            res = Fetcher.post(
                config.detail_url,
                headers=_headers({"content-type": "application/json"}),
                cookies=cookies,
                json=body,
                timeout=config.timeout,
                impersonate=config.impersonate,
                stealthy_headers=False,
            )
    except Exception as err:
        log.warning("detail %s/%s failed: %s: %s", order_id, unit_id, type(err).__name__, err)
        raise upstream(f"Flipkart order-detail request failed ({type(err).__name__}).") from err
    status = getattr(res, "status", 0)
    if status != 200:
        log.warning("detail %s/%s failed: %s", order_id, unit_id, _describe(res))
        raise upstream(f"Flipkart order-detail request failed (HTTP {status}).")
    try:
        return res.json()
    except Exception as err:
        log.warning("detail %s/%s returned non-JSON: %s", order_id, unit_id, _describe(res))
        raise upstream("Flipkart order-detail response was not JSON.") from err


def _is_try_later(body: bytes) -> bool:
    """Flipkart's JSON error envelope ({"STATUS_CODE": 500, "RESPONSE": null, ...}). The invoice
    endpoint answers an order with nothing dispatched (and an unknown order id) exactly this way."""
    try:
        data = json.loads(body)
    except ValueError:
        return False
    return isinstance(data, dict) and "STATUS_CODE" in data and data.get("RESPONSE") is None


def fetch_invoice(cookies: dict, order_id: str) -> bytes:
    """GET the order's invoices: a ZIP with one PDF per invoice (verified 2026-10-20; the detail
    page's INVOICE_DOWNLOAD action is a GET of 1/self-serve/invoice/download/<orderId>). A bare PDF
    is accepted too. RAISES AUTH_EXPIRED (401/403 or a redirect to login), INVOICE_UNAVAILABLE (the
    JSON "try again later" Flipkart sends while no unit is dispatched), PARSE_ERROR (a 200 that is
    no file) and UPSTREAM_ERROR otherwise. A successful body is never logged: it's an invoice."""
    url = f"{config.invoice_url}{quote(order_id, safe='')}"
    try:
        with _conn:
            # No redirects: Flipkart serves the file itself, and a followed redirect would carry the
            # session cookies to wherever it points.
            res = Fetcher.get(url, headers=_headers({"accept": "application/zip, application/pdf, */*"}),
                              cookies=cookies, timeout=config.timeout, impersonate=config.impersonate,
                              stealthy_headers=False, follow_redirects=False)
    except Exception as err:
        log.warning("invoice %s failed: %s: %s", order_id, type(err).__name__, err)
        raise upstream(f"Flipkart invoice request failed ({type(err).__name__}).") from err
    status = getattr(res, "status", 0)
    body = getattr(res, "body", b"")
    body = body if isinstance(body, bytes) else str(body or "").encode()
    headers = getattr(res, "headers", None) or {}
    location = next((str(v) for k, v in headers.items() if str(k).lower() == "location"), "")
    if status in (401, 403) or (300 <= status < 400 and "login" in location.lower()):
        log.warning("invoice %s auth rejected: HTTP %s", order_id, status)
        raise auth_expired()
    if 300 <= status < 400:
        log.warning("invoice %s: unexpected redirect (HTTP %s)", order_id, status)
        raise upstream(f"Flipkart invoice request was redirected (HTTP {status}).")
    if status == 200:
        if body[:2] == b"PK" or body[:5] == b"%PDF-":
            return body
        content_type = next((v for k, v in headers.items() if str(k).lower() == "content-type"), "?")
        log.warning("invoice %s: HTTP 200 but not a file (%d bytes, %s)", order_id, len(body), content_type)
        raise parse_error("Flipkart's invoice response was not a file (session likely expired).")
    if _is_try_later(body):
        log.info("invoice %s unavailable: %s", order_id, _describe(res))
        raise invoice_unavailable(
            "Flipkart has no invoice for this order yet (it appears once a unit ships). Try again later."
        )
    log.warning("invoice %s failed: %s", order_id, _describe(res))
    raise upstream(f"Flipkart invoice request failed (HTTP {status}).")


__all__ = ["fetch_orders", "fetch_detail_raw", "fetch_invoice"]
