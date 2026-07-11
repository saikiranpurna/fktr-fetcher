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

  const visible = useMemo(
    () => applyOrderFilters(orders, filters, new Date(), timezone),
    [orders, filters, timezone],
  );
  const accountLabels = useMemo(() => accountStatuses.map((a) => a.label), [accountStatuses]);

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

      <AccountsPanel accounts={accountMetas} statuses={accountStatuses} onChanged={onChanged} />

      {error && <ErrorNotice code={error.code} message={error.message} />}

      {failedAccounts.length > 0 && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-500/40 dark:bg-amber-950/40 dark:text-amber-200">
          <span className="font-medium tabular-nums">{failedAccounts.length}</span> account
          {failedAccounts.length === 1 ? "" : "s"} need attention:{" "}
          {failedAccounts
            .slice(0, 5)
            .map((a) => `${a.label} (${ERROR_TEXT[a.error?.code ?? "UNKNOWN"]})`)
            .join(", ")}
          {failedAccounts.length > 5 ? `, +${failedAccounts.length - 5} more` : ""}. See the Accounts
          panel above.
        </div>
      )}

      {orders.length > 0 && (
        <OrderFilters filters={filters} onChange={setFilters} accounts={accountLabels} />
      )}

      <OrderList
        orders={visible}
        hasFilters={!isDefaultFilters}
        onClearFilters={() => setFilters(DEFAULT_FILTERS)}
      />
    </div>
  );
}
