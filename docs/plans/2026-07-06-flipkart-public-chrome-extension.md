# Flipkart Delivery Tracker — Public Chrome Extension Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a fully client-side, publicly-listed Chrome extension (Manifest V3) that reads the user's own logged-in Flipkart "My Orders", explodes them into one-row-per-shipment (tracking ID, item, status, OTP, mobile, address), lets the user filter, and exports CSV/Excel — with **no backend server, no cookie export, and no Docker**.

**Architecture:** The extension's **background service worker** performs first-party HTTP calls to Flipkart's internal `self-serve/orders` and `page/fetch` JSON APIs. Because the extension holds `host_permissions` for `https://www.flipkart.com/*`, Chrome treats these requests as *same-site*, so the user's existing session cookies (even `SameSite=Strict`) are attached automatically with `credentials: "include"` — this replaces the entire Python `curl_cffi` + cookie-store layer. Order list + per-shipment detail parsing (ported faithfully from `backend/app/parser.py`) runs in the worker; the UI is a React page (reusing the existing components + `csv.ts`/`filters.ts`) served from the extension. Multi-account is preserved without a server via a **snapshot-per-account model** in `chrome.storage.local`.

**Tech Stack:** TypeScript, Manifest V3, `@crxjs/vite-plugin` (Vite 8 / Rolldown), React 19 + `react-dom` 19 (matching the repo), Tailwind v4, Vitest (already in repo). No new runtime services.

## Global Constraints

- **Manifest V3 only.** MV2 is not accepted by the Chrome Web Store.
- **Zero server.** No FastAPI, Docker, `.env`, `NEXT_PUBLIC_BACKEND_URL`, or network egress except to `https://www.flipkart.com/*`. No analytics, no telemetry, no remote code (Web Store hard rule).
- **Single source of truth for shared logic.** `types.ts`, `orders/csv.ts`, `orders/filters.ts` are reused verbatim — do not fork them. New extension code imports them.
- **Port faithfully.** The TS parser/fetcher MUST reproduce the exact behavior in `backend/app/parser.py`, `flipkart.py`, `service.py`, `config.py`. Any deviation is a bug. Verified by fixture tests.
- **React/react-dom pinned to `19.2.4`** (repo lock). Vitest `^4.1.9`, jsdom `^29`, `@testing-library/*` already present — reuse; do not add competing test runners.
- **Data never leaves the browser.** All fetched order data stays in `chrome.storage.local`; CSV is a local `Blob` download. This claim is load-bearing for the Web Store privacy disclosure.
- **Flipkart constants copied verbatim** from `backend/app/config.py`:
  - `ORDERS_BASE = "https://www.flipkart.com/api/5/self-serve/orders/"`
  - `DETAIL_URL  = "https://www.flipkart.com/api/4/page/fetch?"`
  - `FILTER_TYPE = "PREORDER_UNITS"`
  - `FKUA` (x-user-agent) = `"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36 FKUA/website/42/website/Desktop"`
  - `MAX_PAGES = 100`, `MAX_DETAILS = 40`, `TIMEOUT_MS = 20000`, detail concurrency `= 8`, active-target cap `= 300`.

---

## Directory & File Structure

New top-level `extension/` workspace (keeps the Next.js app intact and untouched during the transition; the old app can be deleted in the final phase once parity is confirmed).

```
extension/
  manifest.config.ts          # MV3 manifest (typed, consumed by CRXJS)
  vite.config.ts              # CRXJS + React + Tailwind + tsconfig paths
  package.json                # extension deps (react 19, crxjs, vite, tailwind)
  tsconfig.json               # paths: "@core/*" -> ../src/lib/*, "@flk/*" -> ./src/*
  public/
    icon-16.png icon-32.png icon-48.png icon-128.png
  src/
    background/
      worker.ts               # SW entry: message router, orchestrates a fetch run
      flipkart.ts             # PORT of backend/flipkart.py (fetchOrders, fetchDetail)
      enrich.ts               # PORT of backend/service.py (enrichDetails, concurrency pool)
      pool.ts                 # bounded promise pool (replaces ThreadPoolExecutor)
    core/
      config.ts               # PORT of backend/config.py constants (see Global Constraints)
      parser.ts               # PORT of backend/parser.py (map_status, parse_orders, ...)
    messaging/
      protocol.ts             # typed messages: RUN_FETCH, PROGRESS, RESULT, ERROR
    storage/
      snapshots.ts            # chrome.storage.local account snapshot CRUD + merge
    ui/
      index.html              # extension page (opened in a tab)
      main.tsx                # React root
      App.tsx                 # replaces src/app -> renders <Dashboard/>
      Dashboard.tsx           # adapted from src/components/Dashboard.tsx
      AccountsPanel.tsx       # REWRITTEN: snapshot list, not cookie drop
      (OrderList, OrderCard, OrderFilters, RefreshBar, StatusBadge, ErrorNotice copied)
    __fixtures__/
      orders-page1.json       # captured real /self-serve/orders response (redacted)
      detail-ofd.json         # captured /page/fetch response with a live OTP
      detail-delivered.json   # captured /page/fetch response, delivered (address only)
    __tests__/
      parser.test.ts
      flipkart.test.ts
      enrich.test.ts
      snapshots.test.ts
docs/plans/2026-07-06-flipkart-public-chrome-extension.md   # this file
store/                        # Chrome Web Store submission assets (Phase 6)
  privacy-policy.md
  listing.md                  # description, permission justifications, single-purpose
  screenshots/ (1280x800)
```

Reused verbatim (imported via `@core/*`, NOT copied): `src/lib/types.ts`, `src/lib/orders/csv.ts`, `src/lib/orders/filters.ts` and their existing tests.

---

## Phase 0 — Feasibility spike (de-risk before building anything)

The entire plan rests on one unverified assumption: *a Manifest V3 service worker with `host_permissions` for flipkart.com can call the internal APIs and get the logged-in user's cookies attached.* Prove it before writing the port.

### Task 0.1: Throwaway spike extension proving cookie-authenticated SW fetch

**Files:**
- Create: `extension/spike/manifest.json`
- Create: `extension/spike/worker.js`

**Interfaces:**
- Produces (knowledge, not code): confirmation that (a) orders JSON returns HTTP 200 with real orders while logged in, (b) `x-user-agent` custom header is accepted, (c) the detail POST returns address + `otpValue`, and (d) whether "block third-party cookies" breaks it (determines if the Phase 2 content-script fallback is needed).

- [ ] **Step 1: Write the minimal spike manifest**

```json
{
  "manifest_version": 3,
  "name": "FKRT spike",
  "version": "0.0.1",
  "permissions": ["storage"],
  "host_permissions": ["https://www.flipkart.com/*"],
  "background": { "service_worker": "worker.js" },
  "action": { "default_title": "run spike" }
}
```

- [ ] **Step 2: Write the spike worker (run on toolbar click)**

```js
const FKUA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36 FKUA/website/42/website/Desktop";
chrome.action.onClicked.addListener(async () => {
  const res = await fetch(
    "https://www.flipkart.com/api/5/self-serve/orders/?page=1&filterType=PREORDER_UNITS",
    { method: "GET", credentials: "include",
      headers: { "x-user-agent": FKUA, "accept": "application/json" } });
  const body = await res.json();
  const orders = body?.RESPONSE?.multipleOrderDetailsView?.orders ?? null;
  console.log("status", res.status, "orders?", Array.isArray(orders), "count", orders?.length);
});
```

- [ ] **Step 3: Load unpacked in Chrome (logged into flipkart.com), click the icon, read the SW console**

Run: `chrome://extensions` → Load unpacked → `extension/spike` → open the service-worker devtools → click the action.
Expected: `status 200 orders? true count <N>`. If `401/403` or `orders? false`, the SW path is blocked — proceed to Step 4.

- [ ] **Step 4 (only if blocked): test the content-script fallback**

Add `"content_scripts": [{ "matches": ["https://www.flipkart.com/*"], "js": ["cs.js"] }]`, move the same fetch into `cs.js` (runs first-party on an open flipkart.com tab), reload, open flipkart.com, check the page console. Record which path works.

- [ ] **Step 5: Capture fixtures from the working path**

Save one real orders response and two detail responses (one OFD-with-OTP, one delivered), **redact** names/phones/addresses/OTPs to fake-but-shape-valid values, into `extension/src/__fixtures__/`. These drive every parser test. Delete `extension/spike/` after.

**Decision gate:** If SW path works → Phase 2 uses the SW fetcher (simplest). If only content-script works → Phase 2 fetcher is injected via `chrome.scripting.executeScript` into a flipkart.com tab and streams results back; the message protocol is identical. Record the outcome at the top of `extension/src/background/flipkart.ts`.

---

## Phase 1 — Port the core (parser, config) with TDD

Pure logic, no Chrome APIs, testable under the existing Vitest. This is the highest-value, highest-risk work: `parser.py` has **zero tests today**.

### Task 1.1: Scaffold the extension workspace

**Files:**
- Create: `extension/package.json`, `extension/vite.config.ts`, `extension/tsconfig.json`, `extension/manifest.config.ts`

**Interfaces:**
- Produces: a buildable CRXJS project; `@core/*` resolves to `../src/lib/*`; `pnpm/npm run build` emits `extension/dist`.

- [ ] **Step 1: Create `extension/package.json`**

```json
{
  "name": "fkrt-extension",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "test": "vitest run"
  },
  "dependencies": { "react": "19.2.4", "react-dom": "19.2.4" },
  "devDependencies": {
    "@crxjs/vite-plugin": "^2.2.0",
    "@vitejs/plugin-react": "^6.0.3",
    "@tailwindcss/postcss": "^4",
    "tailwindcss": "^4",
    "typescript": "^5",
    "vite": "^8",
    "vitest": "^4.1.9",
    "jsdom": "^29.1.1"
  }
}
```

- [ ] **Step 2: Create `extension/tsconfig.json` with shared-lib paths**

```json
{
  "compilerOptions": {
    "target": "ES2022", "module": "ESNext", "moduleResolution": "bundler",
    "jsx": "react-jsx", "strict": true, "skipLibCheck": true,
    "types": ["chrome", "vitest/globals"],
    "baseUrl": ".",
    "paths": { "@core/*": ["../src/lib/*"], "@flk/*": ["./src/*"] }
  },
  "include": ["src", "manifest.config.ts", "vite.config.ts"]
}
```
Add `@types/chrome` to devDependencies.

- [ ] **Step 3: Create `extension/vite.config.ts`**

```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { crx } from "@crxjs/vite-plugin";
import manifest from "./manifest.config";

export default defineConfig({
  plugins: [react(), crx({ manifest })],
  resolve: { alias: { "@core": "../src/lib", "@flk": "/src" } },
  test: { environment: "node", globals: true },
});
```

- [ ] **Step 4: Verify it builds an empty shell**

Run: `cd extension && npm install && npm run build`
Expected: exits 0, produces `extension/dist/manifest.json`. (Manifest gets real content in Phase 2; a stub is fine here.)

- [ ] **Step 5: Commit**

```bash
git add extension/package.json extension/tsconfig.json extension/vite.config.ts
git commit -m "chore(ext): scaffold CRXJS + Vite + React extension workspace"
```

### Task 1.2: Port `config.py` → `core/config.ts`

**Files:**
- Create: `extension/src/core/config.ts`
- Reference: `backend/app/config.py:15-52`

**Interfaces:**
- Produces: `export const CONFIG` with fields consumed by `flipkart.ts`, `enrich.ts`, `parser.ts`.

- [ ] **Step 1: Write the constants module (no env; hardcode the verbatim defaults)**

```ts
export const CONFIG = {
  ordersBase: "https://www.flipkart.com/api/5/self-serve/orders/",
  detailUrl: "https://www.flipkart.com/api/4/page/fetch?",
  filterType: "PREORDER_UNITS",
  fkua:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36 FKUA/website/42/website/Desktop",
  maxPages: 100,
  maxDetails: 40,
  timeoutMs: 20_000,
  detailConcurrency: 8,
  activeTargetCap: 300,
  timezone: "Asia/Kolkata",
} as const;
```

- [ ] **Step 2: Commit** — `git commit -am "feat(ext): port config constants"`

### Task 1.3: Port `parser.py` helpers → `core/parser.ts` (TDD)

**Files:**
- Create: `extension/src/core/parser.ts`
- Test: `extension/src/__tests__/parser.test.ts`
- Reference: `backend/app/parser.py` (whole file)

**Interfaces:**
- Consumes: `ParsedOrder`, `OrderStatus` from `@core/types` (`src/lib/types.ts`).
- Produces (exact signatures — `flipkart.ts`/`enrich.ts` depend on these):
  - `get(obj: unknown, path: string): unknown`
  - `mapStatus(raw: string): OrderStatus`
  - `extractDetail(json: unknown): { address: Record<string, unknown> | null; otp: string | null }`
  - `formatAddress(addr: unknown): string`
  - `unitOtp(unit: unknown): string | null`
  - `ordersArray(body: unknown): unknown[] | null`
  - `ensureOrdersShape(body: unknown): unknown[]` (throws `AppError("PARSE_ERROR", …)`)
  - `parseOrders(rawOrders: unknown[], details: Record<string, Record<string, {address?: unknown; otp?: string|null}>>): ParsedOrder[]`
  - `detailTargetsFor(order: unknown): { orderId: string; unitId: string; shareToken: string }[]`

- [ ] **Step 1: Write failing tests against the captured fixtures**

```ts
import { describe, it, expect } from "vitest";
import ordersPage1 from "../__fixtures__/orders-page1.json";
import detailOfd from "../__fixtures__/detail-ofd.json";
import { mapStatus, extractDetail, formatAddress, parseOrders, ordersArray } from "../core/parser";

describe("mapStatus", () => {
  it("maps out-for-delivery variants", () => {
    expect(mapStatus("Out for delivery")).toBe("OUT_FOR_DELIVERY");
    expect(mapStatus("Delivery unsuccessful")).toBe("OUT_FOR_DELIVERY"); // failed attempt = still active
  });
  it("maps arriving/delivered/other", () => {
    expect(mapStatus("Arriving tomorrow")).toBe("ARRIVING");
    expect(mapStatus("Delivered")).toBe("DELIVERED");
    expect(mapStatus("Cancelled")).toBe("OTHER");
  });
});

describe("extractDetail", () => {
  it("finds the address object and a 4-8 digit otpValue", () => {
    const d = extractDetail(detailOfd);
    expect(d.address).toBeTruthy();
    expect(d.otp).toMatch(/^\d{4,8}$/);
  });
});

describe("parseOrders", () => {
  it("explodes one order into one row per non-VAS unit and forces OFD when an OTP exists", () => {
    const raw = ordersArray(ordersPage1)!;
    const rows = parseOrders(raw, {});
    expect(rows.length).toBeGreaterThanOrEqual(raw.length);
    for (const r of rows) {
      expect(r.orderId).not.toBe("");
      if (r.otp) expect(r.status).toBe("OUT_FOR_DELIVERY");
    }
  });
});
```

- [ ] **Step 2: Run to confirm failure** — `cd extension && npx vitest run src/__tests__/parser.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement `core/parser.ts` faithfully from Python**

Port each function 1:1. Key equivalences:
- `get(obj, "a.b.c")` walks dotted path returning `undefined` on any miss.
- `mapStatus` — port the regexes verbatim from `parser.py:51-62`:
  - `"out for delivery"` → `OUT_FOR_DELIVERY`
  - `/unsuccessful|retrying|reattempt|undelivered|delivery failed/` → `OUT_FOR_DELIVERY`
  - `"delivered"` → `DELIVERED`
  - `/arriving|expected|shipped|on the way|in transit|dispatched/` → `ARRIVING`
  - else `OTHER`. (Normalize `[_-]+`→space, lowercase first.)
- `extractDetail` — iterative DFS over dict/array (port `parser.py:115-134`): first dict with `address.addressLine1||address.pinCode` wins; first string `otpValue` matching `^\d{4,8}$` wins.
- `formatAddress` — port `parser.py:137-147`: `addressLine1 - pinCode` (skip pin if already in line1), else join `[addressLine2, city, state, pin]`, else `"Address unavailable"`.
- `unitOtp` — port `parser.py:150-164`: `deliveryDataBag.otpCallout` string/dict/`\b\d{4,8}\b`.
- `parseOrders` — port `parser.py:174-221`: skip VAS units (`vasItemDetails != null`) but fall back to all if that empties; order-level address from any unit detail with an address; `phone` from `address.phoneNumber`; `customer` from `accessToOrderDataBag.buyer.name` or `"Unknown customer"`; per unit compute `chosen_ms` = delivered||promised for DELIVERED else promised||delivered; `otp = unitOtp(u) || details[orderId]?.[unitId]?.otp || null`; if `otp` → force `OUT_FOR_DELIVERY`; `activityDateIso = toIso(chosen_ms) || toIso(orderDate) || ""`.
- `_num`/`_to_iso`/`_s` helpers — port `parser.py:27-46` (`_num`: positive finite float or null; `_to_iso`: ms→ISO or null).
- `ensureOrdersShape` throws a shared `AppError` (see Task 1.4).

- [ ] **Step 4: Run tests to green** — `npx vitest run src/__tests__/parser.test.ts` → PASS.

- [ ] **Step 5: Commit** — `git commit -am "feat(ext): port parser.py to TS with fixture tests"`

### Task 1.4: Port the typed error contract → `core/errors.ts`

**Files:**
- Create: `extension/src/core/errors.ts`
- Reference: `backend/app/errors.py`

**Interfaces:**
- Consumes: `ErrorCode` from `@core/types`.
- Produces: `class AppError extends Error { code: ErrorCode; message: string }`, plus `authExpired()`, `configError(m)`, `upstream(m)`, `parseError(m)`, and `toErrorPayload(e): { code: ErrorCode; message: string }`.

- [ ] **Step 1: Implement** (mirror `errors.py:26-46`; drop the HTTP-status map — no HTTP layer). **Step 2: Commit.**

---

## Phase 2 — Background fetcher & message bridge

### Task 2.1: Bounded promise pool → `background/pool.ts` (replaces ThreadPoolExecutor)

**Files:**
- Create: `extension/src/background/pool.ts`
- Test: `extension/src/__tests__/enrich.test.ts` (shared with 2.3)

**Interfaces:**
- Produces: `mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]>` — preserves input order, runs at most `limit` concurrently.

- [ ] **Step 1: Failing test**

```ts
import { mapPool } from "../background/pool";
it("keeps order and caps concurrency", async () => {
  let active = 0, peak = 0;
  const out = await mapPool([1,2,3,4,5], 2, async (n) => {
    active++; peak = Math.max(peak, active);
    await new Promise(r => setTimeout(r, 5)); active--; return n * 2;
  });
  expect(out).toEqual([2,4,6,8,10]);
  expect(peak).toBeLessThanOrEqual(2);
});
```

- [ ] **Step 2: Run → FAIL. Step 3: Implement** a simple index-cursor worker pool writing into a pre-sized results array. **Step 4: Run → PASS. Step 5: Commit.**

### Task 2.2: Port `flipkart.py` → `background/flipkart.ts`

**Files:**
- Create: `extension/src/background/flipkart.ts`
- Test: `extension/src/__tests__/flipkart.test.ts`
- Reference: `backend/app/flipkart.py`, `service.py` header logic

**Interfaces:**
- Consumes: `CONFIG` (`@flk/core/config`), `AppError`/`authExpired`/`upstream` (`@flk/core/errors`), `ensureOrdersShape` (`@flk/core/parser`).
- Produces:
  - `fetchOrders(fetchFn?: typeof fetch): Promise<unknown[]>` — paginates My Orders, follows `nextCallParams`, dedups by `orderId`, stops at `CONFIG.maxPages`/`!moreOrder`/missing `ot`.
  - `fetchDetail(orderId: string, unitId: string, shareToken: string, fetchFn?: typeof fetch): Promise<{ address?: unknown; otp?: string|null }>` — POSTs the detail page; `{}` on any failure.
  - `flkFetch(input, init)` — internal helper injecting `x-user-agent`, `accept`, `credentials: "include"`, and an `AbortController` timeout of `CONFIG.timeoutMs`.
- `fetchFn` is injectable so tests run without Chrome/network (default `globalThis.fetch`).

- [ ] **Step 1: Failing test with a stubbed fetch returning fixtures**

```ts
import { fetchOrders, fetchDetail } from "../background/flipkart";
import page1 from "../__fixtures__/orders-page1.json";
import detail from "../__fixtures__/detail-delivered.json";

const stub = (body: unknown, status = 200) =>
  (async () => ({ status, ok: status === 200, json: async () => body })) as unknown as typeof fetch;

it("fetchOrders returns the orders array from a single page", async () => {
  const orders = await fetchOrders(stub(page1));
  expect(Array.isArray(orders)).toBe(true);
  expect(orders.length).toBeGreaterThan(0);
});
it("fetchOrders raises AUTH_EXPIRED on 401", async () => {
  await expect(fetchOrders(stub({}, 401))).rejects.toMatchObject({ code: "AUTH_EXPIRED" });
});
it("fetchDetail extracts address/otp", async () => {
  const d = await fetchDetail("OD1", "U1", "", stub(detail));
  expect(d.address ?? d.otp).toBeTruthy();
});
```

- [ ] **Step 2: Run → FAIL. Step 3: Implement** — port `fetch_orders` (`flipkart.py:35-73`) and `fetch_detail` (`flipkart.py:76-114`) verbatim:
  - Headers: `{ "x-user-agent": CONFIG.fkua, "accept": "application/json", "content-type": "application/json" (POST only) }`. **Do NOT set `user-agent` or `referer`** — both are forbidden fetch headers; the real Chrome UA and same-site Referer are supplied by the browser.
  - GET orders with `credentials: "include"`; `401/403` → `authExpired()`; first-page non-200 → `upstream(...)`; later non-200 → break; first page runs `ensureOrdersShape`.
  - Pagination query mirrors `flipkart.py:65-71` (`order_before_time_stamp` from `ot`, spread remaining `nextCallParams`).
  - `fetchDetail` builds the exact `requestContext`/`pageContext` body from `flipkart.py:78-97`, POSTs, returns `extractDetail(json)` only if address or otp present, else `{}`; swallow all errors → `{}`.
- [ ] **Step 4: Run → PASS. Step 5: Commit.**

### Task 2.3: Port `service.py` enrichment → `background/enrich.ts`

**Files:**
- Create: `extension/src/background/enrich.ts`
- Test: extend `extension/src/__tests__/enrich.test.ts`
- Reference: `backend/app/service.py:12-53`

**Interfaces:**
- Consumes: `parser.get`, `parser.mapStatus`, `fetchDetail`, `mapPool`, `CONFIG`.
- Produces: `enrichDetails(rawOrders: unknown[], onProgress?: (done: number, total: number) => void): Promise<Record<string, Record<string, {address?: unknown; otp?: string|null}>>>`.

- [ ] **Step 1: Failing test** — given raw orders with one OFD unit and one delivered order, assert the active unit is targeted and delivered orders are capped at `CONFIG.maxDetails`.
- [ ] **Step 2: Run → FAIL. Step 3: Implement** the `_enrich_details` selection logic (`service.py:12-53`): collect active (`OUT_FOR_DELIVERY`/`ARRIVING`, non-VAS) targets in any position, plus first-unit "address-only" targets for orders with no active unit; `targets = active.slice(0, 300).concat(addressOnly.slice(0, maxDetails))`; run via `mapPool(targets, CONFIG.detailConcurrency, fetchDetail)`; fold into `{orderId: {unitId: detail}}`; call `onProgress` after each. **Step 4: Run → PASS. Step 5: Commit.**

### Task 2.4: Message protocol → `messaging/protocol.ts`

**Files:**
- Create: `extension/src/messaging/protocol.ts`

**Interfaces:**
- Produces typed messages used by worker ↔ UI:

```ts
import type { ParsedOrder, ErrorCode } from "@core/types";
export type FetchRun = { type: "RUN_FETCH"; accountLabel: string };
export type Progress = { type: "PROGRESS"; phase: "orders" | "details"; done: number; total: number };
export type Result   = { type: "RESULT"; orders: ParsedOrder[]; fetchedAt: string };
export type Failure  = { type: "ERROR"; error: { code: ErrorCode; message: string } };
export type FromWorker = Progress | Result | Failure;
```

- [ ] **Step 1: Implement. Step 2: Commit.**

### Task 2.5: Service worker entry → `background/worker.ts` + real manifest

**Files:**
- Create: `extension/src/background/worker.ts`
- Modify: `extension/manifest.config.ts`
- Create: `extension/public/icon-{16,32,48,128}.png`

**Interfaces:**
- Consumes: `fetchOrders`, `enrichDetails`, `parseOrders`, protocol types.
- Produces: a `chrome.runtime.onConnect` port handler that, on `RUN_FETCH`, runs `fetchOrders → enrichDetails → parseOrders`, streaming `PROGRESS` and finally `RESULT` (or `ERROR` via `toErrorPayload`). Opens the UI page on toolbar click.

- [ ] **Step 1: Write `manifest.config.ts`**

```ts
import { defineManifest } from "@crxjs/vite-plugin";
export default defineManifest({
  manifest_version: 3,
  name: "Flipkart Delivery Tracker",
  version: "1.0.0",
  description: "See your Flipkart orders as one row per shipment — tracking, status, OTP, address — and export CSV. Runs 100% in your browser.",
  permissions: ["storage"],
  host_permissions: ["https://www.flipkart.com/*"],
  background: { service_worker: "src/background/worker.ts", type: "module" },
  action: { default_title: "Open Flipkart Delivery Tracker" },
  icons: { 16: "icon-16.png", 32: "icon-32.png", 48: "icon-48.png", 128: "icon-128.png" },
  web_accessible_resources: [{ resources: ["src/ui/index.html"], matches: ["https://www.flipkart.com/*"] }],
});
```

- [ ] **Step 2: Write `worker.ts`**

```ts
import { fetchOrders } from "./flipkart";
import { enrichDetails } from "./enrich";
import { parseOrders } from "@flk/core/parser";
import { toErrorPayload } from "@flk/core/errors";
import type { FetchRun, FromWorker } from "@flk/messaging/protocol";

chrome.action.onClicked.addListener(() =>
  chrome.tabs.create({ url: chrome.runtime.getURL("src/ui/index.html") }));

chrome.runtime.onConnect.addListener((port) => {
  port.onMessage.addListener(async (msg: FetchRun) => {
    if (msg.type !== "RUN_FETCH") return;
    const send = (m: FromWorker) => port.postMessage(m);
    try {
      const raw = await fetchOrders();
      send({ type: "PROGRESS", phase: "orders", done: raw.length, total: raw.length });
      const details = await enrichDetails(raw, (done, total) =>
        send({ type: "PROGRESS", phase: "details", done, total }));
      const orders = parseOrders(raw, details).map((o) => ({ ...o, account: msg.accountLabel }));
      send({ type: "RESULT", orders, fetchedAt: new Date().toISOString() });
    } catch (e) {
      send({ type: "ERROR", error: toErrorPayload(e) });
    }
  });
});
```

- [ ] **Step 3: Add placeholder icons** (any 16/32/48/128 PNG; final art in Phase 6).
- [ ] **Step 4: Build + load unpacked; click icon → UI tab opens; (UI wired in Phase 3).**
Run: `npm run build`, load `extension/dist`, click action. Expected: a new tab opens at the UI page.
- [ ] **Step 5: Commit.**

---

## Phase 3 — UI (reuse existing React, swap the shell)

### Task 3.1: Copy presentational components + wire Tailwind

**Files:**
- Copy (unchanged logic): `src/components/{OrderList,OrderCard,OrderFilters,RefreshBar,StatusBadge,ErrorNotice}.tsx` → `extension/src/ui/`
- Create: `extension/src/ui/index.html`, `main.tsx`, `globals.css` (import Tailwind), reuse `@core/orders/filters` + `@core/orders/csv` directly.

**Interfaces:**
- Produces: a mounted React root rendering `<App/>`.

- [ ] **Step 1:** Copy the six components; fix imports to `@core/types`, `@core/orders/*`. They have no Next.js coupling (verified: `"use client"` + Tailwind classes only) — drop the `"use client"` directive (meaningless outside Next).
- [ ] **Step 2:** `index.html` + `main.tsx` (`createRoot(...).render(<App/>)`), `globals.css` = `@import "tailwindcss";`.
- [ ] **Step 3:** Build; confirm the page renders empty chrome. **Step 4: Commit.**

### Task 3.2: Snapshot store → `storage/snapshots.ts` (multi-account without a server)

**Files:**
- Create: `extension/src/storage/snapshots.ts`
- Test: `extension/src/__tests__/snapshots.test.ts`

**Interfaces:**
- Produces:
  - `type Snapshot = { label: string; orders: Order[]; fetchedAt: string }`
  - `saveSnapshot(s: Snapshot): Promise<void>` (keyed by `label`)
  - `listSnapshots(): Promise<Snapshot[]>`
  - `removeSnapshot(label: string): Promise<void>`
  - `mergedOrders(): Promise<Order[]>` (union across snapshots)
- Backed by `chrome.storage.local`; in tests, inject a fake via a module-level `setStore()` seam or mock `chrome.storage`.

- [ ] **Step 1: Failing test** — save two labels, assert `mergedOrders` unions and `removeSnapshot` drops one.
- [ ] **Step 2: Run → FAIL. Step 3: Implement** over `chrome.storage.local` (`fkrt.snapshots` key holding `Record<label, Snapshot>`). **Step 4: Run → PASS. Step 5: Commit.**

### Task 3.3: Rewrite `AccountsPanel` for snapshots (no cookie drop)

**Files:**
- Create: `extension/src/ui/AccountsPanel.tsx` (replaces the cookie-file UI)

**Interfaces:**
- Consumes: `listSnapshots`, `removeSnapshot`, and a `onFetchAccount(label: string)` callback (triggers a run for the currently-logged-in Flipkart account under that label).
- Produces: a panel listing saved account snapshots with `fetchedAt` + row count, a "Label + Fetch this account" control, and per-row Remove.

- [ ] **Step 1: Implement** — text input for the account label + "Fetch current login" button (calls `onFetchAccount`), list of snapshots with age + count + Remove. Copy explains: *"Log into a Flipkart account, name it, and Fetch. To add another account, log out, log into the next one, and Fetch again — all fetched accounts stay listed here."*
- [ ] **Step 2: Commit.**

### Task 3.4: Adapt `Dashboard.tsx` to the worker + snapshots

**Files:**
- Create: `extension/src/ui/Dashboard.tsx` (adapted from `src/components/Dashboard.tsx`)
- Create: `extension/src/ui/App.tsx`

**Interfaces:**
- Consumes: `mergedOrders`, `saveSnapshot` (`@flk/storage/snapshots`), protocol types, `applyOrderFilters`/`ordersToCsv` (`@core/orders/*`).
- Produces: `<Dashboard/>` — on mount loads `mergedOrders()`; "Fetch this account" opens `chrome.runtime.connect()`, posts `RUN_FETCH`, renders `PROGRESS` in the `RefreshBar`, on `RESULT` calls `saveSnapshot({label, orders, fetchedAt})` then reloads merged orders; `ERROR` → `<ErrorNotice/>`. CSV/filter code path is unchanged (reuses `applyOrderFilters` + `ordersToCsv`).

- [ ] **Step 1: Implement** — replace the three `fetch(\`${API_BASE}/api/...\`)` calls (`Dashboard.tsx:47-75`) with the port connection + snapshot store. Keep `applyOrderFilters`/`ordersToCsv`/filter state verbatim. `timezone` comes from `CONFIG.timezone` (no server response). Auto-refresh re-runs `RUN_FETCH` for the last-fetched label.
- [ ] **Step 2: Build, load unpacked, log into flipkart.com, click Fetch.**
Run: manual — Expected: progress advances (orders → details), rows appear one-per-shipment, OFD rows show OTP, CSV downloads with the exact 10 columns, filters work.
- [ ] **Step 3: Commit.**

### Task 3.5: Port the existing UI tests

**Files:**
- Copy: `src/components/OrderList.test.tsx` → `extension/src/__tests__/`; keep `src/lib/orders/{csv,filters}.test.ts` runnable via `@core`.

- [ ] **Step 1:** Adjust imports; run `cd extension && npm test`. Expected: parser, flipkart, enrich, pool, snapshots, csv, filters, OrderList all PASS. **Step 2: Commit.**

---

## Phase 4 — Robustness

### Task 4.1: Live FKUA fallback (staleness guard)

**Files:** Modify `extension/src/background/flipkart.ts`.

**Interfaces:** unchanged public API; `flkFetch` first tries `CONFIG.fkua`, and if orders return `401/403`, retries once reading a fresh FKUA.

- [ ] **Step 1: Failing test** — stub returns 403 for the hardcoded FKUA, 200 for the "fresh" one; assert one retry then success.
- [ ] **Step 2: Implement** — obtain a live FKUA via `chrome.scripting.executeScript` on a flipkart.com tab reading the site's own value if present, else keep the constant. Guard with try/catch (no tab → constant). **Step 3: PASS. Step 4: Commit.**

### Task 4.2: "Not logged in" and empty-state UX

**Files:** Modify `Dashboard.tsx`, `AccountsPanel.tsx`.

- [ ] **Step 1:** On `AUTH_EXPIRED`, show an actionable notice: *"Open flipkart.com and log in, then Fetch again."* with a button that `chrome.tabs.create({url:"https://www.flipkart.com/account/orders"})`. **Step 2:** Empty merged store → onboarding copy mirroring the README section 3 but for the new flow. **Step 3: Commit.**

---

## Phase 5 — Retire the server surface (only after Phase 3 parity is confirmed)

### Task 5.1: Delete the backend + Docker + Next shell; keep shared libs

**Files:**
- Remove: `backend/`, `docker-compose.yml`, `Dockerfile`, `next.config.ts`, `src/app/`, `src/components/*` (now living in `extension/src/ui/`), root `.env*` samples that reference the backend.
- Keep: `src/lib/types.ts`, `src/lib/orders/*` (imported by the extension) — or move them into `extension/src/core/` and update the alias, if a single tree is preferred.

- [ ] **Step 1:** Grep for dangling references: `grep -rn "API_BASE\|NEXT_PUBLIC_BACKEND_URL\|backend" extension src` → expect none in shipped code.
- [ ] **Step 2:** Rewrite `README.md`: remove Docker/cookie-export/backend sections; add "Install from Chrome Web Store" + "Log in → Fetch → Export" + multi-account-by-relogin. **Step 3:** `cd extension && npm test && npm run build` green. **Step 4: Commit** `refactor: remove server/Docker; extension is the whole app`.

---

## Phase 6 — Chrome Web Store publishing ("public")

### Task 6.1: Store assets & policy

**Files:** `store/privacy-policy.md`, `store/listing.md`, `store/screenshots/*`, final `extension/public/icon-*.png`.

- [ ] **Step 1: Privacy policy** stating: the extension reads only the user's own Flipkart order data using their existing session; **all data stays on the device** (`chrome.storage.local`); no servers, no third parties, no analytics; CSV export is local. Host it (GitHub Pages) and link it in the listing.
- [ ] **Step 2: Permission justifications** for the review form:
  - `host_permissions https://www.flipkart.com/*` — "read the signed-in user's own order list/detail JSON to display and export it."
  - `storage` — "cache fetched orders locally for the dashboard and multi-account merge."
  - **Single purpose:** "Display and export the user's own Flipkart orders." (Do not add unrelated features — Web Store single-purpose rule.)
- [ ] **Step 3:** 128px icon, ≥1 `1280×800` screenshot, short + detailed description (from `listing.md`).
- [ ] **Step 4: Commit.**

### Task 6.2: Package & submit

- [ ] **Step 1:** `cd extension && npm run build`, zip `extension/dist`.
- [ ] **Step 2:** Create a Chrome Web Store developer account ($5), upload the zip, fill listing + privacy + data-usage disclosures, request `host_permissions` review, submit. **Step 3:** Record the item ID + review status. (Expect a review round-trip on the flipkart.com host permission; the privacy policy + single-purpose statement are what clear it.)

---

## Self-Review

**Spec coverage:**
- "No server" → Phases 2–3 do everything in the SW/UI; Phase 5 deletes the backend. ✔
- "Public / Chrome" → MV3 manifest (2.5), Web Store submission (6). ✔
- "Take the details and export" → orders+detail fetch (2.2/2.3), parse (1.3), one-row-per-shipment (`parseOrders`), CSV export reuses `csv.ts` (3.4). ✔
- Parity with current features (filters, statuses, OTP=OFD, multi-account, CSV columns) → filters/csv reused verbatim; multi-account via snapshots (3.2–3.4). ✔ (Multi-account UX changes from "drop N cookie files" to "re-login per account" — the unavoidable single-profile constraint, called out.)

**Risk register (validate during execution, not assumed):**
- **R1 (blocking):** SW cross-site cookie attach could fail if the user blocks third-party cookies → Phase 0 gate + content-script fallback (identical protocol).
- **R2:** Flipkart CSP could block requests → surfaced by the Phase 0 spike.
- **R3:** FKUA staleness → Task 4.1.
- **R4:** parser port drift → fixture tests (1.3) are the guard; capture real fixtures in 0.1.5.
- **R5:** Web Store rejection of the host permission → mitigated by privacy policy + single-purpose (6.1).

**Placeholder scan:** none — every code step contains real content; icons/screenshots are explicitly art-in-Phase-6.

**Type consistency:** `ParsedOrder`/`Order`/`OrderStatus`/`ErrorCode` come from the single `@core/types`; `fetchOrders`/`fetchDetail`/`enrichDetails`/`parseOrders`/`mapPool`/snapshot signatures are used identically across Tasks 1.3 → 2.2 → 2.3 → 2.5 → 3.4.

## Execution Handoff

Plan saved to `docs/plans/2026-07-06-flipkart-public-chrome-extension.md`. Two execution options:
1. **Subagent-Driven (recommended)** — fresh subagent per task, review between tasks. **Start with Phase 0 — do not build the port until the spike passes.**
2. **Inline Execution** — batch with checkpoints.
