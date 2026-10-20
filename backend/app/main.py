"""FastAPI app serving the exact /api contract the Next.js frontend expects."""

from __future__ import annotations

from contextlib import asynccontextmanager
import json
import re
import tempfile
from datetime import datetime, timezone

from fastapi import FastAPI, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import JSONResponse, Response, StreamingResponse
from starlette.concurrency import run_in_threadpool

from . import poller, service, store
from .config import config
from .errors import config_error, to_error_response, unauthorized

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Start/stop the background refresh loop with the app so the order cache stays warm.
    poller.instance.start()
    try:
        yield
    finally:
        poller.instance.stop()


app = FastAPI(title="Flipkart Delivery Tracker API", lifespan=lifespan)

# The browser calls the API directly from the local UI (NEXT_PUBLIC_BACKEND_URL), so that origin
# needs a CORS grant. Responses carry customer PII and live OTPs, so ONLY the configured local UI
# origins (CORS_ORIGINS) get one: a page from any other site the user has open can't read them.
# No credentials: the API uses no cookies (admin auth is the x-admin-token header).
app.add_middleware(
    CORSMiddleware,
    allow_origins=config.cors_origins,
    allow_methods=["*"],
    allow_headers=["*"],
    # The invoice ZIP reports how many invoices made it in; cross-origin JS can't read other headers.
    expose_headers=["Content-Disposition", "X-Invoice-Files", "X-Invoice-Missing"],
)
# The /api/orders payload aggregates every account's orders and is polled ~60s; gzip it (JSON
# with repeated keys/labels compresses heavily) so 1000-account responses stay cheap on the wire.
app.add_middleware(GZipMiddleware, minimum_size=1024)


def _admin_denied(request: Request) -> JSONResponse | None:
    if not config.admin_token:
        return None
    if request.headers.get("x-admin-token") == config.admin_token:
        return None
    # UNAUTHORIZED, not AUTH_EXPIRED: AUTH_EXPIRED means a Flipkart session expired, which would
    # send the user off to replace a cookie that is fine.
    body, status = to_error_response(unauthorized("Admin token required."))
    return JSONResponse(body, status_code=status)


def _json_required(request: Request) -> JSONResponse | None:
    """Reject state-changing requests whose body isn't declared JSON. A page from any other site can
    send a `text/plain` POST to localhost WITHOUT a CORS preflight (a "simple" request), so the
    origin allow-list alone wouldn't stop it from adding accounts. Requiring application/json forces
    the browser to preflight, which CORS_ORIGINS then refuses for foreign origins."""
    ctype = request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
    if ctype == "application/json":
        return None
    body, status = to_error_response(config_error("Content-Type must be application/json."))
    return JSONResponse(body, status_code=status)


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
            "invoiceZipMax": config.invoice_zip_max,
        })
    except Exception as err:  # noqa: BLE001 - mapped to the shared error contract
        body, status = to_error_response(err)
        return JSONResponse(body, status_code=status)


# Flipkart order ids ("OD" + digits), account ids (label slugs) and unit ids. They end up in a
# Content-Disposition filename or a ZIP entry name, so anything else is refused up front.
_ORDER_ID = re.compile(r"^OD[0-9]{6,30}$")
_ACCOUNT_ID = re.compile(r"^[A-Za-z0-9_-]{1,100}$")
_UNIT_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
_MAX_ZIP_REQUEST_BYTES = 512 * 1024  # INVOICE_ZIP_MAX orders of a few dozen units each, with room
_ZIP_SPOOL_BYTES = 32 * 1024 * 1024  # bulk ZIPs bigger than this spill from memory to a temp file


def _bad_request(message: str) -> JSONResponse:
    body, status = to_error_response(config_error(message))
    return JSONResponse(body, status_code=status)


def _script_required(request: Request) -> JSONResponse | None:
    """Reject a GET that a page from another site could fire without a CORS preflight (an <img>
    or link to localhost). Requiring a custom header forces the browser to preflight, which
    CORS_ORIGINS refuses for foreign origins: unlike /api/orders, the invoice route makes a live
    Flipkart call with the owner's session. Scripts and curl just send the header."""
    if request.headers.get("x-requested-with"):
        return None
    return _bad_request("Missing X-Requested-With header.")


@app.get("/api/invoice", response_model=None)
def get_invoice(
    request: Request,
    account_id: str = Query("", alias="accountId"),
    order_id: str = Query("", alias="orderId"),
    unit_id: str = Query("", alias="unitId"),
) -> Response:
    """One card's tax invoice (a PDF), picked out of the order's invoice bundle. Unlike /api/orders
    this calls Flipkart on request (sync handler, so it runs off the event loop)."""
    denied = _script_required(request)
    if denied:
        return denied
    if not (_ACCOUNT_ID.match(account_id) and _ORDER_ID.match(order_id) and _UNIT_ID.match(unit_id)):
        return _bad_request("Query must include a valid 'accountId', 'orderId' and 'unitId'.")
    try:
        pdf, tracking = service.fetch_invoice(account_id, order_id, unit_id)
    except Exception as err:  # noqa: BLE001 - mapped to the shared error contract
        body, status = to_error_response(err)
        return JSONResponse(body, status_code=status)
    shipment = re.sub(r"[^A-Za-z0-9_-]", "", tracking) or unit_id
    return Response(
        pdf,
        media_type="application/pdf",
        headers={
            "Content-Disposition": f'attachment; filename="invoice-{order_id}-{shipment}.pdf"',
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
        },
    )


def _valid_ids(values: object, pattern: re.Pattern) -> bool:
    return isinstance(values, list) and bool(values) and all(isinstance(v, str) and pattern.match(v) for v in values)


@app.post("/api/invoices/zip", response_model=None)
async def post_invoices_zip(request: Request) -> Response:
    """The tax invoices of the filtered cards in ONE ZIP. Body: {orders: [{orderId, accountIds,
    unitIds}]}: each order's bundle is fetched once, through the first of its accounts that can.
    JSON-only like the account mutations: a cross-site "simple" POST must not be able to fire
    Flipkart calls with the owner's sessions."""
    denied = _json_required(request)
    if denied:
        return denied
    raw = await request.body()
    if len(raw) > _MAX_ZIP_REQUEST_BYTES:
        return _bad_request("Request too large.")
    try:
        body = json.loads(raw) if raw else None
    except Exception:
        body = None
    orders = body.get("orders") if isinstance(body, dict) else None
    valid = isinstance(orders, list) and bool(orders) and all(
        isinstance(o, dict)
        and isinstance(o.get("orderId"), str) and _ORDER_ID.match(o["orderId"])
        and _valid_ids(o.get("accountIds"), _ACCOUNT_ID)
        and _valid_ids(o.get("unitIds"), _UNIT_ID)
        for o in orders
    )
    if not valid:
        return _bad_request("Request body must include 'orders': a non-empty [{orderId, accountIds, unitIds}] array.")

    spool = tempfile.SpooledTemporaryFile(max_size=_ZIP_SPOOL_BYTES)
    try:
        summary = await run_in_threadpool(service.build_invoices_zip, orders, spool)
    except Exception as err:  # noqa: BLE001 - mapped to the shared error contract
        spool.close()
        body, status = to_error_response(err)
        return JSONResponse(body, status_code=status)
    size = spool.tell()
    spool.seek(0)

    def chunks():
        try:
            while block := spool.read(1024 * 1024):
                yield block
        finally:
            spool.close()

    return StreamingResponse(
        chunks(),
        media_type="application/zip",
        headers={
            "Content-Disposition": 'attachment; filename="flipkart-invoices.zip"',
            "Content-Length": str(size),
            "Cache-Control": "no-store",
            "X-Invoice-Files": str(summary["files"]),
            "X-Invoice-Missing": str(summary["missing"]),
        },
    )


@app.get("/api/accounts")
def get_accounts() -> dict:
    return {"accounts": store.list_accounts()}


@app.post("/api/accounts", response_model=None)
async def post_account(request: Request) -> JSONResponse | dict:
    denied = _admin_denied(request) or _json_required(request)
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
        # Store calls do blocking file/S3 I/O; run them off the event loop so one slow MinIO
        # scan doesn't stall every other request (including the /api/orders poll).
        accounts = await run_in_threadpool(store.add_account, label if isinstance(label, str) else "", cookie)
        poller.instance.wake()
        return {"accounts": accounts}
    except Exception as err:  # noqa: BLE001
        b, s = to_error_response(err)
        return JSONResponse(b, status_code=s)


_MAX_IMPORT_BYTES = 2 * 1024 * 1024  # 2 MB cap on an uploaded cookie blob (upload validation)


@app.post("/api/accounts/import", response_model=None)
async def import_accounts(request: Request) -> JSONResponse | dict:
    """Import one blob into one or many accounts (.json/.txt, single or multi-account)."""
    denied = _admin_denied(request) or _json_required(request)
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
        imported, accounts = await run_in_threadpool(
            store.import_accounts, label if isinstance(label, str) else "", content
        )
        poller.instance.wake()
        return {"accounts": accounts, "imported": imported}
    except Exception as err:  # noqa: BLE001
        b, s = to_error_response(err)
        return JSONResponse(b, status_code=s)


@app.delete("/api/accounts", response_model=None)
def delete_account(request: Request, id: list[str] | None = Query(None)) -> JSONResponse | dict:
    """Remove accounts: ``?id=a`` one, ``?id=a&id=b…`` several in one storage pass, no ``id``
    at all clears every account. (A sync handler, so FastAPI already runs it off the event loop.)
    An ``id`` that is present but empty (``?id=``) matches nothing; it never means "clear all"."""
    denied = _admin_denied(request)
    if denied:
        return denied
    try:
        if id is None:
            accounts = store.clear_all()
        elif len(id) == 1:
            accounts = store.remove_account(id[0])
        else:
            accounts = store.remove_accounts(id)
        poller.instance.wake()
        return {"accounts": accounts}
    except Exception as err:  # noqa: BLE001
        b, s = to_error_response(err)
        return JSONResponse(b, status_code=s)


@app.patch("/api/accounts", response_model=None)
async def patch_accounts(request: Request) -> JSONResponse | dict:
    """Activate/deactivate a set of accounts. Body: {ids: string[], active: bool}."""
    denied = _admin_denied(request) or _json_required(request)
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
    try:
        accounts = await run_in_threadpool(store.set_active, ids, active)
        poller.instance.wake()
        return {"accounts": accounts}
    except Exception as err:  # noqa: BLE001
        b, s = to_error_response(err)
        return JSONResponse(b, status_code=s)
