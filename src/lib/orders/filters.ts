import type { Order, OrderStatus } from "../types";

// "custom" uses dateFrom/dateTo instead of a preset window.
export type DateScope = "all" | "today" | "tomorrow" | "next7" | "past7" | "custom";

// "none" = no refund at all; "completed" / "initiated" match Order.refundStatus.
export type RefundFilter = "all" | "completed" | "initiated" | "none";

// Every selected flag must hold (AND), so ticking more flags narrows the list.
export type OrderFlag = "hasOtp" | "replacement" | "hasGstin" | "detailFailed";

export interface OrderFilters {
  statuses: OrderStatus[]; // empty = all statuses
  date: DateScope;
  accounts: string[]; // [] = all accounts; otherwise keep orders whose account is in this set
  search: string;
  // Optional so the frozen extension, which shares this module, still compiles; absent = no filter.
  dateFrom?: string; // "YYYY-MM-DD" inclusive, only with date "custom"; "" = open-ended
  dateTo?: string; // "YYYY-MM-DD" inclusive, only with date "custom"; "" = open-ended
  refund?: RefundFilter;
  flags?: OrderFlag[];
  priceMin?: number | null; // INR, inclusive; a set bound drops rows with no known price
  priceMax?: number | null;
}

export const DEFAULT_FILTERS: OrderFilters = {
  statuses: [],
  date: "all",
  accounts: [],
  search: "",
  dateFrom: "",
  dateTo: "",
  refund: "all",
  flags: [],
  priceMin: null,
  priceMax: null,
};

// True when nothing would be filtered out (drives the "Clear" buttons).
export function isDefaultFilters(f: OrderFilters): boolean {
  return (
    f.statuses.length === 0 &&
    (f.date === "all" || (f.date === "custom" && !f.dateFrom && !f.dateTo)) &&
    f.accounts.length === 0 &&
    f.search === "" &&
    (f.refund ?? "all") === "all" &&
    (f.flags ?? []).length === 0 &&
    f.priceMin == null &&
    f.priceMax == null
  );
}

function hasFlag(o: Order, flag: OrderFlag): boolean {
  switch (flag) {
    case "hasOtp":
      return !!o.otp;
    case "replacement":
      return !!o.replacementOf;
    case "hasGstin":
      return !!o.gstin;
    case "detailFailed":
      return o.detailStatus === "failed";
  }
}

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
    if (f.accounts.length > 0 && !f.accounts.includes(o.account)) return false;

    if (f.date !== "all") {
      const d = new Date(o.activityDateIso);
      if (Number.isNaN(d.getTime())) return false;
      const ymd = ymdInTz(d, timeZone);
      if (f.date === "today" && ymd !== todayYmd) return false;
      if (f.date === "tomorrow" && ymd !== tomorrowYmd) return false;
      // YYYY-MM-DD sorts lexicographically, so string range checks are date-correct.
      if (f.date === "next7" && !(ymd >= todayYmd && ymd <= in7Ymd)) return false;
      if (f.date === "past7" && !(ymd <= todayYmd && ymd >= ago7Ymd)) return false;
      if (f.date === "custom") {
        if (f.dateFrom && ymd < f.dateFrom) return false;
        if (f.dateTo && ymd > f.dateTo) return false;
      }
    }

    const refund = f.refund ?? "all";
    if (refund !== "all") {
      const rs = o.refundStatus ?? "";
      if (refund === "none" ? rs !== "" : rs !== refund) return false;
    }

    for (const flag of f.flags ?? []) if (!hasFlag(o, flag)) return false;

    if (f.priceMin != null || f.priceMax != null) {
      const p = o.pricePaid;
      if (p == null) return false;
      if (f.priceMin != null && p < f.priceMin) return false;
      if (f.priceMax != null && p > f.priceMax) return false;
    }

    if (search) {
      // replacementOf is the ORIGINAL shipment's tracking id, so searching an original tracking id
      // also finds the replacement shipment(s) raised for it.
      const hay =
        `${o.orderId} ${o.trackingId} ${o.replacementOf ?? ""} ${o.phone} ${o.itemName} ${o.customerName} ${o.account}`.toLowerCase();
      if (!hay.includes(search)) return false;
    }
    return true;
  });
}
