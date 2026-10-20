@AGENTS.md

# Flipkart Delivery Tracker (fktr-fetcher)

Reads Flipkart's internal "My Orders" JSON APIs (no headless browser) for many accounts and shows one
row per shipment (order/tracking ID, item, status, OTP, mobile, address, GSTIN, price paid, dates,
cancel/replacement/refund history) with filters and CSV export. Backend: `backend/app/` (Python 3.12,
FastAPI, Scrapling/curl_cffi, boto3). Web UI: `src/`, the repo root is the Next app (Next.js 16, React
19.2.4, Tailwind 4; UI only, no API routes). Chrome extension: `extension/`, **frozen, out of scope**.

## Deployment: local Docker only, never a server

The owner runs this only as a local Docker build on one machine; it is never deployed to a server.
The API serves customer PII and live OTPs and MinIO holds Flipkart session cookies, so:

- `docker-compose.yml` publishes only `127.0.0.1:3100` (UI), `127.0.0.1:8000` (API) and
  `127.0.0.1:9001` (MinIO console); MinIO's S3 port 9000 stays unpublished. Never widen a binding.
- CORS allows only `CORS_ORIGINS` (`backend/app/config.py`; default: the local UI on :3100 and
  `npm run dev` on :3000). Never use `*`.
- `ADMIN_TOKEN` stays optional; a missing or wrong `x-admin-token` returns `UNAUTHORIZED` (401).
- Don't add hosting work (TLS, user login, server/cloud configs) unless the owner asks.

## Commands

- Backend tests (from `backend/`): `pip install -r requirements-dev.txt` once (pytest + httpx for
  FastAPI's `TestClient`), then `POLLER_ENABLED=0 python -m pytest -q`.
- Backend dev: `cd backend && uvicorn app.main:app --reload --port 8000` (reads `backend/.env`).
- Next app (repo root): `npm install` first (AGENTS.md's Next docs live in `node_modules`), then
  `npm test`, `npm run lint`, `npm run build`, `npm run dev` (:3000; set
  `NEXT_PUBLIC_BACKEND_URL=http://localhost:8000` in `.env.local`). `npm run lint` also lints the frozen
  `extension/` and fails on its pre-existing issues; lint the web app with `npx eslint src`.
- Full stack: `docker compose up --build -d`: UI http://localhost:3100, API :8000, MinIO console :9001.
- After touching `src/lib/types.ts` or `src/lib/orders/*`, `cd extension && npm install && npm test
  && npm run build` must still pass. (`npx tsc --noEmit` there already fails on the old `account`
  filter field in `src/ui/OrderFilters.tsx`; add no new errors and don't edit the extension to fix it.)
- Field-path discovery (dev only): `cd backend && python -m scripts.capture_samples --cookie <export>`
  saves raw Flipkart responses to `backend/.samples/<cookie-file-stem>/` (see Data sensitivity).
- Before finishing, run the tests of every surface you touched.

## Architecture

Backend: `main.py` (routes) → `service.py` → `poller.py`. `/api/orders` never fetches live; it returns
`poller.instance.snapshot()`. A scheduler thread refetches each active account every `REFRESH_INTERVAL_S`
(1800s) on a `FETCH_CONCURRENCY` pool; a semaphore in `flipkart.py` caps it (`MAX_FLIPKART_CONNS`).

- `flipkart.py`: paginated orders list (follows `nextCallParams.ot`) and the per-unit detail POST.
- `service.py`: detail calls, in order: every OFD/ARRIVING unit; one per order placed within
  `FLIPKART_HISTORY_DAYS` with a cancelled/refunded/replaced unit (cap `FLIPKART_MAX_HISTORY_DETAILS`);
  one per other order for its address (`FLIPKART_MAX_DETAILS`), all within `ACCOUNT_DEADLINE_S`.
- `parser.py`: raw Flipkart JSON → `Order` rows; its module docstring records the verified field paths.
- `store.py`: cookie normalization, label → id slug, cookie-signature dedup, active/paused accounts.
  Mutations hold `_lock`; `async def` routes call the store via `run_in_threadpool` (never block).
- `storage.py`: `FileBackend` (local JSON) or `MinioBackend` (one object per account, bulk
  `delete_many`). `STORAGE_BACKEND=auto` picks MinIO when `MINIO_ENDPOINT` is set.
- Every account mutation must call `poller.instance.wake()`. A changed cookie on an existing account
  makes it due on the next tick (`Poller._sync_roster`), so a re-dropped cookie clears "Session expired".
- `DELETE /api/accounts` with no `id` clears every account: never send it with an empty selection.

Next app: `src/components/Dashboard.tsx` owns state and re-reads `/api/orders` (Refresh, 60s auto-refresh:
the cache, instant); `AccountsPanel.tsx` imports, pauses and removes; `API_BASE` is in `src/lib/api.ts`.

## Rules that must hold

- **One data contract.** `src/lib/types.ts` defines `Order`, `OrderStatus`, `ErrorCode`,
  `AccountResult` and the response shapes; the backend emits exactly these camelCase fields, all of
  them on every row (`null` / `""` when absent). Change a field in `types.ts` and `parser.py` together.
- **The extension is frozen.** Don't edit `extension/` (owner decision). It imports `src/lib/types.ts`
  and `src/lib/orders/{filters,csv}.ts` through `@core/*`, so keep new `Order` fields and new params of
  shared `src/lib` functions optional (`ordersToCsv(orders, timeZone = "Asia/Kolkata")`) so it still
  compiles. It shares `csv.ts`, so its CSV gets the new columns, empty. Never copy shared logic into it.
- **One row per shipment.** `parse_orders` emits one row per non-VAS unit; a replacement shipment is its
  own row, `replacementOf` = the original's tracking ID. An OTP always means `OUT_FOR_DELIVERY`, as does
  a failed attempt awaiting re-delivery (`map_status`). `activityDateIso` (date-filter key) = latest
  cancel/replacement/refund event, else delivered/promised date, else order date.
- **List and CSV agree.** Both go through `applyOrderFilters`; the CSV also drops repeated tracking
  IDs. Never filter in only one path. Append new CSV columns at the end; every CSV date is
  `YYYY-MM-DD HH:mm` in the API's timezone (IST by default).
- **A failure is never empty data.** Flipkart calls raise on failure and log `flipkart._describe(res)`
  (status + body snippet, never headers or cookies). `fetch_orders` returns `(orders, partial)`: page 1
  must succeed; a later failed page, the deadline or the page cap sets `partial`. `fetch_detail_raw`
  raises; `service` catches per call, recording each row's `detailStatus` (`ok|failed|skipped`) and
  the account's `detailFailed` count. `service.fetch_account_orders` returns `(orders, {partial,
  detailFailed})` and raises on account failure; the poller records it and keeps the last good orders.
- **Typed errors.** Raise `AppError` codes from `backend/app/errors.py` (`AUTH_EXPIRED` 401 = Flipkart
  session, `UNAUTHORIZED` 401 = admin token, `UPSTREAM_ERROR`/`PARSE_ERROR` 502, `CONFIG_ERROR` 400). New
  codes go in `errors.py`, `ErrorCode` and `ERROR_TEXT`; the UI shows `errorText(code)`, never raw codes.

## Data sensitivity

Orders hold customer names, addresses, phone numbers and live delivery OTPs; account records hold
Flipkart session cookies. Never commit `.env`, `.flipkart-session.json`, cookie exports (`docs/cookies/`)
or captured Flipkart responses (`backend/.samples/`): both folders are gitignored but hold a live session
and real customer PII, so never copy their values into code, fixtures, logs, docs or commit messages.
Fixtures (`backend/tests/`, `extension/src/__fixtures__/`) keep real shapes with fabricated values.
Don't log cookie values or order PII.

## Conventions

- Python: `from __future__ import annotations`, a module docstring that explains why, typed signatures,
  settings in `app.config.config` (env-overridable, Flipkart endpoints and FKUA included; a new setting
  also goes in both `.env.example` files and `docker-compose.yml`, which passes only what it lists).
  Tests: `backend/tests/test_<module>.py` with the `file_store` fixture and monkeypatched
  `store`/`service`/`flipkart` (never call Flipkart); `TestClient` for routes.
- TypeScript: strict mode, `@/*` → `src/*`; Vitest + Testing Library + jsdom, colocated `*.test.ts(x)`.
- UI: Tailwind with a dark-mode variant on every color; status tones and error text from
  `src/lib/ui.ts`; accessible controls (real buttons and checkboxes, aria attributes, focus rings).
- Comments explain intent and edge cases, not mechanics. Commits: Conventional Commits (`feat:`, `fix:`).

## Open direction

Phase 5 of `docs/plans/2026-07-06-flipkart-public-chrome-extension.md` proposed retiring the backend,
Docker and Next app for the extension; later the backend scaled to 1000+ accounts and the owner froze
the extension. Don't delete or retire either surface without the owner's explicit decision.
