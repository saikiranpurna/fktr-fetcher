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
});
