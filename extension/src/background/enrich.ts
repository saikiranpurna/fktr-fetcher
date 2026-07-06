// Ported from backend/app/service.py (_enrich_details). Decides which units need a
// per-order detail call (address + live OTP) and runs them with bounded concurrency.
import { CONFIG } from "@flk/core/config";
import { get, isObj, mapStatus, str } from "@flk/core/parser";
import { fetchDetail, type FetchLike } from "./flipkart";
import { mapPool } from "./pool";

type UnitDetail = { address?: unknown; otp?: string | null };
type Target = { orderId: string; unitId: string; shareToken: string };

/**
 * EVERY active unit (out-for-delivery / arriving) gets a call so no live OTP is
 * missed no matter how deep it sits; orders with no active unit get one call each
 * (for the address) up to CONFIG.maxDetails. Returns {orderId: {unitId: {address, otp}}}.
 */
export async function enrichDetails(
  rawOrders: unknown[],
  onProgress?: (done: number, total: number) => void,
  fetchFn: FetchLike = fetch,
): Promise<Record<string, Record<string, UnitDetail>>> {
  if (CONFIG.maxDetails <= 0) return {};

  const active: Target[] = []; // OTP-bearing candidates, any position
  const addressOnly: Target[] = []; // first unit of orders with no active unit
  for (const order of rawOrders) {
    const orderId = str(get(order, "orderMetaData.orderId")).trim();
    const units = get(order, "units");
    if (!orderId || !isObj(units)) continue;
    const shareToken = str(get(order, "accessToOrderDataBag.endUser.id")).trim();
    let firstUid: string | null = null;
    let hasActive = false;
    for (const [unitId, u] of Object.entries(units)) {
      if (get(u, "vasItemDetails") != null) continue;
      if (firstUid === null) firstUid = unitId;
      const status = mapStatus(str(get(u, "metaData.moRedesignHeading")));
      if (status === "OUT_FOR_DELIVERY" || status === "ARRIVING") {
        active.push({ orderId, unitId, shareToken });
        hasActive = true;
      }
    }
    if (firstUid && !hasActive) addressOnly.push({ orderId, unitId: firstUid, shareToken });
  }

  // Active units first (OTP priority, safety-capped), then addresses for recent delivered orders.
  const targets = [
    ...active.slice(0, CONFIG.activeTargetCap),
    ...addressOnly.slice(0, CONFIG.maxDetails),
  ];
  if (targets.length === 0) return {};

  let done = 0;
  const total = targets.length;
  const settled = await mapPool(targets, CONFIG.detailConcurrency, async (target) => {
    const detail = await fetchDetail(target.orderId, target.unitId, target.shareToken, fetchFn);
    done += 1;
    onProgress?.(done, total);
    return { target, detail };
  });

  const details: Record<string, Record<string, UnitDetail>> = {};
  for (const { target, detail } of settled) {
    if (detail.address || detail.otp) {
      (details[target.orderId] ??= {})[target.unitId] = detail;
    }
  }
  return details;
}
