"""HTTP layer: CORS allow-list, admin-token rejection, multi-id DELETE, and account mutations.

The lifespan is never entered (no ``with TestClient``) and the poller is disabled anyway, so no
scheduler thread starts and nothing reaches Flipkart; storage is the isolated file backend.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app import main, poller, store
from app.config import config

THREE = '[{"label":"a","cookie":"SN=1"},{"label":"b","cookie":"SN=2"},{"label":"c","cookie":"SN=3"}]'


@pytest.fixture
def client(file_store, monkeypatch):
    monkeypatch.setattr(config, "poller_enabled", False)
    monkeypatch.setattr(config, "admin_token", "")
    return TestClient(main.app)


@pytest.fixture
def wakes(monkeypatch):
    """Counts poller wake-ups: every account mutation must trigger a roster resync."""
    calls: list[None] = []
    monkeypatch.setattr(poller.instance, "wake", lambda: calls.append(None))
    return calls


def _ids(res) -> list[str]:
    return sorted(m["id"] for m in res.json()["accounts"])


# ── CORS ─────────────────────────────────────────────────────────────────────


def test_cors_grants_only_the_local_ui_origins(client):
    store.import_accounts("acct", "SN=1")

    evil = client.get("/api/orders", headers={"Origin": "http://evil.example"})
    assert evil.status_code == 200  # CORS doesn't block the request; the browser withholds it
    assert "access-control-allow-origin" not in evil.headers

    ui = client.get("/api/orders", headers={"Origin": "http://localhost:3100"})
    assert ui.headers["access-control-allow-origin"] == "http://localhost:3100"
    assert "access-control-allow-credentials" not in ui.headers


@pytest.mark.parametrize(
    "path, body",
    [
        ("/api/accounts", '{"label":"x","cookie":"SN=9"}'),
        ("/api/accounts/import", '{"content":"SN=9"}'),
    ],
)
def test_cross_site_simple_post_cannot_add_accounts(client, path, body):
    # A foreign page can send a text/plain POST with no CORS preflight; it must not add an account.
    res = client.post(path, content=body, headers={"Content-Type": "text/plain", "Origin": "http://evil.example"})
    assert res.status_code == 400
    assert res.json()["error"]["code"] == "CONFIG_ERROR"
    assert store.list_accounts() == []


def test_cors_preflight_allows_ui_mutations_and_rejects_other_origins(client):
    preflight = {"Access-Control-Request-Method": "DELETE", "Access-Control-Request-Headers": "x-admin-token"}

    ok = client.options("/api/accounts", headers={"Origin": "http://127.0.0.1:3100", **preflight})
    assert ok.status_code == 200
    assert ok.headers["access-control-allow-origin"] == "http://127.0.0.1:3100"

    bad = client.options("/api/accounts", headers={"Origin": "http://evil.example", **preflight})
    assert bad.status_code == 400
    assert "access-control-allow-origin" not in bad.headers


# ── admin token ──────────────────────────────────────────────────────────────


@pytest.mark.parametrize("headers", [{}, {"x-admin-token": "wrong"}], ids=["missing", "wrong"])
def test_admin_token_rejects_mutations_with_unauthorized(client, monkeypatch, headers):
    store.import_accounts("keep", "SN=1")
    monkeypatch.setattr(config, "admin_token", "s3cret")

    attempts = [
        client.post("/api/accounts", json={"label": "x", "cookie": "SN=9"}, headers=headers),
        client.post("/api/accounts/import", json={"content": "SN=8"}, headers=headers),
        client.patch("/api/accounts", json={"ids": ["keep"], "active": False}, headers=headers),
        client.delete("/api/accounts", headers=headers),
    ]
    for res in attempts:
        assert res.status_code == 401
        assert res.json() == {"ok": False, "error": {"code": "UNAUTHORIZED", "message": "Admin token required."}}
    assert [(m["id"], m["active"]) for m in store.list_accounts()] == [("keep", True)]  # nothing changed

    allowed = client.post("/api/accounts", json={"label": "x", "cookie": "SN=9"}, headers={"x-admin-token": "s3cret"})
    assert allowed.status_code == 200 and _ids(allowed) == ["keep", "x"]


# ── DELETE /api/accounts ─────────────────────────────────────────────────────


def test_delete_with_repeated_ids_removes_exactly_those(client, wakes):
    store.import_accounts("f", THREE)
    res = client.delete("/api/accounts", params=[("id", "a"), ("id", "c")])
    assert res.status_code == 200 and _ids(res) == ["b"]
    assert [m["id"] for m in store.list_accounts()] == ["b"]
    assert len(wakes) == 1


def test_delete_single_id_then_no_id_clears_all(client, wakes):
    store.import_accounts("f", THREE)
    assert _ids(client.delete("/api/accounts", params={"id": "b"})) == ["a", "c"]
    assert client.delete("/api/accounts").json() == {"accounts": []}
    assert store.has_accounts() is False and len(wakes) == 2


def test_delete_with_empty_id_never_clears_all(client):
    store.import_accounts("f", THREE)
    res = client.delete("/api/accounts?id=")
    assert res.status_code == 200 and _ids(res) == ["a", "b", "c"]


# ── other mutations (run through the threadpool) ─────────────────────────────


def test_import_endpoint_persists_accounts(client, wakes):
    blob = '[{"label":"mom","cookie":"SN=1"},{"label":"dad","cookie":"SN=2"}]'
    res = client.post("/api/accounts/import", json={"label": "file", "content": blob})
    assert res.status_code == 200
    assert res.json()["imported"] == 2 and _ids(res) == ["dad", "mom"]
    assert [a["cookies"] for a in sorted(store.get_active_accounts(), key=lambda a: a["id"])] == [
        {"SN": "2"},
        {"SN": "1"},
    ]
    assert len(wakes) == 1


def test_import_endpoint_rejects_empty_content(client):
    res = client.post("/api/accounts/import", json={"content": "  "})
    assert res.status_code == 400 and res.json()["error"]["code"] == "CONFIG_ERROR"


def test_post_and_patch_accounts(client, wakes):
    assert _ids(client.post("/api/accounts", json={"label": "Home", "cookie": "SN=1"})) == ["home"]
    res = client.patch("/api/accounts", json={"ids": ["home"], "active": False})
    assert res.status_code == 200 and res.json()["accounts"][0]["active"] is False
    assert store.get_active_accounts() == [] and len(wakes) == 2
