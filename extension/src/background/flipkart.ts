// Ported from backend/app/flipkart.py. Runs in the extension (service worker),
// so requests are first-party to flipkart.com: no curl_cffi/TLS impersonation and
// no manual cookies — Chrome attaches the signed-in session automatically with
// `credentials: "include"` + host_permissions. Only the custom FKUA header is set.
import { CONFIG } from "@flk/core/config";
import { authExpired, upstream } from "@flk/core/errors";
import { ensureOrdersShape, extractDetail, get } from "@flk/core/parser";

// Minimal shape we need from a fetch response — `fetch`'s Response satisfies it,
// and tests can inject a lightweight stub.
export interface FlkResponse {
  status: number;
  json(): Promise<unknown>;
}
export type FetchLike = (input: string, init?: RequestInit) => Promise<FlkResponse>;

const FKUA_OVERRIDE_KEY = "fkrt.fkua";

// Staleness guard: Flipkart occasionally bumps the FKUA version. An operator can set
// chrome.storage.local["fkrt.fkua"] to a fresh value without republishing; otherwise
// the built-in default (verified working) is used. Storage-less contexts (tests) fall
// straight through to the default.
async function resolveFkua(): Promise<string> {
  try {
    const got = await chrome.storage.local.get(FKUA_OVERRIDE_KEY);
    const override: unknown = got[FKUA_OVERRIDE_KEY];
    return typeof override === "string" && override.trim() ? override : CONFIG.fkua;
  } catch {
    return CONFIG.fkua;
  }
}

// Paginate My Orders (7/page) following `nextCallParams`, up to CONFIG.maxPages.
export async function fetchOrders(fetchFn: FetchLike = fetch): Promise<unknown[]> {
  const fkua = await resolveFkua();
  const headers: Record<string, string> = { "x-user-agent": fkua, accept: "application/json" };
  const base = CONFIG.ordersBase;
  const seen = new Set<string>();
  const all: unknown[] = [];
  let url = `${base}?${new URLSearchParams({ page: "1", filterType: CONFIG.filterType })}`;
  let page = 1;

  for (let i = 0; i < CONFIG.maxPages; i += 1) {
    const res = await fetchFn(url, {
      method: "GET",
      credentials: "include",
      headers,
      signal: AbortSignal.timeout(CONFIG.timeoutMs),
    });
    if (res.status === 401 || res.status === 403) throw authExpired();
    if (res.status !== 200) {
      if (i === 0) throw upstream(`Flipkart orders request failed (HTTP ${res.status}).`);
      break;
    }
    const body: unknown = await res.json();
    if (i === 0) ensureOrdersShape(body); // first page must look right, else PARSE_ERROR

    const view = get(body, "RESPONSE.multipleOrderDetailsView");
    const orders = get(view, "orders");
    if (Array.isArray(orders)) {
      const orderList: unknown[] = orders;
      for (const o of orderList) {
        const oid = get(o, "orderMetaData.orderId");
        if (typeof oid === "string" && oid && !seen.has(oid)) {
          seen.add(oid);
          all.push(o);
        }
      }
    }

    const ncp = get(view, "nextCallParams");
    if (!get(view, "moreOrder") || !Array.isArray(ncp)) break;
    const ncpItems: unknown[] = ncp;
    const params: Record<string, string> = {};
    for (const x of ncpItems) {
      if (x && typeof x === "object" && "key" in x) {
        const k = x.key; // unknown after `in` narrowing
        if (typeof k === "string") {
          const v = "value" in x ? x.value : "";
          params[k] = typeof v === "string" ? v : String(v ?? "");
        }
      }
    }
    if (!params.ot) break;
    page += 1;
    const query: Record<string, string> = {
      page: String(page),
      order_before_time_stamp: params.ot,
      filterType: CONFIG.filterType,
      ...params,
    };
    url = `${base}?${new URLSearchParams(query)}`;
  }

  return all;
}

// POST the per-order detail page and return {address, otp}; {} on any failure.
export async function fetchDetail(
  orderId: string,
  unitId: string,
  shareToken = "",
  fetchFn: FetchLike = fetch,
): Promise<{ address?: unknown; otp?: string | null }> {
  const fkua = await resolveFkua();
  const requestContext: Record<string, unknown> = {
    type: "CX_ORDER_DETAIL_PAGE",
    orderId,
    unitId,
    pageView: "",
    businessCategory: "",
  };
  if (shareToken) requestContext.shareToken = shareToken;
  const body = {
    requestContext,
    pageType: "CX_ORDER_DETAIL_PAGE",
    pageUri: "/cx/order_detail_desktop",
    locationContext: { pincode: "" },
    pageContext: {
      pageHashKey: null,
      slotContextMap: null,
      paginationContextMap: null,
      paginatedFetch: false,
      pageNumber: 1,
      fetchAllPages: false,
      networkSpeed: 0,
      trackingContext: null,
      fetchSeoData: false,
    },
  };
  try {
    const res = await fetchFn(CONFIG.detailUrl, {
      method: "POST",
      credentials: "include",
      headers: { "x-user-agent": fkua, accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(CONFIG.timeoutMs),
    });
    if (res.status !== 200) return {};
    const json: unknown = await res.json();
    const detail = extractDetail(json);
    // Only keep a result that carries something useful (mirrors flipkart.py).
    return detail.address || detail.otp ? { address: detail.address, otp: detail.otp } : {};
  } catch {
    // best-effort: a single detail failure just leaves that order without an address
    return {};
  }
}
