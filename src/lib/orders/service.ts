import { config } from "../config";
import { configError, toErrorResponse } from "../errors";
import { getFlipkartClient } from "../flipkart";
import { parseOrders, parseOrdersFromHtml } from "../flipkart/parser";
import { logger } from "../logger";
import { getActiveAccounts } from "../session/store";
import type { AccountResult, Order } from "../types";

export interface OrdersFetchResult {
  orders: Order[];
  accounts: AccountResult[];
}

// Fetches ALL orders across accounts. Filtering (status/date/account/search) is applied
// on the client so the same criteria drive both the on-screen list and the CSV export.
export async function getDeliveryOrders(): Promise<OrdersFetchResult> {
  if (config.fetchMode === "http" && !config.ordersUrl) {
    throw configError("FLIPKART_ORDERS_URL is not set. Set the orders endpoint, or use browser fetch mode.");
  }
  const accounts = getActiveAccounts();
  if (accounts.length === 0) {
    throw configError("No Flipkart accounts. Drop at least one account's cookie .json file in the Accounts panel.");
  }

  const client = getFlipkartClient();

  // Fetch every account concurrently. A single account's auth/upstream failure is
  // captured per-account (never blanks the others) - partial success is success.
  const settled = await Promise.all(
    accounts.map(async (acct) => {
      try {
        const raw = await client.fetchRawOrders(acct.cookieHeader, { sessionKey: acct.id });
        const parsed =
          raw.contentType === "html" ? parseOrdersFromHtml(raw.text ?? "") : parseOrders(raw.json);
        const orders: Order[] = parsed.map((o) => ({ ...o, account: acct.label }));
        return { acct, orders, error: undefined as AccountResult["error"] };
      } catch (err) {
        const { body } = toErrorResponse(err);
        logger.warn("orders.account.fail", { account: acct.id, code: body.error.code });
        return { acct, orders: [] as Order[], error: body.error };
      }
    }),
  );

  const orders = settled.flatMap((s) => s.orders);
  const accountResults: AccountResult[] = settled.map((s) => ({
    id: s.acct.id,
    label: s.acct.label,
    ok: !s.error,
    count: s.orders.length,
    error: s.error,
  }));
  logger.info("orders.service.ok", {
    accounts: accounts.length,
    total: orders.length,
    failed: accountResults.filter((a) => !a.ok).length,
  });
  return { orders, accounts: accountResults };
}
