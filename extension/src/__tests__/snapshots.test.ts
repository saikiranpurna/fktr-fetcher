import { describe, it, expect, beforeEach } from "vitest";
import {
  saveSnapshot,
  listSnapshots,
  removeSnapshot,
  mergedOrders,
} from "../storage/snapshots";
import type { Order } from "@core/types";

// Minimal in-memory chrome.storage.local double (node env has no `chrome`).
function installFakeChrome(): void {
  let data: Record<string, unknown> = {};
  const local = {
    get: async (key: string) => (key in data ? { [key]: data[key] } : {}),
    set: async (items: Record<string, unknown>) => {
      data = { ...data, ...items };
    },
  };
  Object.defineProperty(globalThis, "chrome", {
    value: { storage: { local } },
    configurable: true,
    writable: true,
  });
}

function order(orderId: string): Order {
  return {
    account: "",
    orderId,
    trackingId: "",
    customerName: "C",
    itemName: "I",
    deliveryAddress: "A",
    phone: "",
    otp: null,
    status: "DELIVERED",
    rawStatus: "",
    activityDateIso: "",
  };
}

describe("snapshots", () => {
  beforeEach(installFakeChrome);

  it("saves, lists newest-first, merges across accounts, and removes", async () => {
    await saveSnapshot({ label: "A", orders: [order("OD1")], fetchedAt: "2026-07-06T10:00:00.000Z" });
    await saveSnapshot({
      label: "B",
      orders: [order("OD2"), order("OD3")],
      fetchedAt: "2026-07-06T11:00:00.000Z",
    });
    expect((await listSnapshots()).map((s) => s.label)).toEqual(["B", "A"]);
    expect(await mergedOrders()).toHaveLength(3);

    await removeSnapshot("A");
    expect((await listSnapshots()).map((s) => s.label)).toEqual(["B"]);
    expect(await mergedOrders()).toHaveLength(2);
  });

  it("overwrites a snapshot that reuses a label", async () => {
    await saveSnapshot({ label: "A", orders: [order("OD1")], fetchedAt: "2026-07-06T10:00:00.000Z" });
    await saveSnapshot({ label: "A", orders: [order("OD9")], fetchedAt: "2026-07-06T12:00:00.000Z" });
    const snaps = await listSnapshots();
    expect(snaps).toHaveLength(1);
    expect(snaps[0].orders[0].orderId).toBe("OD9");
  });
});
