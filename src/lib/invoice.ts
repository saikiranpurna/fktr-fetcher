// Invoice downloads: a card's own tax invoice, or a ZIP of the filtered cards'. Flipkart serves
// invoices only per ORDER (a bundle of every shipment's documents, once a unit has shipped); the
// backend picks each shipment's tax invoice out of it, so the dashboard offers them on delivered rows.
// Relative imports only: the frozen extension type-checks src/lib without the @/ alias.
import { API_BASE } from "./api";
import { saveBlob } from "./download";
import type { ErrorCode, ErrorResponse, Order } from "./types";

// Most orders per bulk ZIP when the backend doesn't say (it reports INVOICE_ZIP_MAX in /api/orders).
export const INVOICE_ZIP_MAX = 100;

export class InvoiceError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

// One order's filtered cards: every account it shows up under (an order can be shared between
// accounts) and the units (cards) whose tax invoices are wanted.
export type InvoiceOrder = { orderId: string; accountIds: string[]; unitIds: string[] };

export function canDownloadInvoice(o: Order): boolean {
  return o.status === "DELIVERED" && !!o.accountId && !!o.unitId;
}

// The cards among the given rows (the list's filtered rows, so list, CSV and ZIP agree), grouped by
// order: the backend fetches each order's bundle once, through the first of its accounts that can.
export function invoiceOrders(orders: Order[]): InvoiceOrder[] {
  const byOrder = new Map<string, InvoiceOrder>();
  for (const o of orders) {
    if (!o.accountId || !o.unitId || !canDownloadInvoice(o)) continue;
    let entry = byOrder.get(o.orderId);
    if (!entry) {
      entry = { orderId: o.orderId, accountIds: [], unitIds: [] };
      byOrder.set(o.orderId, entry);
    }
    if (!entry.accountIds.includes(o.accountId)) entry.accountIds.push(o.accountId);
    if (!entry.unitIds.includes(o.unitId)) entry.unitIds.push(o.unitId);
  }
  return Array.from(byOrder.values());
}

export function toInvoiceError(err: unknown): InvoiceError {
  return err instanceof InvoiceError ? err : new InvoiceError("UNKNOWN", (err as Error)?.message || "Unexpected error.");
}

// Keeps the backend's typed code (for errorText) and its actionable message.
async function errorOf(res: Response): Promise<InvoiceError> {
  try {
    const body = (await res.json()) as ErrorResponse;
    if (body && body.ok === false && body.error) return new InvoiceError(body.error.code, body.error.message);
  } catch {
    // not JSON: fall through
  }
  return new InvoiceError("UNKNOWN", `HTTP ${res.status}`);
}

async function send(url: string, init?: RequestInit): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, { cache: "no-store", ...init });
  } catch (err) {
    throw new InvoiceError("UNKNOWN", (err as Error).message || "Network error.");
  }
  if (!res.ok) throw await errorOf(res);
  return res;
}

// This card's tax invoice only (a PDF), not the rest of the order's bundle.
export async function downloadInvoice(o: Order): Promise<void> {
  const query = new URLSearchParams({ accountId: o.accountId ?? "", orderId: o.orderId, unitId: o.unitId ?? "" });
  // The custom header makes the browser preflight the request, so only the allowed UI origin can
  // trigger this live Flipkart call (a foreign page's plain link or <img> is refused).
  const res = await send(`${API_BASE}/api/invoice?${query.toString()}`, { headers: { "X-Requested-With": "fktr" } });
  saveBlob(await res.blob(), `invoice-${o.orderId}-${o.trackingId || o.unitId}.pdf`);
}

export async function downloadInvoicesZip(batch: InvoiceOrder[]): Promise<{ files: number; missing: number }> {
  const res = await send(`${API_BASE}/api/invoices/zip`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ orders: batch }),
  });
  saveBlob(await res.blob(), `flipkart-invoices-${new Date().toISOString().slice(0, 10)}.zip`);
  return {
    files: Number(res.headers.get("x-invoice-files") ?? 0),
    missing: Number(res.headers.get("x-invoice-missing") ?? 0),
  };
}
