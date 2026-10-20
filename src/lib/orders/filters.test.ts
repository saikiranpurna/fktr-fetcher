import { describe, expect, it } from "vitest";
import type { Order, OrderStatus } from "../types";
import {
  applyOrderFilters,
  DEFAULT_FILTERS,
  isDefaultFilters,
  type OrderFlag,
  type RefundFilter,
  ymdInTz,
} from "./filters";

const TZ = "Asia/Kolkata";
const NOW = new Date("2026-07-03T12:00:00+05:30");

function order(overrides: Partial<Order>): Order {
  return {
    account: "North",
    orderId: "OD1",
    trackingId: "",
    customerName: "Cust",
    itemName: "Thing",
    deliveryAddress: "Addr",
    phone: "",
    otp: null,
    status: "ARRIVING",
    rawStatus: "Arriving",
    activityDateIso: "2026-07-03T20:00:00+05:30",
    ...overrides,
  };
}

const orders: Order[] = [
  order({ orderId: "A", status: "OUT_FOR_DELIVERY", activityDateIso: "2026-07-03T09:00:00+05:30" }),
  order({ orderId: "B", status: "DELIVERED", activityDateIso: "2026-07-02T11:00:00+05:30", account: "South", itemName: "MacBook" }),
  order({ orderId: "C", status: "ARRIVING", activityDateIso: "2026-07-04T20:00:00+05:30" }), // tomorrow
  order({ orderId: "D", status: "OTHER", activityDateIso: "2026-07-03T10:00:00+05:30" }),
  order({ orderId: "E", status: "CANCELLED", activityDateIso: "2026-06-01T08:00:00+05:30" }), // well before every tested window
];

describe("ymdInTz", () => {
  it("formats the day in the target timezone", () => {
    expect(ymdInTz(new Date("2026-07-03T18:00:00Z"), TZ)).toBe("2026-07-03"); // 23:30 IST
    expect(ymdInTz(new Date("2026-07-03T19:00:00Z"), TZ)).toBe("2026-07-04"); // 00:30 IST next day
  });
});

describe("applyOrderFilters", () => {
  it("returns everything with default filters", () => {
    expect(applyOrderFilters(orders, DEFAULT_FILTERS, NOW, TZ)).toHaveLength(5);
  });

  it("filters by status", () => {
    expect(
      applyOrderFilters(orders, { ...DEFAULT_FILTERS, statuses: ["ARRIVING"] }, NOW, TZ).map((o) => o.orderId),
    ).toEqual(["C"]);
    expect(
      applyOrderFilters(orders, { ...DEFAULT_FILTERS, statuses: ["CANCELLED"] }, NOW, TZ).map((o) => o.orderId),
    ).toEqual(["E"]);
  });

  it("filters by date (today vs tomorrow)", () => {
    const today = applyOrderFilters(orders, { ...DEFAULT_FILTERS, date: "today" }, NOW, TZ);
    expect(today.map((o) => o.orderId).sort()).toEqual(["A", "D"]); // C is tomorrow, B is yesterday
    const tomorrow = applyOrderFilters(orders, { ...DEFAULT_FILTERS, date: "tomorrow" }, NOW, TZ);
    expect(tomorrow.map((o) => o.orderId)).toEqual(["C"]);
  });

  it("filters by rolling windows (next 7 / last 7 days)", () => {
    const next7 = applyOrderFilters(orders, { ...DEFAULT_FILTERS, date: "next7" }, NOW, TZ);
    expect(next7.map((o) => o.orderId).sort()).toEqual(["A", "C", "D"]); // today+tomorrow kept, yesterday out
    const past7 = applyOrderFilters(orders, { ...DEFAULT_FILTERS, date: "past7" }, NOW, TZ);
    expect(past7.map((o) => o.orderId).sort()).toEqual(["A", "B", "D"]); // today+yesterday kept, tomorrow out
  });

  it("filters by account and search, combinable with status", () => {
    expect(
      applyOrderFilters(orders, { ...DEFAULT_FILTERS, accounts: ["South"] }, NOW, TZ).map((o) => o.orderId),
    ).toEqual(["B"]);
    expect(
      applyOrderFilters(orders, { ...DEFAULT_FILTERS, search: "macbook" }, NOW, TZ).map((o) => o.orderId),
    ).toEqual(["B"]);
    // status + date together: OFD today
    const combo = applyOrderFilters(
      orders,
      { statuses: ["OUT_FOR_DELIVERY"] as OrderStatus[], date: "today", accounts: [], search: "" },
      NOW,
      TZ,
    );
    expect(combo.map((o) => o.orderId)).toEqual(["A"]);
  });

  it("search by an original tracking id also finds its replacement shipment", () => {
    const local: Order[] = [
      order({ orderId: "ORIG", trackingId: "FMPP1000000001" }),
      order({ orderId: "REPL", trackingId: "FMPP2000000002", replacementOf: "FMPP1000000001" }),
      order({ orderId: "OTHER", trackingId: "FMPP3000000003", replacementOf: "" }),
    ];
    const hits = applyOrderFilters(local, { ...DEFAULT_FILTERS, search: "fmpp1000000001" }, NOW, TZ);
    expect(hits.map((o) => o.orderId)).toEqual(["ORIG", "REPL"]);
    // The replacement's own tracking id still matches only the replacement.
    const own = applyOrderFilters(local, { ...DEFAULT_FILTERS, search: "FMPP2000000002" }, NOW, TZ);
    expect(own.map((o) => o.orderId)).toEqual(["REPL"]);
  });

  it("filters by multiple accounts (union of the selected set)", () => {
    const local: Order[] = [
      order({ orderId: "N", account: "North" }),
      order({ orderId: "S", account: "South" }),
      order({ orderId: "E", account: "East" }),
    ];
    const out = applyOrderFilters(local, { ...DEFAULT_FILTERS, accounts: ["North", "East"] }, NOW, TZ);
    expect(out.map((o) => o.orderId).sort()).toEqual(["E", "N"]);
  });

  it("filters by a custom inclusive date range, either end open", () => {
    const ids = (dateFrom: string, dateTo: string) =>
      applyOrderFilters(orders, { ...DEFAULT_FILTERS, date: "custom", dateFrom, dateTo }, NOW, TZ)
        .map((o) => o.orderId)
        .sort();
    expect(ids("2026-07-02", "2026-07-03")).toEqual(["A", "B", "D"]);
    expect(ids("2026-07-04", "")).toEqual(["C"]);
    expect(ids("", "2026-06-30")).toEqual(["E"]);
    expect(ids("", "")).toHaveLength(5); // custom with no bounds filters nothing
  });

  it("filters by refund status", () => {
    const local: Order[] = [
      order({ orderId: "DONE", refundStatus: "completed" }),
      order({ orderId: "WIP", refundStatus: "initiated" }),
      order({ orderId: "NONE", refundStatus: "" }),
      order({ orderId: "LEGACY" }), // a producer without refund fields counts as no refund
    ];
    const ids = (refund: RefundFilter) =>
      applyOrderFilters(local, { ...DEFAULT_FILTERS, refund }, NOW, TZ).map((o) => o.orderId);
    expect(ids("completed")).toEqual(["DONE"]);
    expect(ids("initiated")).toEqual(["WIP"]);
    expect(ids("none")).toEqual(["NONE", "LEGACY"]);
  });

  it("requires every selected flag", () => {
    const local: Order[] = [
      order({ orderId: "OTP", otp: "1234" }),
      order({ orderId: "OTP_GST", otp: "5678", gstin: "29ABCDE1234F1Z5" }),
      order({ orderId: "REPL", replacementOf: "FMPP1000000001" }),
      order({ orderId: "FAIL", detailStatus: "failed" }),
      order({ orderId: "PLAIN", detailStatus: "ok", replacementOf: "", gstin: "" }),
    ];
    const ids = (flags: OrderFlag[]) =>
      applyOrderFilters(local, { ...DEFAULT_FILTERS, flags }, NOW, TZ).map((o) => o.orderId);
    expect(ids(["hasOtp"])).toEqual(["OTP", "OTP_GST"]);
    expect(ids(["hasOtp", "hasGstin"])).toEqual(["OTP_GST"]);
    expect(ids(["replacement"])).toEqual(["REPL"]);
    expect(ids(["detailFailed"])).toEqual(["FAIL"]);
  });

  it("filters by an inclusive price range and drops rows without a price", () => {
    const local: Order[] = [
      order({ orderId: "CHEAP", pricePaid: 199 }),
      order({ orderId: "MID", pricePaid: 1500 }),
      order({ orderId: "DEAR", pricePaid: 50000 }),
      order({ orderId: "UNKNOWN", pricePaid: null }),
    ];
    const ids = (priceMin: number | null, priceMax: number | null) =>
      applyOrderFilters(local, { ...DEFAULT_FILTERS, priceMin, priceMax }, NOW, TZ).map((o) => o.orderId);
    expect(ids(199, 1500)).toEqual(["CHEAP", "MID"]);
    expect(ids(1000, null)).toEqual(["MID", "DEAR"]);
    expect(ids(null, 199)).toEqual(["CHEAP"]);
    expect(ids(null, null)).toHaveLength(4);
  });
});

describe("isDefaultFilters", () => {
  it("is true for the defaults and for filter objects without the optional fields", () => {
    expect(isDefaultFilters(DEFAULT_FILTERS)).toBe(true);
    expect(isDefaultFilters({ statuses: [], date: "all", accounts: [], search: "" })).toBe(true);
    expect(isDefaultFilters({ ...DEFAULT_FILTERS, date: "custom" })).toBe(true);
  });

  it("is false once any filter is set", () => {
    expect(isDefaultFilters({ ...DEFAULT_FILTERS, date: "custom", dateFrom: "2026-07-01" })).toBe(false);
    expect(isDefaultFilters({ ...DEFAULT_FILTERS, refund: "none" })).toBe(false);
    expect(isDefaultFilters({ ...DEFAULT_FILTERS, flags: ["hasOtp"] })).toBe(false);
    expect(isDefaultFilters({ ...DEFAULT_FILTERS, priceMin: 0 })).toBe(false);
  });
});
