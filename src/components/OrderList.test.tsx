import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Order } from "@/lib/types";
import { OrderList } from "./OrderList";

afterEach(cleanup);

const orders: Order[] = [
  {
    account: "Seller North",
    orderId: "OD001",
    trackingId: "FMPP4118839140",
    customerName: "Asha Verma",
    itemName: "Boat Airdopes 141",
    deliveryAddress: "12 MG Road, Bengaluru",
    otp: "8842",
    status: "OUT_FOR_DELIVERY",
    rawStatus: "Out for Delivery",
    activityDateIso: "2026-07-01T09:00:00+05:30",
  },
  {
    account: "Seller South",
    orderId: "OD002",
    trackingId: "",
    customerName: "Rohan Iyer",
    itemName: "Samsung 25W Charger",
    deliveryAddress: "45 Anna Salai, Chennai",
    otp: null,
    status: "DELIVERED",
    rawStatus: "Delivered",
    activityDateIso: "2026-07-01T11:30:00+05:30",
  },
];

describe("OrderList", () => {
  it("renders order cards with id, account, otp, and status badge", () => {
    render(<OrderList orders={orders} />);
    expect(screen.queryAllByRole("article")).toHaveLength(2);
    expect(screen.getByText("OD001")).toBeTruthy();
    expect(screen.getByText("8842")).toBeTruthy();
    expect(screen.getByText("Seller North")).toBeTruthy();
    expect(screen.getByText("Seller South")).toBeTruthy();
    expect(screen.getByText("Out for Delivery")).toBeTruthy();
    expect(screen.getByText("Delivered")).toBeTruthy();
    // null OTP renders the dash placeholder.
    expect(screen.getByText("—")).toBeTruthy();
    expect(screen.getByText("FMPP4118839140")).toBeTruthy();
  });

  it("shows the empty-state copy and no cards when there are no orders", () => {
    render(<OrderList orders={[]} />);
    expect(screen.queryAllByRole("article")).toHaveLength(0);
    expect(screen.getByText("No orders match the current filters.")).toBeTruthy();
  });
});
