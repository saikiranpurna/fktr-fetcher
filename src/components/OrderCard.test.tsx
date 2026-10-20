import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Order } from "@/lib/types";
import { OrderCard } from "./OrderCard";

afterEach(cleanup);

function order(overrides: Partial<Order> = {}): Order {
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

const history = () => screen.queryByRole("list", { name: "Shipment history" });

describe("OrderCard", () => {
  it("renders a plain order without a lifecycle section, replacement tag or failure note", () => {
    render(<OrderCard order={order({ detailStatus: "ok", replacementOf: "", refundStatus: "" })} />);
    expect(screen.getByText("Asha Verma")).toBeTruthy();
    expect(screen.getByText("8842")).toBeTruthy();
    expect(history()).toBeNull();
    expect(screen.queryByText(/Replacement of/)).toBeNull();
    expect(screen.queryByText("Details unavailable")).toBeNull();
  });

  it("also renders an order from a producer that predates the lifecycle fields", () => {
    render(<OrderCard order={order()} />);
    expect(screen.getByRole("article")).toBeTruthy();
    expect(history()).toBeNull();
    expect(screen.queryByText(/^Paid/)).toBeNull();
  });

  it("shows the paid amount in INR and the expected date in IST", () => {
    render(<OrderCard order={order({ pricePaid: 1499, expectedDateIso: "2026-07-01T20:00:00Z" })} />);
    expect(screen.getByText("₹1,499.00").parentElement?.textContent).toBe("Paid ₹1,499.00");
    // 20:00 UTC is 01:30 the next day in IST.
    expect(screen.getByText("2 Jul, 01:30").parentElement?.textContent).toBe("Expected 2 Jul, 01:30");
  });

  it("explains a genuine ₹0 instead of showing Paid ₹0.00", () => {
    const priceText = () => screen.getByText(/^(Paid|Not charged|Free)/).textContent;
    render(<OrderCard order={order({ pricePaid: 0, rawStatus: "Order Not Placed", status: "OTHER" })} />);
    expect(priceText()).toBe("Not charged (order not placed)");
    cleanup();
    render(<OrderCard order={order({ pricePaid: 0, replacementOf: "FMPPORIG000001", status: "DELIVERED" })} />);
    expect(priceText()).toBe("Free replacement");
    cleanup();
    render(<OrderCard order={order({ pricePaid: 0, status: "DELIVERED", rawStatus: "Delivered on Oct 02" })} />);
    expect(priceText()).toBe("Free");
    expect(screen.queryByText(/₹0/)).toBeNull();
  });

  it("prefers the delivered date over the expected one, and renders dates in the given timezone", () => {
    render(
      <OrderCard
        timezone="UTC"
        order={order({
          status: "DELIVERED",
          expectedDateIso: "2026-07-01T20:00:00Z",
          deliveredDateIso: "2026-07-01T18:00:00Z",
        })}
      />,
    );
    const time = screen.getByText("1 Jul, 18:00");
    expect(time.parentElement?.textContent).toBe("Delivered 1 Jul, 18:00");
    expect(screen.queryByText(/Expected/)).toBeNull();
    expect(time.tagName).toBe("TIME");
    expect(time.getAttribute("dateTime")).toBe("2026-07-01T18:00:00.000Z");
    expect(time.getAttribute("title")).toBe("1 Jul 2026, 18:00 UTC");
  });

  it("lists the cancel, replacement and refund events that exist, in lifecycle order", () => {
    render(
      <OrderCard
        order={order({
          status: "CANCELLED",
          cancelledDateIso: "2026-07-01T20:00:00Z",
          replacementDateIso: "2026-07-02T04:30:00Z",
          replacementDeliveredDateIso: "2026-07-03T05:00:00Z",
          replacementCancelledDateIso: "2026-07-04T06:00:00Z",
          refundAmount: 1499,
          refundStatus: "completed",
          refundDateIso: "2026-07-05T07:30:00Z",
        })}
      />,
    );
    const items = within(history()!).getAllByRole("listitem").map((li) => li.textContent);
    expect(items).toEqual([
      "Cancelled2 Jul, 01:30",
      "Replacement requested2 Jul, 10:00",
      "Replacement delivered3 Jul, 10:30",
      "Replacement cancelled4 Jul, 11:30",
      "Refund ₹1,499.00 completed5 Jul, 13:00",
    ]);
  });

  it("shows only the events present, e.g. an initiated refund on its own", () => {
    render(
      <OrderCard
        order={order({
          status: "DELIVERED",
          cancelledDateIso: null,
          replacementDateIso: null,
          refundAmount: 250.5,
          refundStatus: "initiated",
          refundDateIso: "2026-07-05T07:30:00Z",
        })}
      />,
    );
    const items = within(history()!).getAllByRole("listitem");
    expect(items).toHaveLength(1);
    expect(items[0].textContent).toBe("Refund ₹250.50 initiated5 Jul, 13:00");
  });

  it("does not show a cancelled shipment as still expected", () => {
    render(
      <OrderCard
        order={order({
          status: "CANCELLED",
          expectedDateIso: "2026-07-04T10:00:00Z",
          cancelledDateIso: "2026-07-01T20:00:00Z",
        })}
      />,
    );
    expect(screen.queryByText(/Expected/)).toBeNull();
    expect(within(history()!).getByText("Cancelled")).toBeTruthy();
  });

  it("tags a replacement shipment with the original tracking id", () => {
    render(<OrderCard order={order({ trackingId: "FMPPNEW0000001", replacementOf: "FMPPORIG000001" })} />);
    expect(screen.getByText(/Replacement of/).textContent).toBe("Replacement of FMPPORIG000001");
    expect(screen.getByText("FMPPNEW0000001")).toBeTruthy();
  });

  it("offers the invoice download only on delivered shipments of a known account", () => {
    const button = () => screen.queryByRole("button", { name: "Download invoice for order OD001" });
    const known = { accountId: "seller-north", unitId: "U1" };
    render(<OrderCard order={order({ status: "DELIVERED", otp: null, ...known })} />);
    expect(button()).toBeTruthy();
    cleanup();
    render(<OrderCard order={order(known)} />); // still out for delivery
    expect(button()).toBeNull();
    cleanup();
    render(<OrderCard order={order({ status: "DELIVERED", otp: null })} />); // older backend: no ids
    expect(button()).toBeNull();
  });

  it("notes when the shipment's detail lookup failed, but not when it was skipped", () => {
    render(<OrderCard order={order({ detailStatus: "failed" })} />);
    expect(screen.getByText("Details unavailable")).toBeTruthy();
    cleanup();
    render(<OrderCard order={order({ detailStatus: "skipped" })} />);
    expect(screen.queryByText("Details unavailable")).toBeNull();
  });
});
