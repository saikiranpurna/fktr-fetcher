"""HTTP layer: CORS allow-list, admin-token rejection, multi-id DELETE, account mutations, and the
invoice download routes.

The lifespan is never entered (no ``with TestClient``) and the poller is disabled anyway, so no
scheduler thread starts and nothing reaches Flipkart; storage is the isolated file backend.
"""

from __future__ import annotations

import io
import json
import zipfile

import pytest
from fastapi.testclient import TestClient

from app import main, poller, service, store
from app.config import config
from app.errors import auth_expired, invoice_unavailable

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


# ── invoices ─────────────────────────────────────────────────────────────────

CARD = {"accountId": "home", "orderId": "OD123456789", "unitId": "338851321797274100012"}
ONE_ORDER = {"orders": [{"orderId": "OD123456789", "accountIds": ["home"], "unitIds": ["338851321797274100012"]}]}
XHR = {"X-Requested-With": "fktr"}  # what the UI sends; forces a CORS preflight cross-origin


def test_orders_response_tells_the_ui_the_invoice_zip_cap(client, monkeypatch):
    store.import_accounts("acct", "SN=1")
    monkeypatch.setattr(config, "invoice_zip_max", 7)
    assert client.get("/api/orders").json()["invoiceZipMax"] == 7


def test_invoice_route_serves_the_cards_pdf_and_validates_ids(client, monkeypatch):
    seen: list = []

    def fake(aid, oid, uid):
        seen.append((aid, oid, uid))
        return b"%PDF-1.4 fabricated", "FMPP0000000001"

    monkeypatch.setattr(service, "fetch_invoice", fake)
    res = client.get("/api/invoice", params=CARD, headers=XHR)
    assert res.status_code == 200 and res.content.startswith(b"%PDF-")
    assert seen == [("home", "OD123456789", "338851321797274100012")]
    assert res.headers["content-type"] == "application/pdf"
    assert res.headers["content-disposition"] == 'attachment; filename="invoice-OD123456789-FMPP0000000001.pdf"'
    assert res.headers["cache-control"] == "no-store"

    # Ids land in the filename header: anything but plain order / account / unit ids is refused.
    for params in (
        {**CARD, "orderId": 'OD1"; evil'},
        {**CARD, "accountId": "../x"},
        {**CARD, "unitId": "u 1"},
        {"accountId": "home", "orderId": "OD123456789"},  # no unit: a card, not an order
    ):
        bad = client.get("/api/invoice", params=params, headers=XHR)
        assert bad.status_code == 400 and bad.json()["error"]["code"] == "CONFIG_ERROR"


def test_invoice_route_refuses_a_plain_cross_site_get(client, monkeypatch):
    # A foreign page's <img src="http://localhost:8000/api/invoice?..."> sends no custom header; it
    # must not trigger a live Flipkart call with the owner's session.
    called: list = []
    monkeypatch.setattr(service, "fetch_invoice", lambda *a: called.append(a))
    res = client.get("/api/invoice", params=CARD)
    assert res.status_code == 400 and res.json()["error"]["code"] == "CONFIG_ERROR"
    assert called == []
    # The UI's origin may send the header (the preflight is allowed); others get no CORS grant.
    ok = client.options(
        "/api/invoice",
        headers={"Origin": "http://localhost:3100", "Access-Control-Request-Method": "GET",
                 "Access-Control-Request-Headers": "x-requested-with"},
    )
    assert ok.status_code == 200 and ok.headers["access-control-allow-origin"] == "http://localhost:3100"
    evil = client.options(
        "/api/invoice",
        headers={"Origin": "http://evil.example", "Access-Control-Request-Method": "GET",
                 "Access-Control-Request-Headers": "x-requested-with"},
    )
    assert "access-control-allow-origin" not in evil.headers


def test_invoice_route_maps_service_errors(client, monkeypatch):
    def unavailable(aid, oid, uid):
        raise invoice_unavailable("No tax invoice for this shipment yet.")

    monkeypatch.setattr(service, "fetch_invoice", unavailable)
    res = client.get("/api/invoice", params=CARD, headers=XHR)
    assert res.status_code == 404 and res.json()["error"]["code"] == "INVOICE_UNAVAILABLE"


def test_invoice_zip_route_streams_the_zip_with_counts(client, monkeypatch):
    def fake(orders, dest):
        assert orders == ONE_ORDER["orders"]
        with zipfile.ZipFile(dest, "w") as zf:
            zf.writestr("OD123456789/FMPP0000000001.pdf", b"%PDF-1.4 fabricated")
        return {"files": 1, "missing": 0}

    monkeypatch.setattr(service, "build_invoices_zip", fake)
    res = client.post("/api/invoices/zip", json=ONE_ORDER, headers={"Origin": "http://localhost:3100"})
    assert res.status_code == 200 and res.headers["content-type"] == "application/zip"
    assert zipfile.ZipFile(io.BytesIO(res.content)).namelist() == ["OD123456789/FMPP0000000001.pdf"]
    assert res.headers["x-invoice-files"] == "1" and res.headers["x-invoice-missing"] == "0"
    assert "x-invoice-files" in res.headers["access-control-expose-headers"].lower()


def test_invoice_zip_route_rejects_bad_bodies_and_cross_site_simple_posts(client, monkeypatch):
    called: list = []
    monkeypatch.setattr(service, "build_invoices_zip", lambda *a: called.append(a))
    simple = client.post("/api/invoices/zip", content=json.dumps(ONE_ORDER), headers={"Content-Type": "text/plain"})
    assert simple.status_code == 400
    good = ONE_ORDER["orders"][0]
    for body in (
        {"orders": []},
        {"orders": [{**good, "orderId": "nope"}]},
        {"orders": [{**good, "unitIds": []}]},
        {"orders": [{**good, "accountIds": ["../x"]}]},
        {"items": [{"accountId": "home", "orderId": "OD123456789"}]},  # the old shape
    ):
        assert client.post("/api/invoices/zip", json=body).status_code == 400
    assert called == []


def test_invoice_zip_route_returns_the_error_when_nothing_could_be_saved(client, monkeypatch):
    def expired(orders, dest):
        raise auth_expired()

    monkeypatch.setattr(service, "build_invoices_zip", expired)
    res = client.post("/api/invoices/zip", json=ONE_ORDER)
    assert res.status_code == 401 and res.json()["error"]["code"] == "AUTH_EXPIRED"
