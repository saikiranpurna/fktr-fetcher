import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Order } from "@/lib/types";

vi.mock("@/lib/download", () => ({ saveBlob: vi.fn() }));

import { saveBlob } from "@/lib/download";
import { InvoiceButton } from "./InvoiceButton";

const ORDER: Order = {
  account: "Home",
  accountId: "home",
  unitId: "U1",
  fsn: "SPKA",
  orderId: "OD100",
  trackingId: "FMPP1000000001",
  customerName: "Cust",
  itemName: "Thing",
  deliveryAddress: "Addr",
  phone: "",
  otp: null,
  status: "DELIVERED",
  rawStatus: "Delivered on Oct 02",
  activityDateIso: "2026-10-02T10:00:00+05:30",
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.mocked(saveBlob).mockClear();
});

describe("InvoiceButton", () => {
  it("names the order, downloads once while busy, and saves the file", async () => {
    let finish: (v: unknown) => void = () => {};
    const fetchMock = vi.fn(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<InvoiceButton order={ORDER} />);

    const button = screen.getByRole("button", { name: "Download invoice for order OD100" });
    fireEvent.click(button);
    expect(await screen.findByText("Downloading…")).toBeTruthy();
    fireEvent.click(button); // ignored while the first download runs
    expect(fetchMock).toHaveBeenCalledTimes(1);

    finish({ ok: true, status: 200, headers: new Headers({ "content-type": "application/pdf" }), blob: async () => new Blob(["%PDF"]) });
    await waitFor(() => expect(saveBlob).toHaveBeenCalledTimes(1));
    // Only this card's tax invoice: one PDF named after its shipment.
    expect(vi.mocked(saveBlob).mock.calls[0][1]).toBe("invoice-OD100-FMPP1000000001.pdf");
    expect(screen.getByText("Download invoice")).toBeTruthy();
  });

  it("explains a failure on the card itself", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 404,
        headers: new Headers(),
        json: async () => ({ ok: false, error: { code: "INVOICE_UNAVAILABLE", message: "Try again later." } }),
      })),
    );
    render(<InvoiceButton order={ORDER} />);
    fireEvent.click(screen.getByRole("button"));
    expect((await screen.findByRole("alert")).textContent).toBe("Invoice not available yet. Try again later.");
    expect(saveBlob).not.toHaveBeenCalled();
  });
});
