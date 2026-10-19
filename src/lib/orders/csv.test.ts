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

const HEADER =
  "Account,Order ID,Tracking ID,Customer Name,Item,Delivery Address,Mobile,OTP,Status,Activity Date,GSTIN," +
  "Price Paid,Expected Date,Delivered Date,Cancelled Date,Replacement Of,Replacement Date," +
  "Replacement Delivered Date,Replacement Cancelled Date,Refund Amount,Refund Status,Refund Date,Details";

// Minimal RFC-4180 line splitter for assertions: quoted cells may hold commas and "" escapes.
function cells(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

// Data rows of a CSV export as header -> cell records.
function rows(csv: string): Record<string, string>[] {
  const [head, ...body] = csv.slice(1).split("\r\n"); // drop the BOM
  const names = cells(head);
  return body.map((line) => Object.fromEntries(cells(line).map((v, i) => [names[i], v])));
}

describe("ordersToCsv", () => {
  it("emits a BOM + header row and quotes cells containing commas", () => {
    const csv = ordersToCsv([order({})]);
    expect(csv.startsWith("\uFEFF")).toBe(true);
    const lines = csv.slice(1).split("\r\n");
    expect(lines[0]).toBe(HEADER);
    // Address has a comma -> must be quoted.
    expect(lines[1]).toContain('"12 MG Road, Bengaluru"');
    expect(lines[1]).toContain("Out for Delivery");
    expect(lines[1]).toContain("8842");
    expect(lines[1]).toContain("FMPP4118839140");
    expect(lines[1]).toContain("9000302101");
    // Every row has exactly one cell per header.
    expect(cells(lines[1])).toHaveLength(cells(HEADER).length);
  });

  it("keeps the original columns in place, with GSTIN still the 11th", () => {
    expect(cells(HEADER).slice(0, 11)).toEqual([
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
    ]);
  });

  it("renders a null OTP as an empty field and escapes embedded quotes", () => {
    const csv = ordersToCsv([order({ otp: null, customerName: 'A "B" C', status: "DELIVERED" })]);
    const line = csv.slice(1).split("\r\n")[1];
    expect(line).toContain('"A ""B"" C"');
    const [row] = rows(csv);
    expect(row["Customer Name"]).toBe('A "B" C');
    expect(row.OTP).toBe("");
    expect(row.Status).toBe("Delivered");
  });

  it("fills the GSTIN column with its value", () => {
    const [row] = rows(ordersToCsv([order({ gstin: "36ABFFK3014J1ZH" })]));
    expect(row.GSTIN).toBe("36ABFFK3014J1ZH");
  });

  it("leaves the GSTIN column empty for an order without GST details", () => {
    const [row] = rows(ordersToCsv([order({})]));
    expect(row.GSTIN).toBe("");
  });

  it("renders Activity Date in IST as YYYY-MM-DD HH:mm, rolling over to the next IST day", () => {
    const [same, rollover] = rows(
      ordersToCsv([
        order({ trackingId: "FMPP1", activityDateIso: "2026-07-01T09:00:00+05:30" }),
        order({ trackingId: "FMPP2", activityDateIso: "2026-07-01T20:00:00Z" }), // 01:30 IST next day
      ]),
    );
    expect(same["Activity Date"]).toBe("2026-07-01 09:00");
    expect(rollover["Activity Date"]).toBe("2026-07-02 01:30");
  });

  it("formats midnight as 00:00 (h23) and honours an explicit timezone", () => {
    const midnightIst = order({ activityDateIso: "2026-07-01T18:30:00Z" }); // 00:00 IST on 2 Jul
    expect(rows(ordersToCsv([midnightIst]))[0]["Activity Date"]).toBe("2026-07-02 00:00");
    expect(rows(ordersToCsv([midnightIst], "UTC"))[0]["Activity Date"]).toBe("2026-07-01 18:30");
  });

  it("formats every lifecycle date column in IST and leaves missing or invalid dates empty", () => {
    const [row] = rows(
      ordersToCsv([
        order({
          activityDateIso: "not a date",
          expectedDateIso: "2026-07-01T20:00:00Z",
          deliveredDateIso: "2026-07-02T04:30:00Z",
          cancelledDateIso: null,
          replacementDateIso: "2026-07-03T00:00:00Z",
          replacementDeliveredDateIso: "2026-07-05T12:15:00+05:30",
          replacementCancelledDateIso: "",
          refundDateIso: "2026-07-06T23:59:00Z",
        }),
      ]),
    );
    expect(row["Activity Date"]).toBe("");
    expect(row["Expected Date"]).toBe("2026-07-02 01:30");
    expect(row["Delivered Date"]).toBe("2026-07-02 10:00");
    expect(row["Cancelled Date"]).toBe("");
    expect(row["Replacement Date"]).toBe("2026-07-03 05:30");
    expect(row["Replacement Delivered Date"]).toBe("2026-07-05 12:15");
    expect(row["Replacement Cancelled Date"]).toBe("");
    expect(row["Refund Date"]).toBe("2026-07-07 05:29");
  });

  it("writes amounts as plain numbers (no currency symbol), with null as empty", () => {
    const [paid, none, zero] = rows(
      ordersToCsv([
        order({ trackingId: "FMPP1", pricePaid: 1499.5, refundAmount: 12999 }),
        order({ trackingId: "FMPP2", pricePaid: null, refundAmount: null }),
        order({ trackingId: "FMPP3", pricePaid: 0 }),
      ]),
    );
    expect(paid["Price Paid"]).toBe("1499.5");
    expect(paid["Refund Amount"]).toBe("12999");
    expect(none["Price Paid"]).toBe("");
    expect(none["Refund Amount"]).toBe("");
    expect(zero["Price Paid"]).toBe("0");
    expect(zero["Refund Amount"]).toBe(""); // field absent (older producer) -> empty
  });

  it("carries replacement link, refund status and the Details lookup outcome", () => {
    const [replacement, failed, legacy] = rows(
      ordersToCsv([
        order({
          trackingId: "FMPPNEW",
          replacementOf: "FMPPORIG",
          refundStatus: "initiated",
          detailStatus: "ok",
        }),
        order({ trackingId: "FMPPFAIL", replacementOf: "", refundStatus: "", detailStatus: "failed" }),
        order({ trackingId: "FMPPOLD" }), // no lifecycle fields at all
      ]),
    );
    expect(replacement["Replacement Of"]).toBe("FMPPORIG");
    expect(replacement["Refund Status"]).toBe("initiated");
    expect(replacement.Details).toBe("ok");
    expect(failed["Replacement Of"]).toBe("");
    expect(failed.Details).toBe("failed");
    expect(legacy.Details).toBe("");
    expect(legacy["Refund Status"]).toBe("");
  });

  it("drops duplicate rows sharing a tracking id, keeping the first", () => {
    const csv = ordersToCsv([
      order({ trackingId: "FMPP1", itemName: "First" }),
      order({ trackingId: "FMPP1", itemName: "Dup" }),
      order({ trackingId: "FMPP2", itemName: "Other" }),
    ]);
    const lines = csv.slice(1).split("\r\n").slice(1); // drop header
    expect(lines).toHaveLength(2);
    expect(csv).toContain("First");
    expect(csv).not.toContain("Dup");
  });

  it("keeps every row that has no tracking id (not dedupable)", () => {
    const lines = ordersToCsv([order({ trackingId: "" }), order({ trackingId: "" })])
      .slice(1)
      .split("\r\n")
      .slice(1);
    expect(lines).toHaveLength(2);
  });
});
