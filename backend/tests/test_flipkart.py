"""flipkart.fetch_orders per-account deadline: page 1 is always fetched, then it stops early."""

from __future__ import annotations

import time

from app import flipkart


class _FakeRes:
    status = 200

    def __init__(self, n: int):
        self._n = n

    def json(self):
        # Always claims there's another page, so only the deadline stops pagination.
        return {
            "RESPONSE": {
                "multipleOrderDetailsView": {
                    "orders": [{"orderMetaData": {"orderId": f"O{self._n}"}}],
                    "moreOrder": True,
                    "nextCallParams": [{"key": "ot", "value": "t"}],
                }
            }
        }


def test_fetch_orders_stops_after_page1_when_deadline_passed(monkeypatch):
    calls = {"n": 0}

    def fake_get(url, cookies):
        calls["n"] += 1
        return _FakeRes(calls["n"])

    monkeypatch.setattr(flipkart, "_get", fake_get)
    monkeypatch.setattr(flipkart, "ensure_orders_shape", lambda body: None)

    out = flipkart.fetch_orders({"SN": "1"}, deadline=time.monotonic() - 1)
    # i=0 fetches page 1; i=1 sees the passed deadline and breaks before another request.
    assert calls["n"] == 1
    assert len(out) == 1
