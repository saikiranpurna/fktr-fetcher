import type { Order, OrderStatus } from "../types";

export type DateScope = "all" | "today" | "tomorrow" | "next7" | "past7";

export interface OrderFilters {
  statuses: OrderStatus[]; // empty = all statuses
  date: DateScope;
  account: string; // "" = all accounts
  search: string;
}

export const DEFAULT_FILTERS: OrderFilters = { statuses: [], date: "all", account: "", search: "" };

// "YYYY-MM-DD" for the given instant in the target timezone (en-CA yields ISO order).
export function ymdInTz(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

// Pure filter used for BOTH the on-screen list and the CSV export, so they always match.
export function applyOrderFilters(
  orders: Order[],
  f: OrderFilters,
  now: Date,
  timeZone: string,
): Order[] {
  const DAY = 24 * 60 * 60 * 1000;
  const todayYmd = ymdInTz(now, timeZone);
  const tomorrowYmd = ymdInTz(new Date(now.getTime() + DAY), timeZone);
  const in7Ymd = ymdInTz(new Date(now.getTime() + 7 * DAY), timeZone);
  const ago7Ymd = ymdInTz(new Date(now.getTime() - 7 * DAY), timeZone);
  const search = f.search.trim().toLowerCase();

  return orders.filter((o) => {
    if (f.statuses.length > 0 && !f.statuses.includes(o.status)) return false;
    if (f.account && o.account !== f.account) return false;

    if (f.date !== "all") {
      const d = new Date(o.activityDateIso);
      if (Number.isNaN(d.getTime())) return false;
      const ymd = ymdInTz(d, timeZone);
      if (f.date === "today" && ymd !== todayYmd) return false;
      if (f.date === "tomorrow" && ymd !== tomorrowYmd) return false;
      // YYYY-MM-DD sorts lexicographically, so string range checks are date-correct.
      if (f.date === "next7" && !(ymd >= todayYmd && ymd <= in7Ymd)) return false;
      if (f.date === "past7" && !(ymd <= todayYmd && ymd >= ago7Ymd)) return false;
    }

    if (search) {
      const hay = `${o.orderId} ${o.trackingId} ${o.phone} ${o.itemName} ${o.customerName} ${o.account}`.toLowerCase();
      if (!hay.includes(search)) return false;
    }
    return true;
  });
}
