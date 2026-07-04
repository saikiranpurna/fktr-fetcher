function safeJson(s: string | undefined): Record<string, string> {
  if (!s || !s.trim()) return {};
  try {
    const parsed = JSON.parse(s);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, string>;
    }
    return {};
  } catch {
    return {};
  }
}

// Proxy from a single URL (FLIPKART_PROXY_URL) or split PROXY_* vars. Splitting avoids
// URL-encoding headaches with special characters in the password.
function proxyFromEnv(): string {
  const direct = process.env.FLIPKART_PROXY_URL;
  if (direct && direct.trim()) return direct.trim();
  const host = process.env.PROXY_HOST;
  const port = process.env.PROXY_PORT;
  if (!host || !port) return "";
  const scheme = process.env.PROXY_PROTOCOL || "http";
  const user = process.env.PROXY_USERNAME || "";
  const pass = process.env.PROXY_PASSWORD || "";
  const auth = user ? `${encodeURIComponent(user)}:${encodeURIComponent(pass)}@` : "";
  return `${scheme}://${auth}${host}:${port}`;
}

export const config = {
  timezone: process.env.APP_TIMEZONE || "Asia/Kolkata",
  logLevel: (process.env.LOG_LEVEL || "info") as "debug" | "info" | "warn" | "error",
  // "browser" (default) renders My Orders in headless Chromium with your cookie;
  // "http" replays a known orders JSON endpoint directly.
  fetchMode: (process.env.FLIPKART_FETCH_MODE || "browser").toLowerCase() as "browser" | "http",
  // browser mode: the My Orders page URL (defaults to flipkart.com/account/orders when empty).
  // http mode: the orders JSON endpoint you captured.
  ordersUrl: process.env.FLIPKART_ORDERS_URL || "",
  baseHeaders: safeJson(process.env.FLIPKART_BASE_HEADERS), // {} on parse fail
  sessionStorePath: process.env.SESSION_STORE_PATH || ".flipkart-session.json",
  adminToken: process.env.ADMIN_TOKEN || "",
  requestTimeoutMs: Number(process.env.FLIPKART_TIMEOUT_MS || 15000),
  // Browser mode paginates My Orders (7/page) up to this many pages (most recent first).
  maxOrderPages: Math.max(1, Number(process.env.FLIPKART_MAX_PAGES || 20)),
  // Browser mode also fetches each order's detail page for the delivery address (+ live OTP),
  // for at most this many most-recent orders. 0 disables detail enrichment.
  maxDetails: Math.max(0, Number(process.env.FLIPKART_MAX_DETAILS || 40)),
  // Residential proxy from FLIPKART_PROXY_URL or PROXY_HOST/PORT/USERNAME/PASSWORD.
  // A literal "{session}" token in the URL is replaced per-account for sticky IPs.
  proxyUrl: proxyFromEnv(),
};
