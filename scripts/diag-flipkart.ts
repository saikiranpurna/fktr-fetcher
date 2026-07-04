/**
 * Live Flipkart diagnostic harness (diagnose-locally-first).
 *
 *   npm run diag        # loads .env.local via `tsx --env-file`
 *
 * Forces real fetches for every configured account using the SAME client the app
 * uses (browser or http, per FLIPKART_FETCH_MODE). Use it to see what flipkart.com
 * returns and adjust JSON_FIELDS / HTML_SELECTORS in src/lib/flipkart/parser.ts.
 * Uses relative imports (no @/* alias under tsx).
 */
import { config } from "../src/lib/config";
import { AppError } from "../src/lib/errors";
import { getFlipkartClient } from "../src/lib/flipkart";
import { closeBrowser } from "../src/lib/flipkart/browser-client";
import { parseOrders, parseOrdersFromHtml } from "../src/lib/flipkart/parser";
import { getActiveAccounts } from "../src/lib/session/store";

async function main() {
  console.log("=== Flipkart diagnostic ===");
  console.log("fetch mode:", config.fetchMode);
  console.log("page/url  :", config.ordersUrl || "(default: https://www.flipkart.com/account/orders)");
  console.log("timezone  :", config.timezone);
  console.log("timeoutMs :", config.requestTimeoutMs);
  console.log("proxy     :", config.proxyUrl ? "configured" : "direct (none)");

  const accounts = getActiveAccounts();
  console.log("accounts  :", accounts.length, `[${accounts.map((a) => a.label).join(", ")}]`);

  if (config.fetchMode === "http" && !config.ordersUrl) {
    console.error("\nhttp mode needs FLIPKART_ORDERS_URL. Set it, or use browser mode.");
    process.exitCode = 1;
    return;
  }
  if (accounts.length === 0) {
    console.error("\nNo accounts. Set FLIPKART_COOKIE/FLIPKART_COOKIE_FILE or add via the Accounts panel.");
    process.exitCode = 1;
    return;
  }

  const client = getFlipkartClient();
  for (const acct of accounts) {
    console.log(`\n===== account: ${acct.label} (${acct.id}) =====`);
    try {
      const raw = await client.fetchRawOrders(acct.cookieHeader, { sessionKey: acct.id });
      console.log("outcome      : OK");
      console.log("content-type :", raw.contentType);
      const bodyHead =
        raw.contentType === "json"
          ? JSON.stringify(raw.json).slice(0, 800)
          : (raw.text ?? "").slice(0, 800);
      console.log("--- body head (first 800 chars) ---\n" + bodyHead);
      const orders =
        raw.contentType === "html" ? parseOrdersFromHtml(raw.text ?? "") : parseOrders(raw.json);
      console.log("parsed order count :", orders.length);
      console.log("first parsed order :", JSON.stringify(orders[0] ?? null, null, 2));
    } catch (err) {
      if (err instanceof AppError) {
        console.error("outcome      : FAILED");
        console.error("error code   :", err.code);
        console.error("message      :", err.message);
      } else {
        console.error("Unexpected error:", err);
      }
      process.exitCode = 1;
    }
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => closeBrowser());
