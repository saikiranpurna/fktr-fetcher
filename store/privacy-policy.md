# Privacy Policy — Flipkart Delivery Tracker (Chrome Extension)

_Last updated: 2026-07-06_

Flipkart Delivery Tracker is a browser extension that helps you view and export **your own**
Flipkart order information as one row per shipment (order ID, tracking ID, item, status, delivery
OTP, customer mobile, and address).

## What data the extension accesses

- **Your Flipkart order data.** When you click **Fetch**, the extension calls Flipkart's own
  "My Orders" web APIs (`flipkart.com`) using the session you are **already logged into** in this
  browser — exactly the requests the Flipkart website itself makes. It reads your order list and,
  for active shipments, the per-order detail (delivery address, mobile, and live OTP).

## Where your data goes

- **Nowhere but your own browser.** There is **no backend server**. The extension has no server of
  its own and sends your order data to no one. Fetched orders are cached only in your browser's
  local extension storage (`chrome.storage.local`) so the dashboard can display them and merge
  multiple accounts.
- **CSV export is local.** "Download CSV" creates the file in your browser and saves it to your
  computer. It is never uploaded anywhere.
- **No analytics, no tracking, no third parties.** The extension contains no analytics SDKs, no
  telemetry, and no remote code. Its only network requests are to `https://www.flipkart.com`.

## Data retention and deletion

- Cached orders remain in local storage until you click **Remove** on an account, or until you
  uninstall the extension (which clears its storage). You are in full control.

## Permissions and why they are needed

- **`storage`** — cache your fetched orders locally so the dashboard can show them and merge
  accounts across sessions.
- **Host access to `https://www.flipkart.com/*`** — make the same order-reading requests the
  Flipkart site makes, using your existing login, so your orders can be displayed and exported.

## Contact

Questions about this policy: **<ADD A CONTACT EMAIL BEFORE PUBLISHING>**.
