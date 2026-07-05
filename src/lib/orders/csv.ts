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
];

// RFC-4180 escaping: wrap in quotes and double inner quotes when the cell contains
// a comma, quote, or newline.
function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function ordersToCsv(orders: Order[]): string {
  const lines = [HEADERS.map(csvCell).join(",")];
  for (const o of orders) {
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
        o.activityDateIso,
      ]
        .map(csvCell)
        .join(","),
    );
  }
  // Prepend a UTF-8 BOM so Excel opens non-ASCII names/addresses correctly.
  return `\uFEFF${lines.join("\r\n")}`;
}
