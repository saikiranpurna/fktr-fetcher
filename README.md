# Flipkart Delivery Tracker

Internal tool for a delivery team. It logs into your Flipkart **My Orders** with your own
browser cookie and shows, **one row per shipment**: order ID, shipment/**tracking ID**, item,
status, delivery **OTP**, customer **mobile**, and delivery address — across one or more Flipkart
accounts. Filter by status/date/search and export everything to **CSV / Excel**.

> **New: zero-setup Chrome extension.** A fully client-side public Chrome extension now lives in
> [`extension/`](extension/README.md) — same board, but **no Docker, no backend, and no cookie
> export**. It reads your orders using the Flipkart session you're already logged into. The Docker
> app below still works and remains the setup until the extension is verified in your browser and
> published (see `docs/plans/2026-07-06-flipkart-public-chrome-extension.md`).

- A single order ID can appear as **several rows** (one per unit/shipment), each with its own
  tracking ID, item, status, OTP and mobile.
- If a shipment has an **OTP**, it is treated as **Out for Delivery**.

---

## 1. Prerequisites

- **Docker Desktop** installed and **running** (Windows/macOS/Linux). This is the only requirement
  to run the app. On Windows, Docker Desktop with the WSL2 backend.
- A **Flipkart account** you're logged into in a normal browser (to export its cookie).

> You do **not** need Node, Python, or Chromium installed — everything runs inside Docker.

---

## 2. Quick start (Docker)

From the project folder (the one containing `docker-compose.yml`):

```bash
docker compose up --build -d
```

- First build takes **~2–3 minutes** (downloads dependencies). Later starts are instant.
- When it's up:
  - **App (open this):** http://localhost:3100
  - Backend API (optional/debug): http://localhost:8000

Check both are running:

```bash
docker compose ps          # both "backend" and "frontend" should be Up
```

Stop it:

```bash
docker compose down        # stop containers (your added cookies are kept)
docker compose down -v     # also delete stored cookies (start fresh)
```

---

## 3. Add your Flipkart account (one-time, in the app)

The board is empty until you add an account cookie.

1. In a normal browser, **log in** at <https://www.flipkart.com/>.
2. Install a cookie exporter (e.g. the **Cookie-Editor** browser extension).
3. On flipkart.com, open Cookie-Editor → **Export → JSON**. Save/copy the `.json` (a `.txt`
   file with the same JSON, or a raw `name=value; name2=value2` cookie header, also works).
4. Open the app (http://localhost:3100) → **Accounts** panel →
   **drag the file(s) onto the drop zone** (or click to choose). Each file may hold **one
   account** (a Cookie-Editor export or raw header) **or many** — a single `.json`/`.txt`
   holding an array/map of accounts is expanded automatically. Drop several files at once too.

Orders load automatically. Cookies are saved as **one object per account in MinIO** (S3 object
storage, bundled in Docker). To add more accounts, drop more files; to remove one, click **Remove**.

> Cookies expire (Flipkart sessions are short-lived). When an account chip turns **red**
> (“session expired”), just re-export the cookie and drop the new file in again.

---

## 4. Using the app

- **Refresh** re-fetches; **Auto-refresh (60s)** keeps it current.
- **Filters:**
  - Status pills: **Out for Delivery / Arriving / Delivered / Cancelled / Other** (click to toggle).
  - **Date:** All / Today / Tomorrow / Next 7 days / Last 7 days.
  - **Search:** matches order ID, tracking ID (FMPP…), mobile number, item, or customer.
- **Download CSV** exports exactly what's currently shown (respects your filters). Columns:
  `Account, Order ID, Tracking ID, Customer Name, Item, Delivery Address, Mobile, OTP, Status,
  Activity Date, GSTIN`. The GSTIN column is filled from the order's "GST details" section for
  orders that carry a GST number, and blank otherwise. Opens cleanly in Excel (UTF‑8 BOM).

**Note on speed:** a full refresh takes **~40–70 seconds** because it pulls your entire order
history plus per-shipment details (address, OTP, mobile) — with no browser, over plain HTTP.
Larger accounts take longer.

---

## 5. Configuration (optional)

Defaults work out of the box. To tune the backend, copy `.env.example` to **`.env`** in the project
root (Docker Compose reads it automatically), then edit:

| Variable | Default | Purpose |
|---|---|---|
| `APP_TIMEZONE` | `Asia/Kolkata` | Timezone for the Today / Next 7 days filters |
| `FLIPKART_MAX_PAGES` | `100` | How many order pages to pull (7 orders/page). Stops early when there are no more |
| `FLIPKART_MAX_DETAILS` | `40` | Extra address lookups for recent delivered orders (active/out-for-delivery orders always get theirs) |
| `FLIPKART_TIMEOUT_MS` | `20000` | Per-request timeout |
| `ADMIN_TOKEN` | *(blank)* | If set, adding/removing accounts requires this token (enter it in the Accounts panel). Leave blank for local use |
| `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` | `minioadmin` | MinIO credentials (change before sharing) |
| `MINIO_BUCKET` | `flipkart-cookies` | Bucket holding one cookie object per account |

After changing `.env`: `docker compose up -d` (recreates with the new values).

Your added cookies persist in **MinIO** (bucket `flipkart-cookies`, stored on the `minio` Docker
volume), so they survive restarts and code updates. Without Docker the backend falls back to a
local JSON file at `SESSION_STORE_PATH` (set `STORAGE_BACKEND=file`, or leave `auto` with no
`MINIO_ENDPOINT`).

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
| App doesn't open on :3100 | Another app may use the port. Edit `docker-compose.yml` → frontend `ports: "3100:3000"` to e.g. `"3200:3000"`, then `docker compose up -d`. (Same for backend `8000` if needed.) |
| Board is **empty** | Add an account cookie (section 3). If added and still empty, set **Date = All dates** and clear status pills — you may simply have nothing out for delivery today |
| Account chip is **red** / “session expired” | The cookie expired — re-export from flipkart.com and drop the new `.json` in |
| “No Flipkart accounts” message | Drop at least one cookie `.json` in the Accounts panel |
| Refresh seems slow (~1 min) | Normal for large accounts — it fetches all orders + per-shipment details |

View logs if something looks wrong:

```bash
docker compose logs backend --tail 50
docker compose logs frontend --tail 50
```

---

## 8. How it works (for developers)

Three services (see `docker-compose.yml`):

- **`backend/`** — Python (**FastAPI** + **Scrapling**/`curl_cffi`). Calls Flipkart's internal
  *My Orders* JSON APIs over plain HTTP using the account cookie + Flipkart's `x-user-agent` (FKUA)
  header. Paginates all orders, then fetches each **active shipment's** detail for its address,
  mobile, and live OTP. **No headless browser.** One order is exploded into one row per unit.
- **repo root** — **Next.js** frontend (UI only). In Docker the browser calls the backend directly
  (`NEXT_PUBLIC_BACKEND_URL`, baked at build) so long refreshes aren't cut off by the dev proxy.
- **`minio`** — **MinIO** (S3-compatible object storage). Persists each account's cookies as a
  JSON object (`accounts/<id>.json`) in the `flipkart-cookies` bucket; the backend auto-creates the
  bucket on startup. Optional web console at http://localhost:9001.

Backend API:

| Method | Path | Notes |
|---|---|---|
| GET | `/api/orders` | `{ ok, orders[], accounts[], fetchedAt, timezone }` |
| GET | `/api/accounts` | `{ accounts[] }` |
| POST | `/api/accounts` | body `{ label, cookie }` (+ `x-admin-token` if `ADMIN_TOKEN` set) |
| POST | `/api/accounts/import` | body `{ label?, content }` — `content` is a raw file blob; expands a single **or** multi-account `.json`/`.txt` (returns `{ accounts, imported }`) |
| DELETE | `/api/accounts?id=…` | omit `id` to clear all |
| GET | `/api/health` | liveness + account count |

### Run without Docker (local dev)

Docker is strongly recommended (it avoids Python/`curl_cffi`/`playwright` install issues,
especially on Windows). If you still want a local setup:

```bash
# 1) Backend  (Python 3.12)
cd backend
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000

# 2) Frontend (Node 22) — in a second shell, from the repo root
npm install
# tell the browser where the backend is (create .env.local):
#   NEXT_PUBLIC_BACKEND_URL=http://localhost:8000
npm run dev            # http://localhost:3000
```

Config for local backend runs goes in `backend/.env` (see `backend/.env.example`; it is
auto-loaded). Frontend unit tests: `npm test`.

---

## Security / privacy

- Your Flipkart cookie is stored **only** in the local Docker volume (`session`) — never committed
  (`.flipkart-session.json` and `.env` are gitignored).
- This tool uses **your own** logged-in account cookie to read **your own** orders. Set
  `ADMIN_TOKEN` if you deploy it somewhere shared.
