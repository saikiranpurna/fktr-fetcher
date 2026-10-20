"""Background refresh loop that keeps a per-account order cache warm.

Why: serving /api/orders straight from cache decouples read latency from fetch cost, so the app
holds 1000+ accounts. A single scheduler thread selects accounts that are "due" (not fetched
within ``config.refresh_interval_s``, default 30 min) and hands them to a bounded worker pool
(``config.fetch_concurrency``). We therefore never spawn one thread per account, never fetch every
account on a request, and cap concurrent load on Flipkart. Reads are O(accounts) dict aggregation.

Throughput note: a full cycle takes ~ (accounts * seconds_per_account / concurrency). At ~50s per
account and concurrency 16, ~1000 accounts refresh in ~50 min; raise FETCH_CONCURRENCY to tighten
the cadence toward the 30-min target (watch Flipkart rate limits).
"""

from __future__ import annotations

import logging
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import datetime, timezone

from . import service, store
from .config import config
from .errors import AppError

log = logging.getLogger("poller")


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


@dataclass
class AccountCache:
    id: str
    label: str
    orders: list[dict] = field(default_factory=list)
    ok: bool = False
    pending: bool = True  # no successful/failed fetch recorded yet
    error: dict | None = None
    count: int = 0
    fetched_at: str | None = None  # ISO of last completed fetch
    fetched_monotonic: float | None = None  # scheduling clock; None = due on the next tick
    # Quality of the orders being served, from the last successful fetch (kept on failure, like
    # the orders): history truncated (a later page failed / deadline / page cap), and how many
    # per-shipment detail calls failed.
    partial: bool = False
    detail_failed: int = 0


class Poller:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._lifecycle = threading.Lock()
        self._stop = threading.Event()
        self._wake = threading.Event()
        self._roster_dirty = False
        self._roster: dict[str, dict] = {}  # id -> {"label", "cookies"}
        self._cache: dict[str, AccountCache] = {}
        self._inflight: set[str] = set()
        self._thread: threading.Thread | None = None
        self._executor: ThreadPoolExecutor | None = None

    # ── lifecycle ────────────────────────────────────────────────────────────

    def start(self) -> None:
        if not config.poller_enabled:
            log.info("poller disabled (POLLER_ENABLED=0)")
            return
        with self._lifecycle:
            if self._thread and self._thread.is_alive():
                return
            self._stop.clear()
            with self._lock:
                self._inflight.clear()  # drop any ids stranded by a prior stop() before re-scheduling
            self._executor = ThreadPoolExecutor(
                max_workers=config.fetch_concurrency, thread_name_prefix="fetch"
            )
            self._thread = threading.Thread(target=self._run, name="poller", daemon=True)
            self._thread.start()
            log.info(
                "poller started (interval=%ss, concurrency=%s)",
                config.refresh_interval_s,
                config.fetch_concurrency,
            )

    def stop(self) -> None:
        self._stop.set()
        self._wake.set()
        with self._lifecycle:
            t, ex = self._thread, self._executor
            self._thread, self._executor = None, None
        if t:
            t.join(timeout=5)
        if ex:
            ex.shutdown(wait=False, cancel_futures=True)

    def wake(self) -> None:
        """Force an immediate roster resync + scheduling pass (call after account mutations)."""
        self._roster_dirty = True
        self._wake.set()

    # ── scheduler ──────────────────────────────────────────────────────────────

    def _run(self) -> None:
        self._sync_roster()
        next_roster = time.monotonic() + config.roster_refresh_s
        while not self._stop.is_set():
            try:
                now = time.monotonic()
                if self._roster_dirty or now >= next_roster:
                    self._roster_dirty = False
                    self._sync_roster()
                    next_roster = time.monotonic() + config.roster_refresh_s
                self._submit_due()
            except Exception:  # never let the scheduler die
                log.exception("poller tick failed")
            self._wake.wait(config.poller_tick_s)
            self._wake.clear()

    def _sync_roster(self) -> None:
        try:
            accounts = store.get_active_accounts()  # [{id, label, cookies}]
        except Exception:
            log.exception("roster refresh failed")
            return
        with self._lock:
            seen: set[str] = set()
            for a in accounts:
                aid = a["id"]
                seen.add(aid)
                prev = self._roster.get(aid)
                self._roster[aid] = {"label": a["label"], "cookies": a["cookies"]}
                cached = self._cache.get(aid)
                if cached is None:
                    self._cache[aid] = AccountCache(id=aid, label=a["label"])
                else:
                    cached.label = a["label"]
                    if prev is not None and prev["cookies"] != a["cookies"]:
                        # A re-dropped (fresh) cookie: fetch on the next tick rather than after the
                        # refresh interval, so "Session expired" clears now, not up to 30 min later.
                        # The last orders stay on the board until that fetch lands.
                        cached.fetched_monotonic = None
            for gone in [aid for aid in self._roster if aid not in seen]:
                self._roster.pop(gone, None)
                self._cache.pop(gone, None)
                self._inflight.discard(gone)

    def _submit_due(self) -> None:
        now = time.monotonic()
        interval = config.refresh_interval_s
        with self._lock:
            due = [
                aid
                for aid, ac in self._cache.items()
                if aid not in self._inflight
                and (ac.fetched_monotonic is None or (now - ac.fetched_monotonic) >= interval)
            ]
            for aid in due:
                self._inflight.add(aid)
        for aid in due:
            ex = self._executor
            if ex is None:
                with self._lock:
                    self._inflight.discard(aid)
                continue
            try:
                ex.submit(self._fetch_one, aid)
            except RuntimeError:  # executor shutting down
                with self._lock:
                    self._inflight.discard(aid)

    def _fetch_one(self, aid: str) -> None:
        with self._lock:
            entry = self._roster.get(aid)
            label = entry["label"] if entry else aid
            cookies = entry["cookies"] if entry else None
        ok, error, orders = False, None, None
        partial, detail_failed = False, 0
        if not cookies:
            error = {"code": "CONFIG_ERROR", "message": "No cookies stored for this account."}
        else:
            try:
                orders, meta = service.fetch_account_orders(label, cookies)
                # The account id (not the label, which can be renamed) is what an invoice download
                # sends back to find this account's cookies.
                orders = [{**o, "accountId": aid} for o in orders]
                partial = bool(meta.get("partial", False))
                detail_failed = int(meta.get("detailFailed", 0) or 0)
                ok = True
            except AppError as e:
                error = {"code": e.code, "message": e.message}
            except Exception as e:  # noqa: BLE001
                error = {"code": "UNKNOWN", "message": str(e) or "Unexpected error while fetching."}
        with self._lock:
            ac = self._cache.get(aid)
            if ac is not None:
                ac.label = label
                ac.pending = False
                current = self._roster.get(aid)
                # The cookie was re-dropped while this fetch ran with the old one: stay due so the
                # new cookie is tried on the next tick instead of after a full refresh interval.
                stale = current is not None and current["cookies"] != cookies
                ac.fetched_monotonic = None if stale else time.monotonic()
                ac.fetched_at = _now_iso()
                if ok and orders is not None:
                    if partial and ac.orders:
                        # A partial fetch (a later page failed, the deadline or the page cap) only
                        # reached the newest orders: keep the older ones from earlier fetches rather
                        # than dropping them from the board until the next complete fetch.
                        reached = {o.get("orderId") for o in orders}
                        orders = orders + [
                            {**o, "account": label, "accountId": aid}
                            for o in ac.orders
                            if o.get("orderId") not in reached
                        ]
                    ac.orders = orders
                    ac.count = len(orders)
                    ac.ok = True
                    ac.error = None
                    ac.partial = partial
                    ac.detail_failed = detail_failed
                else:
                    # Keep the last good orders (a transient failure shouldn't blank the board).
                    ac.ok = False
                    ac.error = error
            self._inflight.discard(aid)

    # ── reads ────────────────────────────────────────────────────────────────

    def _coverage_locked(self) -> dict:
        total = len(self._cache)
        ok = fail = pending = 0
        fetched_ats: list[str] = []
        for ac in self._cache.values():
            if ac.pending:
                pending += 1
            elif ac.ok:
                ok += 1
            else:
                fail += 1
            if ac.fetched_at:
                fetched_ats.append(ac.fetched_at)
        return {
            "total": total,
            "fetched": total - pending,
            "pending": pending,
            "ok": ok,
            "failed": fail,
            "inFlight": len(self._inflight),
            "oldestFetchedAt": min(fetched_ats) if fetched_ats else None,
            "newestFetchedAt": max(fetched_ats) if fetched_ats else None,
            "intervalSeconds": config.refresh_interval_s,
        }

    def stats(self) -> dict:
        with self._lock:
            return self._coverage_locked()

    def snapshot(self) -> dict:
        with self._lock:
            orders: list[dict] = []
            accounts: list[dict] = []
            for ac in self._cache.values():
                orders.extend(ac.orders)
                res: dict = {"id": ac.id, "label": ac.label, "ok": ac.ok, "count": ac.count}
                if ac.pending:
                    res["pending"] = True
                else:
                    # Describes the orders served for this account (the last good fetch's).
                    res["partial"] = ac.partial
                    res["detailFailed"] = ac.detail_failed
                if ac.fetched_at:
                    res["fetchedAt"] = ac.fetched_at
                if ac.error and not ac.ok:
                    res["error"] = ac.error
                accounts.append(res)
            coverage = self._coverage_locked()
        return {"orders": orders, "accounts": accounts, "coverage": coverage}

    def roster_size(self) -> int:
        with self._lock:
            return len(self._roster)

    def order_rows(self, account_id: str, order_id: str) -> list[dict]:
        """The cached rows of one order for one account (its shipments: unitId, fsn, trackingId),
        which pair an invoice bundle's tax invoices with shipments. [] when not cached."""
        with self._lock:
            ac = self._cache.get(account_id)
            return [o for o in ac.orders if o.get("orderId") == order_id] if ac else []

    def cookies_for(self, account_id: str) -> dict | None:
        """An active account's cookies from the in-memory roster (no storage scan), or None for an
        unknown / paused / removed account."""
        with self._lock:
            entry = self._roster.get(account_id)
            return entry["cookies"] if entry else None


instance = Poller()
