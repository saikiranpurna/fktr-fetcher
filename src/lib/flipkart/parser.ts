import * as cheerio from "cheerio";
import { parseError } from "../errors";
import { logger } from "../logger";
import type { OrderStatus, ParsedOrder } from "../types";

// Field paths for flipkart.com "My Orders" (1.rome.api.flipkart.com/api/5/self-serve/orders).
// An order holds a MAP of units (line items); we collapse to one row per order.
// Verify/adjust these against the live response via `npm run diag`.
const JSON_FIELDS = {
  ordersArray: "RESPONSE.multipleOrderDetailsView.orders",
  orderId: "orderMetaData.orderId",
  orderDate: "orderMetaData.orderDate", // ms epoch, fallback for activity date
  units: "units", // map of unitId -> unit
  productDataBag: "productDataBag", // map of listingId/fsn -> product
  productTitle: "productBasicData.title",
  unitListingId: "metaData.listingId",
  unitFsn: "metaData.fsn",
  unitHeading: "metaData.moRedesignHeading", // human status headline, e.g. "Delivered on Jun 26"
  unitDeliveredDate: "deliveryDataBag.promiseDataBag.actualDeliveredDate", // ms epoch
  unitPromisedDate: "deliveryDataBag.promiseDataBag.promisedDate", // ms epoch
  unitOtpCallout: "deliveryDataBag.otpCallout", // populated only while actively out-for-delivery
  unitVas: "vasItemDetails", // present on add-ons (Flipkart Black Membership, Trust Shield) - not the real product
  buyerName: "accessToOrderDataBag.buyer.name", // account holder / buyer on the order
  shareToken: "accessToOrderDataBag.endUser.id", // per-order share token, needed for the detail endpoint
  detailAddress: "__detail.address", // injected by the browser adapter from the per-order detail endpoint
  detailOtpCallout: "__detail.otpCallout", // live OTP callout from the detail endpoint (OFD orders)
} as const;

// unverified - adjust to live DOM via `npm run diag`
const HTML_SELECTORS = {
  row: "[data-order-row]",
  orderId: "data-order-id",
  status: "data-status",
  activity: "data-activity",
  customer: "[data-customer]",
  item: "[data-item]",
  address: "[data-address]",
  otp: "[data-otp]",
} as const;

export function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const key of path.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

// True when `raw` carries a parsable orders array at the configured path — used by
// the browser adapter to pick which captured JSON response holds the orders.
export function hasOrdersArray(raw: unknown): boolean {
  return Array.isArray(getPath(raw, JSON_FIELDS.ordersArray));
}

export function mapStatus(rawStatus: string): OrderStatus {
  const s = (rawStatus || "").toLowerCase().replace(/[_-]+/g, " ");
  if (s.includes("out for delivery")) return "OUT_FOR_DELIVERY";
  if (s.includes("delivered")) return "DELIVERED";
  // In transit with an ETA (e.g. "Arriving today by 11 pm", "Delivery expected by Jul 5", "shipped").
  if (/arriving|expected|shipped|on the way|in transit|dispatched/.test(s)) return "ARRIVING";
  return "OTHER";
}

function asString(value: unknown): string {
  if (value == null) return "";
  return typeof value === "string" ? value : String(value);
}

function toIso(ms: unknown): string | null {
  const n = typeof ms === "number" ? ms : Number(ms);
  if (!Number.isFinite(n) || n <= 0) return null;
  const d = new Date(n);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function unitValues(order: unknown): unknown[] {
  const units = getPath(order, JSON_FIELDS.units);
  return units && typeof units === "object" ? Object.values(units as Record<string, unknown>) : [];
}

function productTitle(order: unknown, unit: unknown): string {
  const bag = getPath(order, JSON_FIELDS.productDataBag) as Record<string, unknown> | undefined;
  if (!bag) return "";
  const listingId = asString(getPath(unit, JSON_FIELDS.unitListingId));
  const fsn = asString(getPath(unit, JSON_FIELDS.unitFsn));
  const product = (listingId && bag[listingId]) || (fsn && bag[fsn]);
  return asString(getPath(product, JSON_FIELDS.productTitle)).trim();
}

// Prefer the most actionable state across an order's unit headings:
// OFD > Arriving > Delivered > Other. The date filter decides inclusion.
function deriveStatus(headings: string[]): { status: OrderStatus; rawStatus: string } {
  let arriving = false;
  let delivered = false;
  for (const h of headings) {
    const mapped = mapStatus(h);
    if (mapped === "OUT_FOR_DELIVERY") return { status: "OUT_FOR_DELIVERY", rawStatus: h };
    if (mapped === "ARRIVING") arriving = true;
    if (mapped === "DELIVERED") delivered = true;
  }
  const status: OrderStatus = arriving ? "ARRIVING" : delivered ? "DELIVERED" : "OTHER";
  const match = headings.find((h) => mapStatus(h) === status);
  return { status, rawStatus: match ?? headings[0] ?? "" };
}

// Pull a 4-8 digit OTP out of a single otpCallout (string, or an object with otp/code/value).
function otpFromCallout(oc: unknown): string | null {
  if (!oc) return null;
  if (typeof oc === "string") return oc.trim() || null;
  if (typeof oc === "object") {
    const rec = oc as Record<string, unknown>;
    const direct = rec.otp ?? rec.code ?? rec.value;
    if (typeof direct === "string" && direct.trim()) return direct.trim();
    const match = JSON.stringify(oc).match(/\b\d{4,8}\b/);
    if (match) return match[0];
  }
  return null;
}

// The delivery OTP appears in a unit's otpCallout only while it's out-for-delivery.
function extractOtp(units: unknown[]): string | null {
  for (const u of units) {
    const otp = otpFromCallout(getPath(u, JSON_FIELDS.unitOtpCallout));
    if (otp) return otp;
  }
  return null;
}

export interface DetailRequest {
  orderId: string;
  unitId: string;
  shareToken: string;
}

// Fields the per-order detail endpoint (/api/4/page/fetch) needs, all read from the list order.
// The browser adapter calls this, fetches the detail, and injects `__detail` back onto the order.
export function detailRequestFor(order: unknown): DetailRequest | null {
  const orderId = asString(getPath(order, JSON_FIELDS.orderId)).trim();
  const shareToken = asString(getPath(order, JSON_FIELDS.shareToken)).trim();
  const units = getPath(order, JSON_FIELDS.units);
  const unitId = units && typeof units === "object" ? (Object.keys(units)[0] ?? "") : "";
  if (!orderId || !shareToken) return null;
  return { orderId, unitId, shareToken };
}

// Format the detail endpoint's address object into one line. addressLine1 is usually the full
// comma-joined address, so prefer it and append the pincode when it isn't already present.
function formatAddress(addr: unknown): string {
  if (!addr || typeof addr !== "object") return "Address unavailable";
  const a = addr as Record<string, unknown>;
  const line1 = asString(a.addressLine1).trim();
  const pin = asString(a.pinCode).trim();
  if (line1) return pin && !line1.includes(pin) ? `${line1} - ${pin}` : line1;
  const parts = [a.addressLine2, a.city, a.state, pin].map((x) => asString(x).trim()).filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : "Address unavailable";
}

export function parseOrders(raw: unknown): ParsedOrder[] {
  if (raw == null || typeof raw !== "object") {
    throw parseError("Unexpected response shape: not an object (check the session cookie or endpoint).");
  }
  const arr = getPath(raw, JSON_FIELDS.ordersArray);
  if (!Array.isArray(arr)) {
    throw parseError(
      `Unexpected response shape: '${JSON_FIELDS.ordersArray}' is not an array (session likely expired).`,
    );
  }

  const orders: ParsedOrder[] = [];
  for (const order of arr) {
    const orderId = asString(getPath(order, JSON_FIELDS.orderId)).trim();
    if (!orderId) {
      logger.warn("parser.skip.no_order_id", {});
      continue;
    }

    const units = unitValues(order);
    // Prefer the real product(s); skip free add-ons/VAS (membership, trust shield) for the
    // item/status/date, so the card shows the actual item, not "Flipkart Black Membership".
    const realUnits = units.filter((u) => getPath(u, JSON_FIELDS.unitVas) == null);
    const useUnits = realUnits.length > 0 ? realUnits : units;
    const titles: string[] = [];
    const headings: string[] = [];
    let deliveredMs: number | null = null;
    let promisedMs: number | null = null;
    for (const u of useUnits) {
      const title = productTitle(order, u);
      if (title && !titles.includes(title)) titles.push(title);
      const heading = asString(getPath(u, JSON_FIELDS.unitHeading)).trim();
      if (heading) headings.push(heading);
      const dv = Number(getPath(u, JSON_FIELDS.unitDeliveredDate));
      if (Number.isFinite(dv) && dv > 0) deliveredMs = Math.max(deliveredMs ?? 0, dv);
      const pv = Number(getPath(u, JSON_FIELDS.unitPromisedDate));
      if (Number.isFinite(pv) && pv > 0) promisedMs = promisedMs == null ? pv : Math.min(promisedMs, pv);
    }

    const { status, rawStatus } = deriveStatus(headings);
    const first = titles[0] || "Unknown item";
    const itemName = titles.length > 1 ? `${first} (+${titles.length - 1} more)` : first;
    const activityDateIso =
      toIso(status === "DELIVERED" ? (deliveredMs ?? promisedMs) : (promisedMs ?? deliveredMs)) ??
      toIso(getPath(order, JSON_FIELDS.orderDate)) ??
      "";

    orders.push({
      orderId,
      customerName: asString(getPath(order, JSON_FIELDS.buyerName)).trim() || "Unknown customer",
      itemName,
      // Delivery address + a live OTP come from the per-order detail endpoint, injected as
      // `__detail` by the browser adapter (see detailRequestFor); absent -> placeholder / list OTP.
      deliveryAddress: formatAddress(getPath(order, JSON_FIELDS.detailAddress)),
      otp: extractOtp(units) ?? otpFromCallout(getPath(order, JSON_FIELDS.detailOtpCallout)),
      status,
      rawStatus,
      activityDateIso,
    });
  }
  return orders;
}

export function parseOrdersFromHtml(html: string): ParsedOrder[] {
  const $ = cheerio.load(html || "");
  const rows = $(HTML_SELECTORS.row);
  const orders: ParsedOrder[] = [];
  rows.each((_, el) => {
    const $row = $(el);
    const orderId = ($row.attr(HTML_SELECTORS.orderId) || "").trim();
    if (!orderId) {
      logger.warn("parser.html.skip.no_order_id", {});
      return;
    }
    const rawStatus = ($row.attr(HTML_SELECTORS.status) || "").trim();
    const customer = $row.find(HTML_SELECTORS.customer).first().text().trim();
    const item = $row.find(HTML_SELECTORS.item).first().text().trim();
    const address = $row.find(HTML_SELECTORS.address).first().text().trim();
    const otp = $row.find(HTML_SELECTORS.otp).first().text().trim();

    orders.push({
      orderId,
      customerName: customer || "Unknown customer",
      itemName: item || "Unknown item",
      deliveryAddress: address || "Address unavailable",
      otp: otp || null,
      status: mapStatus(rawStatus),
      rawStatus,
      activityDateIso: ($row.attr(HTML_SELECTORS.activity) || "").trim(),
    });
  });
  return orders;
}
