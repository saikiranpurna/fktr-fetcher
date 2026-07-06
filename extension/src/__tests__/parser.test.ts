import { describe, it, expect } from "vitest";
import ordersPage1 from "../__fixtures__/orders-page1.json";
import detailOfd from "../__fixtures__/detail-ofd.json";
import detailDelivered from "../__fixtures__/detail-delivered.json";
import {
  mapStatus,
  extractDetail,
  formatAddress,
  ordersArray,
  parseOrders,
  ensureOrdersShape,
} from "../core/parser";
import { AppError } from "../core/errors";
import type { ParsedOrder } from "@core/types";

describe("mapStatus", () => {
  it("maps out-for-delivery and failed-attempt variants to OUT_FOR_DELIVERY", () => {
    expect(mapStatus("Out for delivery")).toBe("OUT_FOR_DELIVERY");
    expect(mapStatus("Delivery unsuccessful")).toBe("OUT_FOR_DELIVERY");
  });
  it("maps arriving / delivered / other", () => {
    expect(mapStatus("Arriving today by 11 pm")).toBe("ARRIVING");
    expect(mapStatus("Delivered on Sun Jul 05")).toBe("DELIVERED");
    expect(mapStatus("Cancelled")).toBe("OTHER");
  });
});

describe("extractDetail", () => {
  it("finds the address object and a 4-8 digit otpValue when out for delivery", () => {
    const d = extractDetail(detailOfd);
    expect(d.address).toBeTruthy();
    expect(d.otp).toBe("4321");
  });
  it("finds only the address (no OTP) for a delivered order", () => {
    const d = extractDetail(detailDelivered);
    expect(d.address).toBeTruthy();
    expect(d.otp).toBeNull();
  });
});

describe("formatAddress", () => {
  it("formats addressLine1 with pinCode", () => {
    const { address } = extractDetail(detailOfd);
    expect(formatAddress(address)).toBe("42 Example Road - 560001");
  });
  it("returns a sentinel for a missing address", () => {
    expect(formatAddress(null)).toBe("Address unavailable");
  });
});

describe("parseOrders", () => {
  const rows = parseOrders(ordersArray(ordersPage1) as unknown[], {});
  const byOrder = (id: string): ParsedOrder | undefined => rows.find((r) => r.orderId === id);

  it("explodes into one row per non-VAS unit (VAS membership skipped)", () => {
    expect(rows).toHaveLength(3);
  });

  it("forces OUT_FOR_DELIVERY when a unit carries an OTP", () => {
    const r = byOrder("OD100000000000000001")!;
    expect(r.status).toBe("OUT_FOR_DELIVERY");
    expect(r.otp).toBe("4321");
    expect(r.itemName).toBe("Wireless Mouse");
    expect(r.customerName).toBe("Test Buyer One");
    expect(r.trackingId).toBe("FMPP1000000001");
  });

  it("maps an arriving order", () => {
    const r = byOrder("OD100000000000000002")!;
    expect(r.status).toBe("ARRIVING");
    expect(r.otp).toBeNull();
    expect(r.itemName).toBe("USB-C Cable");
  });

  it("maps a delivered order and defaults a missing buyer name", () => {
    const r = byOrder("OD100000000000000003")!;
    expect(r.status).toBe("DELIVERED");
    expect(r.customerName).toBe("Unknown customer");
  });

  it("holds the shared invariants across every row", () => {
    for (const r of rows) {
      expect(r.orderId).not.toBe("");
      if (r.otp) expect(r.status).toBe("OUT_FOR_DELIVERY");
      // no details supplied -> address unavailable, no phone
      expect(r.deliveryAddress).toBe("Address unavailable");
      expect(r.phone).toBe("");
    }
  });
});

describe("ensureOrdersShape", () => {
  it("throws PARSE_ERROR when the orders array is missing", () => {
    try {
      ensureOrdersShape({});
      throw new Error("expected ensureOrdersShape to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      expect((e as AppError).code).toBe("PARSE_ERROR");
    }
  });
});
