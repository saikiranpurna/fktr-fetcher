import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { config } from "@/lib/config";
import { DELETE, GET, POST } from "./route";

const ORIG = { ...config };
const STORE = join(tmpdir(), `fkrt-accts-route-${process.pid}-${Date.now()}.json`);

function post(body: unknown, token?: string) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers["x-admin-token"] = token;
  return new Request("http://x/api/accounts", { method: "POST", headers, body: JSON.stringify(body) });
}

afterEach(() => {
  if (existsSync(STORE)) rmSync(STORE);
  Object.assign(config, ORIG);
});

describe("/api/accounts", () => {
  it("adds, lists, and removes accounts", async () => {
    config.sessionStorePath = STORE;
    config.adminToken = "";

    let res = await POST(post({ label: "Seller North", cookie: "SN=north" }));
    expect(res.status).toBe(200);
    let body = await res.json();
    expect(body.accounts).toHaveLength(1);

    await POST(post({ label: "Seller South", cookie: "SN=south" }));
    res = await GET();
    body = await res.json();
    expect(body.accounts.map((a: { id: string }) => a.id).sort()).toEqual([
      "seller-north",
      "seller-south",
    ]);

    res = await DELETE(new Request("http://x/api/accounts?id=seller-north", { method: "DELETE" }));
    body = await res.json();
    expect(body.accounts.map((a: { id: string }) => a.id)).toEqual(["seller-south"]);
  });

  it("rejects an empty cookie with 400 CONFIG_ERROR", async () => {
    config.sessionStorePath = STORE;
    config.adminToken = "";
    const res = await POST(post({ label: "X", cookie: "" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("CONFIG_ERROR");
  });

  it("enforces the admin token when configured", async () => {
    config.sessionStorePath = STORE;
    config.adminToken = "secret";
    const denied = await POST(post({ label: "X", cookie: "SN=x" }));
    expect(denied.status).toBe(401);

    const allowed = await POST(post({ label: "X", cookie: "SN=x" }, "secret"));
    expect(allowed.status).toBe(200);
  });
});
