"""flipkart.py contract: page 1 must succeed, later pages are best-effort (partial=True instead of a
silent truncation), detail calls RAISE instead of returning {}, and failures log the upstream body."""

from __future__ import annotations

import logging
import time

import pytest

from app import flipkart
from app.errors import AppError


class _FakeRes:
    def __init__(self, n: int, status: int = 200, more: bool = True, body: bytes = b""):
        self._n = n
        self.status = status
        self._more = more
        self.body = body

    def json(self):
        return {
            "RESPONSE": {
                "multipleOrderDetailsView": {
                    "orders": [{"orderMetaData": {"orderId": f"O{self._n}"}}],
                    "moreOrder": self._more,
                    "nextCallParams": [{"key": "ot", "value": "t"}],
                }
            }
        }


@pytest.fixture
def pages(monkeypatch):
    """Serve scripted list pages: each item is a status code (200 = page with one order) or an
    Exception instance to raise for that request."""
    script: list = []
    calls = {"n": 0}

    def fake_get(url, cookies):
        calls["n"] += 1
        step = script[calls["n"] - 1] if calls["n"] <= len(script) else 200
        if isinstance(step, Exception):
            raise step
        return _FakeRes(calls["n"], status=step, more=calls["n"] < len(script),
                        body=b'{"serverErrorMessage":"Please try again later"}' if step != 200 else b"")

    monkeypatch.setattr(flipkart, "_get", fake_get)
    monkeypatch.setattr(flipkart, "ensure_orders_shape", lambda body: None)
    return script, calls


def test_fetch_orders_stops_after_page1_when_deadline_passed(pages):
    script, calls = pages
    script.extend([200, 200, 200])
    out, partial = flipkart.fetch_orders({"SN": "1"}, deadline=time.monotonic() - 1)
    # i=0 fetches page 1; i=1 sees the passed deadline and stops before another request.
    assert calls["n"] == 1
    assert len(out) == 1
    assert partial is True


def test_fetch_orders_complete_history_is_not_partial(pages):
    script, _ = pages
    script.extend([200, 200])
    out, partial = flipkart.fetch_orders({"SN": "1"})
    assert [o["orderMetaData"]["orderId"] for o in out] == ["O1", "O2"]
    assert partial is False


def test_later_page_http_error_keeps_earlier_orders_and_logs_body(pages, caplog):
    script, _ = pages
    script.extend([200, 500, 200])
    with caplog.at_level(logging.WARNING, logger="flipkart"):
        out, partial = flipkart.fetch_orders({"SN": "1"})
    assert [o["orderMetaData"]["orderId"] for o in out] == ["O1"]
    assert partial is True
    assert "HTTP 500" in caplog.text and "Please try again later" in caplog.text


def test_later_page_network_error_is_partial_not_fatal(pages):
    script, _ = pages
    script.extend([200, TimeoutError("read timed out")])
    out, partial = flipkart.fetch_orders({"SN": "1"})
    assert len(out) == 1 and partial is True


def test_first_page_failure_raises_upstream(pages):
    script, _ = pages
    script.append(503)
    with pytest.raises(AppError) as exc:
        flipkart.fetch_orders({"SN": "1"})
    assert exc.value.code == "UPSTREAM_ERROR"


def test_first_page_auth_rejection_raises_auth_expired(pages):
    script, _ = pages
    script.append(401)
    with pytest.raises(AppError) as exc:
        flipkart.fetch_orders({"SN": "1"})
    assert exc.value.code == "AUTH_EXPIRED"


class _DetailRes:
    def __init__(self, status: int, body: bytes, payload=None):
        self.status = status
        self.body = body
        self._payload = payload

    def json(self):
        if self._payload is None:
            raise ValueError("not json")
        return self._payload


def test_fetch_detail_raw_raises_on_http_error_and_logs_the_body(monkeypatch, caplog):
    monkeypatch.setattr(flipkart.Fetcher, "post", lambda *a, **k: _DetailRes(500, b'{"ERROR_MESSAGE":"Something went wrong"}'))
    with caplog.at_level(logging.WARNING, logger="flipkart"), pytest.raises(AppError) as exc:
        flipkart.fetch_detail_raw({"SN": "1"}, "OD1", "U1")
    assert exc.value.code == "UPSTREAM_ERROR"
    assert "HTTP 500" in caplog.text and "Something went wrong" in caplog.text
    assert "SN" not in caplog.text  # cookies never reach the logs


def test_fetch_detail_raw_raises_on_network_error(monkeypatch):
    def boom(*a, **k):
        raise ConnectionError("reset")

    monkeypatch.setattr(flipkart.Fetcher, "post", boom)
    with pytest.raises(AppError) as exc:
        flipkart.fetch_detail_raw({"SN": "1"}, "OD1", "U1")
    assert exc.value.code == "UPSTREAM_ERROR"


def test_fetch_detail_raw_returns_raw_json(monkeypatch):
    monkeypatch.setattr(flipkart.Fetcher, "post", lambda *a, **k: _DetailRes(200, b"{}", {"RESPONSE": {"slots": []}}))
    assert flipkart.fetch_detail_raw({"SN": "1"}, "OD1", "U1") == {"RESPONSE": {"slots": []}}


class _HtmlRes(_FakeRes):
    def json(self):
        raise ValueError("Expecting value: line 1 column 1")


def test_non_json_later_page_is_partial_not_fatal(monkeypatch):
    calls = {"n": 0}

    def fake_get(url, cookies):
        calls["n"] += 1
        return _FakeRes(1) if calls["n"] == 1 else _HtmlRes(2, body=b"<html>Please wait</html>")

    monkeypatch.setattr(flipkart, "_get", fake_get)
    monkeypatch.setattr(flipkart, "ensure_orders_shape", lambda body: None)
    out, partial = flipkart.fetch_orders({"SN": "1"})
    assert len(out) == 1 and partial is True


def test_non_json_first_page_is_a_parse_error(monkeypatch):
    monkeypatch.setattr(flipkart, "_get", lambda url, cookies: _HtmlRes(1, body=b"<html>Login</html>"))
    with pytest.raises(AppError) as exc:
        flipkart.fetch_orders({"SN": "1"})
    assert exc.value.code == "PARSE_ERROR"
