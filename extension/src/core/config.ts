// Ported from backend/app/config.py. No env layer — constants only (the extension
// runs entirely in the browser). Values copied verbatim from the Python defaults.
export const CONFIG = {
  ordersBase: "https://www.flipkart.com/api/5/self-serve/orders/",
  detailUrl: "https://www.flipkart.com/api/4/page/fetch?",
  filterType: "PREORDER_UNITS",
  fkua:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36 FKUA/website/42/website/Desktop",
  // Paginate My Orders (7/page); safety cap.
  maxPages: 100,
  // Extra address lookups for recent delivered orders (active units always get theirs).
  maxDetails: 40,
  // Per-request timeout, ms.
  timeoutMs: 20_000,
  // Detail-fetch concurrency (was ThreadPoolExecutor(max_workers=8)).
  detailConcurrency: 8,
  // Safety cap on active OTP-bearing detail targets.
  activeTargetCap: 300,
  // Timezone for the "today / next 7 days" filters.
  timezone: "Asia/Kolkata",
} as const;
