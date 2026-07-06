import { describe, it, expect, afterEach } from "vitest";
import { fetchOrders, fetchDetail, type FetchLike } from "../background/flipkart";
import page1 from "../__fixtures__/orders-page1.json";
import detailOfd from "../__fixtures__/detail-ofd.json";

function stub(body: unknown, status = 200): FetchLike {
  return async () => ({ status, json: async () => body });
}

function setStoredFkua(value: string | null): void {
  const data: Record<string, unknown> = value === null ? {} : { "fkrt.fkua": value };
  const local = {
    get: async (key: string) => (key in data ? { [key]: data[key] } : {}),
    set: async () => {},
  };
  Object.defineProperty(globalThis, "chrome", {
    value: { storage: { local } },
    configurable: true,
    writable: true,
  });
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, "chrome");
});

describe("fetchOrders", () => {
  it("returns the deduped orders array from a single page", async () => {
    const orders = await fetchOrders(stub(page1));
    expect(Array.isArray(orders)).toBe(true);
    expect(orders).toHaveLength(3);
  });

  it("throws AUTH_EXPIRED on 401", async () => {
    await expect(fetchOrders(stub({}, 401))).rejects.toMatchObject({ code: "AUTH_EXPIRED" });
  });

  it("throws PARSE_ERROR when the first page shape is unexpected", async () => {
    await expect(fetchOrders(stub({}, 200))).rejects.toMatchObject({ code: "PARSE_ERROR" });
  });
});

describe("fetchDetail", () => {
  it("extracts address and OTP on 200", async () => {
    const d = await fetchDetail("OD1", "U1", "", stub(detailOfd));
    expect(d.address).toBeTruthy();
    expect(d.otp).toBe("4321");
  });

  it("returns {} on a non-200 response", async () => {
    const d = await fetchDetail("OD1", "U1", "", stub(detailOfd, 500));
    expect(d).toEqual({});
  });
});

describe("FKUA staleness guard", () => {
  it("uses a stored FKUA override when present", async () => {
    setStoredFkua("CUSTOM/9.9");
    let seen = "";
    const capture: FetchLike = async (_url, init) => {
      seen = new Headers(init?.headers).get("x-user-agent") ?? "";
      return { status: 200, json: async () => page1 };
    };
    await fetchOrders(capture);
    expect(seen).toBe("CUSTOM/9.9");
  });

  it("falls back to the built-in FKUA when no override is stored", async () => {
    setStoredFkua(null);
    let seen = "";
    const capture: FetchLike = async (_url, init) => {
      seen = new Headers(init?.headers).get("x-user-agent") ?? "";
      return { status: 200, json: async () => page1 };
    };
    await fetchOrders(capture);
    expect(seen).toContain("FKUA/website");
  });
});
