import { config } from "@/lib/config";
import { toErrorResponse } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { getDeliveryOrders } from "@/lib/orders/service";
import type { OrdersResponse } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const t0 = Date.now();
  try {
    const { orders, accounts } = await getDeliveryOrders();
    logger.info("api.orders.ok", {
      count: orders.length,
      accounts: accounts.length,
      ms: Date.now() - t0,
    });
    return Response.json({
      ok: true,
      orders,
      accounts,
      fetchedAt: new Date().toISOString(),
      timezone: config.timezone,
    } satisfies OrdersResponse);
  } catch (err) {
    const { body, status } = toErrorResponse(err);
    logger.error("api.orders.fail", {
      code: body.error.code,
      message: body.error.message,
      ms: Date.now() - t0,
    });
    return Response.json(body, { status });
  }
}
