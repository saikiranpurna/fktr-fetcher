"""Status-mapping tests for the order parser (mirrors extension parser.test.ts)."""

from __future__ import annotations

from app import parser


def test_map_status_active_and_terminal():
    assert parser.map_status("Out for delivery") == "OUT_FOR_DELIVERY"
    assert parser.map_status("Delivery unsuccessful") == "OUT_FOR_DELIVERY"
    assert parser.map_status("Arriving today by 11 pm") == "ARRIVING"
    assert parser.map_status("Delivered on Sun Jul 05") == "DELIVERED"
    assert parser.map_status("Payment pending") == "OTHER"


def test_map_status_cancelled_variants():
    assert parser.map_status("Cancelled") == "CANCELLED"
    assert parser.map_status("Order cancellation requested") == "CANCELLED"
    assert parser.map_status("CANCELLED_BY_SELLER") == "CANCELLED"


def test_map_status_does_not_flag_return_or_negation_as_cancelled():
    # A cancelled RETURN/replacement or a negated phrase is not a cancelled order.
    assert parser.map_status("Return cancelled") != "CANCELLED"
    assert parser.map_status("Replacement cancelled") != "CANCELLED"
    assert parser.map_status("Cancellation window closed") != "CANCELLED"


def test_derive_status_prefers_cancelled_over_other():
    assert parser._derive_status(["Cancelled"])[0] == "CANCELLED"
    # Active/settled states still win over a cancelled sibling shipment.
    assert parser._derive_status(["Cancelled", "Arriving tomorrow"])[0] == "ARRIVING"
    assert parser._derive_status(["Cancelled", "Delivered"])[0] == "DELIVERED"


# ── extract_gst: the order's GST number (matches Flipkart's live "GST details") ─


def test_extract_gst_reads_flipkart_gst_details_shape():
    # Exact shape observed live in the order-detail response.
    detail = {"ewbNumber": None, "gstFieldTitle": "GST Number",
              "gstNumber": "36ABFFK3014J1ZH", "heading": "GST details"}
    assert parser.extract_gst(detail)["gstin"] == "36ABFFK3014J1ZH"


def test_extract_gst_finds_gstin_by_format_anywhere():
    order = {"orderMetaData": {"buyerDetails": {"taxId": "29ABCDE1234F1Z5"}}}
    assert parser.extract_gst(order)["gstin"] == "29ABCDE1234F1Z5"


def test_extract_gst_absent_returns_blank():
    assert parser.extract_gst({"orderMetaData": {"orderId": "OD1"}}) == {"gstin": ""}


def test_extract_gst_ignores_tracking_and_order_ids():
    # A tracking id / numeric order id must never be mistaken for a GSTIN.
    assert parser.extract_gst({"trackingId": "FMPP4118839140", "orderId": "OD123456"})["gstin"] == ""


def test_extract_gst_ignores_abtest_and_invoice_noise():
    # Regression: an A/B block like invoice_eta_comms.abId must not leak as GST.
    noise = {"invoice_eta_comms": {"value": True, "abId": "STG|launchedGroup|85e070c7|h"}}
    assert parser.extract_gst(noise)["gstin"] == ""


def test_parse_orders_carries_gst_from_detail_page():
    raw = [{"orderMetaData": {"orderId": "OD1"}, "units": {"u1": {"metaData": {"moRedesignHeading": "Delivered"}}}}]
    details = {"OD1": {"u1": {"address": None, "otp": None, "gst": {"gstin": "36ABFFK3014J1ZH"}}}}
    rows = parser.parse_orders(raw, details)
    assert rows and rows[0]["gstin"] == "36ABFFK3014J1ZH"


def test_extract_gst_finds_gstin_inside_an_array():
    assert parser.extract_gst({"gstDetails": ["36ABFFK3014J1ZH"]})["gstin"] == "36ABFFK3014J1ZH"


# ── price / lifecycle fields (synthetic fixtures shaped like live 2026-10-19 captures) ─

import json  # noqa: E402
from datetime import datetime, timedelta, timezone  # noqa: E402
from pathlib import Path  # noqa: E402

_FIX = Path(__file__).parent / "fixtures"
_ORDERS = json.loads((_FIX / "lifecycle-orders.json").read_text(encoding="utf-8"))["orders"]
_DETAIL = json.loads((_FIX / "lifecycle-detail.json").read_text(encoding="utf-8"))
_IST = timezone(timedelta(hours=5, minutes=30))


def _iso(ms: int) -> str:
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).isoformat()


def _rows(details=None, timelines=None, state=None) -> dict[str, dict]:
    rows = parser.parse_orders(_ORDERS, details or {}, timelines, state)
    return {r["trackingId"] or r["orderId"]: r for r in rows}


def _detailed_rows() -> dict[str, dict]:
    d = parser.extract_detail(_DETAIL)
    oid = "OD900000000000000001"
    details = {oid: {"U1002": {"address": d["address"], "otp": None, "gst": d["gst"]}}}
    state = {oid: {u: "ok" for u in ("U1001", "U1002", "U2002", "U1003")}}
    return _rows(details, {oid: d["timelines"]}, state)


def test_map_status_delivery_attempted_is_out_for_delivery():
    # Live: "Delivery attempted" = OUT_FOR_DELIVERY done + UNDEL current -> still an active delivery.
    assert parser.map_status("Delivery attempted") == "OUT_FOR_DELIVERY"
    assert _rows()["FMPP6000000001"]["status"] == "OUT_FOR_DELIVERY"


def test_extract_detail_reads_every_units_timeline_and_ignores_unfinished_steps():
    d = parser.extract_detail(_DETAIL)
    assert set(d["timelines"]) == {"U1001", "U1002", "U2002", "U1003"}
    assert d["timelines"]["U1002"]["cancelled"].isoformat() == _iso(1792150000000)
    assert d["timelines"]["U2002"]["created"].isoformat() == _iso(1792150001000)
    assert "delivered" not in d["timelines"]["U2002"]  # the DELIVERY step is INACTIVE, not DONE
    assert d["otp"] == "4821" and d["address"]["pinCode"] == "560001"


def test_price_paid_uses_whichever_field_reconciles_with_the_order_total():
    rows = _rows()
    assert rows["FMPP1000000001"]["pricePaid"] == 1425.0  # moneyDataBag.amount reconciles
    assert rows["FMPP5000000001"]["pricePaid"] == 138.0  # fees added after pricing: charged amount
    assert rows["OD900000000000000003"]["pricePaid"] == 0.0  # "Order Not Placed": nothing charged
    assert rows["FMPP8000000001"]["pricePaid"] == 0.0  # exchange unit was free...
    assert rows["FMPP7000000001"]["pricePaid"] == 335.0  # ...the original was paid


def _order_with(units: dict[str, dict], titles: dict[str, str]) -> dict:
    return {
        "orderMetaData": {"orderId": "OD900000000000000077", "orderDate": 1792000000000},
        "productDataBag": {lid: {"productBasicData": {"title": t}} for lid, t in titles.items()},
        "units": units,
    }


def _unit(kind: str, listing: str, tracking: str = "", amount: float = 0.0) -> dict:
    return {
        "metaData": {"type": kind, "listingId": listing, "trackingId": tracking, "moRedesignHeading": "Delivered on Oct 02"},
        "moneyDataBag": {"amount": amount},
    }


def test_addons_without_vas_details_are_skipped_by_their_digital_service_type():
    # Live 2026-10-20: a bulk order's trust-shield units were metaData.type "digital_service" with NO
    # vasItemDetails, so each surfaced as a ₹0 row next to the product unit it rode on.
    shield = _unit("digital_service", "LSTSHIELD")
    order = _order_with(
        {
            "U1": _unit("physical", "LSTPROD", "FMPP9100000001", 2286.0),
            "U2": shield,
            "U3": _unit("physical", "LSTPROD", "FMPP9100000002", 2286.0),
            "U4": _unit("digital_service", "LSTSHIELD"),
        },
        {"LSTPROD": "Bluetooth Speaker", "LSTSHIELD": "Flipkart Trust Shield"},
    )
    rows = parser.parse_orders([order], {})
    assert [(r["trackingId"], r["itemName"], r["pricePaid"]) for r in rows] == [
        ("FMPP9100000001", "Bluetooth Speaker", 2286.0),
        ("FMPP9100000002", "Bluetooth Speaker", 2286.0),
    ]
    assert parser.is_addon(shield) and parser.is_addon({"vasItemDetails": {"type": "TRUST_SHIELD"}})
    assert not parser.is_addon(_unit("physical", "LSTPROD")) and not parser.is_addon({"metaData": {}})


def test_a_paid_digital_item_keeps_its_row_and_price():
    # Only a FREE digital_service unit is an add-on: one that charged something is a real purchase.
    plan = _unit("digital_service", "LSTPLAN", amount=799.0)
    assert not parser.is_addon(plan)
    order = _order_with(
        {"U1": _unit("physical", "LSTPROD", "FMPP9200000001", 15999.0), "U2": plan},
        {"LSTPROD": "Phone", "LSTPLAN": "Extended Warranty"},
    )
    assert [(r["itemName"], r["pricePaid"]) for r in parser.parse_orders([order], {})] == [
        ("Phone", 15999.0),
        ("Extended Warranty", 799.0),
    ]


def test_rows_carry_their_unit_id_and_product_fsn():
    # An invoice download sends the unit back; the order's bundle names each tax invoice's FSN.
    unit = _unit("physical", "LSTPROD", "FMPP9300000001", 999.0)
    unit["metaData"]["fsn"] = "SPKFSN00000001"
    [row] = parser.parse_orders([_order_with({"U1": unit}, {"LSTPROD": "Speaker"})], {})
    assert (row["unitId"], row["fsn"]) == ("U1", "SPKFSN00000001")
    assert _rows()["FMPP1000000001"]["unitId"] and "fsn" in _rows()["FMPP1000000001"]


def test_an_order_made_only_of_add_ons_still_shows_them():
    rows = parser.parse_orders([_order_with({"U1": _unit("digital_service", "LSTV")}, {"LSTV": "Hotel voucher"})], {})
    assert [r["itemName"] for r in rows] == ["Hotel voucher"]


def test_expected_and_delivered_dates_come_from_the_promise_data():
    row = _rows()["FMPP1000000001"]
    assert row["expectedDateIso"] == _iso(1792100000000)
    assert row["deliveredDateIso"] == _iso(1792090000000)
    assert row["activityDateIso"] == _iso(1792090000000)  # no lifecycle event: delivered date


def test_cancellation_refunds_sum_and_report_latest_completed_date():
    row = _rows()["FMPP3000000001"]
    assert row["refundAmount"] == 5000.0  # 100 + 4900 partial refunds
    assert row["refundStatus"] == "completed"
    latest = datetime(2026, 10, 12, 18, 30, tzinfo=_IST)  # naive refundPromiseDate is IST
    assert row["refundDateIso"] == latest.isoformat()
    assert row["activityDateIso"] == latest.isoformat()


def test_processed_refund_is_initiated_and_dated_by_initiation():
    row = _rows()["FMPP2000000002"]
    assert (row["refundAmount"], row["refundStatus"]) == (7773.0, "initiated")
    assert row["refundDateIso"] == _iso(1792300500000)


def test_return_refund_amount_comes_from_the_return_remarks():
    row = _rows()["FMPP9000000001"]
    assert (row["refundAmount"], row["refundStatus"], row["refundDateIso"]) == (154.0, "completed", None)


def test_no_lifecycle_data_gives_empty_fields_not_errors():
    row = _rows()["FMPP1000000001"]
    assert row["refundAmount"] is None and row["refundStatus"] == "" and row["refundDateIso"] is None
    assert row["cancelledDateIso"] is None and row["replacementOf"] == ""
    assert row["detailStatus"] == "skipped"  # nothing was fetched for it in this call


def test_replacement_links_resent_unit_and_dates_the_original_row():
    rows = _detailed_rows()
    original, resent = rows["FMPP1000000002"], rows["FMPP2000000002"]
    assert resent["replacementOf"] == "FMPP1000000002"
    assert original["replacementOf"] == ""
    assert original["cancelledDateIso"] == _iso(1792150000000)
    assert original["replacementDateIso"] == _iso(1792150001000)  # resent unit's ORDER_RECEIVED
    assert original["replacementCancelledDateIso"] == _iso(1792300000000)  # resent unit's CANCEL
    assert original["replacementDeliveredDateIso"] is None
    # Latest lifecycle event drives the activity date (the replacement's cancellation).
    assert original["activityDateIso"] == _iso(1792300000000)
    assert resent["activityDateIso"] == _iso(1792300500000)  # its refund initiation is latest
    assert original["detailStatus"] == "ok" and original["deliveryAddress"].startswith("1 Test Street")


def test_exchange_counts_as_replacement_and_uses_resent_delivery_date():
    rows = _rows()
    assert rows["FMPP8000000001"]["replacementOf"] == "FMPP7000000001"
    assert rows["FMPP7000000001"]["replacementDeliveredDateIso"] == _iso(1790400000000)


def test_latest_replacement_wins_when_a_unit_was_replaced_twice():
    order = json.loads(json.dumps(_ORDERS[0]))
    units = order["units"]
    units["U3003"] = json.loads(json.dumps(units["U2002"]))
    units["U3003"]["metaData"]["trackingId"] = "FMPP3000000003"
    units["U1002"]["reverseLegDataBag"]["returnTracking"].append(
        {"associatedUnitId": "U3003", "returnType": "Replacement", "returnStatus": "Completed"}
    )
    created = datetime.fromtimestamp(1792400000, tz=timezone.utc)
    timelines = {order["orderMetaData"]["orderId"]: {"U2002": {"created": datetime.fromtimestamp(1792150001, tz=timezone.utc)},
                                                     "U3003": {"created": created}}}
    rows = {r["trackingId"]: r for r in parser.parse_orders([order], {}, timelines)}
    assert rows["FMPP1000000002"]["replacementDateIso"] == created.isoformat()
    assert rows["FMPP3000000003"]["replacementOf"] == "FMPP1000000002"


def test_is_lifecycle_unit_flags_cancel_refund_and_replacement_units():
    units = _ORDERS[0]["units"]
    assert parser.is_lifecycle_unit(units["U1002"])  # returnTracking
    assert parser.is_lifecycle_unit(units["U2002"])  # refunds + returnBadge
    assert not parser.is_lifecycle_unit(units["U1001"])  # plain delivered unit
    assert parser.is_lifecycle_unit({"metaData": {"moRedesignHeading": "Cancelled on Oct 17"}})


def test_failed_return_pickup_is_not_an_active_delivery():
    assert parser.map_status("Return pickup attempted") != "OUT_FOR_DELIVERY"
    assert parser.map_status("Pickup unsuccessful") != "OUT_FOR_DELIVERY"
    assert parser.map_status("Delivery unsuccessful") == "OUT_FOR_DELIVERY"
