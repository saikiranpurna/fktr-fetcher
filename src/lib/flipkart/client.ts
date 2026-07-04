import type { Dispatcher } from "undici";
import { config } from "../config";
import { authExpired, describeUpstreamError, upstream } from "../errors";
import { logger } from "../logger";
import { getProxyDispatcher } from "./proxy";

export interface RawResult {
  contentType: "json" | "html" | "other";
  json?: unknown;
  text?: string;
}

export interface FetchOptions {
  // Stable key used for proxy sticky-session routing (typically the account id).
  sessionKey?: string;
}

export interface FlipkartClient {
  fetchRawOrders(cookie: string, opts?: FetchOptions): Promise<RawResult>;
}

// Heuristics below (redirect:"manual" + 401/403 + login sniff) are
// unverified - confirm against live traffic via `npm run diag`.
const LOGIN_URL_MARKERS = ["login", "signin", "sign-in", "account/login"];
const LOGIN_BODY_MARKERS = ['name="login"', 'id="login"', "login-form", "signin-form", "please log in"];

function looksLikeLoginRedirect(location: string | null): boolean {
  if (!location) return false;
  const l = location.toLowerCase();
  return LOGIN_URL_MARKERS.some((m) => l.includes(m));
}

function looksLikeLoginBody(body: string): boolean {
  const l = body.toLowerCase();
  return LOGIN_BODY_MARKERS.some((m) => l.includes(m));
}

export class HttpFlipkartClient implements FlipkartClient {
  async fetchRawOrders(cookie: string, opts?: FetchOptions): Promise<RawResult> {
    const sessionKey = opts?.sessionKey ?? "default";
    const dispatcher = getProxyDispatcher(sessionKey);
    if (dispatcher) logger.debug("flipkart.proxy.enabled", { sessionKey });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.requestTimeoutMs);
    const init: RequestInit & { dispatcher?: Dispatcher } = {
      headers: {
        Cookie: cookie,
        Accept: "application/json, text/html",
        ...config.baseHeaders,
      },
      redirect: "manual",
      signal: controller.signal,
    };
    if (dispatcher) init.dispatcher = dispatcher;

    let res: Response;
    try {
      res = await fetch(config.ordersUrl, init);
    } catch (err) {
      if ((err as Error)?.name === "AbortError") {
        throw upstream(`Flipkart request timed out after ${config.requestTimeoutMs}ms`, err);
      }
      throw upstream("Network error reaching Flipkart", err);
    } finally {
      clearTimeout(timer);
    }

    // Redirect to a login page => session gone.
    if (res.status >= 300 && res.status < 400 && looksLikeLoginRedirect(res.headers.get("location"))) {
      throw authExpired();
    }
    if (res.status === 401 || res.status === 403) {
      throw authExpired();
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const detail = describeUpstreamError(res.status, body);
      logger.error("flipkart.upstream.fail", { detail });
      throw upstream(`Flipkart request failed (${detail})`);
    }

    const contentType = (res.headers.get("content-type") || "").toLowerCase();

    if (contentType.includes("application/json") || contentType.includes("text/json")) {
      const json = await res.json().catch(() => {
        throw upstream("Flipkart returned invalid JSON");
      });
      return { contentType: "json", json };
    }

    if (contentType.includes("text/html")) {
      const text = await res.text();
      if (looksLikeLoginBody(text)) throw authExpired();
      return { contentType: "html", text };
    }

    // Unknown content-type: return text so the caller/diag can inspect it.
    const text = await res.text().catch(() => "");
    return { contentType: "other", text };
  }
}
