import { describe, expect, it } from "vitest";
import type { Order } from "../types";
import { ordersToCsv } from "./csv";

function order(overrides: Partial<Order>): Order {
  return {
    account: "Seller North",
    orderId: "OD001",
    trackingId: "FMPP4118839140",
    customerName: "Asha Verma",
    itemName: "Boat Airdopes 141",
    deliveryAddress: "12 MG Road, Bengaluru",
    phone: "9000302101",
    otp: "8842",
    status: "OUT_FOR_DELIVERY",
    rawStatus: "Out for Delivery",
    activityDateIso: "2026-07-01T09:00:00+05:30",
    ...overrides,
  };
}

describe("ordersToCsv", () => {
  it("emits a BOM + header row and quotes cells containing commas", () => {
    const csv = ordersToCsv([order({})]);
    expect(csv.startsWith("\uFEFF")).toBe(true);
    const lines = csv.slice(1).split("\r\n");
    expect(lines[0]).toBe(
      "Account,Order ID,Tracking ID,Customer Name,Item,Delivery Address,Mobile,OTP,Status,Activity Date",
    );
    // Address has a comma -> must be quoted.
    expect(lines[1]).toContain('"12 MG Road, Bengaluru"');
    expect(lines[1]).toContain("Out for Delivery");
    expect(lines[1]).toContain("8842");
    expect(lines[1]).toContain("FMPP4118839140");
    expect(lines[1]).toContain("9000302101");
  });

  it("renders a null OTP as an empty field and escapes embedded quotes", () => {
    const csv = ordersToCsv([order({ otp: null, customerName: 'A "B" C', status: "DELIVERED" })]);
    const row = csv.slice(1).split("\r\n")[1];
    expect(row).toContain('"A ""B"" C"');
    expect(row).toContain("Delivered");
    // Account,OrderID,"A ""B"" C",Item,"...",<empty otp>,Delivered,date
    expect(row.split(",").length).toBeGreaterThanOrEqual(8);
  });
});
