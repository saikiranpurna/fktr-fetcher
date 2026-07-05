"""Parse Flipkart 'My Orders' list + per-order detail into the frontend Order shape.

Field paths mirror flipkart.com's internal APIs discovered live. An order holds a MAP of
units (line items); we collapse to one row per order, preferring the real product over
free add-ons (VAS: memberships, trust shield) and the most actionable delivery status.
"""

from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Any

from .errors import parse_error

# --- generic helpers --------------------------------------------------------

def get(obj: Any, path: str) -> Any:
    cur = obj
    for key in path.split("."):
        if not isinstance(cur, dict):
            return None
        cur = cur.get(key)
    return cur


def _num(v: Any) -> float | None:
    try:
        n = float(v)
    except (TypeError, ValueError):
        return None
    return n if n > 0 else None


def _to_iso(ms: Any) -> str | None:
    n = _num(ms)
    if n is None:
        return None
    try:
        return datetime.fromtimestamp(n / 1000.0, tz=timezone.utc).isoformat()
    except (OverflowError, OSError, ValueError):
        return None


def _s(v: Any) -> str:
    return "" if v is None else (v if isinstance(v, str) else str(v))


# --- status -----------------------------------------------------------------

def map_status(raw_status: str) -> str:
    s = re.sub(r"[_-]+", " ", (raw_status or "").lower())
    if "out for delivery" in s:
        return "OUT_FOR_DELIVERY"
    # A failed attempt awaiting re-delivery is still an active, OTP-bearing delivery.
    if re.search(r"unsuccessful|retrying|reattempt|undelivered|delivery failed", s):
        return "OUT_FOR_DELIVERY"
    if "delivered" in s:
        return "DELIVERED"
    if re.search(r"arriving|expected|shipped|on the way|in transit|dispatched", s):
        return "ARRIVING"
    return "OTHER"


def _derive_status(headings: list[str]) -> tuple[str, str]:
    arriving = delivered = False
    for h in headings:
        mapped = map_status(h)
        if mapped == "OUT_FOR_DELIVERY":
            return "OUT_FOR_DELIVERY", h
        arriving = arriving or mapped == "ARRIVING"
        delivered = delivered or mapped == "DELIVERED"
    status = "ARRIVING" if arriving else "DELIVERED" if delivered else "OTHER"
    match = next((h for h in headings if map_status(h) == status), None)
    return status, (match if match is not None else (headings[0] if headings else ""))


# --- product / units --------------------------------------------------------

def _unit_values(order: dict) -> list:
    units = get(order, "units")
    return list(units.values()) if isinstance(units, dict) else []


def _product_title(order: dict, unit: dict) -> str:
    bag = get(order, "productDataBag")
    if not isinstance(bag, dict):
        return ""
    listing_id = _s(get(unit, "metaData.listingId"))
    fsn = _s(get(unit, "metaData.fsn"))
    product = (bag.get(listing_id) if listing_id else None) or (bag.get(fsn) if fsn else None)
    return _s(get(product, "productBasicData.title")).strip()


# --- detail request (which unit to fetch) -----------------------------------

def detail_request_for(order: dict) -> dict | None:
    """Fields the detail endpoint needs. Prefer the actively-delivering unit — its OTP only
    shows when that unit is the request's unit. shareToken is optional (omit when absent)."""
    order_id = _s(get(order, "orderMetaData.orderId")).strip()
    units = get(order, "units")
    if not order_id or not isinstance(units, dict) or not units:
        return None
    unit_id = next(
        (uid for uid, u in units.items()
         if map_status(_s(get(u, "metaData.moRedesignHeading"))) == "OUT_FOR_DELIVERY"),
        next(iter(units.keys())),
    )
    share_token = _s(get(order, "accessToOrderDataBag.endUser.id")).strip()
    return {"orderId": order_id, "unitId": unit_id, "shareToken": share_token}


# --- detail extraction (address + live OTP) ---------------------------------

def extract_detail(detail_json: Any) -> dict:
    """Walk the page-model response for the delivery address object and the active-unit OTP."""
    address = None
    otp = None
    stack = [detail_json]
    while stack:
        n = stack.pop()
        if isinstance(n, dict):
            if address is None:
                a = n.get("address")
                if isinstance(a, dict) and (a.get("addressLine1") or a.get("pinCode")):
                    address = a
            if otp is None:
                v = n.get("otpValue")
                if isinstance(v, str) and v.isdigit() and 4 <= len(v) <= 8:
                    otp = v
            stack.extend(n.values())
        elif isinstance(n, list):
            stack.extend(n)
    return {"address": address, "otp": otp}


def _format_address(addr: Any) -> str:
    if not isinstance(addr, dict):
        return "Address unavailable"
    line1 = _s(addr.get("addressLine1")).strip()
    pin = _s(addr.get("pinCode")).strip()
    if line1:
        return f"{line1} - {pin}" if pin and pin not in line1 else line1
    parts = [_s(addr.get(k)).strip() for k in ("addressLine2", "city", "state")]
    parts.append(pin)
    parts = [p for p in parts if p]
    return ", ".join(parts) if parts else "Address unavailable"


def _list_otp(units: list) -> str | None:
    """OTP from a unit's otpCallout in the list response (only present while OFD)."""
    for u in units:
        oc = get(u, "deliveryDataBag.otpCallout")
        if not oc:
            continue
        if isinstance(oc, str) and oc.strip():
            return oc.strip()
        if isinstance(oc, dict):
            direct = oc.get("otp") or oc.get("code") or oc.get("value")
            if isinstance(direct, str) and direct.strip():
                return direct.strip()
            m = re.search(r"\b\d{4,8}\b", str(oc))
            if m:
                return m.group(0)
    return None


# --- top-level --------------------------------------------------------------

def orders_array(body: Any) -> list | None:
    arr = get(body, "RESPONSE.multipleOrderDetailsView.orders")
    return arr if isinstance(arr, list) else None


def parse_orders(raw_orders: list, details: dict[str, dict]) -> list[dict]:
    """raw_orders: the aggregated list orders. details: {orderId: {address, otp}} from the detail endpoint."""
    out: list[dict] = []
    for order in raw_orders:
        if not isinstance(order, dict):
            continue
        order_id = _s(get(order, "orderMetaData.orderId")).strip()
        if not order_id:
            continue
        units = _unit_values(order)
        real = [u for u in units if get(u, "vasItemDetails") is None] or units
        titles: list[str] = []
        headings: list[str] = []
        delivered_ms = None
        promised_ms = None
        for u in real:
            title = _product_title(order, u)
            if title and title not in titles:
                titles.append(title)
            heading = _s(get(u, "metaData.moRedesignHeading")).strip()
            if heading:
                headings.append(heading)
            dv = _num(get(u, "deliveryDataBag.promiseDataBag.actualDeliveredDate"))
            if dv:
                delivered_ms = max(delivered_ms or 0, dv)
            pv = _num(get(u, "deliveryDataBag.promiseDataBag.promisedDate"))
            if pv:
                promised_ms = pv if promised_ms is None else min(promised_ms, pv)

        status, raw_status = _derive_status(headings)
        first = titles[0] if titles else "Unknown item"
        item_name = f"{first} (+{len(titles) - 1} more)" if len(titles) > 1 else first
        chosen_ms = (delivered_ms or promised_ms) if status == "DELIVERED" else (promised_ms or delivered_ms)
        activity_iso = _to_iso(chosen_ms) or _to_iso(get(order, "orderMetaData.orderDate")) or ""

        tracking_id = ""
        for u in units:
            tid = _s(get(u, "metaData.trackingId")).strip()
            if tid:
                tracking_id = tid
                break

        detail = details.get(order_id, {})
        otp = _list_otp(units) or detail.get("otp") or None
        if otp:
            # An OTP is only issued for an active delivery -> the order is out for delivery.
            status = "OUT_FOR_DELIVERY"

        out.append({
            "orderId": order_id,
            "trackingId": tracking_id,
            "customerName": _s(get(order, "accessToOrderDataBag.buyer.name")).strip() or "Unknown customer",
            "itemName": item_name,
            "deliveryAddress": _format_address(detail.get("address")),
            "otp": otp,
            "status": status,
            "rawStatus": raw_status,
            "activityDateIso": activity_iso,
        })
    return out


def ensure_orders_shape(body: Any) -> list:
    """Raise PARSE_ERROR when the response is not the expected orders shape (likely auth)."""
    if not isinstance(body, dict):
        raise parse_error("Unexpected response shape: not an object (check the session cookie).")
    arr = orders_array(body)
    if arr is None:
        raise parse_error("Unexpected response shape: orders array missing (session likely expired).")
    return arr
