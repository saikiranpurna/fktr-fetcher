import { defineManifest } from "@crxjs/vite-plugin";

// Manifest V3. Minimal permission surface for Chrome Web Store review:
//   storage        — cache fetched orders locally (multi-account snapshots)
//   host_permissions flipkart.com — read the signed-in user's own order JSON
export default defineManifest({
  manifest_version: 3,
  name: "Flipkart Delivery Tracker",
  version: "1.0.0",
  description:
    "See your Flipkart orders as one row per shipment — tracking, status, OTP, address — and export CSV. Runs 100% in your browser.",
  permissions: ["storage"],
  host_permissions: ["https://www.flipkart.com/*"],
  background: {
    service_worker: "src/background/worker.ts",
    type: "module",
  },
  action: {
    default_title: "Open Flipkart Delivery Tracker",
  },
  icons: {
    16: "icons/icon-16.png",
    32: "icons/icon-32.png",
    48: "icons/icon-48.png",
    128: "icons/icon-128.png",
  },
});
