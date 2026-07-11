"""Background poller: roster sync/prune, cache population, error isolation, due-scheduling.

Internals are driven directly (no scheduler thread, no network) by stubbing the roster source
and the per-account fetch, so the tests are deterministic.
"""

from __future__ import annotations

import time

import pytest

from app import poller as poller_mod
from app import service, store
from app.config import config
from app.errors import AppError


class FakeExecutor:
    """Records submissions without running them (keeps ids 'in flight' for scheduling tests)."""

    def __init__(self):
        self.calls: list[tuple] = []

    def submit(self, fn, *args):
        self.calls.append(args)
        return None


@pytest.fixture
def p(monkeypatch):
    monkeypatch.setattr(config, "refresh_interval_s", 1800.0)
    return poller_mod.Poller()


def test_sync_roster_tracks_new_and_prunes_removed(p, monkeypatch):
    roster = [
        {"id": "a", "label": "A", "cookies": {"SN": "1"}},
        {"id": "b", "label": "B", "cookies": {"SN": "2"}},
    ]
    monkeypatch.setattr(store, "get_active_accounts", lambda: roster)
    p._sync_roster()
    assert p.roster_size() == 2
    assert {ac.id for ac in p._cache.values()} == {"a", "b"}
    assert all(ac.pending for ac in p._cache.values())  # nothing fetched yet

    roster.pop()  # drop "b"
    p._sync_roster()
    assert p.roster_size() == 1 and "b" not in p._cache


def test_fetch_one_populates_cache_and_coverage(p, monkeypatch):
    monkeypatch.setattr(store, "get_active_accounts", lambda: [{"id": "a", "label": "Home", "cookies": {"SN": "1"}}])
    monkeypatch.setattr(service, "fetch_account_orders", lambda label, cookies: [{"orderId": "O1", "account": label}])
    p._sync_roster()
    p._fetch_one("a")

    snap = p.snapshot()
    assert snap["orders"] == [{"orderId": "O1", "account": "Home"}]
    acct = snap["accounts"][0]
    assert acct["ok"] is True and acct["count"] == 1 and "pending" not in acct
    cov = snap["coverage"]
    assert (cov["total"], cov["ok"], cov["failed"], cov["pending"]) == (1, 1, 0, 0)


def test_failing_account_is_flagged_without_blanking_others(p, monkeypatch):
    monkeypatch.setattr(store, "get_active_accounts", lambda: [
        {"id": "good", "label": "Good", "cookies": {"SN": "1"}},
        {"id": "bad", "label": "Bad", "cookies": {"SN": "2"}},
    ])

    def fake(label, cookies):
        if label == "Bad":
            raise AppError("AUTH_EXPIRED", "session expired")
        return [{"orderId": "O1", "account": label}]

    monkeypatch.setattr(service, "fetch_account_orders", fake)
    p._sync_roster()
    p._fetch_one("good")
    p._fetch_one("bad")

    snap = p.snapshot()
    by = {a["id"]: a for a in snap["accounts"]}
    assert by["good"]["ok"] is True
    assert by["bad"]["ok"] is False and by["bad"]["error"]["code"] == "AUTH_EXPIRED"
    assert len(snap["orders"]) == 1  # the good account still contributes its orders
    assert (snap["coverage"]["ok"], snap["coverage"]["failed"]) == (1, 1)


def test_transient_error_keeps_last_good_orders(p, monkeypatch):
    state = {"fail": False}
    monkeypatch.setattr(store, "get_active_accounts", lambda: [{"id": "a", "label": "A", "cookies": {"SN": "1"}}])

    def fake(label, cookies):
        if state["fail"]:
            raise AppError("UPSTREAM_ERROR", "timeout")
        return [{"orderId": "O1", "account": label}]

    monkeypatch.setattr(service, "fetch_account_orders", fake)
    p._sync_roster()
    p._fetch_one("a")            # good
    state["fail"] = True
    p._fetch_one("a")            # transient failure

    snap = p.snapshot()
    assert snap["accounts"][0]["ok"] is False        # flagged
    assert len(snap["orders"]) == 1                  # but stale orders retained


def test_due_scheduling_respects_interval(p, monkeypatch):
    monkeypatch.setattr(store, "get_active_accounts", lambda: [{"id": "a", "label": "A", "cookies": {"SN": "1"}}])
    monkeypatch.setattr(service, "fetch_account_orders", lambda label, cookies: [])
    fake = FakeExecutor()
    p._executor = fake

    p._sync_roster()
    p._submit_due()                       # never fetched -> due
    assert fake.calls == [("a",)]

    p._fetch_one("a")                     # completes; clears in-flight, stamps fetched time
    fake.calls.clear()
    p._submit_due()                       # fetched < interval ago -> not due
    assert fake.calls == []

    p._cache["a"].fetched_monotonic = time.monotonic() - 2000  # older than 1800s interval
    p._submit_due()
    assert fake.calls == [("a",)]


def test_scales_to_1000_accounts_reads_instant_concurrency_bounded(monkeypatch, tmp_path):
    """The whole point of the poller: 1000 accounts refresh under a bounded pool while reads
    (snapshot) stay instant. Uses a stubbed fetch (no network), so it's deterministic."""
    import json
    import threading

    from app import storage

    monkeypatch.setattr(config, "storage_backend", "file")
    monkeypatch.setattr(config, "session_store_path", str(tmp_path / "s.json"))
    monkeypatch.setattr(config, "fetch_concurrency", 16)
    monkeypatch.setattr(config, "refresh_interval_s", 3600.0)
    monkeypatch.setattr(config, "roster_refresh_s", 3600.0)
    monkeypatch.setattr(config, "poller_tick_s", 1.0)
    monkeypatch.setattr(config, "poller_enabled", True)
    storage.reset_backend()

    entries = [{"label": f"acct{i}", "cookie": f"SN=v{i}"} for i in range(1000)]
    store.import_accounts("batch", json.dumps(entries))
    assert store.has_accounts()

    live = {"n": 0, "max": 0}
    lock = threading.Lock()

    def fake_fetch(label, cookies):
        with lock:
            live["n"] += 1
            live["max"] = max(live["max"], live["n"])
        time.sleep(0.002)
        with lock:
            live["n"] -= 1
        return [{"orderId": label, "account": label}]

    monkeypatch.setattr(service, "fetch_account_orders", fake_fetch)

    p = poller_mod.Poller()
    p.start()
    try:
        # reads serve the cache instantly even while 1000 accounts churn in the background
        t0 = time.perf_counter()
        p.snapshot()
        assert time.perf_counter() - t0 < 0.25

        deadline = time.time() + 30
        while time.time() < deadline:
            st = p.stats()
            if st["total"] == 1000 and st["pending"] == 0:
                break
            time.sleep(0.05)
        st = p.stats()
        assert st["total"] == 1000 and st["pending"] == 0 and st["ok"] == 1000
    finally:
        p.stop()
        storage.reset_backend()

    # concurrency never exceeded the configured bound (no thread-per-account explosion)
    assert live["max"] <= 16
