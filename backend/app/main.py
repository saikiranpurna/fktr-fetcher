"""FastAPI app serving the exact /api contract the Next.js frontend expects."""

from __future__ import annotations

from contextlib import asynccontextmanager
import json
from datetime import datetime, timezone

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import JSONResponse

from . import poller, service, store
from .config import config
from .errors import AppError, config_error, to_error_response

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Start/stop the background refresh loop with the app so the order cache stays warm.
    poller.instance.start()
    try:
        yield
    finally:
        poller.instance.stop()


app = FastAPI(title="Flipkart Delivery Tracker API", lifespan=lifespan)

# Frontend normally reaches us via the Next.js proxy (same-origin), but allow direct
# browser calls too (e.g. during development) without CORS friction.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)
# The /api/orders payload aggregates every account's orders and is polled ~60s; gzip it (JSON
# with repeated keys/labels compresses heavily) so 1000-account responses stay cheap on the wire.
app.add_middleware(GZipMiddleware, minimum_size=1024)


def _admin_denied(request: Request) -> JSONResponse | None:
    if not config.admin_token:
        return None
    if request.headers.get("x-admin-token") == config.admin_token:
        return None
    return JSONResponse(
        {"ok": False, "error": {"code": "AUTH_EXPIRED", "message": "Admin token required."}},
        status_code=401,
    )


@app.get("/api/health")
def health() -> dict:
    # roster_size()/stats() read the poller's in-memory state — no per-account storage scan.
    return {"ok": True, "accounts": poller.instance.roster_size(), "poller": poller.instance.stats()}


@app.get("/api/orders")
def get_orders() -> JSONResponse:
    try:
        orders, accounts, coverage = service.get_delivery_orders()
        return JSONResponse({
            "ok": True,
            "orders": orders,
            "accounts": accounts,
            "coverage": coverage,
            "fetchedAt": datetime.now(timezone.utc).isoformat(),
            "timezone": config.timezone,
        })
    except Exception as err:  # noqa: BLE001 - mapped to the shared error contract
        body, status = to_error_response(err)
        return JSONResponse(body, status_code=status)


@app.get("/api/accounts")
def get_accounts() -> dict:
    return {"accounts": store.list_accounts()}


@app.post("/api/accounts", response_model=None)
async def post_account(request: Request) -> JSONResponse | dict:
    denied = _admin_denied(request)
    if denied:
        return denied
    try:
        body = await request.json()
    except Exception:
        body = None
    label = body.get("label") if isinstance(body, dict) else None
    cookie = body.get("cookie") if isinstance(body, dict) else None
    if not isinstance(cookie, str) or not cookie.strip():
        b, s = to_error_response(config_error("Request body must include a non-empty 'cookie' string."))
        return JSONResponse(b, status_code=s)
    try:
        accounts = store.add_account(label if isinstance(label, str) else "", cookie)
        poller.instance.wake()
        return {"accounts": accounts}
    except Exception as err:  # noqa: BLE001
        b, s = to_error_response(err)
        return JSONResponse(b, status_code=s)


_MAX_IMPORT_BYTES = 2 * 1024 * 1024  # 2 MB cap on an uploaded cookie blob (upload validation)


@app.post("/api/accounts/import", response_model=None)
async def import_accounts(request: Request) -> JSONResponse | dict:
    """Import one blob into one or many accounts (.json/.txt, single or multi-account)."""
    denied = _admin_denied(request)
    if denied:
        return denied
    raw = await request.body()
    if len(raw) > _MAX_IMPORT_BYTES:
        b, s = to_error_response(config_error("Upload too large (max 2 MB per file)."))
        return JSONResponse(b, status_code=s)
    try:
        body = json.loads(raw) if raw else None
    except Exception:
        body = None
    content = body.get("content") if isinstance(body, dict) else None
    label = body.get("label") if isinstance(body, dict) else None
    if not isinstance(content, str) or not content.strip():
        b, s = to_error_response(config_error("Request body must include a non-empty 'content' string."))
        return JSONResponse(b, status_code=s)
    try:
        imported, accounts = store.import_accounts(label if isinstance(label, str) else "", content)
        poller.instance.wake()
        return {"accounts": accounts, "imported": imported}
    except Exception as err:  # noqa: BLE001
        b, s = to_error_response(err)
        return JSONResponse(b, status_code=s)


@app.delete("/api/accounts", response_model=None)
def delete_account(request: Request, id: str | None = None) -> JSONResponse | dict:
    denied = _admin_denied(request)
    if denied:
        return denied
    accounts = store.remove_account(id) if id else store.clear_all()
    poller.instance.wake()
    return {"accounts": accounts}


@app.patch("/api/accounts", response_model=None)
async def patch_accounts(request: Request) -> JSONResponse | dict:
    """Activate/deactivate a set of accounts. Body: {ids: string[], active: bool}."""
    denied = _admin_denied(request)
    if denied:
        return denied
    try:
        body = await request.json()
    except Exception:
        body = None
    ids = body.get("ids") if isinstance(body, dict) else None
    active = body.get("active") if isinstance(body, dict) else None
    if not isinstance(ids, list) or not all(isinstance(i, str) for i in ids) or not ids:
        b, s = to_error_response(config_error("Request body must include a non-empty 'ids' string array."))
        return JSONResponse(b, status_code=s)
    if not isinstance(active, bool):
        b, s = to_error_response(config_error("Request body must include a boolean 'active'."))
        return JSONResponse(b, status_code=s)
    accounts = store.set_active(ids, active)
    poller.instance.wake()
    return {"accounts": accounts}
