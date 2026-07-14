"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ordersToCsv } from "@/lib/orders/csv";
import { API_BASE } from "@/lib/api";
import {
  applyOrderFilters,
  DEFAULT_FILTERS,
  type OrderFilters as OrderFilterState,
} from "@/lib/orders/filters";
import type {
  AccountMeta,
  AccountResult,
  AccountsResponse,
  Coverage,
  ErrorCode,
  ErrorResponse,
  Order,
  OrderStatus,
  OrdersResponse,
} from "@/lib/types";
import { AccountsPanel } from "./AccountsPanel";
import { ErrorNotice } from "./ErrorNotice";
import { OrderFilters } from "./OrderFilters";
import { OrderList } from "./OrderList";
import { RefreshBar } from "./RefreshBar";

const POLL_MS = 60_000;
const DEFAULT_TZ = "Asia/Kolkata";

// Operator-facing text for internal error codes (no raw enums in the UI).
const ERROR_TEXT: Record<ErrorCode, string> = {
  AUTH_EXPIRED: "session expired",
  UPSTREAM_ERROR: "couldn't reach Flipkart",
  PARSE_ERROR: "unexpected response",
  CONFIG_ERROR: "not configured",
  UNKNOWN: "unknown error",
};

export function Dashboard() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<{ code: ErrorCode; message: string } | null>(null);
  const [lastFetchedAt, setLastFetchedAt] = useState<string | null>(null);
  const [timezone, setTimezone] = useState(DEFAULT_TZ);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [accountMetas, setAccountMetas] = useState<AccountMeta[]>([]);
  const [accountStatuses, setAccountStatuses] = useState<AccountResult[]>([]);
  const [coverage, setCoverage] = useState<Coverage | null>(null);
  const [filters, setFilters] = useState<OrderFilterState>(DEFAULT_FILTERS);
  const [tab, setTab] = useState<"orders" | "accounts">("orders");

  const visible = useMemo(
    () => applyOrderFilters(orders, filters, new Date(), timezone),
    [orders, filters, timezone],
  );
  const accountLabels = useMemo(() => accountStatuses.map((a) => a.label), [accountStatuses]);
  // Total count per status across all fetched orders (unaffected by the active filters),
  // so the chips answer "how many are cancelled / delivered / …" at a glance.
  const statusCounts = useMemo(() => {
    const counts: Partial<Record<OrderStatus, number>> = {};
    for (const o of orders) counts[o.status] = (counts[o.status] ?? 0) + 1;
    return counts;
  }, [orders]);

  const loadAccounts = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/accounts`);
      if (res.ok) setAccountMetas(((await res.json()) as AccountsResponse).accounts);
    } catch {
      // account metadata is non-critical; ignore
    }
  }, []);

  const fetchOrders = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/orders`, { cache: "no-store" });
      const body = (await res.json()) as OrdersResponse | ErrorResponse;
      if (body.ok) {
        setOrders(body.orders);
        setAccountStatuses(body.accounts);
        setCoverage(body.coverage);
        setTimezone(body.timezone || DEFAULT_TZ);
        setLastFetchedAt(body.fetchedAt);
        setError(null);
      } else {
        setError(body.error);
      }
    } catch (err) {
      setError({ code: "UNKNOWN", message: (err as Error).message || "Network error." });
    } finally {
      setLoading(false);
    }
  }, []);

  // Export exactly what the filters currently show (same applyOrderFilters as the list).
  const downloadCsv = useCallback(() => {
    setDownloading(true);
    try {
      const csv = ordersToCsv(applyOrderFilters(orders, filters, new Date(), timezone));
      const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `flipkart-orders-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } finally {
      setDownloading(false);
    }
  }, [orders, filters, timezone]);

  // Initial load: fetch orders + accounts once on mount. The loading flag set inside fetchOrders
  // is the intended one-time render; this rule targets sync state sync, not mount data-fetching.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- canonical fetch-on-mount
    void fetchOrders();
    void loadAccounts();
  }, [fetchOrders, loadAccounts]);

  useEffect(() => {
    if (!autoRefresh) return;
    const id = setInterval(() => void fetchOrders(), POLL_MS);
    return () => clearInterval(id);
  }, [autoRefresh, fetchOrders]);

  const onChanged = useCallback(() => {
    void loadAccounts();
    void fetchOrders();
  }, [loadAccounts, fetchOrders]);

  // Pending accounts (not yet fetched by the poller) are not failures — exclude them.
  const failedAccounts = accountStatuses.filter((a) => !a.ok && !a.pending);
  const isDefaultFilters =
    filters.statuses.length === 0 &&
    filters.date === "all" &&
    filters.accounts.length === 0 &&
    filters.search === "";

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-4 p-4 sm:p-6">
      <header className="sticky top-0 z-10 -mx-4 flex items-center justify-between gap-2 border-b border-black/10 bg-background/90 px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6 dark:border-white/15">
        <h1 className="text-lg font-bold text-neutral-900 sm:text-xl dark:text-neutral-100">
          Flipkart Delivery Tracker
        </h1>
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-neutral-500 dark:text-neutral-400">
          <span
            aria-hidden
            className={`h-2 w-2 rounded-full ${lastFetchedAt ? "bg-green-500" : "bg-neutral-300 dark:bg-neutral-600"}`}
          />
          {lastFetchedAt ? "Live" : "Connecting…"}
        </span>
      </header>

      <div
        role="tablist"
        aria-label="Dashboard sections"
        onKeyDown={(e) => {
          let next: "orders" | "accounts" | null = null;
          if (e.key === "ArrowRight" || e.key === "ArrowLeft") next = tab === "orders" ? "accounts" : "orders";
          else if (e.key === "Home") next = "orders";
          else if (e.key === "End") next = "accounts";
          if (!next) return;
          e.preventDefault();
          setTab(next);
          const id = `tab-${next}`;
          requestAnimationFrame(() => document.getElementById(id)?.focus());
        }}
        className="flex gap-1 border-b border-black/10 dark:border-white/15"
      >
        <button
          type="button"
          role="tab"
          id="tab-orders"
          aria-selected={tab === "orders"}
          aria-controls="panel-orders"
          tabIndex={tab === "orders" ? 0 : -1}
          onClick={() => setTab("orders")}
          className={`-mb-px inline-flex items-center gap-2 rounded-t px-3 py-2 text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${
            tab === "orders"
              ? "border-b-2 border-blue-600 text-blue-700 dark:text-blue-300"
              : "border-b-2 border-transparent text-neutral-500 hover:text-neutral-800 dark:text-neutral-400 dark:hover:text-neutral-100"
          }`}
        >
          Orders
          <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-xs font-medium tabular-nums text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">
            {orders.length}
          </span>
        </button>
        <button
          type="button"
          role="tab"
          id="tab-accounts"
          aria-selected={tab === "accounts"}
          aria-controls="panel-accounts"
          tabIndex={tab === "accounts" ? 0 : -1}
          onClick={() => setTab("accounts")}
          className={`-mb-px inline-flex items-center gap-2 rounded-t px-3 py-2 text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${
            tab === "accounts"
              ? "border-b-2 border-blue-600 text-blue-700 dark:text-blue-300"
              : "border-b-2 border-transparent text-neutral-500 hover:text-neutral-800 dark:text-neutral-400 dark:hover:text-neutral-100"
          }`}
        >
          Accounts
          <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-xs font-medium tabular-nums text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">
            {accountMetas.length}
          </span>
          {failedAccounts.length > 0 && (
            <span
              title={`${failedAccounts.length} need attention`}
              className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold tabular-nums text-amber-800 dark:bg-amber-950/60 dark:text-amber-300"
            >
              {failedAccounts.length}
            </span>
          )}
        </button>
      </div>

      <div
        id="panel-orders"
        role="tabpanel"
        aria-labelledby="tab-orders"
        className={`flex-col gap-4 ${tab === "orders" ? "flex" : "hidden"}`}
      >
          <RefreshBar
            loading={loading}
            lastFetchedAt={lastFetchedAt}
            autoRefresh={autoRefresh}
            onRefresh={() => void fetchOrders()}
            onToggleAuto={setAutoRefresh}
            count={visible.length}
            total={orders.length}
            onDownload={downloadCsv}
            downloading={downloading}
            coverage={coverage}
          />

          {error && <ErrorNotice code={error.code} message={error.message} />}

          {orders.length > 0 && (
            <OrderFilters filters={filters} onChange={setFilters} accounts={accountLabels} statusCounts={statusCounts} />
          )}

          <OrderList
            orders={visible}
            hasFilters={!isDefaultFilters}
            onClearFilters={() => setFilters(DEFAULT_FILTERS)}
          />
      </div>

      <div
        id="panel-accounts"
        role="tabpanel"
        aria-labelledby="tab-accounts"
        className={`flex-col gap-4 ${tab === "accounts" ? "flex" : "hidden"}`}
      >
          {failedAccounts.length > 0 && (
            <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-500/40 dark:bg-amber-950/40 dark:text-amber-200">
              <span className="font-medium tabular-nums">{failedAccounts.length}</span> account
              {failedAccounts.length === 1 ? "" : "s"} need attention:{" "}
              {failedAccounts
                .slice(0, 5)
                .map((a) => `${a.label} (${ERROR_TEXT[a.error?.code ?? "UNKNOWN"]})`)
                .join(", ")}
              {failedAccounts.length > 5 ? `, +${failedAccounts.length - 5} more` : ""}.
            </div>
          )}

          <AccountsPanel accounts={accountMetas} statuses={accountStatuses} onChanged={onChanged} />
      </div>
    </div>
  );
}
