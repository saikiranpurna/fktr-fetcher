import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AppError } from "../errors";
import type { ParsedOrder } from "../types";
import { buildFlipkartPayload } from "./__fixtures__/flipkart-orders";
import { detailRequestFor, mapStatus, parseOrders, parseOrdersFromHtml } from "./parser";

const sampleHtml = readFileSync(
  join(process.cwd(), "src/lib/flipkart/__fixtures__/orders.sample.html"),
  "utf8",
);

const DELIVERED_MS = Date.parse("2026-06-26T11:30:00+05:30");
const PROMISED_MS = Date.parse("2026-07-01T18:00:00+05:30");

const payload = buildFlipkartPayload([
  { orderId: "ODA", titles: ["Boat Airdopes 141"], heading: "Out for delivery", promisedMs: PROMISED_MS, otp: "8842" },
  {
    orderId: "ODB",
    titles: ["Samsung 990 PRO", "Samsung 990 PRO", "SanDisk Ultra"], // dup + distinct
    heading: "Delivered on Jun 26",
    deliveredMs: DELIVERED_MS,
  },
  { orderId: "ODC", titles: ["Kettle"], heading: "Arriving today by 11 pm", promisedMs: PROMISED_MS },
  { orderId: "", titles: ["Ghost"], heading: "Out for delivery", otp: "0001" }, // skipped (no orderId)
]);

function byId(orders: ParsedOrder[], id: string): ParsedOrder {
  const found = orders.find((o) => o.orderId === id);
  if (!found) throw new Error(`order ${id} not parsed`);
  return found;
}

describe("mapStatus", () => {
  it("prefers OUT_FOR_DELIVERY and tolerates casing/underscores", () => {
    expect(mapStatus("Out For Delivery")).toBe("OUT_FOR_DELIVERY");
    expect(mapStatus("OUT_FOR_DELIVERY")).toBe("OUT_FOR_DELIVERY");
    expect(mapStatus("Delivered on Jun 26")).toBe("DELIVERED");
    expect(mapStatus("Delivery expected by Jul 05")).toBe("ARRIVING");
    expect(mapStatus("Arriving today by 11 pm")).toBe("ARRIVING");
    expect(mapStatus("")).toBe("OTHER");
  });
});

describe("parseOrders (flipkart shape)", () => {
  const orders = parseOrders(payload);

  it("collapses orders and skips the one with an empty orderId", () => {
    expect(orders).toHaveLength(3);
    expect(orders.some((o) => o.orderId === "")).toBe(false);
  });

  it("derives status from the unit heading", () => {
    expect(byId(orders, "ODA").status).toBe("OUT_FOR_DELIVERY");
    expect(byId(orders, "ODB").status).toBe("DELIVERED");
    expect(byId(orders, "ODC").status).toBe("ARRIVING"); // "Arriving today" = in transit, today ETA
  });

  it("dedups product titles into a single item summary", () => {
    expect(byId(orders, "ODA").itemName).toBe("Boat Airdopes 141");
    expect(byId(orders, "ODB").itemName).toBe("Samsung 990 PRO (+1 more)"); // 2 distinct of 3 units
  });

  it("uses delivered date for delivered orders and promised date otherwise", () => {
    expect(byId(orders, "ODB").activityDateIso).toBe(new Date(DELIVERED_MS).toISOString());
    expect(byId(orders, "ODA").activityDateIso).toBe(new Date(PROMISED_MS).toISOString());
  });

  it("extracts the delivery OTP when present, else null; name/address unavailable from list", () => {
    expect(byId(orders, "ODA").otp).toBe("8842");
    expect(byId(orders, "ODB").otp).toBeNull();
    expect(byId(orders, "ODA").customerName).toBe("Unknown customer");
    expect(byId(orders, "ODA").deliveryAddress).toBe("Address unavailable");
  });

  it("throws PARSE_ERROR on bad shapes", () => {
    expect(() => parseOrders({})).toThrow(AppError);
    expect(() => parseOrders("<html>")).toThrow(AppError);
    try {
      parseOrders({});
    } catch (err) {
      expect((err as AppError).code).toBe("PARSE_ERROR");
    }
  });

  it("returns [] for a clean-empty orders array (empty != error)", () => {
    expect(parseOrders(buildFlipkartPayload([]))).toEqual([]);
  });

  it("shows the real product, not add-ons (Flipkart Black Membership / Trust Shield)", () => {
    const withVas = {
      RESPONSE: {
        multipleOrderDetailsView: {
          orders: [
            {
              orderMetaData: { orderId: "ODV", orderDate: 0 },
              accessToOrderDataBag: { buyer: { name: "Ravi Shankar" } },
              productDataBag: {
                LPTOP: { productBasicData: { title: "Samsung Galaxy Book4" } },
                MEMB: { productBasicData: { title: "Flipkart Black Membership 3 Months" } },
              },
              units: {
                u1: {
                  metaData: { listingId: "MEMB", moRedesignHeading: "Delivered instantly" },
                  deliveryDataBag: { promiseDataBag: {} },
                  vasItemDetails: { some: "vas" },
                },
                u2: {
                  metaData: { listingId: "LPTOP", moRedesignHeading: "Arriving tomorrow by 11 pm" },
                  deliveryDataBag: { promiseDataBag: { promisedDate: Date.parse("2026-07-04T20:00:00+05:30") } },
                },
              },
            },
          ],
        },
      },
    };
    const [order] = parseOrders(withVas);
    expect(order.itemName).toBe("Samsung Galaxy Book4");
    expect(order.status).toBe("ARRIVING"); // from the real product, not the "Delivered instantly" voucher
    expect(order.customerName).toBe("Ravi Shankar"); // from accessToOrderDataBag.buyer.name
  });
});

describe("parseOrdersFromHtml", () => {
  it("parses data-attribute rows", () => {
    const orders = parseOrdersFromHtml(sampleHtml);
    expect(orders).toHaveLength(2);
    expect(orders[0].orderId).toBe("OD101");
    expect(orders[0].status).toBe("OUT_FOR_DELIVERY");
    expect(orders[0].otp).toBe("8842");
    expect(orders[1].status).toBe("DELIVERED");
  });

  it("returns [] for empty input", () => {
    expect(parseOrdersFromHtml("")).toEqual([]);
  });
});

describe("detailRequestFor", () => {
  it("derives orderId, unitId (units-map key), and shareToken", () => {
    const order = {
      orderMetaData: { orderId: "OD9" },
      accessToOrderDataBag: { endUser: { id: "SHX" } },
      units: { OD9_u0: {} },
    };
    expect(detailRequestFor(order)).toEqual({ orderId: "OD9", unitId: "OD9_u0", shareToken: "SHX" });
  });

  it("returns null without a share token", () => {
    expect(detailRequestFor({ orderMetaData: { orderId: "OD9" }, units: { u: {} } })).toBeNull();
  });
});

describe("detail enrichment (address + live OTP)", () => {
  function orderWith(detail: unknown) {
    return {
      RESPONSE: {
        multipleOrderDetailsView: {
          orders: [
            {
              orderMetaData: { orderId: "OD1", orderDate: 0 },
              productDataBag: { L: { productBasicData: { title: "Book" } } },
              units: { u1: { metaData: { listingId: "L", moRedesignHeading: "Out for delivery" }, deliveryDataBag: { promiseDataBag: {} } } },
              __detail: detail,
            },
          ],
        },
      },
    };
  }

  it("formats the injected detail address and appends the pincode when missing", () => {
    const [o] = parseOrders(orderWith({ address: { addressLine1: "12 MG Road, Bengaluru", pinCode: "560001" } }));
    expect(o.deliveryAddress).toBe("12 MG Road, Bengaluru - 560001");
  });

  it("keeps 'Address unavailable' when no detail was injected", () => {
    const [o] = parseOrders(buildFlipkartPayload([{ orderId: "OD1", titles: ["Book"], heading: "Out for delivery" }]));
    expect(o.deliveryAddress).toBe("Address unavailable");
  });

  it("uses the detail otpCallout when the list unit has none", () => {
    const [o] = parseOrders(orderWith({ otpCallout: { otp: "4321" } }));
    expect(o.otp).toBe("4321");
  });
});
