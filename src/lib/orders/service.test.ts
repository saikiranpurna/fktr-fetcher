import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "../config";
import { addAccount } from "../session/store";
import { getDeliveryOrders } from "./service";
import { buildFlipkartPayload } from "../flipkart/__fixtures__/flipkart-orders";

const ORIG = { ...config };
const STORE = join(tmpdir(), `fkrt-svc-${process.pid}-${Date.now()}.json`);
const MISSING = join(tmpdir(), `fkrt-missing-${Date.now()}.json`);

beforeEach(() => {
  config.fetchMode = "http";
});

function orderPayload(orderId: string) {
  // A delivered-today order so it passes the "today" filter.
  return buildFlipkartPayload([
    { orderId, titles: ["Thing"], heading: "Delivered today", deliveredMs: Date.now() },
  ]);
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  if (existsSync(STORE)) rmSync(STORE);
  Object.assign(config, ORIG);
  vi.unstubAllGlobals();
});

describe("getDeliveryOrders (all orders, unfiltered)", () => {
  it("aggregates today's orders across multiple accounts, tagging each", async () => {
    config.ordersUrl = "https://flipkart.test/orders";
    config.sessionStorePath = STORE;
    addAccount("North", "SN=north");
    addAccount("South", "SN=south");

    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        const cookie = String((init.headers as Record<string, string>).Cookie);
        return jsonResponse(orderPayload(cookie.includes("north") ? "N1" : "S1"));
      }),
    );

    const { orders, accounts } = await getDeliveryOrders();
    expect(accounts.map((a) => a.label).sort()).toEqual(["North", "South"]);
    expect(accounts.every((a) => a.ok && a.count === 1)).toBe(true);
    expect(orders).toHaveLength(2);
    expect(orders.find((o) => o.orderId === "N1")?.account).toBe("North");
    expect(orders.find((o) => o.orderId === "S1")?.account).toBe("South");
  });

  it("returns partial results when one account's cookie is expired (401)", async () => {
    config.ordersUrl = "https://flipkart.test/orders";
    config.sessionStorePath = STORE;
    addAccount("Good", "SN=good");
    addAccount("Bad", "SN=bad");

    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        const cookie = String((init.headers as Record<string, string>).Cookie);
        if (cookie.includes("good")) return jsonResponse(orderPayload("GOOD1"));
        return new Response("no", { status: 401 });
      }),
    );

    const { orders, accounts } = await getDeliveryOrders();
    expect(orders.map((o) => o.orderId)).toEqual(["GOOD1"]);
    expect(orders[0].account).toBe("Good");

    const good = accounts.find((a) => a.label === "Good");
    const bad = accounts.find((a) => a.label === "Bad");
    expect(good?.ok).toBe(true);
    expect(good?.count).toBe(1);
    expect(bad?.ok).toBe(false);
    expect(bad?.error?.code).toBe("AUTH_EXPIRED");
  });

  it("throws CONFIG_ERROR when there is no endpoint URL", async () => {
    config.ordersUrl = "";
    config.sessionStorePath = MISSING;
    await expect(getDeliveryOrders()).rejects.toMatchObject({ code: "CONFIG_ERROR" });
  });

  it("throws CONFIG_ERROR when there are no accounts", async () => {
    config.ordersUrl = "https://flipkart.test/orders";
    config.sessionStorePath = MISSING;
    await expect(getDeliveryOrders()).rejects.toMatchObject({ code: "CONFIG_ERROR" });
  });
});
