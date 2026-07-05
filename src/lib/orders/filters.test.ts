import { describe, expect, it } from "vitest";
import type { Order, OrderStatus } from "../types";
import { applyOrderFilters, DEFAULT_FILTERS, ymdInTz } from "./filters";

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
];

describe("ymdInTz", () => {
  it("formats the day in the target timezone", () => {
    expect(ymdInTz(new Date("2026-07-03T18:00:00Z"), TZ)).toBe("2026-07-03"); // 23:30 IST
    expect(ymdInTz(new Date("2026-07-03T19:00:00Z"), TZ)).toBe("2026-07-04"); // 00:30 IST next day
  });
});

describe("applyOrderFilters", () => {
  it("returns everything with default filters", () => {
    expect(applyOrderFilters(orders, DEFAULT_FILTERS, NOW, TZ)).toHaveLength(4);
  });

  it("filters by status", () => {
    const out = applyOrderFilters(orders, { ...DEFAULT_FILTERS, statuses: ["ARRIVING"] }, NOW, TZ);
    expect(out.map((o) => o.orderId)).toEqual(["C"]);
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
      applyOrderFilters(orders, { ...DEFAULT_FILTERS, account: "South" }, NOW, TZ).map((o) => o.orderId),
    ).toEqual(["B"]);
    expect(
      applyOrderFilters(orders, { ...DEFAULT_FILTERS, search: "macbook" }, NOW, TZ).map((o) => o.orderId),
    ).toEqual(["B"]);
    // status + date together: OFD today
    const combo = applyOrderFilters(
      orders,
      { statuses: ["OUT_FOR_DELIVERY"] as OrderStatus[], date: "today", account: "", search: "" },
      NOW,
      TZ,
    );
    expect(combo.map((o) => o.orderId)).toEqual(["A"]);
  });
});
