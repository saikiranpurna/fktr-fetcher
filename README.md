# Flipkart Delivery Tracker

Internal single-page tool for a delivery team. It fetches **today's** Flipkart orders that are
**Out for Delivery** or **Delivered** across **multiple Flipkart accounts**, aggregates them into one
view, and shows per order: Account, Order ID, customer name, item, delivery address, and delivery
**OTP**. The whole result exports as a single **CSV** (opens directly in Excel).

By default it works like a real browser: for each account it opens **flipkart.com "My Orders"** in
**headless Chromium** using your session cookie, lets the page load your orders, and reads them off
the page — so you only need to paste each account's cookie, nothing else. It uses your own accounts'
sessions directly (no seller API).

## Prerequisites

- **Node.js 22+** and **npm 10+** (verified against Node 22.22, npm 10.9).
- `npm install` also downloads a **Chromium** build (via `puppeteer`) used for headless rendering.

## Install & run

```bash
npm install                 # also fetches Chromium for puppeteer
cp .env.example .env.local  # optional — defaults work out of the box
npm run dev                 # http://localhost:3000
npm run build && npm start  # production
```

### First run

There's no fake-data mode. On first load it shows an actionable prompt:

- No accounts yet → *"Add at least one account's cookie JSON in the Accounts panel."*

Add one account's cookie (below) and today's orders appear.

## Adding an account (the only setup step)

1. Log in to `https://www.flipkart.com/` in your browser (for each account you want to track).
2. Export that account's cookies **as JSON** with a cookie exporter — e.g. the **Cookie-Editor**
   extension → **Export → JSON**.
3. In the app's **Accounts** panel, **drop the `.json` file(s)** onto the dropzone (or click to
   choose). Each file becomes one account, labelled from its filename — drop several at once for
   several accounts. (A manual paste box is available under "or paste a cookie manually".)

That's it — the app renders each account's My Orders page in the background and reads the orders. You
don't need to find any API/endpoint.

## How it fetches (fetch modes)

Set with `FLIPKART_FETCH_MODE`:

- **`browser`** (default) — renders `flipkart.com/account/orders` in headless Chromium (stealth) with
  your cookie, then **paginates** the orders API (7/page, most recent first) using the page's own
  session/headers — up to `FLIPKART_MAX_PAGES` (default 20 ≈ 140 orders). Only needs the cookie.
- **Delivery address + live OTP** come from each order's detail page (`/api/4/page/fetch`), replayed
  in the same session for up to `FLIPKART_MAX_DETAILS` most-recent orders (default 40; `0` disables).
- **`http`** (advanced) — replays a known orders **JSON endpoint** directly (lighter, no browser).
  Requires `FLIPKART_ORDERS_URL` set to the captured request. Use this if you'd rather point at the
  exact XHR (DevTools → Network → Copy as cURL) than run a browser.

Both go through the same parser/filter/aggregation; only the fetch step differs.

## Multiple accounts

- `/api/orders` fetches every account **concurrently** and returns the **union of all parsed orders**,
  each tagged with its account. Filtering (status / date / account / search) runs on the client, so the
  list and CSV always match. Date scopes: All, Today, Tomorrow, Next 7 days, Last 7 days.
- **Partial success is success:** if one account's cookie is expired, that account is flagged (red
  chip + a banner) and the others still load — one bad cookie never blanks the dashboard.

## CSV / Excel export

Click **Download CSV** (or `GET /api/export`) → `flipkart-deliveries-<YYYY-MM-DD>.csv`. Columns:
`Account, Order ID, Customer Name, Item, Delivery Address, OTP, Status, Activity Date`. UTF-8 with a
BOM and RFC-4180 quoting, so it opens correctly in Excel (incl. non-ASCII names/addresses).

## Residential proxy (optional, e.g. Decodo)

Fetching many accounts from one server IP invites rate-limits/blocks. Set `FLIPKART_PROXY_URL` to
route through a residential proxy. Include a literal `{session}` token to pin a **stable IP per
account** (each account's id is substituted in):

```
FLIPKART_PROXY_URL=http://USER-session-{session}:PASS@gate.decodo.com:7000
```

Works in both fetch modes (browser via a per-account proxied context, http via an undici dispatcher).
Empty = direct connection. Credentials are never logged.

## Environment reference

Copy `.env.example` to `.env.local`. In `browser` mode all of these are optional.

| Variable | Default | Purpose |
| --- | --- | --- |
| `FLIPKART_FETCH_MODE` | `browser` | `browser` (headless Chromium) or `http` (JSON endpoint). |
| `FLIPKART_ORDERS_URL` | _(empty)_ | browser: My Orders page URL (defaults to `flipkart.com/account/orders`). http: the orders JSON endpoint (**required in http mode**). |
| `FLIPKART_BASE_HEADERS` | `{}` | Extra request headers as JSON (e.g. User-Agent, CSRF). |
| `FLIPKART_TIMEOUT_MS` | `15000` | Per-account request / page-render budget (ms). |
| `FLIPKART_PROXY_URL` | _(empty)_ | Residential proxy; optional `{session}` token for per-account sticky IPs. |
| `APP_TIMEZONE` | `Asia/Kolkata` | Timezone used to compute "today". |
| `LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error`. |
| `SESSION_STORE_PATH` | `.flipkart-session.json` | Where uploaded account cookies are persisted (gitignored). |
| `ADMIN_TOKEN` | _(empty)_ | When set, account mutation routes require header `x-admin-token`. |


## Verifying / tuning what it reads

Use the diagnostic harness — it fetches every configured account with the **same client the app
uses** and prints what it got:

```bash
npm run diag     # loads .env.local
```

It shows the fetch mode, page/endpoint, proxy status, and per account: content-type, the first ~800
chars of the body, the parsed order count, and the first parsed order (or the error). If the parsed
count is 0 but a body is present, the field/selector names differ — adjust `JSON_FIELDS` (JSON
responses) or `HTML_SELECTORS` (rendered DOM) in `src/lib/flipkart/parser.ts` to match flipkart.com,
then re-run. This is the one place you tune for the live site.

## Cookie maintenance

Flipkart cookies expire ~daily. When one expires its Accounts chip turns red (with the error code)
and a banner lists the failed accounts; the rest keep loading. Recover **without restarting**:
re-export that account's cookies and re-add it under the same label (it replaces the old entry).

## "Today" semantics

An order counts as "today" when its **delivery-activity timestamp** (when it reached its current OFD/
Delivered status) falls on today's date in `APP_TIMEZONE`. If there's no per-order status timestamp,
the parser falls back to the order-placed date (`activityDateIso = statusUpdatedAt ?? orderDate`).

## API

| Route | Method | Purpose |
| --- | --- | --- |
| `/api/orders` | GET | Today's orders across all accounts + per-account status. |
| `/api/export` | GET | CSV download of the aggregated orders. |
| `/api/accounts` | GET | List account metadata (never cookie values). |
| `/api/accounts` | POST | Add/replace an account: `{ label, cookie }`. |
| `/api/accounts` | DELETE | `?id=<id>` removes one; no id clears all. |

`/api/orders` returns `200` with `orders: []` for an empty day (empty ≠ error). Per-account
`AUTH_EXPIRED` / `UPSTREAM_ERROR` / `PARSE_ERROR` are reported inside the `accounts` array of a `200`
response. Global failures use the mapped status: `CONFIG_ERROR` → 400, `AUTH_EXPIRED` → 401,
`UPSTREAM_ERROR` / `PARSE_ERROR` → 502, `UNKNOWN` → 500.

## Logging

Structured JSON lines, level-gated by `LOG_LEVEL`. `cookie`, `authorization`, and `set-cookie` are
recursively redacted to `[REDACTED]`; proxy credentials are never logged.

## Tests

```bash
npm test          # Vitest (unit + integration, incl. real headless-Chromium round-trips)
npm run test:watch
```

## Deploy notes

- API routes run on the **Node.js runtime** (they use `fs`, `fetch`, undici `ProxyAgent`, and — in
  browser mode — puppeteer/Chromium). `puppeteer` is marked as a server-external package.
- The deploy host needs the **Chromium** puppeteer downloads (or set `PUPPETEER_EXECUTABLE_PATH` to a
  system Chrome) and enough memory to run it. If you can't run a browser there, use `http` mode.
- Uploaded account cookies are stored in a **plaintext, gitignored file** (`SESSION_STORE_PATH`);
  ensure a writable, persisted path.
- Set **`ADMIN_TOKEN`** in any shared deployment so account mutation routes require `x-admin-token`.
