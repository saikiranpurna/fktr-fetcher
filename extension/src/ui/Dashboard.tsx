import { useCallback, useEffect, useMemo, useState } from "react";
import type { ErrorCode, Order, OrderStatus } from "@core/types";
import { ordersToCsv } from "@core/orders/csv";
import {
  applyOrderFilters,
  DEFAULT_FILTERS,
  type OrderFilters as OrderFilterState,
} from "@core/orders/filters";
import { CONFIG } from "@flk/core/config";
import type { FromWorker, Progress, ToWorker } from "@flk/messaging/protocol";
import {
  listSnapshots,
  mergedOrders,
  removeSnapshot,
  saveSnapshot,
  type Snapshot,
} from "@flk/storage/snapshots";
import { AccountsPanel } from "./AccountsPanel";
import { ErrorNotice } from "./ErrorNotice";
import { OrderFilters } from "./OrderFilters";
import { OrderList } from "./OrderList";
import { RefreshBar } from "./RefreshBar";

const POLL_MS = 60_000;

export function Dashboard() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [loading, setLoading] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<{ code: ErrorCode; message: string } | null>(null);
  const [lastFetchedAt, setLastFetchedAt] = useState<string | null>(null);
  const [lastLabel, setLastLabel] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [filters, setFilters] = useState<OrderFilterState>(DEFAULT_FILTERS);

  const timezone = CONFIG.timezone;
  const visible = useMemo(
    () => applyOrderFilters(orders, filters, new Date(), timezone),
    [orders, filters, timezone],
  );
  const accountLabels = useMemo(() => snapshots.map((s) => s.label), [snapshots]);
  const statusCounts = useMemo(() => {
    const counts: Partial<Record<OrderStatus, number>> = {};
    for (const o of orders) counts[o.status] = (counts[o.status] ?? 0) + 1;
    return counts;
  }, [orders]);

  const reload = useCallback(async () => {
    try {
      setOrders(await mergedOrders());
      setSnapshots(await listSnapshots());
    } catch {
      // chrome.storage unavailable (e.g. a plain dev preview) — ignore.
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const fetchAccount = useCallback(
    (label: string) => {
      const name = label.trim();
      if (!name) return;
      setLoading(true);
      setError(null);
      setProgress(null);
      setLastLabel(name);
      const port = chrome.runtime.connect();
      port.onMessage.addListener((message: FromWorker) => {
        if (message.type === "PROGRESS") {
          setProgress(message);
          return;
        }
        if (message.type === "RESULT") {
          const { orders: fetched, fetchedAt } = message;
          void saveSnapshot({ label: name, orders: fetched, fetchedAt }).then(async () => {
            await reload();
            setLastFetchedAt(fetchedAt);
            setLoading(false);
            setProgress(null);
            port.disconnect();
          });
          return;
        }
        setError(message.error);
        setLoading(false);
        setProgress(null);
        port.disconnect();
      });
      port.postMessage({ type: "RUN_FETCH", accountLabel: name } satisfies ToWorker);
    },
    [reload],
  );

  const removeAccount = useCallback(
    (label: string) => {
      void removeSnapshot(label).then(reload);
    },
    [reload],
  );

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

  useEffect(() => {
    if (!autoRefresh || !lastLabel) return;
    const id = setInterval(() => fetchAccount(lastLabel), POLL_MS);
    return () => clearInterval(id);
  }, [autoRefresh, lastLabel, fetchAccount]);

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-4 p-4 sm:p-6">
      <header className="sticky top-0 z-10 -mx-4 flex items-center justify-between gap-2 border-b border-black/10 bg-white/90 px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6 dark:border-white/15 dark:bg-neutral-950/90">
        <h1 className="text-lg font-bold text-neutral-900 sm:text-xl dark:text-neutral-100">
          Flipkart Delivery Tracker
        </h1>
        <span className="text-xs font-medium text-neutral-400 dark:text-neutral-500">
          {lastFetchedAt ? "Live" : ""}
        </span>
      </header>

      <RefreshBar
        loading={loading}
        lastFetchedAt={lastFetchedAt}
        autoRefresh={autoRefresh}
        onRefresh={() => {
          if (lastLabel) fetchAccount(lastLabel);
        }}
        onToggleAuto={setAutoRefresh}
        count={visible.length}
        total={orders.length}
        onDownload={downloadCsv}
        downloading={downloading}
      />

      {progress && (
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          {progress.phase === "orders"
            ? `Loaded ${progress.done} orders…`
            : `Fetching shipment details ${progress.done}/${progress.total}…`}
        </p>
      )}

      <AccountsPanel
        snapshots={snapshots}
        onFetch={fetchAccount}
        onRemove={removeAccount}
        busy={loading}
      />

      {error && (
        <div className="flex flex-col gap-2">
          <ErrorNotice code={error.code} message={error.message} />
          {error.code === "AUTH_EXPIRED" && (
            <button
              type="button"
              onClick={() =>
                void chrome.tabs.create({ url: "https://www.flipkart.com/account/orders" })
              }
              className="w-fit rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700"
            >
              Open Flipkart login
            </button>
          )}
        </div>
      )}

      {orders.length > 0 && (
        <OrderFilters filters={filters} onChange={setFilters} accounts={accountLabels} statusCounts={statusCounts} />
      )}

      {snapshots.length === 0 && !loading ? (
        <div className="rounded-xl border border-dashed border-black/15 p-10 text-center text-sm text-neutral-500 dark:border-white/15 dark:text-neutral-400">
          No accounts yet. Make sure you&apos;re logged into Flipkart in this browser, then use{" "}
          <span className="font-medium">Fetch this account</span> above.
        </div>
      ) : (
        <OrderList orders={visible} />
      )}
    </div>
  );
}
