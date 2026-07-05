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

def detail_targets_for(order: dict) -> list[dict]:
    """One detail request per real (non-VAS) unit. The detail endpoint returns that unit's OTP
    plus the order-level address. shareToken is order-level (optional)."""
    order_id = _s(get(order, "orderMetaData.orderId")).strip()
    units = get(order, "units")
    if not order_id or not isinstance(units, dict):
        return []
    share_token = _s(get(order, "accessToOrderDataBag.endUser.id")).strip()
    targets: list[dict] = []
    for unit_id, u in units.items():
        if get(u, "vasItemDetails") is not None:
            continue
        targets.append({"orderId": order_id, "unitId": unit_id, "shareToken": share_token})
    return targets


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


def _unit_otp(unit: dict) -> str | None:
    """OTP from a single unit's otpCallout in the list response (present only while OFD)."""
    oc = get(unit, "deliveryDataBag.otpCallout")
    if not oc:
        return None
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
    """Explode each order into one row PER UNIT (shipment): a single orderId can yield several
    rows, each with its own item, status, tracking id, and OTP. `details` is keyed
    {orderId: {unitId: {address, otp}}}; the delivery address is order-level (shared)."""
    out: list[dict] = []
    for order in raw_orders:
        if not isinstance(order, dict):
            continue
        order_id = _s(get(order, "orderMetaData.orderId")).strip()
        if not order_id:
            continue
        units = get(order, "units")
        items = list(units.items()) if isinstance(units, dict) else []
        # Skip free add-ons (membership, trust shield); fall back to all units if that leaves nothing.
        real = [(uid, u) for uid, u in items if get(u, "vasItemDetails") is None] or items
        if not real:
            continue

        unit_details = details.get(order_id, {})
        order_address = next((d["address"] for d in unit_details.values() if d.get("address")), None)
        address = _format_address(order_address)
        phone = _s(order_address.get("phoneNumber")).strip() if isinstance(order_address, dict) else ""
        customer = _s(get(order, "accessToOrderDataBag.buyer.name")).strip() or "Unknown customer"
        order_date = get(order, "orderMetaData.orderDate")

        for unit_id, u in real:
            heading = _s(get(u, "metaData.moRedesignHeading")).strip()
            status = map_status(heading)
            delivered = _num(get(u, "deliveryDataBag.promiseDataBag.actualDeliveredDate"))
            promised = _num(get(u, "deliveryDataBag.promiseDataBag.promisedDate"))
            chosen_ms = (delivered or promised) if status == "DELIVERED" else (promised or delivered)
            otp = _unit_otp(u) or unit_details.get(unit_id, {}).get("otp") or None
            if otp:
                # An OTP is only issued for an active delivery -> out for delivery.
                status = "OUT_FOR_DELIVERY"
            out.append({
                "orderId": order_id,
                "trackingId": _s(get(u, "metaData.trackingId")).strip(),
                "customerName": customer,
                "itemName": _product_title(order, u) or "Unknown item",
                "deliveryAddress": address,
                "phone": phone,
                "otp": otp,
                "status": status,
                "rawStatus": heading,
                "activityDateIso": _to_iso(chosen_ms) or _to_iso(order_date) or "",
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
