import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import type { AccountMeta, AccountResult } from "@/lib/types";
import { AccountsPanel } from "./AccountsPanel";

const accounts: AccountMeta[] = [
  { id: "mom", label: "Mom", updatedAt: null, count: 1, active: true },
  { id: "dad", label: "Dad", updatedAt: null, count: 1, active: false },
];
const statuses: AccountResult[] = [];

function okFetch(): Mock {
  return vi.fn(async () => ({ ok: true, json: async () => ({ accounts }) }));
}

afterEach(cleanup);
beforeEach(() => {
  vi.restoreAllMocks();
});

describe("AccountsPanel bulk actions", () => {
  it("shows a Paused badge for an inactive account", () => {
    render(<AccountsPanel accounts={accounts} statuses={statuses} onChanged={() => {}} />);
    expect(screen.getAllByText("Paused").length).toBeGreaterThan(0);
  });

  it("selecting all reveals the bulk toolbar and Make inactive PATCHes the selected ids", async () => {
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);
    const onChanged = vi.fn();

    render(<AccountsPanel accounts={accounts} statuses={statuses} onChanged={onChanged} />);

    fireEvent.click(screen.getByRole("checkbox", { name: "Select all accounts" }));
    expect(screen.getByText("2 selected")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Make inactive" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/api/accounts");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body)).toEqual({ ids: ["mom", "dad"], active: false });
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it("bulk Remove requires a confirm step before deleting", async () => {
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);

    render(<AccountsPanel accounts={accounts} statuses={statuses} onChanged={() => {}} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Select all accounts" }));

    // First click only arms the confirmation — no request yet.
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /Confirm remove/ }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2)); // one DELETE per selected id
    for (const call of fetchMock.mock.calls) {
      expect(call[1].method).toBe("DELETE");
    }
  });
});
