# Flipkart Delivery Tracker

Internal tool for a delivery team. It reads Flipkart **My Orders** for one or more Flipkart accounts,
using each account's browser cookie, and shows **one row per shipment**: order ID,
shipment/**tracking ID**, item, status, delivery **OTP**, customer **mobile**, delivery address, GSTIN,
**price paid**, expected / delivered dates, and any **cancellation, replacement or refund**. Filter by
status / date / account / search and export to **CSV / Excel**.

> **Local use only: never deploy it to a server.** The app runs as a local Docker build on **one
> machine**. It shows customer names, addresses, phone numbers and live delivery OTPs and stores
> Flipkart session cookies, so every port listens on `127.0.0.1` only. It is reachable from this
> computer's browser, not from your network. Keep it that way (see
> [Security / privacy](#security--privacy)).

- A single order ID can appear as **several rows** (one per shipment), each with its own tracking ID,
  item, status, OTP and mobile. A **replacement** shipment gets its own row too.
- A shipment with an **OTP** always counts as **Out for Delivery**, and so does a failed delivery
  attempt that is waiting for re-delivery (Flipkart's "Delivery attempted").

> **Chrome extension: frozen.** [`extension/`](extension/README.md) holds an earlier, fully
> client-side Chrome extension. It is frozen and no longer maintained, and it doesn't get the price or
> cancellation / replacement / refund data. The Docker app below is the supported setup.

---

## 1. Prerequisites

- **Docker Desktop** installed and **running** (Windows/macOS/Linux). This is the only requirement
  to run the app. On Windows, Docker Desktop with the WSL2 backend.
- A **Flipkart account** you're logged into in a normal browser (to export its cookie).

> You do **not** need Node, Python, or Chromium installed — everything runs inside Docker.

---

## 2. Quick start (Docker)

From the project folder (the one containing `docker-compose.yml`). In PowerShell, put a path that
has spaces in quotes, e.g. `cd "C:\Users\Your Name\Desktop\fktr-fetcher-main"`; without them `cd`
fails with *A positional parameter cannot be found*.

```bash
docker compose up --build -d
```

- First build takes **~2–3 minutes** (downloads dependencies). Later starts are instant.
- When it's up:
  - **App (open this):** http://localhost:3100
  - Backend API (optional/debug): http://localhost:8000
  - MinIO console (optional): http://localhost:9001 (log in with `MINIO_ROOT_USER` /
    `MINIO_ROOT_PASSWORD`, default `minioadmin` / `minioadmin`)

Check it's running:

```bash
docker compose ps -a       # "minio", "backend" and "frontend" should be Up, on 127.0.0.1 ports
```

`minio-perms` shows **Exited (0)**: that's expected. It's a one-shot step that makes MinIO's storage
volume writable for MinIO before MinIO starts.

Stop it:

```bash
docker compose down        # stop containers (your accounts are kept)
docker compose down -v     # also delete the volumes, i.e. every stored cookie (start fresh)
```

---

## 3. Add your Flipkart accounts (in the app)

The board is empty until you add an account cookie.

1. In a normal browser, **log in** at <https://www.flipkart.com/>.
2. Install a cookie exporter (e.g. the **Cookie-Editor** browser extension).
3. On flipkart.com, open Cookie-Editor → **Export → JSON** and save it as a `.json` file (a `.txt`
   file with the same JSON, or a raw `name=value; name2=value2` cookie header, also works).
   **The file name (without `.json` / `.txt`) becomes the account's label**, so name it after the
   account, e.g. `north-store.json`.
4. Open the app (http://localhost:3100) → **Accounts** tab → **Add accounts** → drag the file(s)
   onto the drop zone (or click to browse). You can drop several files at once, and one file can
   hold **several accounts** (a JSON array of `{label, cookie}` objects, or a `{label: cookie}` map).
   **Paste a cookie manually** (with an optional label) works too.

Each new account is fetched in the background straight away. Its status shows **Queued** or
**Refreshing** until the first fetch finishes, usually within a couple of minutes (many new accounts
are worked through 16 at a time). The board doesn't update by itself: click **Refresh** (or turn on
**Auto-refresh**) to see its orders. Cookies are saved as **one object per account in MinIO** (S3
object storage, bundled in Docker).

**Account status**, shown next to each account in the **Accounts** tab:

| Status / note | Meaning |
|---|---|
| **Working** | The last fetch succeeded |
| **Queued** / **Refreshing** | Waiting for / running its first fetch |
| **Session expired** | The cookie expired: renew it (below) |
| **Error** | Flipkart couldn't be reached or answered unexpectedly (the message is shown under the account). Retried at the next scheduled fetch |
| **Paused** | Made inactive: cookie kept, not fetched, and its orders are hidden from the board |
| *partial history* | A later page of the order history didn't load (or the account hit its time or page limit), so older orders may be missing |
| *N details failed* | N detail lookups failed in the last fetch, so some shipments' address, mobile, OTP or cancellation / replacement dates may be missing |

**Renewing an expired account.** Flipkart sessions are short-lived. When an account shows **Session
expired**, log in to flipkart.com again, re-export the cookie, and add it **under the same label as
before**: save it with the same file name (or use that label inside a multi-account file, or under
**Paste a cookie manually**). Same label = the existing account is updated. The backend starts
refetching it right away instead of waiting for the 30-minute cycle; click **Refresh** after a minute
or two. A different label adds a *new* account, so remove the old one.

**Pause or remove accounts.** Tick accounts (or **Select all**), then **Make inactive** (pause: cookie
kept, not fetched, orders hidden), **Activate**, or **Remove** (asks you to confirm). Each account row
also has its own **Remove**. If `ADMIN_TOKEN` is set (section 5), enter it in the **Admin token**
field under **Add accounts** first.

---

## 4. Using the app

- **Refresh** re-reads the backend's order cache. It's instant and doesn't call Flipkart.
  **Auto-refresh (60s)** does the same every 60 seconds. The backend itself refetches every active
  account from Flipkart in the background every **30 minutes** (`REFRESH_INTERVAL_S`), so a new OTP
  or status appears after that account's next background fetch. The chip next to the buttons shows
  how many accounts are up to date, still refreshing, or failing.
- **Filters:**
  - Status pills: **Out for Delivery / Arriving / Delivered / Cancelled / Other** (click to toggle;
    counts in brackets).
  - **Date:** All dates / Today / Tomorrow / Next 7 days / Last 7 days / **Custom range** (From and
    To dates, both included; leave either blank), based on each row's **Activity Date**. For
    cancelled, replaced or refunded shipments that is the latest of those events, so **Today** and
    **Last 7 days** include recent cancellations and refunds. Otherwise it is the delivered date
    (delivered shipments) or the expected date, falling back to the order date.
  - **Account** picker (when you have more than one account).
  - **Search:** order ID, tracking ID (FMPP…), mobile number, item, customer, account label, or
    **Replacement Of**, so searching an original tracking ID also finds its replacement shipment.
  - **Refund:** any / completed / in progress / no refund.
  - **Price ₹** min and max (both included). While either is set, rows with no known price are hidden.
  - **Has OTP / Replacement / Has GSTIN / Details failed:** a row must match every box you tick.
- **Order cards** show the price, "Expected …" or "Delivered …", and a short history
  (Cancelled, Replacement requested / delivered / cancelled, Refund ₹… initiated / completed) when
  there is one. A replacement shipment's card is tagged **Replacement of &lt;tracking ID&gt;**.
  **Details unavailable** means that shipment's detail lookup failed.
  - The price reads **Paid ₹…**, or says why nothing was paid: **Not charged (order not placed)**
    (the payment never went through), **Free replacement**, or **Free**.
  - Free add-ons that ride on a product (e.g. **Flipkart Trust Shield**, voucher freebies) aren't
    shipments, so they get no card or CSV row.
  - Delivered cards have **Download invoice**: that shipment's **tax invoice**, one PDF
    (`invoice-<order ID>-<tracking ID>.pdf`). Flipkart only hands out an order's invoices as one
    bundle (tax invoices, fee invoices and transport documents for every shipment); the app picks out
    this shipment's tax invoice by its product (FSN). When an order has several **identical** units,
    Flipkart's invoices don't say which shipment each one is for, so they are paired in a fixed order:
    every card always gets the same invoice and no two cards share one, but the IMEI / serial printed
    on it may be another unit's of that order.
- **Download CSV** exports exactly what's currently shown (it respects your filters). A tracking ID
  that appears twice (e.g. the same account added twice) is exported once. Opens cleanly in Excel
  (UTF‑8 BOM).
- **Invoices (ZIP)** saves the tax invoices of **exactly the delivered cards currently shown** (same
  filters as the list and the CSV; the button shows how many): one ZIP with a folder per order and a
  PDF per shipment (`<order ID>/<tracking ID>.pdf`). Cards without one (not shipped yet, or Flipkart
  hasn't issued it) are listed in the ZIP's `missing.txt`. Each order's bundle is fetched once, so a
  ZIP covers the cards of up to `INVOICE_ZIP_MAX` (100) orders; with more, each click saves the next
  batch (the note shows which orders). An order shared between accounts is fetched through whichever
  of them still works (one may be paused or have an expired session).

### CSV columns

In this order. The first eleven (up to **GSTIN**) are unchanged from earlier versions; the newer
columns come after them, so sheets built on the old layout keep working.

| Column | Contents |
|---|---|
| Account | The account's label |
| Order ID | Flipkart order ID (several rows can share one) |
| Tracking ID | Shipment ID (FMPP…); blank until shipped |
| Customer Name, Item, Delivery Address, Mobile | As on the card |
| OTP | Live delivery OTP, while the shipment is out for delivery |
| Status | Out for Delivery / Arriving / Delivered / Cancelled / Other |
| Activity Date | The date the filters use (see above) |
| GSTIN | The order's GST number from its "GST details" section; blank when it has none |
| Price Paid | What the customer paid for this shipment's item, after discounts (₹, plain number; `0` when nothing was charged, e.g. an order that was never placed or a free exchange) |
| Expected Date | Promised delivery date |
| Delivered Date | Actual delivery date |
| Cancelled Date | When the shipment was cancelled |
| Replacement Of | On a replacement shipment's row: the **original** shipment's tracking ID |
| Replacement Date | On the original shipment's row: when its replacement was requested (the latest one, if there were several) |
| Replacement Delivered Date | On the original's row: when that replacement was delivered |
| Replacement Cancelled Date | On the original's row: when that replacement was cancelled |
| Refund Amount | Total refunded for this shipment, all partial refunds added up (₹, plain number) |
| Refund Status | `completed` (every refund credited), `initiated` (still in progress), or blank (no refund) |
| Refund Date | Latest completed refund date, or the latest initiated date while none has completed yet |
| Details | Whether this shipment's detail lookup succeeded (`ok`), failed (`failed`) or wasn't attempted (`skipped`) |

- Every date column, **Activity Date** included, is in **IST**, formatted `YYYY-MM-DD HH:mm` (the
  timezone is `APP_TIMEZONE`, default `Asia/Kolkata`). Amounts are plain numbers, so Excel can sum
  them.
- **Empty cells and `Details`:** Cancelled Date, the replacement dates and a returned item's refund
  date (like the address and mobile) come from the shipment's detail lookup. With `Details` = `ok`,
  an empty cell there means *none*; with `failed` or `skipped`, it means *unknown*. Price Paid,
  Expected Date, Refund Amount and Refund Status come with the order list, so they don't depend on
  `Details`.
- Orders with a cancelled / replaced / refunded shipment are only looked up if they were placed in
  the last **30 days** (`FLIPKART_HISTORY_DAYS`), at most 150 orders per account per fetch, so older
  history may show `skipped`.

---

## 5. Configuration (optional)

Defaults work out of the box. To tune the backend, copy `.env.example` to **`.env`** in the project
root (Docker Compose reads it automatically), then edit:

| Variable | Default | Purpose |
|---|---|---|
| `APP_TIMEZONE` | `Asia/Kolkata` | Timezone for the date filters and every date on the cards and in the CSV |
| `REFRESH_INTERVAL_S` | `1800` (30 min) | How often the backend refetches each active account from Flipkart, in seconds (minimum 30). Lower = fresher OTPs and statuses, but more load on Flipkart |
| `FETCH_CONCURRENCY` | `16` | Accounts fetched at the same time |
| `FLIPKART_MAX_PAGES` | `100` | Order-history pages per account (7 orders/page). Stops early when there are no more; hitting the cap marks the account *partial history* |
| `FLIPKART_MAX_DETAILS` | `40` | Address lookups (one per order) for other recent orders with no active shipment; out-for-delivery / arriving shipments always get theirs. `0` turns off only these address lookups |
| `FLIPKART_HISTORY_DAYS` | `30` | Orders with a cancelled / replaced / refunded shipment get their lifecycle lookup only if placed in the last N days |
| `FLIPKART_MAX_HISTORY_DETAILS` | `150` | Safety cap on those lookups (one per order) per account per fetch (`0` turns them off) |
| `FLIPKART_TIMEOUT_MS` | `20000` | Per-request timeout |
| `INVOICE_ZIP_MAX` | `100` | Most orders whose cards one **Invoices (ZIP)** download covers (each order's invoice bundle is one Flipkart request, several MB for a bulk order); with more, each click saves the next batch |
| `FLIPKART_INVOICE_URL` | Flipkart's endpoint | Where an order's invoices are fetched (`<url><orderId>`). Change it only if Flipkart moves the endpoint |
| `ADMIN_TOKEN` | *(blank)* | If set, adding, pausing and removing accounts needs this token (enter it in the Accounts tab); a missing or wrong token is refused (`UNAUTHORIZED`). Viewing orders never needs it. Leave blank for normal local use |
| `CORS_ORIGINS` | *(blank)* | Browser origins allowed to call the API, comma-separated. Blank = the local UI: `http://localhost:3100`, `http://127.0.0.1:3100`, plus `:3000` for `npm run dev`. Change it only if you move the UI to another port |
| `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` | `minioadmin` | MinIO credentials (console login; the backend uses them too) |
| `MINIO_BUCKET` | `flipkart-cookies` | Bucket holding one cookie object per account |

After changing `.env`: `docker compose up -d` (recreates with the new values). Only the variables in
this table reach the backend (see `environment:` in `docker-compose.yml`).

Your accounts persist in **MinIO** (bucket `flipkart-cookies` on the `minio` Docker volume), so they
survive restarts and code updates; `docker compose down -v` deletes them. Without Docker the backend
falls back to a local JSON file at `SESSION_STORE_PATH` (set `STORAGE_BACKEND=file`, or leave `auto`
with no `MINIO_ENDPOINT`).

---

## 6. Update the code / rebuild

After pulling new changes:

```bash
docker compose up -d --build
```

---

## 7. Troubleshooting

| Symptom | Fix |
|---|---|
| `docker compose` errors / "cannot connect" | Start **Docker Desktop** and wait until it's running |
| `dependency failed to start: container …-minio-1 is unhealthy` | MinIO can't write its storage volume, usually one left by an earlier install (`docker compose logs minio` shows `file access denied`). Use the current `docker-compose.yml` (its `minio-perms` step fixes the volume), then run `docker compose down` and `docker compose up -d --build`. On a first install with no accounts yet you can instead start clean: `docker compose down -v`, then `docker compose up -d --build` |
| App doesn't open on :3100 | Another app may use the port. In `docker-compose.yml` change the frontend's `"127.0.0.1:3100:3000"` to e.g. `"127.0.0.1:3200:3000"`, set `CORS_ORIGINS=http://localhost:3200,http://127.0.0.1:3200` in `.env`, then `docker compose up -d`. Keep the `127.0.0.1:` prefix |
| Port 8000 is taken | Change the backend's `"127.0.0.1:8000:8000"` to e.g. `"127.0.0.1:8100:8000"` **and** the frontend's `NEXT_PUBLIC_BACKEND_URL` build arg to `http://localhost:8100`, then `docker compose up -d --build` (that URL is baked into the frontend at build time) |
| Board is **empty** | Add an account (section 3). If you just added one, wait until it stops **Refreshing** and click **Refresh**. Still empty? Set **Date = All dates** and clear the status pills; you may simply have nothing out for delivery today |
| Account shows **Session expired** | The cookie expired: re-export it and add it under the same label, e.g. the same file name (section 3) |
| “No Flipkart accounts” message | Drop at least one cookie file in the **Accounts** tab |
| “Admin token required” | `ADMIN_TOKEN` is set: enter it in the **Admin token** field (Accounts tab → **Add accounts**) |
| Orders or OTPs look out of date | **Refresh** only re-reads the backend's cache; each account is refetched from Flipkart every 30 min. Lower `REFRESH_INTERVAL_S` in `.env` for fresher data |
| *partial history* / *N details failed* on an account | *partial history*: the order history was cut short (a later page failed, the per-account time budget `ACCOUNT_DEADLINE_S` ran out, or the `FLIPKART_MAX_PAGES` cap was hit). The board keeps the older orders from earlier fetches that this one didn't reach, until a complete fetch. *N details failed*: that many order-detail requests failed. The next scheduled fetch tries again; the backend log shows Flipkart's reply |
| Cancelled or replacement dates are empty | Check the row's **Details**: `skipped` = not looked up (order older than `FLIPKART_HISTORY_DAYS`, or over a cap), `failed` = the lookup errored, `ok` = there was no such event |
| **Invoice not available yet** | Flipkart issues invoices once a unit ships, and until then answers "try again later" (it says the same on a temporary fault); or its bundle has no tax invoice for that shipment yet. Try again later |
| Invoice download says **Not configured** | The card's account was paused or removed after the page loaded: **Refresh**, or reactivate the account in the Accounts tab |

View logs if something looks wrong (failed Flipkart calls are logged with the HTTP status and the start
of Flipkart's reply, never cookies):

```bash
docker compose logs backend --tail 50
docker compose logs frontend --tail 50
```

---

## 8. How it works (for developers)

Three services (see `docker-compose.yml`), all on one machine:

- **`backend/`** — Python (**FastAPI** + **Scrapling**/`curl_cffi`). Calls Flipkart's internal
  *My Orders* JSON APIs over plain HTTP using the account cookie + Flipkart's `x-user-agent` (FKUA)
  header. **No headless browser.** A background poller keeps an in-memory order cache: it refetches
  each active account every `REFRESH_INTERVAL_S`, `FETCH_CONCURRENCY` accounts at a time, each within
  a per-account time budget. A fetch pages through the order history, then requests detail pages:
  one per out-for-delivery / arriving shipment (address, mobile, live OTP), then one per recent order
  with a cancelled / replaced / refunded shipment (cancellation and replacement dates), then one per
  other recent order (its address). Each order becomes one row per shipment. `GET /api/orders` only
  serves the cache. The invoice routes are the only ones that call Flipkart on request; they use
  the account's cookies from the poller's in-memory roster.
- **repo root** — **Next.js** frontend (UI only). The browser calls the backend directly at
  http://localhost:8000 (`NEXT_PUBLIC_BACKEND_URL`, baked in at build), which is why the UI's origin
  must be listed in `CORS_ORIGINS`.
- **`minio`** — **MinIO** (S3-compatible object storage). Holds each account's cookies as a JSON
  object (`accounts/<id>.json`) in the `flipkart-cookies` bucket. The backend creates the bucket if
  it's missing and reaches MinIO over the compose network (the S3 port 9000 isn't published). Web
  console at http://localhost:9001.

### Backend API

| Method | Path | Notes |
|---|---|---|
| GET | `/api/orders` | `{ ok, orders[], accounts[], coverage, fetchedAt, timezone, invoiceZipMax }`, served from the cache (never calls Flipkart). `accounts[]`: `{ id, label, ok, count, pending?, fetchedAt?, error?, partial, detailFailed }`, where `partial` = order history truncated and `detailFailed` = detail lookups that failed. `coverage`: poller progress (`total`, `ok`, `failed`, `pending`, `inFlight`, …) |
| GET | `/api/accounts` | `{ accounts[] }`, each `{ id, label, updatedAt, count, active }` (never cookie values) |
| POST | `/api/accounts` | body `{ label, cookie }`: add one account, or update it if the label already exists |
| POST | `/api/accounts/import` | body `{ label?, content }`: `content` is a raw `.json`/`.txt` blob (max 2 MB), single **or** multi-account. Returns `{ accounts, imported }` |
| PATCH | `/api/accounts` | body `{ ids: string[], active: boolean }`: pause (`false`) or activate accounts |
| DELETE | `/api/accounts?id=a&id=b` | Remove the listed accounts (repeat `id`; one is fine). **No `id` at all clears every account**; an empty `?id=` matches nothing |
| GET | `/api/health` | `{ ok, accounts, poller }`: liveness, active-account count, poller progress |
| GET | `/api/invoice?accountId=&orderId=&unitId=` | One card's tax invoice (`application/pdf`), picked out of the order's invoice bundle, which is fetched from Flipkart on request. Needs the header `X-Requested-With` (any value), which makes browsers preflight it so other websites can't trigger it |
| POST | `/api/invoices/zip` | JSON body `{ orders: [{ orderId, accountIds, unitIds }] }` (the filtered cards, grouped by order): one ZIP with `<orderId>/<trackingId>.pdf` per card, plus `missing.txt` (order ID, shipment, error code, reason) for cards without one. At most `INVOICE_ZIP_MAX` orders. Each order's bundle is fetched once, through the first of its `accountIds` that can (one may be paused or have an expired session). `X-Invoice-Files` / `X-Invoice-Missing` give the counts. When nothing could be saved, the error comes back as JSON instead of a ZIP |

`POST`, `PATCH` and `DELETE` on `/api/accounts` need the header `x-admin-token` when `ADMIN_TOKEN`
is set; a missing or wrong token gets **401** with error code `UNAUTHORIZED`. Errors look like
`{ ok: false, error: { code, message } }`, with codes `AUTH_EXPIRED` (401, a Flipkart session
expired), `UNAUTHORIZED` (401), `UPSTREAM_ERROR` / `PARSE_ERROR` (502), `CONFIG_ERROR` (400),
`INVOICE_UNAVAILABLE` (404, Flipkart has no invoice for the order yet) and `UNKNOWN` (500).

**Order rows** (`orders[]`, one per shipment; the contract is `Order` in `src/lib/types.ts`):
`account`, `orderId`, `trackingId`, `customerName`, `itemName`, `deliveryAddress`, `phone`, `otp`,
`status` (`OUT_FOR_DELIVERY` | `ARRIVING` | `DELIVERED` | `CANCELLED` | `OTHER`), `rawStatus`,
`activityDateIso`, `gstin`, plus `pricePaid`, `expectedDateIso`, `deliveredDateIso`,
`cancelledDateIso`, `replacementOf`, `replacementDateIso`, `replacementDeliveredDateIso`,
`replacementCancelledDateIso`, `refundAmount`, `refundStatus` (`completed` | `initiated` | `""`),
`refundDateIso` and `detailStatus` (`ok` | `failed` | `skipped`). They mean the same as the CSV
columns (section 4); dates are ISO timestamps (the CSV shows them in IST), and missing values are
`null` or `""`. Each row also carries `accountId` (the account's id, stable when its label is
renamed), `unitId` (Flipkart's id for the unit) and `fsn` (its product's id), which invoice requests
use; they aren't CSV columns.

### Run without Docker (local dev)

Docker is strongly recommended (it avoids Python/`curl_cffi`/`playwright` install issues,
especially on Windows). If you still want a local setup:

```bash
# 1) Backend  (Python 3.12)
cd backend
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000   # listens on 127.0.0.1 only; keep it that way

# 2) Frontend (Node 22) — in a second shell, from the repo root
npm install
# tell the browser where the backend is (create .env.local):
#   NEXT_PUBLIC_BACKEND_URL=http://localhost:8000
npm run dev            # http://localhost:3000
```

Config for local backend runs goes in `backend/.env` (see `backend/.env.example`; it is
auto-loaded). With no `MINIO_*` settings there, accounts are saved to `.flipkart-session.json` in
`backend/` (gitignored).

### Tests

```bash
# Backend (from backend/). requirements-dev.txt adds pytest + httpx (for FastAPI's TestClient).
pip install -r requirements-dev.txt
POLLER_ENABLED=0 python -m pytest -q        # PowerShell: $env:POLLER_ENABLED="0"; python -m pytest -q

# Frontend (repo root)
npm test && npm run lint && npm run build
```

### Capturing raw Flipkart responses (dev only)

To find where Flipkart puts a field, `backend/scripts/capture_samples.py` saves one account's raw
responses:

```bash
cd backend
python -m scripts.capture_samples --cookie <path to a Cookie-Editor export>
```

It writes `orders.json`, `detail-<category>-<n>.json`, `headings.txt`, `paths.txt`, `addons.txt`
(add-on units next to the product units of the same orders, to spot a new add-on marker) and
`invoice.txt` (every invoice-related node on the detail pages, IDs masked) to
`backend/.samples/<cookie-file-name>/` (`--out` changes the folder, `--per-category` the sample
count). `python -m scripts.probe_invoice --cookie <export>` downloads one delivered order's invoices
through the app's own code and reports what came back (`--save` keeps the file there).
**These files contain real customer data.** `backend/.samples/` is gitignored (and kept out of the
Docker build context): never commit or share it, and write test fixtures with made-up values instead.

Without Python on the host, run them in a throwaway backend container instead (from the repo root;
the image holds only `app/`, so mount the scripts, the output folder and the cookie file):

```bash
docker compose run --rm --no-deps -v ./backend/app:/app/app:ro -v ./backend/scripts:/app/scripts:ro -v ./backend/.samples:/app/.samples -v ./docs/cookies:/cookies:ro backend python -m scripts.capture_samples --cookie /cookies/<export>.txt
```

---

## Security / privacy

- **Local only, never a server.** The app is used only as a local Docker build on one machine. Every
  published port binds to `127.0.0.1` (UI 3100, API 8000, MinIO console 9001), and MinIO's S3 port
  9000 isn't published at all. Don't change these bindings to `0.0.0.0` or expose the app on your
  network.
- The API only lets the local UI read it from a browser (`CORS_ORIGINS`), so other websites open in
  your browser can't read your orders.
- Cookies are stored in **MinIO**, on the `minio` Docker volume (one object per account), never in
  the repo. `docker compose down -v` deletes them.
- Never commit secrets or customer data. These are gitignored: `.env`, `.flipkart-session.json`,
  cookie exports in `docs/cookies/`, and captured Flipkart responses in `backend/.samples/` (real
  customer PII).
- `ADMIN_TOKEN` is optional; when set, adding, pausing and removing accounts requires it.
- Backend logs show the HTTP status and the start of Flipkart's reply for failed calls, never cookie
  values.
- This tool uses **your own** logged-in account cookies to read **your own** orders.
