import { STATUS_LABELS, type Order } from "../types";

const HEADERS = [
  "Account",
  "Order ID",
  "Tracking ID",
  "Customer Name",
  "Item",
  "Delivery Address",
  "Mobile",
  "OTP",
  "Status",
  "Activity Date",
  "GSTIN",
  // Lifecycle columns are appended AFTER GSTIN so existing column positions (and any sheet
  // formulas or imports built on them) don't move.
  "Price Paid",
  "Expected Date",
  "Delivered Date",
  "Cancelled Date",
  "Replacement Of",
  "Replacement Date",
  "Replacement Delivered Date",
  "Replacement Cancelled Date",
  "Refund Amount",
  "Refund Status",
  "Refund Date",
  "Details",
];

// RFC-4180 escaping: wrap in quotes and double inner quotes when the cell contains
// a comma, quote, or newline.
function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

// "YYYY-MM-DD HH:mm" (24h) in the target timezone; "" for a missing or unparseable timestamp.
// Same en-CA Intl approach as ymdInTz in filters.ts, but assembled from formatToParts so the output
// never depends on locale punctuation, and h23 so midnight is "00", never "24".
function dateTimeCell(iso: string | null | undefined, fmt: Intl.DateTimeFormat): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const p: Partial<Record<Intl.DateTimeFormatPartTypes, string>> = {};
  for (const part of fmt.formatToParts(d)) p[part.type] = part.value;
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

// Plain number (no currency symbol or digit grouping) so Excel treats the cell as numeric; null -> "".
function amountCell(n: number | null | undefined): string {
  return typeof n === "number" && Number.isFinite(n) ? String(n) : "";
}

// timeZone defaults to IST; the dashboard passes the timezone the API reports.
export function ordersToCsv(orders: Order[], timeZone = "Asia/Kolkata"): string {
  // One formatter for the whole export: constructing Intl formatters per cell is slow at 10k+ rows.
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const date = (iso: string | null | undefined) => dateTimeCell(iso, fmt);

  const lines = [HEADERS.map(csvCell).join(",")];
  // One row per shipment: drop repeats of the same tracking id (FMP…) — e.g. when the same
  // account was added twice. Rows without a tracking id yet aren't dedupable, so keep them all.
  const seenTracking = new Set<string>();
  for (const o of orders) {
    const tid = o.trackingId.trim();
    if (tid) {
      if (seenTracking.has(tid)) continue;
      seenTracking.add(tid);
    }
    lines.push(
      [
        o.account,
        o.orderId,
        o.trackingId,
        o.customerName,
        o.itemName,
        o.deliveryAddress,
        o.phone,
        o.otp ?? "",
        STATUS_LABELS[o.status],
        date(o.activityDateIso),
        o.gstin ?? "",
        amountCell(o.pricePaid),
        date(o.expectedDateIso),
        date(o.deliveredDateIso),
        date(o.cancelledDateIso),
        o.replacementOf ?? "",
        date(o.replacementDateIso),
        date(o.replacementDeliveredDateIso),
        date(o.replacementCancelledDateIso),
        amountCell(o.refundAmount),
        o.refundStatus ?? "",
        date(o.refundDateIso),
        // ok / failed / skipped: tells "no refund" apart from "the lookup failed or never ran".
        o.detailStatus ?? "",
      ]
        .map(csvCell)
        .join(","),
    );
  }
  // Prepend a UTF-8 BOM so Excel opens non-ASCII names/addresses correctly.
  return `\uFEFF${lines.join("\r\n")}`;
}
