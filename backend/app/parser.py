"""Parse Flipkart 'My Orders' list + per-order detail into the frontend Order shape.

Each order holds a MAP of units (one per shipment); we emit ONE ROW PER UNIT, skipping free add-ons
(VAS: memberships, trust shield). Field paths below were verified against live captures (2026-10-19)
of the list (/api/5/self-serve/orders) and detail (/api/4/page/fetch) responses:

  pricePaid           list    per unit, whichever of moneyDataBag.amount (usual: after offers, incl.
                              fees) or the sum of moneyDataBag.paymentMethods[].amounts[].value
                              (what was charged: right when fees were added after pricing, 0 for an
                              "Order Not Placed" order or a free exchange unit) reconciles with the
                              order's orderMoneyDataBag.amount; defaults to moneyDataBag.amount
  expectedDateIso     list    units.<id>.deliveryDataBag.promiseDataBag.promisedDate (epoch ms)
  deliveredDateIso    list    ...promiseDataBag.actualDeliveredDate, else the detail DELIVERY step
  cancelledDateIso    detail  timeline step groupName=CANCEL, stepStatus=DONE -> date (epoch ms)
  refund*             list    units.<id>.nonReturnRefundDataBag.nonReturnRefunds[] — cancellation
                              refunds, one entry per (partial) refund of THIS unit: refundAmount,
                              refundStatus ("Completed" | "Processed" = initiated, not yet
                              credited), refundInitiationDate (epoch ms), refundPromiseDate (naive
                              IST "YYYY-MM-DDTHH:MM:SS": the credited-by date; the detail REFUND
                              step carries the same instant). Return-for-refund amounts sit in
                              reverseLegDataBag.returnTracking[returnType=Refund].remarks[].amountValue
  replacement*        list    the ORIGINAL unit's reverseLegDataBag.returnTracking[] entry with
                              returnType Replacement|Exchange -> associatedUnitId = the resent unit,
                              always in the SAME order. The resent unit has no back-reference (only
                              returnBadge REPLACEMENT|EXCHANGE), so links are resolved per order.
                              Dates come from the resent unit: created = its detail ORDER_RECEIVED
                              step, delivered = its delivered date, cancelled = its CANCEL step.
  timelines           detail  ssResponse.orderView.units.<id>.orderUnitProgressStepsV1
                              .unitProgressSteps[] — ONE detail call returns EVERY unit's timeline.
"""

from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone
from typing import Any

from .errors import parse_error

# Flipkart's naive local timestamps (e.g. refundPromiseDate) are India time; IST has no DST.
_IST = timezone(timedelta(hours=5, minutes=30))

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


def _ms_dt(ms: Any) -> datetime | None:
    """Epoch-milliseconds -> aware UTC datetime; None when missing/zero/unparseable."""
    n = _num(ms)
    if n is None:
        return None
    try:
        return datetime.fromtimestamp(n / 1000.0, tz=timezone.utc)
    except (OverflowError, OSError, ValueError):
        return None


def _ist_dt(v: Any) -> datetime | None:
    """Flipkart's naive local "YYYY-MM-DDTHH:MM:SS" string -> aware IST datetime."""
    if not isinstance(v, str) or not v.strip():
        return None
    try:
        d = datetime.fromisoformat(v.strip())
    except ValueError:
        return None
    return d if d.tzinfo else d.replace(tzinfo=_IST)


def _iso(d: datetime | None) -> str | None:
    return d.isoformat() if d else None


def _to_iso(ms: Any) -> str | None:
    return _iso(_ms_dt(ms))


def _amount(v: Any) -> float | None:
    """A money value as float (0 allowed: a free unit really cost 0). Accepts {value|inrValue}."""
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return float(v)
    if isinstance(v, str):
        try:
            return float(v.strip())
        except ValueError:
            return None
    if isinstance(v, dict):
        return _amount(v["value"] if "value" in v else v.get("inrValue"))
    return None


def _s(v: Any) -> str:
    return "" if v is None else (v if isinstance(v, str) else str(v))


# --- status -----------------------------------------------------------------

def map_status(raw_status: str) -> str:
    s = re.sub(r"[_-]+", " ", (raw_status or "").lower())
    # A cancelled ORDER is CANCELLED, but a cancelled return/replacement or a negation
    # ("cannot cancel", "cancellation window closed") is not — exclude those contexts.
    if re.search(r"cancel", s) and not re.search(r"return|replacement|pickup|cannot|window", s):
        return "CANCELLED"
    if "out for delivery" in s:
        return "OUT_FOR_DELIVERY"
    # A failed attempt awaiting re-delivery ("Delivery attempted": its timeline shows OUT_FOR_DELIVERY
    # done and an UNDEL step current) is still an active, OTP-bearing delivery — but a failed RETURN
    # pickup ("Return pickup attempted") is a reverse-leg event, not a delivery to the customer.
    if re.search(r"unsuccessful|retrying|reattempt|attempted|undelivered|delivery failed", s) and not re.search(
        r"return|pickup", s
    ):
        return "OUT_FOR_DELIVERY"
    if "delivered" in s:
        return "DELIVERED"
    if re.search(r"arriving|expected|shipped|on the way|in transit|dispatched", s):
        return "ARRIVING"
    return "OTHER"


def _derive_status(headings: list[str]) -> tuple[str, str]:
    arriving = delivered = cancelled = False
    for h in headings:
        mapped = map_status(h)
        if mapped == "OUT_FOR_DELIVERY":
            return "OUT_FOR_DELIVERY", h
        arriving = arriving or mapped == "ARRIVING"
        delivered = delivered or mapped == "DELIVERED"
        cancelled = cancelled or mapped == "CANCELLED"
    status = "ARRIVING" if arriving else "DELIVERED" if delivered else "CANCELLED" if cancelled else "OTHER"
    match = next((h for h in headings if map_status(h) == status), None)
    return status, (match if match is not None else (headings[0] if headings else ""))


_LIFECYCLE_HEADING = re.compile(r"refund|replac|exchange|return", re.I)


def is_lifecycle_unit(unit: Any) -> bool:
    """Cancelled, refunded, replaced, exchanged or returned: the units whose dates need the detail
    page's timeline (the list response carries no cancel/replacement dates)."""
    heading = _s(get(unit, "metaData.moRedesignHeading"))
    if map_status(heading) == "CANCELLED" or _LIFECYCLE_HEADING.search(heading):
        return True
    if get(unit, "nonReturnRefundDataBag.nonReturnRefunds"):
        return True
    reverse = get(unit, "reverseLegDataBag")
    return isinstance(reverse, dict) and bool(reverse.get("returnTracking") or reverse.get("returnBadge"))


# --- product / units --------------------------------------------------------

def _product_title(order: dict, unit: dict) -> str:
    bag = get(order, "productDataBag")
    if not isinstance(bag, dict):
        return ""
    listing_id = _s(get(unit, "metaData.listingId"))
    fsn = _s(get(unit, "metaData.fsn"))
    product = (bag.get(listing_id) if listing_id else None) or (bag.get(fsn) if fsn else None)
    return _s(get(product, "productBasicData.title")).strip()


# --- GST -------------------------------------------------------------------

# A GSTIN is a fixed 15-char code: 2-digit state + 5 letters + 4 digits + letter + entity char
# + 'Z' + checksum. Flipkart exposes it as `gstNumber` in the order-detail "GST details" section.
# We prefer a value under a GST-named key, then fall back to any value matching the format, so a
# key rename can't break us. (The tax invoice itself is a downloadable file, not JSON fields, so
# invoice number/date are not available from the responses we fetch.)
_GSTIN_RE = re.compile(r"^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$")


def extract_gst(*sources: Any) -> dict:
    """Extract the order's GST number. Returns {"gstin": ...} ("" when the order carries none)."""
    keyed = ""
    any_fmt = ""
    stack = [s for s in sources if s is not None]
    while stack:
        n = stack.pop()
        if isinstance(n, dict):
            for k, v in n.items():
                if isinstance(v, str):
                    sv = v.strip().upper()
                    if sv and _GSTIN_RE.match(sv):
                        if "gst" in re.sub(r"[^a-z0-9]", "", _s(k).lower()):
                            keyed = keyed or sv
                        else:
                            any_fmt = any_fmt or sv
                elif isinstance(v, (dict, list)):
                    stack.append(v)
        elif isinstance(n, list):
            for item in n:
                if isinstance(item, str):
                    sv = item.strip().upper()
                    if sv and _GSTIN_RE.match(sv):
                        any_fmt = any_fmt or sv
                else:
                    stack.append(item)
    return {"gstin": keyed or any_fmt}


# --- detail extraction (address + live OTP + every unit's timeline) ---------

# Completed timeline step (groupName) -> the lifecycle date it records.
_TIMELINE_FIELDS = {"ORDER_RECEIVED": "created", "CANCEL": "cancelled", "DELIVERY": "delivered", "REFUND": "refund"}


def _unit_timeline(unit: Any) -> dict[str, datetime]:
    """{created|cancelled|delivered|refund: datetime} from a unit's DONE timeline steps."""
    out: dict[str, datetime] = {}
    steps = get(unit, "orderUnitProgressStepsV1.unitProgressSteps")
    for step in steps if isinstance(steps, list) else []:
        if not isinstance(step, dict) or _s(step.get("stepStatus")).upper() != "DONE":
            continue
        field = _TIMELINE_FIELDS.get(_s(step.get("groupName")).upper())
        when = _ms_dt(step.get("date"))
        if field and when:
            out[field] = when
    return out


def extract_detail(detail_json: Any) -> dict:
    """Walk the page-model response for the delivery address object, the active-unit OTP, the GST
    number, and the timeline of every unit in the order (keyed by unit id)."""
    address = None
    otp = None
    timelines: dict[str, dict[str, datetime]] = {}
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
            view = n.get("orderView")
            if isinstance(view, dict) and isinstance(view.get("units"), dict):
                for unit_id, unit in view["units"].items():
                    if isinstance(unit, dict):
                        timelines.setdefault(str(unit_id), _unit_timeline(unit))
            stack.extend(n.values())
        elif isinstance(n, list):
            stack.extend(n)
    return {"address": address, "otp": otp, "gst": extract_gst(detail_json), "timelines": timelines}


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


# --- price paid (list response) ---------------------------------------------

def _unit_charged(unit: Any) -> float | None:
    """Sum of what the unit's payment methods actually charged; None when none are listed."""
    methods = get(unit, "moneyDataBag.paymentMethods")
    if not isinstance(methods, list) or not methods:
        return None
    total = 0.0
    for method in methods:
        for entry in (method.get("amounts") or []) if isinstance(method, dict) else []:
            total += _amount(entry) or 0.0
    return total


def _paid_by_unit(order: Any, units: dict) -> dict[str, float | None]:
    """Amount paid per unit. moneyDataBag.amount usually reconciles with the order total; when it
    doesn't (fees added after pricing, an order never placed, a free exchange unit) the per-unit
    payment-method amounts do. Pick whichever field sums to orderMoneyDataBag.amount."""
    listed = {uid: _amount(get(u, "moneyDataBag.amount")) for uid, u in units.items()}
    total = _amount(get(order, "orderMoneyDataBag.amount"))
    if total is None:
        return listed
    if total == 0:
        # Nothing was charged for the order (e.g. "Order Not Placed"): its units list their price
        # but carry no payment methods, so neither field would reconcile.
        return {uid: 0.0 for uid in units}

    def reconciles(values: dict[str, float | None]) -> bool:
        known = list(values.values())
        return bool(known) and all(v is not None for v in known) and abs(sum(known) - total) < 0.01

    if reconciles(listed):
        return listed
    charged = {uid: _unit_charged(u) for uid, u in units.items()}
    return charged if reconciles(charged) else listed


# --- refunds / replacements (list response) ---------------------------------

def _unit_refund(unit: Any) -> dict:
    """{amount, status, date} for one unit. amount = SUM of its refunds (partial refunds are separate
    entries); status "completed" only when every refund completed, else "initiated"; date = latest
    completed (credited-by) date, else latest initiation date. No refunds -> (None, "", None)."""
    total = 0.0
    has_amount = False
    done_flags: list[bool] = []
    completed: list[datetime] = []
    initiated: list[datetime] = []
    refunds = get(unit, "nonReturnRefundDataBag.nonReturnRefunds")
    for r in refunds if isinstance(refunds, list) else []:
        if not isinstance(r, dict):
            continue
        amount = _amount(r.get("refundAmount"))
        if amount is not None:
            total += amount
            has_amount = True
        done = _s(r.get("refundStatus")).strip().lower() == "completed"
        done_flags.append(done)
        started = _ms_dt(r.get("refundInitiationDate")) or _ms_dt(r.get("createdDate"))
        if done:
            when = _ist_dt(r.get("refundPromiseDate")) or started
            if when:
                completed.append(when)
        elif started:
            initiated.append(started)
    # Return-for-refund: the amount rides on the return's remarks (no nonReturnRefunds entry).
    tracking = get(unit, "reverseLegDataBag.returnTracking")
    for t in tracking if isinstance(tracking, list) else []:
        if not isinstance(t, dict) or _s(t.get("returnType")).strip().lower() != "refund":
            continue
        for remark in t.get("remarks") or []:
            amount = _amount(get(remark, "amountValue"))
            if amount:
                total += amount
                has_amount = True
        done_flags.append(_s(t.get("returnStatus")).strip().lower() == "completed")
    if not done_flags:
        return {"amount": None, "status": "", "date": None}
    return {
        "amount": total if has_amount else None,
        "status": "completed" if all(done_flags) else "initiated",
        "date": max(completed) if completed else (max(initiated) if initiated else None),
    }


_REPLACEMENT_TYPES = {"replacement", "exchange"}


def _replacement_links(units: dict) -> dict[str, list[str]]:
    """original unitId -> resent unitIds (Replacement/Exchange), resolved within one order."""
    links: dict[str, list[str]] = {}
    for unit_id, unit in units.items():
        tracking = get(unit, "reverseLegDataBag.returnTracking")
        for t in tracking if isinstance(tracking, list) else []:
            if not isinstance(t, dict) or _s(t.get("returnType")).strip().lower() not in _REPLACEMENT_TYPES:
                continue
            new_id = _s(t.get("associatedUnitId")).strip()
            if new_id and new_id != unit_id and new_id in units:
                links.setdefault(unit_id, []).append(new_id)
    return links


# --- top-level --------------------------------------------------------------

def orders_array(body: Any) -> list | None:
    arr = get(body, "RESPONSE.multipleOrderDetailsView.orders")
    return arr if isinstance(arr, list) else None


def parse_orders(
    raw_orders: list,
    details: dict[str, dict],
    timelines: dict[str, dict[str, dict[str, datetime]]] | None = None,
    detail_state: dict[str, dict[str, str]] | None = None,
) -> list[dict]:
    """Explode each order into one row PER UNIT (shipment): a single orderId can yield several rows,
    each with its own item, status, tracking id, OTP, price and lifecycle dates.

    ``details``      {orderId: {unitId: {address, otp, gst}}} — the delivery address is order-level.
    ``timelines``    {orderId: {unitId: {created|cancelled|delivered|refund: datetime}}}.
    ``detail_state`` {orderId: {unitId: "ok" | "failed" | "skipped"}} — whether the detail-page data
                     for that unit is known, so an empty lifecycle field reads as "none" vs "unknown".
    """
    timelines = timelines or {}
    detail_state = detail_state or {}
    out: list[dict] = []
    for order in raw_orders:
        if not isinstance(order, dict):
            continue
        order_id = _s(get(order, "orderMetaData.orderId")).strip()
        if not order_id:
            continue
        units = get(order, "units")
        units = units if isinstance(units, dict) else {}
        items = list(units.items())
        # Skip free add-ons (membership, trust shield); fall back to all units if that leaves nothing.
        real = [(uid, u) for uid, u in items if get(u, "vasItemDetails") is None] or items
        if not real:
            continue

        unit_details = details.get(order_id, {})
        order_timelines = timelines.get(order_id, {})
        states = detail_state.get(order_id, {})
        order_address = next((d["address"] for d in unit_details.values() if d.get("address")), None)
        address = _format_address(order_address)
        phone = _s(order_address.get("phoneNumber")).strip() if isinstance(order_address, dict) else ""
        customer = _s(get(order, "accessToOrderDataBag.buyer.name")).strip() or "Unknown customer"
        order_date = _ms_dt(get(order, "orderMetaData.orderDate"))
        # The GST number lives on the order-detail page; prefer it, fall back to the list entry.
        gstin = ""
        for d in unit_details.values():
            dg = d.get("gst") if isinstance(d, dict) else None
            if isinstance(dg, dict) and dg.get("gstin"):
                gstin = dg["gstin"]
                break
        if not gstin:
            gstin = extract_gst(order).get("gstin", "")

        replaced_by = _replacement_links(units)
        replacement_of = {new: old for old, news in replaced_by.items() for new in news}
        paid = _paid_by_unit(order, units)

        for unit_id, u in real:
            heading = _s(get(u, "metaData.moRedesignHeading")).strip()
            status = map_status(heading)
            timeline = order_timelines.get(unit_id, {})
            delivered = _ms_dt(get(u, "deliveryDataBag.promiseDataBag.actualDeliveredDate")) or timeline.get("delivered")
            promised = _ms_dt(get(u, "deliveryDataBag.promiseDataBag.promisedDate"))
            chosen = (delivered or promised) if status == "DELIVERED" else (promised or delivered)
            otp = _unit_otp(u) or unit_details.get(unit_id, {}).get("otp") or None
            if otp:
                # An OTP is only issued for an active delivery -> out for delivery.
                status = "OUT_FOR_DELIVERY"

            cancelled = timeline.get("cancelled")
            refund = _unit_refund(u)
            # A return-refund has no date in the list response; the detail REFUND step has it.
            refund_date = refund["date"] or (timeline.get("refund") if refund["status"] else None)

            # This unit was replaced: report the LATEST resent unit's dates on the original's row.
            repl_created = repl_delivered = repl_cancelled = None
            resent = replaced_by.get(unit_id)
            if resent:
                floor = datetime.min.replace(tzinfo=timezone.utc)
                latest = max(resent, key=lambda n: (order_timelines.get(n, {}).get("created") or floor, resent.index(n)))
                resent_timeline = order_timelines.get(latest, {})
                repl_created = resent_timeline.get("created")
                repl_delivered = (
                    _ms_dt(get(units[latest], "deliveryDataBag.promiseDataBag.actualDeliveredDate"))
                    or resent_timeline.get("delivered")
                )
                repl_cancelled = resent_timeline.get("cancelled")
            original_id = replacement_of.get(unit_id)
            replacement_of_tid = _s(get(units[original_id], "metaData.trackingId")).strip() if original_id else ""

            # Cancelled / replaced / refunded rows date by their LATEST lifecycle event, so the
            # Today / Last 7 days filters surface recent cancellations and refunds.
            lifecycle = [d for d in (cancelled, repl_created, repl_delivered, repl_cancelled, refund_date) if d]
            activity = max(lifecycle) if lifecycle else (chosen or order_date)

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
                "activityDateIso": _iso(activity) or "",
                "gstin": gstin,
                "pricePaid": paid.get(unit_id),
                "expectedDateIso": _iso(promised),
                "deliveredDateIso": _iso(delivered),
                "cancelledDateIso": _iso(cancelled),
                "replacementOf": replacement_of_tid,
                "replacementDateIso": _iso(repl_created),
                "replacementDeliveredDateIso": _iso(repl_delivered),
                "replacementCancelledDateIso": _iso(repl_cancelled),
                "refundAmount": refund["amount"],
                "refundStatus": refund["status"],
                "refundDateIso": _iso(refund_date),
                "detailStatus": states.get(unit_id, "skipped"),
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
