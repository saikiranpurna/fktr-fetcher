import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Order } from "@/lib/types";

vi.mock("@/lib/download", () => ({ saveBlob: vi.fn() }));

import { saveBlob } from "@/lib/download";
import { InvoiceZipButton } from "./InvoiceZipButton";

function card(orderId: string, unitId: string, overrides: Partial<Order> = {}): Order {
  return {
    account: "Home",
    accountId: "home",
    orderId,
    unitId,
    fsn: "SPKA",
    trackingId: `FMPP-${unitId}`,
    customerName: "Cust",
    itemName: "Thing",
    deliveryAddress: "Addr",
    phone: "",
    otp: null,
    status: "DELIVERED",
    rawStatus: "Delivered on Oct 02",
    activityDateIso: "2026-10-02T10:00:00+05:30",
    ...overrides,
  };
}

const zipResponse = (files: number, missing: number) => ({
  ok: true,
  status: 200,
  headers: new Headers({ "x-invoice-files": String(files), "x-invoice-missing": String(missing) }),
  blob: async () => new Blob(["PK"]),
});

type Sent = { orderId: string; accountIds: string[]; unitIds: string[] };

function stubZip(...answers: ReturnType<typeof zipResponse>[]) {
  const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<ReturnType<typeof zipResponse>>>();
  for (const a of answers) fetchMock.mockResolvedValueOnce(a);
  vi.stubGlobal("fetch", fetchMock);
  const sent = (call: number) => JSON.parse(fetchMock.mock.calls[call][1]?.body as string).orders as Sent[];
  return { sent };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.mocked(saveBlob).mockClear();
});

describe("InvoiceZipButton", () => {
  it("counts the delivered cards shown and is unavailable when there are none", () => {
    const { rerender } = render(
      <InvoiceZipButton orders={[card("OD1", "U1"), card("OD1", "U2"), card("OD2", "U3", { status: "ARRIVING" })]} />,
    );
    expect(screen.getByRole("button", { name: "Invoices (ZIP), 2 invoices" })).toBeTruthy();
    rerender(<InvoiceZipButton orders={[card("OD2", "U3", { status: "ARRIVING" })]} />);
    expect(screen.getByRole("button").getAttribute("aria-disabled")).toBe("true");
  });

  it("sends exactly the filtered cards, grouped by order with every account they show up under", async () => {
    const { sent } = stubZip(zipResponse(2, 1));
    // OD1's U9 isn't in the filtered rows, so it isn't asked for; U1 also shows under a 2nd account.
    render(<InvoiceZipButton orders={[card("OD1", "U1"), card("OD1", "U2"), card("OD1", "U1", { accountId: "shop" }), card("OD2", "U7")]} />);
    fireEvent.click(screen.getByRole("button", { name: "Invoices (ZIP), 3 invoices" }));
    expect((await screen.findByRole("status")).textContent).toBe(
      "Saved 2 invoices; 1 without one (listed in missing.txt).",
    );
    expect(sent(0)).toEqual([
      { orderId: "OD1", accountIds: ["home", "shop"], unitIds: ["U1", "U2"] },
      { orderId: "OD2", accountIds: ["home"], unitIds: ["U7"] },
    ]);
    expect(saveBlob).toHaveBeenCalledTimes(1);
  });

  it("takes the cards of at most `max` orders per ZIP, one batch per click, then starts over", async () => {
    const { sent } = stubZip(zipResponse(3, 0), zipResponse(1, 0));
    render(<InvoiceZipButton orders={[card("OD1", "U1"), card("OD1", "U2"), card("OD2", "U3"), card("OD3", "U4")]} max={2} />);
    expect(screen.getByText("Orders 1–2 of 3 (up to 2 orders per ZIP); each click saves the next batch.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Invoices (ZIP), 3 invoices from orders 1 to 2 of 3" }));
    expect((await screen.findByRole("status")).textContent).toBe("Saved 3 invoices (orders 1–2 of 3).");
    expect(sent(0).map((o) => o.orderId)).toEqual(["OD1", "OD2"]);

    fireEvent.click(screen.getByRole("button", { name: "Invoices (ZIP), 1 invoice from orders 3 to 3 of 3" }));
    expect((await screen.findByText("Saved 1 invoice (orders 3–3 of 3).")).getAttribute("role")).toBe("status");
    expect(sent(1).map((o) => o.orderId)).toEqual(["OD3"]);
    expect(screen.getByRole("button", { name: "Invoices (ZIP), 3 invoices from orders 1 to 2 of 3" })).toBeTruthy();
  });

  it("keeps its result across a refresh of the same rows, but drops it when the selection changes", async () => {
    stubZip(zipResponse(1, 0));
    const { rerender } = render(<InvoiceZipButton orders={[card("OD1", "U1")]} />);
    fireEvent.click(screen.getByRole("button"));
    expect((await screen.findByRole("status")).textContent).toBe("Saved 1 invoice.");

    rerender(<InvoiceZipButton orders={[card("OD1", "U1")]} />); // auto-refresh: new array, same cards
    expect(screen.getByRole("status")).toBeTruthy();
    rerender(<InvoiceZipButton orders={[card("OD1", "U1"), card("OD1", "U2")]} />); // the filters changed
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("shows a total failure as an alert", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 401,
        headers: new Headers(),
        json: async () => ({ ok: false, error: { code: "AUTH_EXPIRED", message: "Update the cookie." } }),
      })),
    );
    render(<InvoiceZipButton orders={[card("OD1", "U1")]} />);
    fireEvent.click(screen.getByRole("button"));
    expect((await screen.findByRole("alert")).textContent).toBe("Session expired. Update the cookie.");
  });
});
