import { afterEach, describe, expect, it, vi } from "vitest";
import type { Order } from "./types";

vi.mock("./download", () => ({ saveBlob: vi.fn() }));

import { saveBlob } from "./download";
import { canDownloadInvoice, downloadInvoice, downloadInvoicesZip, InvoiceError, invoiceOrders } from "./invoice";

function order(overrides: Partial<Order> = {}): Order {
  return {
    account: "Home",
    accountId: "home",
    orderId: "OD100",
    unitId: "U1",
    fsn: "SPKA",
    trackingId: "FMPP1000000001",
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

function response(status: number, body: unknown, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    blob: async () => new Blob(["%PDF-1.4"]),
    json: async () => {
      if (typeof body === "string") throw new SyntaxError("not json");
      return body;
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(saveBlob).mockClear();
});

describe("invoice eligibility", () => {
  it("offers invoices on delivered cards that know their account and unit", () => {
    expect(canDownloadInvoice(order())).toBe(true);
    expect(canDownloadInvoice(order({ status: "ARRIVING" }))).toBe(false);
    expect(canDownloadInvoice(order({ accountId: undefined }))).toBe(false); // an older backend
    expect(canDownloadInvoice(order({ unitId: undefined }))).toBe(false);
  });

  it("groups the cards by order, with every account and unit they show up under", () => {
    const groups = invoiceOrders([
      order({ orderId: "OD1", unitId: "U1", trackingId: "T1" }),
      order({ orderId: "OD1", unitId: "U2", trackingId: "T2" }),
      order({ orderId: "OD1", unitId: "U1", accountId: "shop", account: "Shop" }), // shared order
      order({ orderId: "OD2", unitId: "U7", accountId: "shop", account: "Shop" }),
      order({ orderId: "OD3", unitId: "U9", status: "CANCELLED" }),
    ]);
    expect(groups).toEqual([
      { orderId: "OD1", accountIds: ["home", "shop"], unitIds: ["U1", "U2"] },
      { orderId: "OD2", accountIds: ["shop"], unitIds: ["U7"] },
    ]);
  });
});

describe("downloads", () => {
  it("fetches only this card's invoice, uncached, as a PDF named after its shipment", async () => {
    const fetchMock = vi.fn(async () => response(200, null, { "content-type": "application/pdf" }));
    vi.stubGlobal("fetch", fetchMock);
    await downloadInvoice(order());
    expect(fetchMock).toHaveBeenCalledWith("/api/invoice?accountId=home&orderId=OD100&unitId=U1", {
      cache: "no-store",
      headers: { "X-Requested-With": "fktr" }, // forces a preflight: only the UI origin may trigger it
    });
    expect(vi.mocked(saveBlob).mock.calls[0][1]).toBe("invoice-OD100-FMPP1000000001.pdf");
  });

  it("keeps the backend's error code and message, and survives non-JSON or network failures", async () => {
    const unavailable = { ok: false, error: { code: "INVOICE_UNAVAILABLE", message: "Not shipped yet." } };
    vi.stubGlobal("fetch", vi.fn(async () => response(404, unavailable)));
    await expect(downloadInvoice(order())).rejects.toMatchObject({ code: "INVOICE_UNAVAILABLE", message: "Not shipped yet." });

    vi.stubGlobal("fetch", vi.fn(async () => response(502, "<html>")));
    await expect(downloadInvoice(order())).rejects.toMatchObject({ code: "UNKNOWN", message: "HTTP 502" });

    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))));
    const err = await downloadInvoice(order()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvoiceError);
    expect(saveBlob).not.toHaveBeenCalled();
  });

  it("posts the filtered cards grouped by order for the ZIP and reports the counts", async () => {
    const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<ReturnType<typeof response>>>(async () =>
      response(200, null, { "content-type": "application/zip", "x-invoice-files": "2", "x-invoice-missing": "1" }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const batch = [
      { orderId: "OD1", accountIds: ["home", "shop"], unitIds: ["U1", "U2"] },
      { orderId: "OD2", accountIds: ["shop"], unitIds: ["U7"] },
    ];
    expect(await downloadInvoicesZip(batch)).toEqual({ files: 2, missing: 1 });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/invoices/zip");
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect(JSON.parse(init?.body as string)).toEqual({ orders: batch });
    expect(vi.mocked(saveBlob).mock.calls[0][1]).toMatch(/^flipkart-invoices-\d{4}-\d{2}-\d{2}\.zip$/);
  });
});
