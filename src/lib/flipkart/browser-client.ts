import puppeteer from "puppeteer";
import type { Browser, BrowserContext, CookieData, HTTPResponse } from "puppeteer";
import { addExtra } from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { config } from "../config";
import { AppError, authExpired, upstream } from "../errors";
import { logger } from "../logger";
import type { FetchOptions, FlipkartClient, RawResult } from "./client";
import { detailRequestFor, hasOrdersArray, type DetailRequest } from "./parser";
import { resolveProxyUrl } from "./proxy";

const DEFAULT_ORDERS_PAGE = "https://www.flipkart.com/account/orders";
const LOGIN_RE = /\/(account\/)?login|signin|sign[- ]in|log in/i;

// Parse a "k=v; k2=v2" cookie header into puppeteer cookies scoped to the site's
// registrable domain (".flipkart.com") so they apply on www + subdomains.
export function cookiesForUrl(cookieHeader: string, url: string): CookieData[] {
  const host = new URL(url).hostname;
  const domain = host === "localhost" ? host : `.${host.replace(/^www\./, "")}`;
  return cookieHeader
    .split(/;\s*/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((pair) => {
      const eq = pair.indexOf("=");
      const name = (eq === -1 ? pair : pair.slice(0, eq)).trim();
      const value = eq === -1 ? "" : pair.slice(eq + 1);
      return { name, value, domain, path: "/" } satisfies CookieData;
    })
    .filter((c) => c.name);
}

export interface PuppeteerProxy {
  server: string;
  username?: string;
  password?: string;
}

// Split a proxy URL into the server (no creds) + optional credentials, since
// puppeteer takes the server at context creation and creds via page.authenticate.
export function parseProxyForPuppeteer(proxyUrl: string): PuppeteerProxy | null {
  if (!proxyUrl) return null;
  try {
    const u = new URL(proxyUrl);
    const proxy: PuppeteerProxy = { server: `${u.protocol}//${u.host}` };
    if (u.username) proxy.username = decodeURIComponent(u.username);
    if (u.password) proxy.password = decodeURIComponent(u.password);
    return proxy;
  } catch {
    return null;
  }
}

function delay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

// Stealth-patched puppeteer: flipkart.com serves a degraded (order-less) page to
// plain headless Chromium, so we mask the automation fingerprint.
const stealthPuppeteer = addExtra(puppeteer);
stealthPuppeteer.use(StealthPlugin());

let browserPromise: Promise<Browser> | null = null;
function launchBrowser(): Promise<Browser> {
  if (!browserPromise) {
    browserPromise = stealthPuppeteer
      .launch({ headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox"] })
      .then((browser) => {
        browser.on("disconnected", () => {
          browserPromise = null;
        });
        return browser;
      });
  }
  return browserPromise;
}

// Shut down the shared browser (used for graceful shutdown / test teardown).
export async function closeBrowser(): Promise<void> {
  if (!browserPromise) return;
  const browser = await browserPromise;
  browserPromise = null;
  await browser.close();
}

const DEFAULT_FKUA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36 FKUA/website/42/website/Desktop";

// Runs IN the page context (same session/cookies). Follows Flipkart's `nextCallParams`
// pagination (7 orders/page) using the SPA's own x-user-agent header, which the API requires.
async function paginateOrders(startUrl: string, xua: string, maxPages: number): Promise<unknown[]> {
  const u0 = new URL(startUrl);
  const apiBase = u0.origin + u0.pathname;
  const filterType = u0.searchParams.get("filterType") || "PREORDER_UNITS";
  const headers = { "x-user-agent": xua, "content-type": "application/json", accept: "application/json" };
  const seen = new Set<string>();
  const all: unknown[] = [];
  let url = startUrl;
  let page = Number(u0.searchParams.get("page") || "1");
  for (let i = 0; i < maxPages; i++) {
    const res = await fetch(url, { credentials: "include", headers });
    if (!res.ok) break;
    const body = await res.json();
    const view = body?.RESPONSE?.multipleOrderDetailsView || {};
    const orders = Array.isArray(view.orders) ? view.orders : [];
    for (const o of orders) {
      const id = o?.orderMetaData?.orderId;
      if (id && !seen.has(id)) {
        seen.add(id);
        all.push(o);
      }
    }
    const ncp = view.nextCallParams;
    if (!view.moreOrder || !Array.isArray(ncp)) break;
    const p: Record<string, string> = {};
    for (const x of ncp) if (x && typeof x.key === "string") p[x.key] = String(x.value);
    if (!p.ot) break;
    page += 1;
    const q = new URLSearchParams({ page: String(page), order_before_time_stamp: p.ot, filterType });
    for (const k of Object.keys(p)) q.set(k, p[k]);
    url = `${apiBase}?${q.toString()}`;
  }
  return all;
}

// Runs IN the page context. Replays the SPA's per-order detail call (POST /api/4/page/fetch)
// for each target and extracts the delivery address (+ live OTP) from the page-model response.
async function fetchDetails(
  targets: DetailRequest[],
  xua: string,
): Promise<Record<string, { address: unknown; otpCallout: unknown }>> {
  const headers = { "content-type": "application/json", "x-user-agent": xua };
  const out: Record<string, { address: unknown; otpCallout: unknown }> = {};
  const findBy = (root: unknown, hit: (n: Record<string, unknown>) => unknown): unknown => {
    const stack: unknown[] = [root];
    while (stack.length) {
      const n = stack.pop();
      if (n && typeof n === "object") {
        const found = hit(n as Record<string, unknown>);
        if (found != null) return found;
        for (const k of Object.keys(n)) stack.push((n as Record<string, unknown>)[k]);
      }
    }
    return null;
  };
  const one = async (t: DetailRequest): Promise<void> => {
    try {
      const body = {
        requestContext: { type: "CX_ORDER_DETAIL_PAGE", orderId: t.orderId, unitId: t.unitId, shareToken: t.shareToken, pageView: "", businessCategory: "" },
        pageType: "CX_ORDER_DETAIL_PAGE",
        pageUri: "/cx/order_detail_desktop",
        locationContext: { pincode: "" },
        pageContext: { pageHashKey: null, slotContextMap: null, paginationContextMap: null, paginatedFetch: false, pageNumber: 1, fetchAllPages: false, networkSpeed: 0, trackingContext: null, fetchSeoData: false },
      };
      const res = await fetch("/api/4/page/fetch?", { method: "POST", credentials: "include", headers, body: JSON.stringify(body) });
      if (!res.ok) return;
      const j = await res.json();
      const address = findBy(j, (n) => {
        const a = n.address as Record<string, unknown> | undefined;
        return a && typeof a === "object" && (a.addressLine1 || a.pinCode) ? a : null;
      });
      const otpCallout = findBy(j, (n) => n.otpCallout ?? null);
      out[t.orderId] = { address, otpCallout };
    } catch {
      // best-effort: a single detail failure just leaves that order without an address
    }
  };
  const CONCURRENCY = 6;
  for (let i = 0; i < targets.length; i += CONCURRENCY) {
    await Promise.all(targets.slice(i, i + CONCURRENCY).map(one));
  }
  return out;
}

export class BrowserFlipkartClient implements FlipkartClient {
  async fetchRawOrders(cookie: string, opts?: FetchOptions): Promise<RawResult> {
    const pageUrl = config.ordersUrl || DEFAULT_ORDERS_PAGE;
    const proxy = parseProxyForPuppeteer(resolveProxyUrl(config.proxyUrl, opts?.sessionKey ?? "default"));
    const browser = await launchBrowser();
    const context: BrowserContext = await browser.createBrowserContext(
      proxy ? { proxyServer: proxy.server } : undefined,
    );
    try {
      const cookies = cookiesForUrl(cookie, pageUrl);
      if (cookies.length) await context.setCookie(...cookies);

      const page = await context.newPage();
      if (proxy?.username) {
        await page.authenticate({ username: proxy.username, password: proxy.password ?? "" });
      }

      // Grab the SPA's own orders request: its x-user-agent (FKUA) header unblocks the API,
      // and its URL is the page-1 starting point. Keep the first response as a fallback.
      let fkua = "";
      let firstOrdersUrl = "";
      const firstPages: unknown[] = [];
      page.on("request", (req) => {
        if (req.url().includes("/self-serve/orders") && !firstOrdersUrl) {
          firstOrdersUrl = req.url();
          fkua = req.headers()["x-user-agent"] || "";
        }
      });
      page.on("response", (res: HTTPResponse) => {
        if (!res.url().includes("/self-serve/orders")) return;
        if (!(res.headers()["content-type"] || "").includes("json")) return;
        res
          .json()
          .then((json) => {
            if (hasOrdersArray(json)) firstPages.push(json);
          })
          .catch(() => {});
      });

      await page.goto(pageUrl, { waitUntil: "networkidle2", timeout: config.requestTimeoutMs });
      if (LOGIN_RE.test(page.url())) throw authExpired();
      await delay(1500);

      // Only paginate if the page actually made its orders request (gives us the real URL +
      // FKUA header). No guessing a URL — keeps the DOM fallback and offline behavior clean.
      const orders = firstOrdersUrl
        ? ((await page
            .evaluate(paginateOrders, firstOrdersUrl, fkua || DEFAULT_FKUA, config.maxOrderPages)
            .catch(() => [] as unknown[])) as unknown[])
        : [];

      // Enrich the most-recent orders with their delivery address (+ live OTP) from the detail
      // endpoint, replayed in the page context. Best-effort: failures leave the placeholder.
      if (config.maxDetails > 0 && orders.length > 0) {
        const enrichable = orders
          .slice(0, config.maxDetails)
          .map((o) => ({ o, req: detailRequestFor(o) }))
          .filter((x): x is { o: unknown; req: DetailRequest } => x.req !== null);
        if (enrichable.length > 0) {
          const details = (await page
            .evaluate(
              fetchDetails,
              enrichable.map((e) => e.req),
              fkua || DEFAULT_FKUA,
            )
            .catch(() => ({}))) as Record<string, { address: unknown; otpCallout: unknown }>;
          let enriched = 0;
          for (const { o, req } of enrichable) {
            const d = details[req.orderId];
            if (d && (d.address || d.otpCallout)) {
              (o as Record<string, unknown>).__detail = d;
              enriched++;
            }
          }
          logger.info("flipkart.browser.detail", { targets: enrichable.length, enriched });
        }
      }

      if (Array.isArray(orders) && orders.length > 0) {
        logger.info("flipkart.browser.paginated", { maxPages: config.maxOrderPages, orders: orders.length });
        return { contentType: "json", json: { RESPONSE: { multipleOrderDetailsView: { orders } } } };
      }
      // Fallback: the auto-captured first page.
      if (firstPages.length > 0) return { contentType: "json", json: firstPages[firstPages.length - 1] };

      const html = await page.content();
      if (LOGIN_RE.test(html) && !html.includes("data-order")) throw authExpired();
      logger.warn("flipkart.browser.no_orders_json", { pageUrl });
      return { contentType: "html", text: html };
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw upstream("Headless browser fetch failed", err);
    } finally {
      await context.close();
    }
  }
}
