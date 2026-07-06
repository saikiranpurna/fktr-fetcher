# Flipkart Delivery Tracker — Chrome Extension

A fully client-side Manifest V3 extension that shows your Flipkart **My Orders** as **one row per
shipment** (order ID, tracking ID, item, status, delivery OTP, customer mobile, address), lets you
filter, and exports CSV — **no backend server, no cookie export, no Docker**.

It reads your orders using the Flipkart session you are **already logged into** in this browser
(the service worker calls Flipkart's own order APIs first-party; Chrome attaches your session
automatically). All data stays in your browser (`chrome.storage.local`).

## Use it

1. Be **logged into flipkart.com** in this browser.
2. Click the extension's toolbar icon → the dashboard opens in a new tab.
3. In **Accounts**, type a label (e.g. "Seller North") and click **Fetch this account**.
4. Filter (status / date / search) and **Download CSV** for exactly what's shown.

### Multiple accounts (no server needed)
A browser is logged into one Flipkart account at a time, so multi-account works by **snapshots**:
fetch account A → log out → log into account B → fetch again. Every fetched account stays listed and
the board/CSV merge them. Use **Remove** to drop one.

### If it says "session expired / not logged in"
Click **Open Flipkart login**, sign in, then **Fetch** again.

### FKUA staleness escape hatch
Flipkart occasionally bumps its internal `x-user-agent` (FKUA) version. If fetches start failing
after working before, set a fresh value without republishing — in the extension's service-worker
devtools console:
```js
chrome.storage.local.set({ "fkrt.fkua": "<fresh FKUA string>" });
```
Clear it with `chrome.storage.local.remove("fkrt.fkua")` to return to the built-in default.

## Develop

```bash
cd extension
npm install
npm run build       # -> extension/dist  (load unpacked in chrome://extensions)
npm test            # vitest: parser/flipkart/enrich/pool/snapshots/OrderList
npm run dev         # CRXJS dev server with HMR
```

Shared pure logic (`types`, `csv`, `filters`) is imported from the sibling app's `src/lib` via the
`@core/*` alias (single source of truth). Ported backend logic lives in `src/core` (parser, config,
errors) and `src/background` (flipkart client, enrichment, promise pool, service worker).

## Load unpacked (for testing before store submission)

1. `npm run build`
2. Open `chrome://extensions`, enable **Developer mode**, **Load unpacked** → select `extension/dist`.
3. Log into flipkart.com, click the toolbar icon, **Fetch this account**.

## Publishing

See `../store/listing.md` and `../store/privacy-policy.md`. Replace the placeholder icons in
`public/icons/` with real art before submitting.
