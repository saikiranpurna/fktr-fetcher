"""FastAPI app serving the exact /api contract the Next.js frontend expects."""

from __future__ import annotations

from datetime import datetime, timezone

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from . import service, store
from .config import config
from .errors import AppError, config_error, to_error_response

app = FastAPI(title="Flipkart Delivery Tracker API")

# Frontend normally reaches us via the Next.js proxy (same-origin), but allow direct
# browser calls too (e.g. during development) without CORS friction.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


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
    return {"ok": True, "accounts": len(store.list_accounts())}


@app.get("/api/orders")
def get_orders() -> JSONResponse:
    try:
        orders, accounts = service.get_delivery_orders()
        return JSONResponse({
            "ok": True,
            "orders": orders,
            "accounts": accounts,
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
        return {"accounts": accounts}
    except Exception as err:  # noqa: BLE001
        b, s = to_error_response(err)
        return JSONResponse(b, status_code=s)


@app.delete("/api/accounts", response_model=None)
def delete_account(request: Request, id: str | None = None) -> JSONResponse | dict:
    denied = _admin_denied(request)
    if denied:
        return denied
    accounts = store.remove_account(id) if id else store.clear_all()
    return {"accounts": accounts}
