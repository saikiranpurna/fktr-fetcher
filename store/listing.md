# Chrome Web Store listing — Flipkart Delivery Tracker

## Single purpose (required by the CWS single-purpose policy)
> Display and export the signed-in user's own Flipkart orders as one row per shipment.

Keep the extension to this single purpose. Do not add unrelated features to the same item.

## Short description (<= 132 chars)
> View your Flipkart orders as one row per shipment — tracking, status, OTP, address — and export CSV. 100% in your browser.

## Detailed description
Flipkart Delivery Tracker turns your Flipkart "My Orders" into a clean, filterable board built for
delivery teams — one row per shipment, not per order.

For every shipment you see: order ID, tracking ID (FMPP…), item, status, the delivery OTP (when a
shipment is out for delivery), customer mobile, and delivery address.

- Filter by status (Out for Delivery / Arriving / Delivered / Other), by date (Today / Tomorrow /
  Next 7 / Last 7), or search by order ID, tracking ID, mobile, item, or customer.
- Download CSV (opens cleanly in Excel) of exactly what your filters show.
- Track several accounts: fetch one account, log into the next, fetch again — all fetched accounts
  stay on one board.

Privacy first: there is no server. The extension reads your orders using the Flipkart session you
are already logged into, and all data stays in your browser. Nothing is uploaded, no analytics, no
third parties. It only ever talks to flipkart.com.

## Permission justifications (paste into the CWS review form)
- **host_permissions `https://www.flipkart.com/*`**: The extension reads the signed-in user's own
  Flipkart order list and order-detail JSON (the same endpoints the Flipkart website calls) in
  order to display and export the user's orders. No other site is contacted.
- **`storage`**: Caches the user's fetched orders locally (`chrome.storage.local`) so the dashboard
  can render them and merge multiple accounts across sessions. No data leaves the device.

## Data usage disclosures (CWS "Privacy practices" form)
- Collects: "Personally identifiable information" (the user's own order names/addresses/phone) and
  "User activity" — **only stored locally, never transmitted**.
- Not sold to third parties. Not used for anything unrelated to the single purpose. Not used for
  creditworthiness/lending.
- Link the hosted privacy policy (store/privacy-policy.md, published to a public URL).

## Assets checklist before submitting
- [ ] Replace placeholder icons in `extension/public/icons/` with real 16/32/48/128 PNGs (128 is
      the store icon). Current icons are 1×1 placeholders — **must be replaced**.
- [ ] At least one 1280×800 (or 640×400) screenshot of the dashboard.
- [ ] Publish `privacy-policy.md` to a public URL and add a contact email.
- [ ] Fill the single-purpose + permission justifications above in the dashboard.
