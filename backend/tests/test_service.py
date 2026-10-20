"""service.py: detail-call targeting (active -> history window -> address), the per-unit
detailStatus that keeps "no data" distinguishable from "fetch failed / not attempted", and the
on-demand invoice downloads (one card's tax invoice, a ZIP of the filtered cards')."""

from __future__ import annotations

import io
import json
import time
import zipfile
from pathlib import Path

import pytest

from app import flipkart, invoice_docs, poller, service
from app.config import config
from app.errors import AppError, auth_expired, upstream

_DAY_MS = 24 * 60 * 60 * 1000
_DETAIL = json.loads((Path(__file__).parent / "fixtures" / "lifecycle-detail.json").read_text(encoding="utf-8"))


def _order(oid: str, heading: str, *, days_ago: float = 1, units: int = 1) -> dict:
    placed = time.time() * 1000 - days_ago * _DAY_MS
    return {
        "orderMetaData": {"orderId": oid, "orderDate": placed},
        "units": {f"{oid}-u{i}": {"metaData": {"moRedesignHeading": heading}} for i in range(units)},
    }


@pytest.fixture
def caps(monkeypatch):
    monkeypatch.setattr(config, "history_days", 30)
    monkeypatch.setattr(config, "max_history_details", 150)
    monkeypatch.setattr(config, "max_details", 40)


def test_targets_prioritise_active_then_recent_history_then_addresses(caps):
    raw = [
        _order("OLD", "Cancelled on Aug 01", days_ago=60),  # outside the history window
        _order("DEL", "Delivered on Oct 15"),
        _order("REC", "Refund completed", days_ago=5),
        _order("ACT", "Out for delivery", units=2),
    ]
    targets = [(oid, uid) for oid, uid, _ in service._detail_targets(raw)]
    assert targets == [
        ("ACT", "ACT-u0"), ("ACT", "ACT-u1"),  # every active unit: each needs its own OTP
        ("REC", "REC-u0"),  # one call per recent lifecycle order covers all its units' timelines
        ("OLD", "OLD-u0"), ("DEL", "DEL-u0"),  # address-only, in list order
    ]


def test_targets_skip_add_on_units_even_without_vas_details(caps):
    order = _order("MIX", "Out for delivery", units=2)
    order["units"]["MIX-u0"]["metaData"]["type"] = "digital_service"  # a trust shield on the product
    assert [(oid, uid) for oid, uid, _ in service._detail_targets([order])] == [("MIX", "MIX-u1")]


def test_history_tier_is_capped_and_can_be_disabled(caps, monkeypatch):
    raw = [_order(f"H{i}", "Cancelled on Oct 10", days_ago=2) for i in range(3)]
    monkeypatch.setattr(config, "max_history_details", 1)
    monkeypatch.setattr(config, "max_details", 0)
    assert [t[0] for t in service._detail_targets(raw)] == ["H0"]

    monkeypatch.setattr(config, "history_days", 0)  # 0 disables history lookups
    monkeypatch.setattr(config, "max_details", 40)
    assert [t[0] for t in service._detail_targets(raw)] == ["H0", "H1", "H2"]  # address tier instead


def test_detail_state_separates_ok_failed_and_skipped(caps, monkeypatch):
    raw = [
        _order("ACT", "Out for delivery", units=2),
        _order("BAD", "Refund completed"),
    ]
    raw[0]["units"]["ACT-x"] = {"metaData": {"moRedesignHeading": "Delivered on Oct 15"}}

    def fake_detail(cookies, order_id, unit_id, share=""):
        if order_id == "BAD" or unit_id == "ACT-u1":
            raise upstream("Flipkart order-detail request failed (HTTP 500).")
        return _DETAIL

    monkeypatch.setattr(flipkart, "fetch_detail_raw", fake_detail)
    monkeypatch.setattr(config, "max_details", 40)
    result = service._enrich_details({"SN": "1"}, raw)
    assert result.failed == 2
    assert result.state["ACT"] == {"ACT-u0": "ok", "ACT-u1": "failed", "ACT-x": "ok"}  # x covered by u0's call
    assert result.state["BAD"] == {"BAD-u0": "failed"}
    assert result.details["ACT"]["ACT-u0"]["otp"] == "4821"
    assert set(result.timelines["ACT"]) == {"U1001", "U1002", "U2002", "U1003"}


def test_deadline_leaves_unattempted_units_skipped(caps, monkeypatch):
    raw = [_order("ACT", "Out for delivery")]
    monkeypatch.setattr(flipkart, "fetch_detail_raw", lambda *a, **k: pytest.fail("no call after the deadline"))
    result = service._enrich_details({"SN": "1"}, raw, deadline=time.monotonic() - 1)
    assert result.state["ACT"] == {"ACT-u0": "skipped"} and result.failed == 0


def test_fetch_account_orders_returns_rows_and_meta(caps, monkeypatch):
    raw = [_order("ACT", "Out for delivery")]
    monkeypatch.setattr(flipkart, "fetch_orders", lambda cookies, deadline=None: (raw, True))

    def fail(*a, **k):
        raise upstream("boom")

    monkeypatch.setattr(flipkart, "fetch_detail_raw", fail)
    rows, meta = service.fetch_account_orders("Home", {"SN": "1"})
    assert meta == {"partial": True, "detailFailed": 1}
    assert rows[0]["account"] == "Home" and rows[0]["detailStatus"] == "failed"


def test_budget_exhaustion_is_skipped_not_failed(caps, monkeypatch):
    raw = [_order("ACT", "Out for delivery", units=3)]

    def slow(*a, **k):
        time.sleep(0.5)
        return _DETAIL

    monkeypatch.setattr(flipkart, "fetch_detail_raw", slow)
    result = service._enrich_details({"SN": "1"}, raw, deadline=time.monotonic() + 0.1)
    # The calls were still running when the account's budget ran out: nothing FAILED upstream.
    assert result.failed == 0
    assert set(result.state["ACT"].values()) == {"skipped"}


def test_max_details_zero_only_drops_address_lookups(caps, monkeypatch):
    monkeypatch.setattr(config, "max_details", 0)
    raw = [_order("ACT", "Out for delivery"), _order("REC", "Cancelled on Oct 18", days_ago=1), _order("DEL", "Delivered")]
    assert [t[0] for t in service._detail_targets(raw)] == ["ACT", "REC"]




# ── invoices ────────────────────────────────────────────────────────────────
# Bundles are ZIPs of fake "PDFs" whose bytes double as their text (invoice_docs.pdf_text is stubbed);
# test_invoice_docs covers reading real PDFs.

def _doc(text: str) -> bytes:
    return f"%PDF-1.4 {text}".encode()


def _bundle(*docs: bytes) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for i, doc in enumerate(docs, start=1):
            zf.writestr(f"file_{i}.pdf", doc)
    return buf.getvalue()


TAX_S1, TAX_S2 = _doc("Tax Invoice FSN SPKA serial S1"), _doc("Tax Invoice FSN SPKA serial S2")
FEE = _doc("Contact Flipkart SAC fee")
SHIP = _doc("Consignor details FSN SPKA")
OD1, OD2 = "OD900000000000000001", "OD900000000000000002"
ROWS = {
    oid: [
        {"orderId": oid, "unitId": "U1", "fsn": "SPKA", "trackingId": "FMPP0000000001"},
        {"orderId": oid, "unitId": "U2", "fsn": "SPKA", "trackingId": "FMPP0000000002"},
        {"orderId": oid, "unitId": "U3", "fsn": "SPKA", "trackingId": ""},  # cancelled before shipping
    ]
    for oid in (OD1, OD2)
}


@pytest.fixture
def roster(monkeypatch):
    """Two known accounts in the poller's roster (anything else is unknown or paused), their cached
    rows, and fake-PDF text."""
    known = {"home": {"SN": "1"}, "shop": {"SN": "2"}}
    monkeypatch.setattr(poller.instance, "cookies_for", lambda aid: known.get(aid))
    monkeypatch.setattr(poller.instance, "order_rows", lambda aid, oid: ROWS.get(oid, []) if aid in known else [])
    monkeypatch.setattr(invoice_docs, "pdf_text", lambda data: data.decode())


def test_a_card_downloads_only_its_own_tax_invoice(roster, monkeypatch):
    monkeypatch.setattr(flipkart, "fetch_invoice", lambda cookies, oid: _bundle(SHIP, TAX_S1, FEE, TAX_S2))
    assert service.fetch_invoice("home", OD1, "U2") == (TAX_S2, "FMPP0000000002")
    assert service.fetch_invoice("home", OD1, "U1") == (TAX_S1, "FMPP0000000001")


@pytest.mark.parametrize(
    ("account", "unit", "code"),
    [
        ("home", "U9", "CONFIG_ERROR"),  # not in the cached list (a stale page)
        ("gone", "U1", "CONFIG_ERROR"),  # unknown or paused account
        ("home", "U3", "INVOICE_UNAVAILABLE"),  # never shipped
    ],
)
def test_a_card_without_an_invoice_gets_a_typed_error(roster, monkeypatch, account, unit, code):
    monkeypatch.setattr(flipkart, "fetch_invoice", lambda cookies, oid: _bundle(TAX_S1, TAX_S2))
    with pytest.raises(AppError) as exc:
        service.fetch_invoice(account, OD1, unit)
    assert exc.value.code == code


def test_a_bundle_without_the_cards_invoice_is_unavailable_and_a_broken_one_a_parse_error(roster, monkeypatch):
    monkeypatch.setattr(flipkart, "fetch_invoice", lambda cookies, oid: _bundle(FEE, SHIP))
    with pytest.raises(AppError) as exc:
        service.fetch_invoice("home", OD1, "U1")
    assert exc.value.code == "INVOICE_UNAVAILABLE"

    monkeypatch.setattr(flipkart, "fetch_invoice", lambda cookies, oid: b"PK\x03\x04 cut short")
    with pytest.raises(AppError) as exc:
        service.fetch_invoice("home", OD1, "U1")
    assert exc.value.code == "PARSE_ERROR"


def test_invoices_zip_holds_exactly_the_requested_cards(roster, monkeypatch):
    calls: list[str] = []

    def fake(cookies, oid):
        calls.append(oid)
        return _bundle(SHIP, TAX_S1, FEE, TAX_S2)

    monkeypatch.setattr(flipkart, "fetch_invoice", fake)
    dest = io.BytesIO()
    # Only U2 passed the filters: U1's invoice stays out, though it sits in the same bundle.
    request = [{"orderId": OD1, "accountIds": ["home"], "unitIds": ["U2"]}]
    assert service.build_invoices_zip(request, dest) == {"files": 1, "missing": 0}
    zf = zipfile.ZipFile(io.BytesIO(dest.getvalue()))
    assert zf.namelist() == [f"{OD1}/FMPP0000000002.pdf"]
    assert zf.read(f"{OD1}/FMPP0000000002.pdf") == TAX_S2

    # The same order listed twice (shared between accounts) is fetched once.
    request = [
        {"orderId": OD2, "accountIds": ["home"], "unitIds": ["U1"]},
        {"orderId": OD2, "accountIds": ["shop"], "unitIds": ["U1", "U2"]},
    ]
    assert service.build_invoices_zip(request, io.BytesIO()) == {"files": 2, "missing": 0}
    assert calls == [OD1, OD2]


def test_invoices_zip_lists_cards_without_an_invoice_and_falls_back_across_accounts(roster, monkeypatch):
    calls: list[str] = []

    def fake(cookies, oid):
        calls.append(cookies["SN"])
        if cookies["SN"] == "1":
            raise auth_expired()  # "home"'s session expired
        return _bundle(TAX_S1)  # only one tax invoice so far

    monkeypatch.setattr(flipkart, "fetch_invoice", fake)
    dest = io.BytesIO()
    request = [{"orderId": OD1, "accountIds": ["gone", "home", "shop"], "unitIds": ["U1", "U2", "U3", "U9"]}]
    assert service.build_invoices_zip(request, dest) == {"files": 1, "missing": 3}
    assert calls == ["1", "2"]  # "gone" isn't in the roster and home's session expired: shop fetched it
    zf = zipfile.ZipFile(io.BytesIO(dest.getvalue()))
    assert sorted(zf.namelist()) == [f"{OD1}/FMPP0000000001.pdf", "missing.txt"]
    missing = zf.read("missing.txt").decode()
    assert f"{OD1}\tFMPP0000000002\tINVOICE_UNAVAILABLE\t" in missing  # no tax invoice for it yet
    assert f"{OD1}\tU3\tINVOICE_UNAVAILABLE\t" in missing  # never shipped
    assert f"{OD1}\tU9\tCONFIG_ERROR\t" in missing  # not in the cached list


def test_invoices_zip_raises_instead_of_an_empty_zip_and_enforces_the_cap(roster, monkeypatch):
    one = [{"orderId": OD1, "accountIds": ["home"], "unitIds": ["U1"]}]

    def expired(cookies, oid):
        raise auth_expired()

    monkeypatch.setattr(flipkart, "fetch_invoice", expired)
    with pytest.raises(AppError) as exc:
        service.build_invoices_zip(one, io.BytesIO())
    assert exc.value.code == "AUTH_EXPIRED"  # nothing saved: the order's own error, no ZIP

    monkeypatch.setattr(flipkart, "fetch_invoice", lambda cookies, oid: _bundle(FEE, SHIP))
    with pytest.raises(AppError) as exc:  # fetched fine, but no requested card had a tax invoice
        service.build_invoices_zip(one, io.BytesIO())
    assert exc.value.code == "INVOICE_UNAVAILABLE"

    monkeypatch.setattr(config, "invoice_zip_max", 1)
    two = [{"orderId": oid, "accountIds": ["home"], "unitIds": ["U1"]} for oid in (OD1, OD2)]
    with pytest.raises(AppError) as exc:
        service.build_invoices_zip(two, io.BytesIO())
    assert exc.value.code == "CONFIG_ERROR"
