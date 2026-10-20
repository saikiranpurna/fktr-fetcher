// Base URL for the backend API.
//   ""  -> same-origin (Next.js rewrite proxy) — fine for local dev / small datasets.
//   set -> the browser calls the Python backend directly; the backend grants CORS only to the
//          local UI origins in CORS_ORIGINS (the app is local-only).
// NEXT_PUBLIC_* is inlined at build time; docker-compose bakes http://localhost:8000.
export const API_BASE = process.env.NEXT_PUBLIC_BACKEND_URL || "";
