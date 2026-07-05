// Base URL for the backend API.
//   ""  -> same-origin (Next.js rewrite proxy) — fine for local dev / small datasets.
//   set -> the browser calls the Python backend directly (it sends permissive CORS).
// Direct calls avoid the Next proxy's ~30s timeout, which the full "all orders" fetch exceeds.
// NEXT_PUBLIC_* is inlined at build time; docker-compose bakes http://localhost:8000.
export const API_BASE = process.env.NEXT_PUBLIC_BACKEND_URL || "";
