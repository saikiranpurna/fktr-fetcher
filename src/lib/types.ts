export type OrderStatus = "OUT_FOR_DELIVERY" | "DELIVERED" | "ARRIVING" | "OTHER";

export interface Order {
  account: string; // label of the Flipkart account this order came from
  orderId: string;
  trackingId: string; // shipment/tracking id (e.g. FMPP4118839140); "" when not yet shipped
  customerName: string; // "Unknown customer" when source field missing
  itemName: string; // first item title; "<title> (+N more)" for multi-item
  deliveryAddress: string; // non-empty address parts joined by ", "
  phone: string; // delivery contact mobile (from the detail endpoint); "" when unavailable
  otp: string | null; // null when unavailable
  status: OrderStatus;
  rawStatus: string; // original status text, kept for debugging/logging
  activityDateIso: string; // ISO ts used for the "today" filter (see semantics)
}

// What the parser produces before the service tags it with an account.
export type ParsedOrder = Omit<Order, "account">;

export const STATUS_LABELS: Record<OrderStatus, string> = {
  OUT_FOR_DELIVERY: "Out for Delivery",
  DELIVERED: "Delivered",
  ARRIVING: "Arriving",
  OTHER: "Other",
};

export type ErrorCode =
  | "AUTH_EXPIRED" // cookie invalid/expired          -> HTTP 401
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
  count: number; // today's matched orders from this account
  error?: { code: ErrorCode; message: string };
  pending?: boolean; // background poller hasn't completed a first fetch for this account yet
  fetchedAt?: string | null; // ISO of this account's last completed fetch
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
