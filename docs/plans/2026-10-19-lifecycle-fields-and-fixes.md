# Plan: fix review issues + add price / delivery / cancel / replacement / refund data

Scope: **backend (`backend/app/`) + web UI (`src/`) only.** Extension is frozen, not touched.

## Context

The deep review found real defects:
- **Stale-cookie bug (verified):** re-dropping a fresh cookie doesn't clear "Session expired" for up to 30 min.
- **Exposure:** the backend is open on every interface with CORS `*`, serving customer PII and live OTPs.
- **Blocked event loop:** account mutations block the async event loop.
- **Slow bulk remove:** it rescans all of storage once per id (quadratic).
- **Swallowed failures:** detail-fetch failures are silently returned as `{}`.
- **Stale docs.**

Separately, the delivery team needs more per-shipment data: amount paid, expected/delivered dates, cancelled date, replacement dates (requested, delivered, cancelled), and refund amount + date.

Decisions from the user:
- **Hosting:** the app runs only as a local Docker build on one machine, never on a server. Record this in CLAUDE.md.
- **Price:** the amount the customer actually paid for that unit.
- **Samples:** real samples come from the Cookie-Editor export in `docs/cookies/` (1 file, 23 cookies).
- **Replacement shipments** get their **own row**, linked by a `Replacement Of` column (the original
  tracking ID). The original row carries the replacement requested / delivered / cancelled dates.
  Multiple replacements of one shipment use the latest.
- **History window:** lifecycle detail lookups only for orders placed in the **last 30 days**.
- **CSV dates:** every date column, including Activity Date, as **IST `YYYY-MM-DD HH:mm`**.
- **Activity Date** on cancelled / replaced / refunded rows is the **latest lifecycle event**, so the
  Today / Last 7 days filters see recent cancellations and refunds.
- **Refunds:** the total amount per shipment plus the latest *completed* date. When a refund has
  only been initiated, use the initiated date and set `refundStatus="initiated"`.

Skills applied:
- **distinguish-empty-from-error:** "no refund" must never look like "detail fetch failed".
- **surface-upstream-errors:** log the Flipkart response body, not just the status code.

On approval, copy this plan to `docs/plans/2026-10-19-lifecycle-fields-and-fixes.md`, a local repo
doc next to the existing extension plan.

## Step 0: Protect secrets (do first)

`docs/cookies/` is untracked and **not gitignored**, and it holds a live session.
- Add `docs/cookies/` and `backend/.samples/` to `.gitignore`.
- Confirm with `git status --short` and `git check-ignore -v docs/cookies/*`.

## Step 1: Discover real Flipkart field paths (gate)

The repo has no evidence of where price, cancel, replacement or refund data lives; the fixtures are trimmed. Don't guess paths.

1. Split `fetch_detail` in `backend/app/flipkart.py`:
   - `fetch_detail_raw(cookies, order_id, unit_id, share_token) -> dict` returns the raw JSON and **raises** on failure (see Step 2).
   - The current extraction becomes a thin wrapper around it.
2. New dev script `backend/scripts/capture_samples.py`:
   - **Input:** `--cookie <file>`. Normalize it with `store.normalize_cookie_input` + `store.to_cookie_dict`.
   - **Orders:** call `flipkart.fetch_orders` and save the raw orders to `backend/.samples/orders.json`.
   - **Classify units** by `metaData.moRedesignHeading` into delivered, ofd/arriving, cancelled, replacement, return, refund and other. Use `parser.map_status` plus a `replac|return|refund` regex.
   - **Details:** for up to 3 units per category, call `fetch_detail_raw` and save `backend/.samples/detail-<category>-<n>.json`.
   - **Path dump:** write `backend/.samples/paths.txt`. It lists every key path whose key or value matches `price|amount|paid|refund|cancel|replac|return|date|time|tracker|timeline|step`, with a sample value type, not the value.
3. Run it:
   `cd backend && python -m scripts.capture_samples --cookie ../docs/cookies/www.flipkart.com_json_1792397238957.json`
4. Read `paths.txt` and the samples, then record the chosen field path for each new field in the module docstring of `parser.py`.
5. **Gate:**
   - **Session expired:** ask the user for a fresh export.
   - **No examples in this account** (e.g. no replacement or refund): stop and ask for an account that has them. Leave those fields `null` with no guessed paths.
   - **No replacement link:** if nothing in the payload ties a replacement unit to its original (a shared order ID plus a field pointing at the original unit or tracking ID), stop and ask before linking by heuristic.
   - **Data lives outside both APIs** (e.g. a separate refunds API): report back before adding any new endpoint.
6. Turn the real shapes into **synthetic, PII-free fixtures**: keep the shapes, fabricate every value. Place them in `backend/tests/fixtures/`:
   - `orders-lifecycle.json`
   - `detail-cancelled.json`
   - `detail-replacement.json`
   - `detail-refund.json`
   - `detail-delivered-price.json`

## Step 2: Backend fetch contract (empty vs error, upstream bodies)

- **Body helper in `flipkart.py`:** `_describe(res)` returns `"HTTP {status} | body={text[:500]}"`, with no headers or cookies.
  - Log it with `logging.getLogger("flipkart").warning(...)` on every non-200.
  - The user-facing `AppError` messages stay as they are.
- **`fetch_detail_raw`:** raise `upstream(...)` on non-200, timeout or bad JSON (log first, then raise). Remove the `except: return {}`.
- **`service._enrich_details`** (`backend/app/service.py`): keep catching per target, which is the batch loop's resilience decision. Return `(details, detail_state)`:
  - `detail_state[orderId][unitId]` is one of `"ok" | "failed" | "skipped"`.
  - `"skipped"` means not targeted, or the deadline was hit.
- **`fetch_orders`:** a failure after page 1 (non-200 or exception) no longer kills the whole account or silently truncates.
  - Log `_describe`, stop paging, and return a `partial=True` flag.
  - Page-1 failures still raise, as today.
- **Plumbing:** `service.fetch_account_orders` returns `(orders, meta)`, where meta is `{partial, detailFailed}`.
  - `poller._fetch_one` stores both on `AccountCache`.
  - `snapshot()` emits `partial` and `detailFailed` on each account result.

## Step 3: Backend new fields (`backend/app/parser.py`)

Add these per-row fields in `parse_orders`. They're always emitted, `null` or `""` when absent:

| Field | Source |
|---|---|
| `pricePaid: float \| None` | path from Step 1 (unit level, after discounts) |
| `expectedDateIso` | `deliveryDataBag.promiseDataBag.promisedDate` (known today) |
| `deliveredDateIso` | `deliveryDataBag.promiseDataBag.actualDeliveredDate` (known today) |
| `cancelledDateIso` | Step 1 path |
| `replacementDateIso`, `replacementDeliveredDateIso`, `replacementCancelledDateIso` | Step 1 paths |
| `replacementOf: str` | on a replacement row: the original unit's tracking ID (Step 1 link field); `""` otherwise |
| `refundAmount: float \| None` | Step 1 path; **sum** of refunds for the unit |
| `refundDateIso` | Step 1 path; latest **completed** refund date, else the initiated date |
| `refundStatus: "completed" \| "initiated" \| ""` | Step 1 path |
| `detailStatus: "ok" \| "failed" \| "skipped"` | from `detail_state` (Step 2) |

- **`activityDateIso`:** for a row with any lifecycle date (cancelled, replacement, refund), use the
  **latest** of those dates. Other rows keep today's rule (delivered or promised date, falling back to
  the order date).
- **Replacement row:** stays one row per unit with its own tracking ID, status and OTP. Normal
  OFD/ARRIVING targeting already fetches its OTP. It only gains `replacementOf`.

- **Helpers:**
  - Add `extract_lifecycle(detail_json) -> dict` next to `extract_detail`, with the same DFS style.
  - Add `_unit_price(order, unit)`.
  - Reuse `get`, `_num`, `_to_iso` and `_s`.
- **Detail targeting** in `service._enrich_details`: if Step 1 shows that lifecycle dates exist only on the detail page, add a **history** tier.
  - It covers units whose status maps to `CANCELLED` or whose heading matches `replac|return|refund`,
    **in orders placed within `FLIPKART_HISTORY_DAYS`** (default 30, from `orderMetaData.orderDate`).
  - A safety cap, `FLIPKART_MAX_HISTORY_DETAILS` (default 150), bounds it. Both settings go in
    `config.py`, the `.env.example` files and `docker-compose.yml`.
  - Priority order: active (300) → history → address-only (`FLIPKART_MAX_DETAILS`).
  - The existing per-account deadline still bounds the total.
- **Keep detail results** when lifecycle or price data is present. Today a result is dropped unless it has an address, OTP or GSTIN.
- **Dead code:** delete `detail_targets_for`, which is unused.

## Step 4: Backend fixes

1. **Stale cookie:** in `Poller._sync_roster` (`backend/app/poller.py:117`), when an existing account's cookies differ from its roster entry, set `fetched_monotonic = None` so the account is due on the next tick. Keep its last orders.
2. **Local-only exposure:**
   - In `docker-compose.yml`, bind `127.0.0.1:3100:3000`, `127.0.0.1:8000:8000` and `127.0.0.1:9001:9001`, and stop publishing MinIO `9000`. The backend reaches it on the compose network.
   - Replace CORS `*` in `main.py` with `CORS_ORIGINS` (`config.py`). Default: `http://localhost:3100,http://127.0.0.1:3100,http://localhost:3000`.
   - `ADMIN_TOKEN` stays optional.
3. **Event loop:**
   - In the `async def` handlers (`post_account`, `import_accounts`, `patch_accounts`), call store functions through `starlette.concurrency.run_in_threadpool`.
   - Add one module-level `threading.Lock` in `store.py` around read-modify-write mutations (add, import, remove, set_active, clear).
4. **Bulk remove:**
   - `DELETE /api/accounts` accepts a repeated `id` query (`id: list[str] | None = Query(None)`). A single id still works, and no id still clears all.
   - New `store.remove_accounts(ids)` calls a new `StorageBackend.delete_many(ids)`:
     - **File backend:** one read-modify-write.
     - **MinIO backend:** `delete_objects`, in chunks of 1000.
   - Then one `load_all()`.
5. **Admin rejection:** add `ErrorCode` `"UNAUTHORIZED"` (401) in `errors.py` and `src/lib/types.ts`. It replaces the misleading `AUTH_EXPIRED` in `_admin_denied`.
6. **Duplicate labels in one import blob:** when `_unique_id` suffixes the id (`store.py:203`), suffix the label the same way. That keeps the label-based account filter and the CSV Account column unambiguous.

## Step 5: Web UI (`src/`)

- **`src/lib/types.ts`:**
  - Add the Step 3 fields to `Order` as **optional**, so the frozen extension still compiles.
  - Add `partial?` and `detailFailed?` to `AccountResult`.
  - Add `"UNAUTHORIZED"` to `ErrorCode`.
  - Fix the stale comments on `itemName` and `count`.
- **`src/lib/orders/csv.ts`:** append columns after GSTIN, so existing positions don't move, in this order: `Price Paid, Expected Date, Delivered Date, Cancelled Date, Replacement Of, Replacement Date, Replacement Delivered Date, Replacement Cancelled Date, Refund Amount, Refund Status, Refund Date, Details`.
  - **Every** date column, Activity Date included, is IST `YYYY-MM-DD HH:mm`.
    - The signature becomes `ordersToCsv(orders, timeZone = "Asia/Kolkata")`. The optional parameter keeps the extension's call compiling.
    - Dashboard passes the `timezone` it gets from the API.
    - Formatting reuses the `Intl.DateTimeFormat("en-CA", …)` approach from `filters.ts` `ymdInTz`, with `hourCycle: "h23"`.
  - Amounts are plain numbers so Excel treats them as numeric.
  - `Details` is `ok/failed/skipped`, so an empty refund cell is never ambiguous.
- **`src/components/OrderCard.tsx`:**
  - Show the paid amount (`Intl.NumberFormat("en-IN", {style:"currency", currency:"INR"})`).
  - Show "Expected <date>" or "Delivered <date>".
  - Show a compact lifecycle list (Cancelled / Replacement / Replacement delivered / Replacement cancelled / Refund ₹X initiated|completed on date), rendered only when present.
  - On a replacement row, show a "Replacement of <tracking ID>" tag.
  - The search filter (`filters.ts`) also matches `replacementOf`, so searching an original tracking ID finds its replacement.
  - Show a "Details unavailable" note when `detailStatus === "failed"`.
- **Error text:** move `ERROR_TEXT` from `Dashboard.tsx:32` to `src/lib/ui.ts`, add `UNAUTHORIZED`, and use it in `ErrorNotice.tsx` so raw enum codes are never shown.
- **`src/components/AccountsPanel.tsx`:**
  - Bulk remove becomes one request per 100 ids (`?id=a&id=b…`) instead of one per id.
  - Account rows show "N details failed" / "partial history" hints from `AccountResult`.

## Step 6: Docs

- **CLAUDE.md:**
  - Add a **Deployment: local Docker only, never a server** section, explaining that this is why ports bind to 127.0.0.1.
  - Mark the extension as **frozen / out of scope** and replace the parity rule with "don't edit `extension/`; keep new `Order` fields optional".
  - Add the fetch contract: detail fetch raises, `detailStatus` per row, upstream bodies logged.
  - Add the `docs/cookies/` and `backend/.samples/` secret rule.
- **README:**
  - Refresh semantics: it re-reads the cache; the backend refreshes every `REFRESH_INTERVAL_S`.
  - API table: add PATCH, multi-id DELETE, the new fields and CSV columns.
  - Security section: cookies live in MinIO; local-only binding.
- **Docstrings:** fix the `parser.py` module docstring ("one row per unit") and `service.py:1`.

## Critical files

- `backend/app/flipkart.py`, `service.py`, `parser.py`, `poller.py`, `store.py`, `storage.py`, `main.py`, `config.py`, `errors.py`
- `backend/scripts/capture_samples.py` (new)
- `backend/tests/fixtures/*` (new)
- `backend/requirements-dev.txt` (new: `pytest`, `httpx`, needed for FastAPI `TestClient`)
- `docker-compose.yml`, `.env.example`, `backend/.env.example`, `.gitignore`
- `src/lib/types.ts`, `src/lib/orders/csv.ts`, `src/lib/ui.ts`
- `src/components/OrderCard.tsx`, `ErrorNotice.tsx`, `Dashboard.tsx`, `AccountsPanel.tsx`
- `README.md`, `CLAUDE.md`

## Tests to add

- **`test_parser.py`:**
  - Each new field from the synthetic fixtures.
  - Refunds: summed amount, latest completed date, and an initiated-only refund.
  - The replacement row gets `replacementOf`; the original row gets the replacement dates; the latest replacement wins.
  - `activityDateIso` is the latest lifecycle event on cancelled, replaced and refunded rows.
  - A unit with no lifecycle data gives nulls, not errors.
  - A unit in an order older than `FLIPKART_HISTORY_DAYS` is not targeted for history details.
- **`test_service`:**
  - A failed detail gives `detailStatus="failed"`; an over-cap unit gives `"skipped"`.
  - History-tier priority and cap.
- **`test_flipkart.py`:**
  - `fetch_detail_raw` raises on non-200 and logs a body snippet.
  - A page-2 failure gives `partial=True`, and page-1 orders are kept.
- **`test_poller.py`:** a cookie change makes the account due immediately (the repro already exists: `scratchpad/repro_poller.py`).
- **`test_store.py` / `test_storage.py`:**
  - `remove_accounts` / `delete_many` on both backends.
  - Label suffixing for duplicate labels.
- **New `test_main.py`** (TestClient):
  - A disallowed `Origin` gets no `access-control-allow-origin`.
  - Multi-id DELETE.
  - A bad admin token returns `UNAUTHORIZED` 401.
- **`src/lib/orders/csv.test.ts`:**
  - New header row and the `Details` column.
  - Number cells.
  - IST date formatting, including a UTC timestamp that falls on the next day in IST (e.g. `2026-07-01T20:00:00Z` → `2026-07-02 01:30`).
- **OrderCard render test:** the lifecycle section shows only when data is present.

## Verification

1. **Backend tests:** `cd backend && pip install -r requirements-dev.txt && POLLER_ENABLED=0 python -m pytest -q`. All green.
2. **Web checks:** `npm install && npm test && npm run lint && npm run build` from the repo root.
3. **Live samples:** the Step 1 capture run succeeds and `paths.txt` maps every new field. `git status` shows no `.samples` or `docs/cookies` files.
4. **E2E (local Docker):**
   - `docker compose up --build -d`. `docker compose ps` shows `127.0.0.1:` bindings and no 9000.
   - Open http://localhost:3100 and drop the `docs/cookies` file.
   - The account turns "Working" and cards show the price, dates and the lifecycle section for cancelled, replaced and refunded shipments.
   - Download the CSV and check that the new columns open correctly in Excel.
5. **CORS:** `curl -s -I -H "Origin: http://evil.example" http://localhost:8000/api/orders` has no `access-control-allow-origin` header. The same request with `Origin: http://localhost:3100` has it.
6. **Stale cookie:** expire an account (drop a bad cookie), then re-drop the good one. It turns "Working" within one poll cycle, not 30 min.
7. **Final:** run the full repo check once: backend pytest plus `npm test && npm run lint && npm run build`.

## Risks / out of scope

- Some lifecycle data may live only in a Flipkart API that isn't called today. The Step 1 gate handles this, and nothing is guessed.
- More detail calls per account mean more load on Flipkart. They're bounded by `FLIPKART_MAX_HISTORY_DETAILS` and the 120 s per-account deadline. Caching details for terminal units across refresh cycles is a follow-up, not part of this work.
- The extension is untouched. Its parser won't emit the new fields; they're optional in `types.ts`, so it still builds.
