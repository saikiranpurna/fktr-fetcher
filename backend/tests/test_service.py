"""service.py: detail-call targeting (active -> history window -> address) and the per-unit
detailStatus that keeps "no data" distinguishable from "fetch failed / not attempted"."""

from __future__ import annotations

import json
import time
from pathlib import Path

import pytest

from app import flipkart, service
from app.config import config
from app.errors import upstream

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
