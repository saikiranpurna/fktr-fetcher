import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_FILTERS } from "@/lib/orders/filters";
import { OrderFilters } from "./OrderFilters";

afterEach(cleanup);

describe("OrderFilters", () => {
  it("renders a Cancelled chip with its count and toggles the CANCELLED status", () => {
    const onChange = vi.fn();
    render(
      <OrderFilters
        filters={DEFAULT_FILTERS}
        onChange={onChange}
        accounts={[]}
        statusCounts={{ CANCELLED: 3, DELIVERED: 5 }}
      />,
    );

    // The Cancelled chip shows how many orders are cancelled.
    const chip = screen.getByRole("button", { name: /Cancelled\s*\(3\)/ });
    expect(chip).toBeTruthy();

    // Clicking it selects the CANCELLED status filter.
    fireEvent.click(chip);
    expect(onChange).toHaveBeenCalledWith({ ...DEFAULT_FILTERS, statuses: ["CANCELLED"] });
  });

  it("omits the count when no statusCounts are provided", () => {
    render(<OrderFilters filters={DEFAULT_FILTERS} onChange={() => {}} accounts={[]} />);
    expect(screen.getByRole("button", { name: "Cancelled" })).toBeTruthy();
  });

  it("shows date inputs only for a custom range and updates the bounds", () => {
    const onChange = vi.fn();
    const { rerender } = render(<OrderFilters filters={DEFAULT_FILTERS} onChange={onChange} accounts={[]} />);
    expect(screen.queryByLabelText("From date")).toBeNull();

    const custom = { ...DEFAULT_FILTERS, date: "custom" as const };
    rerender(<OrderFilters filters={custom} onChange={onChange} accounts={[]} />);
    fireEvent.change(screen.getByLabelText("From date"), { target: { value: "2026-07-01" } });
    expect(onChange).toHaveBeenLastCalledWith({ ...custom, dateFrom: "2026-07-01" });
    fireEvent.change(screen.getByLabelText("To date"), { target: { value: "2026-07-05" } });
    expect(onChange).toHaveBeenLastCalledWith({ ...custom, dateTo: "2026-07-05" });
  });

  it("sets the refund filter, price bounds and flags", () => {
    const onChange = vi.fn();
    render(<OrderFilters filters={DEFAULT_FILTERS} onChange={onChange} accounts={[]} />);

    fireEvent.change(screen.getByLabelText("Refund"), { target: { value: "initiated" } });
    expect(onChange).toHaveBeenLastCalledWith({ ...DEFAULT_FILTERS, refund: "initiated" });

    fireEvent.change(screen.getByLabelText("Minimum price"), { target: { value: "500" } });
    expect(onChange).toHaveBeenLastCalledWith({ ...DEFAULT_FILTERS, priceMin: 500 });

    fireEvent.click(screen.getByRole("checkbox", { name: "Has OTP" }));
    expect(onChange).toHaveBeenLastCalledWith({ ...DEFAULT_FILTERS, flags: ["hasOtp"] });
  });

  it("clears a price bound when its input is emptied and resets everything with Clear", () => {
    const onChange = vi.fn();
    const set = { ...DEFAULT_FILTERS, priceMax: 900, flags: ["replacement" as const] };
    render(<OrderFilters filters={set} onChange={onChange} accounts={[]} />);

    fireEvent.change(screen.getByLabelText("Maximum price"), { target: { value: "" } });
    expect(onChange).toHaveBeenLastCalledWith({ ...set, priceMax: null });

    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(onChange).toHaveBeenLastCalledWith(DEFAULT_FILTERS);
  });
});
