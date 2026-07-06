// Ported 1:1 from backend/app/parser.py. Parses Flipkart's "My Orders" list + per-order
// detail into the frontend Order shape, exploding each order into one row PER UNIT (shipment).
import type { ParsedOrder, OrderStatus } from "@core/types";
import { parseError } from "./errors";

type Dict = Record<string, unknown>;

// Type guard (preserves narrowing); mirrors Python's `isinstance(x, dict)` — arrays excluded.
function isObj(v: unknown): v is Dict {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// --- generic helpers --------------------------------------------------------

export function get(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const part of path.split(".")) {
    if (!isObj(cur)) return undefined;
    cur = cur[part];
  }
  return cur;
}

// Positive finite number or null (mirrors _num: 0/negative/NaN -> None).
function num(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Epoch-ms -> ISO string, or null when unparseable (mirrors _to_iso).
function toIso(ms: unknown): string | null {
  const n = num(ms);
  if (n === null) return null;
  const d = new Date(n);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// "" for null/undefined, else the value stringified (mirrors _s).
function str(v: unknown): string {
  return v == null ? "" : typeof v === "string" ? v : String(v);
}

// --- status -----------------------------------------------------------------

export function mapStatus(rawStatus: string): OrderStatus {
  const s = (rawStatus || "").toLowerCase().replace(/[_-]+/g, " ");
  if (s.includes("out for delivery")) return "OUT_FOR_DELIVERY";
  // A failed attempt awaiting re-delivery is still an active, OTP-bearing delivery.
  if (/unsuccessful|retrying|reattempt|undelivered|delivery failed/.test(s)) return "OUT_FOR_DELIVERY";
  if (s.includes("delivered")) return "DELIVERED";
  if (/arriving|expected|shipped|on the way|in transit|dispatched/.test(s)) return "ARRIVING";
  return "OTHER";
}

// --- product / units --------------------------------------------------------

function productTitle(order: unknown, unit: unknown): string {
  const bag = get(order, "productDataBag");
  if (!isObj(bag)) return "";
  const listingId = str(get(unit, "metaData.listingId"));
  const fsn = str(get(unit, "metaData.fsn"));
  const product = (listingId ? bag[listingId] : undefined) ?? (fsn ? bag[fsn] : undefined);
  return str(get(product, "productBasicData.title")).trim();
}

// --- detail request (which unit to fetch) -----------------------------------

export function detailTargetsFor(
  order: unknown,
): { orderId: string; unitId: string; shareToken: string }[] {
  const orderId = str(get(order, "orderMetaData.orderId")).trim();
  const units = get(order, "units");
  if (!orderId || !isObj(units)) return [];
  const shareToken = str(get(order, "accessToOrderDataBag.endUser.id")).trim();
  const targets: { orderId: string; unitId: string; shareToken: string }[] = [];
  for (const [unitId, u] of Object.entries(units)) {
    if (get(u, "vasItemDetails") != null) continue;
    targets.push({ orderId, unitId, shareToken });
  }
  return targets;
}

// --- detail extraction (address + live OTP) ---------------------------------

export function extractDetail(detailJson: unknown): {
  address: Dict | null;
  otp: string | null;
} {
  let address: Dict | null = null;
  let otp: string | null = null;
  const stack: unknown[] = [detailJson];
  while (stack.length) {
    const n = stack.pop();
    if (isObj(n)) {
      if (address === null) {
        const a = n.address;
        if (isObj(a) && (a.addressLine1 || a.pinCode)) address = a;
      }
      if (otp === null) {
        const v = n.otpValue;
        if (typeof v === "string" && /^\d{4,8}$/.test(v)) otp = v;
      }
      for (const val of Object.values(n)) stack.push(val);
    } else if (Array.isArray(n)) {
      for (const val of n) stack.push(val);
    }
  }
  return { address, otp };
}

export function formatAddress(addr: unknown): string {
  if (!isObj(addr)) return "Address unavailable";
  const line1 = str(addr.addressLine1).trim();
  const pin = str(addr.pinCode).trim();
  if (line1) return pin && !line1.includes(pin) ? `${line1} - ${pin}` : line1;
  const parts = ["addressLine2", "city", "state"].map((k) => str(addr[k]).trim());
  parts.push(pin);
  const filtered = parts.filter((p) => p);
  return filtered.length ? filtered.join(", ") : "Address unavailable";
}

// OTP from a single unit's otpCallout in the list response (present only while OFD).
export function unitOtp(unit: unknown): string | null {
  const oc = get(unit, "deliveryDataBag.otpCallout");
  if (!oc) return null;
  if (typeof oc === "string") return oc.trim() || null;
  if (isObj(oc)) {
    const direct = oc.otp ?? oc.code ?? oc.value;
    if (typeof direct === "string" && direct.trim()) return direct.trim();
    const m = JSON.stringify(oc).match(/\b\d{4,8}\b/);
    if (m) return m[0];
  }
  return null;
}

// --- top-level --------------------------------------------------------------

export function ordersArray(body: unknown): unknown[] | null {
  const arr = get(body, "RESPONSE.multipleOrderDetailsView.orders");
  return Array.isArray(arr) ? arr : null;
}

type UnitDetail = { address?: unknown; otp?: string | null };

export function parseOrders(
  rawOrders: unknown[],
  details: Record<string, Record<string, UnitDetail>>,
): ParsedOrder[] {
  const out: ParsedOrder[] = [];
  for (const order of rawOrders) {
    if (!isObj(order)) continue;
    const orderId = str(get(order, "orderMetaData.orderId")).trim();
    if (!orderId) continue;
    const units = get(order, "units");
    const items: [string, unknown][] = isObj(units) ? Object.entries(units) : [];
    // Skip free add-ons (VAS: membership, trust shield); fall back to all units if that empties.
    let real = items.filter(([, u]) => get(u, "vasItemDetails") == null);
    if (real.length === 0) real = items;
    if (real.length === 0) continue;

    const unitDetails = details[orderId] ?? {};
    let orderAddress: unknown = null;
    for (const d of Object.values(unitDetails)) {
      if (d && d.address) {
        orderAddress = d.address;
        break;
      }
    }
    const address = formatAddress(orderAddress);
    const phone = isObj(orderAddress) ? str(orderAddress.phoneNumber).trim() : "";
    const customer = str(get(order, "accessToOrderDataBag.buyer.name")).trim() || "Unknown customer";
    const orderDate = get(order, "orderMetaData.orderDate");

    for (const [unitId, u] of real) {
      const heading = str(get(u, "metaData.moRedesignHeading")).trim();
      let status = mapStatus(heading);
      const delivered = num(get(u, "deliveryDataBag.promiseDataBag.actualDeliveredDate"));
      const promised = num(get(u, "deliveryDataBag.promiseDataBag.promisedDate"));
      const chosenMs = status === "DELIVERED" ? (delivered ?? promised) : (promised ?? delivered);
      const otp = unitOtp(u) || unitDetails[unitId]?.otp || null;
      if (otp) {
        // An OTP is only issued for an active delivery -> out for delivery.
        status = "OUT_FOR_DELIVERY";
      }
      out.push({
        orderId,
        trackingId: str(get(u, "metaData.trackingId")).trim(),
        customerName: customer,
        itemName: productTitle(order, u) || "Unknown item",
        deliveryAddress: address,
        phone,
        otp,
        status,
        rawStatus: heading,
        activityDateIso: toIso(chosenMs) ?? toIso(orderDate) ?? "",
      });
    }
  }
  return out;
}

export function ensureOrdersShape(body: unknown): unknown[] {
  if (!isObj(body)) {
    throw parseError("Unexpected response shape: not an object (check the session cookie).");
  }
  const arr = ordersArray(body);
  if (arr === null) {
    throw parseError("Unexpected response shape: orders array missing (session likely expired).");
  }
  return arr;
}
