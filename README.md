# Flipkart Delivery Tracker

Internal tool for a delivery team. Fetches your Flipkart **My Orders** and shows, per order:
account, order ID, customer, item, **delivery address**, status, and the delivery **OTP** —
across multiple accounts, with client-side filters (status / date window / search) and one-click
**CSV** export.

## Architecture

Two services (see `docker-compose.yml`):

- **`backend/`** — Python (**FastAPI** + **Scrapling**). Calls Flipkart's internal *My Orders*
  JSON APIs over plain HTTP using each account's cookies plus Flipkart's `x-user-agent` (FKUA)
  header, with `curl_cffi` TLS impersonation. Paginates every recent order and fetches each
  order's detail page for the **address + live OTP**. **No headless browser.**
- **repo root** — **Next.js** frontend (UI only). Every `/api/*` request is proxied to the backend
  via `next.config.ts` rewrites, so the frontend code is backend-agnostic.

## Run (Docker)

```bash
docker compose up --build -d
```

- Frontend: **http://localhost:3100**  ·  Backend API: **http://localhost:8000**
- In the **Accounts** panel, drop each Flipkart account's cookie **`.json`** (a Cookie-Editor
  export). One file per account — orders load automatically.
- Stop: `docker compose down` (add `-v` to also delete stored cookies).

Cookies are persisted in a named Docker volume (`session` → `/data`), so they survive restarts.

## Getting your cookie

1. Log in at <https://www.flipkart.com/> in your browser.
2. Export cookies as JSON (e.g. the **Cookie-Editor** extension → *Export → JSON*).
3. Drop the file into the app's **Accounts** panel (or click to choose).

## How it fetches (no browser)

- `GET  …/api/5/self-serve/orders` — paginated 7/page via `nextCallParams`, up to `FLIPKART_MAX_PAGES`.
- `POST …/api/4/page/fetch` — per-order detail (delivery address + the active unit's OTP), for up to
  `FLIPKART_MAX_DETAILS` most-recent orders.
- Both require the account cookie + the `x-user-agent` FKUA header. Undeliverable/"retrying" units
  are treated as out-for-delivery so their OTP surfaces.

## Backend endpoints

| Method | Path | Notes |
|---|---|---|
| GET | `/api/orders` | `{ ok, orders[], accounts[], fetchedAt, timezone }` |
| GET | `/api/accounts` | `{ accounts[] }` |
| POST | `/api/accounts` | body `{ label, cookie }`; `x-admin-token` required when `ADMIN_TOKEN` set |
| DELETE | `/api/accounts?id=…` | omit `id` to clear all; same admin guard |
| GET | `/api/health` | liveness + account count |

## Configuration

- **Backend** (`backend/.env.example`): `APP_TIMEZONE`, `FLIPKART_MAX_PAGES` (20),
  `FLIPKART_MAX_DETAILS` (40), `FLIPKART_TIMEOUT_MS`, `ADMIN_TOKEN`, `FLIPKART_IMPERSONATE`.
- **Frontend**: `BACKEND_URL` — proxy target, resolved at build time; Compose sets it to
  `http://backend:8000`.

## Develop without Docker

```bash
# backend
cd backend && pip install -r requirements.txt && uvicorn app.main:app --reload --port 8000
# frontend (new shell, repo root)
npm install && npm run dev      # proxies to http://localhost:8000 (override with BACKEND_URL)
```

Frontend unit tests (filters / CSV / rendering): `npm test`.
