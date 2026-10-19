export type OrderStatus = "OUT_FOR_DELIVERY" | "DELIVERED" | "ARRIVING" | "CANCELLED" | "OTHER";

// Outcome of the per-shipment detail lookup, so an empty refund/date cell is never ambiguous:
// "ok" = looked up (empty means "none"), "failed" = lookup errored, "skipped" = not attempted
// (outside the targeted tiers/caps, or the per-account deadline was hit).
export type DetailStatus = "ok" | "failed" | "skipped";

// "completed" once Flipkart reports the refund credited, "initiated" while it is in flight, "" = no refund.
export type RefundStatus = "completed" | "initiated" | "";

// One row per shipment (unit): a multi-item order yields one Order per unit.
export interface Order {
  account: string; // label of the Flipkart account this order came from
  orderId: string;
  trackingId: string; // shipment/tracking id (e.g. FMPP4118839140); "" when not yet shipped
  customerName: string; // "Unknown customer" when source field missing
  itemName: string; // product title of THIS unit
  deliveryAddress: string; // non-empty address parts joined by ", "
  phone: string; // delivery contact mobile (from the detail endpoint); "" when unavailable
  otp: string | null; // null when unavailable
  status: OrderStatus;
  rawStatus: string; // original status text, kept for debugging/logging
  // ISO ts used by the date filters: the latest lifecycle event (cancel / replacement / refund) when
  // the unit has one, else the delivered or promised date, falling back to the order date.
  activityDateIso: string;
  gstin?: string; // order's GST number (from the order-detail "GST details" section); absent otherwise

  // Lifecycle fields. The backend always emits them (null / "" when absent); they're optional here
  // so producers that predate them (the frozen extension's parser) still type-check.
  pricePaid?: number | null; // amount the customer paid for this unit (after discounts), INR
  expectedDateIso?: string | null; // promised delivery date
  deliveredDateIso?: string | null;
  cancelledDateIso?: string | null;
  replacementDateIso?: string | null; // replacement requested (latest replacement wins)
  replacementDeliveredDateIso?: string | null;
  replacementCancelledDateIso?: string | null;
  replacementOf?: string; // on a replacement shipment's row: the ORIGINAL shipment's tracking ID; "" otherwise
  refundAmount?: number | null; // total refunded for this unit, INR
  refundStatus?: RefundStatus;
  refundDateIso?: string | null; // latest completed refund date, else the initiated date
  detailStatus?: DetailStatus;
}

// What the parser produces before the service tags it with an account.
export type ParsedOrder = Omit<Order, "account">;

export const STATUS_LABELS: Record<OrderStatus, string> = {
  OUT_FOR_DELIVERY: "Out for Delivery",
  DELIVERED: "Delivered",
  ARRIVING: "Arriving",
  CANCELLED: "Cancelled",
  OTHER: "Other",
};

export type ErrorCode =
  | "AUTH_EXPIRED" // cookie invalid/expired          -> HTTP 401
  | "UNAUTHORIZED" // admin token missing/wrong       -> HTTP 401
  | "UPSTREAM_ERROR" // network/timeout/5xx/other 4xx    -> HTTP 502
  | "PARSE_ERROR" // response shape unexpected         -> HTTP 502
  | "CONFIG_ERROR" // missing account or endpoint URL   -> HTTP 400
  | "UNKNOWN"; //                                   -> HTTP 500

// Per-account outcome of one fetch, surfaced so a single expired cookie
// does not blank the whole dashboard (partial success is success).
export interface AccountResult {
  id: string;
  label: string;
  ok: boolean;
  count: number; // rows (one per shipment) from this account's last successful fetch
  error?: { code: ErrorCode; message: string };
  pending?: boolean; // background poller hasn't completed a first fetch for this account yet
  fetchedAt?: string | null; // ISO of this account's last completed fetch
  partial?: boolean; // order history truncated (later page failed / time budget / page cap): older rows may be missing
  detailFailed?: number; // order-detail calls that failed in the last fetch (see Order.detailStatus per row)
}

// Aggregate progress of the background refresh loop across all accounts.
export interface Coverage {
  total: number;
  fetched: number; // accounts with at least one completed fetch
  pending: number; // accounts not yet fetched once
  ok: number;
  failed: number;
  inFlight: number; // accounts currently being fetched
  oldestFetchedAt: string | null;
  newestFetchedAt: string | null;
  intervalSeconds: number; // per-account refresh cadence
}

// Account metadata for the UI; never carries cookie values.
export interface AccountMeta {
  id: string;
  label: string;
  updatedAt: string | null;
  count: number; // number of cookies stored for the account
  active: boolean; // false = paused: cookies kept, but excluded from polling until reactivated
}

export interface OrdersResponse {
  ok: true;
  orders: Order[]; // union across accounts, each tagged with .account
  accounts: AccountResult[];
  coverage: Coverage;
  fetchedAt: string; // ISO
  timezone: string;
}

export interface AccountsResponse {
  accounts: AccountMeta[];
}

export interface ErrorResponse {
  ok: false;
  error: { code: ErrorCode; message: string }; // message is user-facing + actionable
}
