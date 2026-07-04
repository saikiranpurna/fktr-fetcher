// @vitest-environment node
import { type Server, createServer } from "node:http";
import { type AddressInfo } from "node:net";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { config } from "../config";
import { hasOrdersArray, parseOrders, parseOrdersFromHtml } from "./parser";
import { buildFlipkartPayload } from "./__fixtures__/flipkart-orders";
import { BrowserFlipkartClient, closeBrowser, cookiesForUrl, parseProxyForPuppeteer } from "./browser-client";

const ORIG = { ...config };
afterEach(() => Object.assign(config, ORIG));
afterAll(async () => {
  await closeBrowser();
});

describe("cookiesForUrl", () => {
  it("scopes cookies to the registrable domain", () => {
    expect(cookiesForUrl("SN=abc; T=1", "https://www.flipkart.com/account/orders")).toEqual([
      { name: "SN", value: "abc", domain: ".flipkart.com", path: "/" },
      { name: "T", value: "1", domain: ".flipkart.com", path: "/" },
    ]);
  });

  it("keeps localhost as-is and skips empty names", () => {
    expect(cookiesForUrl("A=1; =skip", "http://localhost:5000/x")).toEqual([
      { name: "A", value: "1", domain: "localhost", path: "/" },
    ]);
  });
});

describe("parseProxyForPuppeteer", () => {
  it("splits server from credentials", () => {
    expect(parseProxyForPuppeteer("http://user-session-x:pass@gate.decodo.com:7000")).toEqual({
      server: "http://gate.decodo.com:7000",
      username: "user-session-x",
      password: "pass",
    });
  });

  it("returns null for empty input", () => {
    expect(parseProxyForPuppeteer("")).toBeNull();
  });
});

// Real headless-Chromium round-trips against a tiny local server standing in for
// flipkart.com's My Orders page — proves the capture machinery, not the live selectors.
describe("BrowserFlipkartClient (headless Chromium)", () => {
  let server: Server;
  let base: string;

  function start(handler: (path: string) => { type: string; body: string } | null): Promise<void> {
    server = createServer((req, res) => {
      const out = handler(req.url ?? "/");
      if (!out) {
        res.writeHead(404);
        res.end("nope");
        return;
      }
      res.writeHead(200, { "content-type": out.type });
      res.end(out.body);
    });
    const { promise, resolve } = Promise.withResolvers<void>();
    server.listen(0, "127.0.0.1", () => {
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      resolve();
    });
    return promise;
  }

  afterEach(() => {
    server?.close();
  });

  it("captures orders and enriches them with the detail-endpoint address", async () => {
    const data = buildFlipkartPayload([
      { orderId: "OD1", titles: ["Airdopes"], heading: "Out for delivery", promisedMs: Date.now(), otp: "8842", shareToken: "SH1" },
    ]);
    // Per-order detail page-model: address lives under widget.data.actionDataReq.address.
    const detail = {
      RESPONSE: {
        slots: [
          {
            widget: {
              data: {
                actionDataReq: {
                  name: "deliveryAddress",
                  address: { addressLine1: "12 MG Road, Bengaluru", city: "Bengaluru", state: "Karnataka", pinCode: "560001", name: "Asha" },
                },
              },
            },
          },
        ],
      },
    };
    await start((path) => {
      if (path.startsWith("/orders"))
        return {
          type: "text/html",
          body: `<!doctype html><html><body><script>fetch('/api/5/self-serve/orders/?page=1&filterType=PREORDER_UNITS').then(r=>r.json())</script></body></html>`,
        };
      if (path.includes("/self-serve/orders")) return { type: "application/json", body: JSON.stringify(data) };
      if (path.includes("/api/4/page/fetch")) return { type: "application/json", body: JSON.stringify(detail) };
      return null;
    });
    config.proxyUrl = "";
    config.ordersUrl = `${base}/orders`;
    config.maxDetails = 5;

    const raw = await new BrowserFlipkartClient().fetchRawOrders("", { sessionKey: "t" });
    expect(raw.contentType).toBe("json");
    expect(hasOrdersArray(raw.json)).toBe(true);
    const order = parseOrders(raw.json)[0];
    expect(order.orderId).toBe("OD1");
    expect(order.deliveryAddress).toContain("12 MG Road");
    expect(order.deliveryAddress).toContain("560001");
  }, 45000);

  it("falls back to the rendered DOM when there is no orders JSON", async () => {
    await start((path) => {
      if (path.startsWith("/orders"))
        return {
          type: "text/html",
          body: `<!doctype html><html><body><div data-order-row data-order-id="OD9" data-status="DELIVERED" data-activity="2026-07-01T09:00:00+05:30"><span data-customer>Z</span><span data-item>Y</span><span data-address>Addr</span><span data-otp>9</span></div></body></html>`,
        };
      return null;
    });
    config.proxyUrl = "";
    config.ordersUrl = `${base}/orders`;

    const raw = await new BrowserFlipkartClient().fetchRawOrders("", { sessionKey: "t" });
    expect(raw.contentType).toBe("html");
    const orders = parseOrdersFromHtml(raw.text ?? "");
    expect(orders).toHaveLength(1);
    expect(orders[0].orderId).toBe("OD9");
  }, 45000);
});
