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
