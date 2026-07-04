import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { config } from "@/lib/config";
import { addAccount } from "@/lib/session/store";
import { buildFlipkartPayload } from "@/lib/flipkart/__fixtures__/flipkart-orders";
import { GET } from "./route";

const ORIG = { ...config };
const STORE = join(tmpdir(), `fkrt-orders-route-${process.pid}-${Date.now()}.json`);
const MISSING = join(tmpdir(), `fkrt-orders-missing-${Date.now()}.json`);

function liveBase(storePath: string) {
  config.fetchMode = "http";
  config.ordersUrl = "https://flipkart.test/orders";
  config.sessionStorePath = storePath;
}

function orderPayload() {
  return buildFlipkartPayload([
    { orderId: "OD1", titles: ["Thing"], heading: "Delivered today", deliveredMs: Date.now() },
  ]);
}

function stubFetch(makeResponse: () => Response) {
  vi.stubGlobal("fetch", vi.fn(async () => makeResponse()));
}

afterEach(() => {
  if (existsSync(STORE)) rmSync(STORE);
  Object.assign(config, ORIG);
  vi.unstubAllGlobals();
});

describe("GET /api/orders", () => {
  it("returns 200 with orders aggregated across accounts", async () => {
    liveBase(STORE);
    addAccount("North", "SN=north");
    addAccount("South", "SN=south");
    stubFetch(
      () =>
        new Response(JSON.stringify(orderPayload()), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.accounts).toHaveLength(2);
    expect(body.orders).toHaveLength(2);
    expect(body.source).toBeUndefined();
  });

  it("returns 200 partial-success with a failed account marked AUTH_EXPIRED", async () => {
    liveBase(STORE);
    addAccount("Acct", "SN=x");
    stubFetch(() => new Response("unauthorized", { status: 401 }));

    const res = await GET();
    expect(res.status).toBe(200); // one account down != whole request failing
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.orders).toEqual([]);
    expect(body.accounts[0].ok).toBe(false);
    expect(body.accounts[0].error.code).toBe("AUTH_EXPIRED");
  });

  it("returns 200 with an empty array when an account has no orders (empty != error)", async () => {
    liveBase(STORE);
    addAccount("Acct", "SN=x");
    stubFetch(
      () =>
        new Response(JSON.stringify(buildFlipkartPayload([])), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.orders).toEqual([]);
    expect(body.accounts[0].ok).toBe(true);
    expect(body.accounts[0].count).toBe(0);
  });

  it("returns 400 CONFIG_ERROR when no accounts are configured", async () => {
    liveBase(MISSING);
    const res = await GET();
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("CONFIG_ERROR");
  });
});
