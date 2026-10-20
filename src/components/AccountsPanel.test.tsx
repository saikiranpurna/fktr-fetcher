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

function manyAccounts(n: number): AccountMeta[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `acct-${i}`,
    label: `Account ${i}`,
    updatedAt: null,
    count: 1,
    active: true,
  }));
}

// The repeated ?id= values of a DELETE request URL.
function idsOf(url: string): string[] {
  return new URL(url, "http://localhost").searchParams.getAll("id");
}

function confirmBulkRemove(count: number) {
  fireEvent.click(screen.getByRole("checkbox", { name: "Select all accounts" }));
  fireEvent.click(screen.getByRole("button", { name: "Remove" }));
  fireEvent.click(screen.getByRole("button", { name: `Confirm remove ${count}` }));
}

afterEach(cleanup);
beforeEach(() => {
  vi.restoreAllMocks();
});

// getByRole walks the panel's whole accessible tree (hundreds of rows/controls in the bulk tests),
// which in jsdom takes several seconds per query on a loaded machine. Give this suite headroom
// instead of flaking at Vitest's 5s default; the assertions are unchanged.
describe("AccountsPanel bulk actions", { timeout: 30_000 }, () => {
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
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1)); // one DELETE for the whole selection
    const [url, init] = fetchMock.mock.calls[0];
    expect(init.method).toBe("DELETE");
    expect(idsOf(url).sort()).toEqual(["dad", "mom"]);
  });

  it("bulk Remove sends one DELETE per chunk of 100 ids, as repeated id params", async () => {
    const many = manyAccounts(250);
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);
    const onChanged = vi.fn();

    render(<AccountsPanel accounts={many} statuses={statuses} onChanged={onChanged} />);
    confirmBulkRemove(250);

    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const sent = fetchMock.mock.calls.map(([url, init]) => {
      expect(init.method).toBe("DELETE");
      return idsOf(url);
    });
    expect(sent.map((ids) => ids.length)).toEqual([100, 100, 50]);
    // Every selected id is sent exactly once; no request ever goes out without ids.
    expect(sent.flat().sort()).toEqual(many.map((a) => a.id).sort());
    expect(screen.getAllByText("Removed 250 accounts.").length).toBeGreaterThan(0);
  });

  it("counts every id of a failed chunk as not removed and shows the backend's message", async () => {
    let calls = 0;
    const fetchMock: Mock = vi.fn(async () => {
      calls += 1;
      return calls === 2
        ? {
            ok: false,
            status: 401,
            json: async () => ({ ok: false, error: { code: "UNAUTHORIZED", message: "Admin token required." } }),
          }
        : { ok: true, json: async () => ({ accounts: [] }) };
    });
    vi.stubGlobal("fetch", fetchMock);
    const onChanged = vi.fn();

    render(<AccountsPanel accounts={manyAccounts(150)} statuses={statuses} onChanged={onChanged} />);
    confirmBulkRemove(150);

    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.getAllByText("Removed 100 accounts.").length).toBeGreaterThan(0);
    expect(screen.getByRole("alert").textContent).toContain("Admin token required. (50 accounts not removed)");
  });
});

describe("AccountsPanel data-quality hints", () => {
  it("flags partial history and failed detail lookups from the last fetch", () => {
    const withHints: AccountResult[] = [
      { id: "mom", label: "Mom", ok: true, count: 12, partial: true, detailFailed: 3 },
      { id: "dad", label: "Dad", ok: true, count: 4, partial: false, detailFailed: 0 },
    ];
    render(<AccountsPanel accounts={accounts} statuses={withHints} onChanged={() => {}} />);
    expect(screen.getByText("partial history")).toBeTruthy();
    expect(screen.getByText("3 details failed")).toBeTruthy();
    // Nothing for the account whose last fetch was complete.
    expect(screen.getAllByText(/partial history|details? failed/)).toHaveLength(2);
  });

  it("shows no hints when the backend doesn't report them", () => {
    render(
      <AccountsPanel
        accounts={accounts}
        statuses={[{ id: "mom", label: "Mom", ok: true, count: 12 }]}
        onChanged={() => {}}
      />,
    );
    expect(screen.queryByText(/partial history|details? failed/)).toBeNull();
  });
});
