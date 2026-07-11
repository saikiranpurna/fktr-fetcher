"use client";

import type { Coverage } from "@/lib/types";

function formatTime(iso: string | null): string {
  if (!iso) return "never";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "never";
  // Minute precision: the value only changes on fetch, so seconds would be false precision.
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function RefreshBar({
  loading,
  lastFetchedAt,
  autoRefresh,
  onRefresh,
  onToggleAuto,
  count,
  total,
  onDownload,
  downloading,
  coverage,
}: {
  loading: boolean;
  lastFetchedAt: string | null;
  autoRefresh: boolean;
  onRefresh: () => void;
  onToggleAuto: (next: boolean) => void;
  count: number;
  total: number;
  onDownload: () => void;
  downloading: boolean;
  coverage: Coverage | null;
}) {
  const downloadDisabled = downloading || count === 0;
  const coverageDot =
    coverage && coverage.pending > 0 ? "bg-amber-500" : coverage && coverage.failed > 0 ? "bg-red-500" : "bg-green-500";

  return (
    <div className="flex flex-wrap items-center gap-3">
      <button
        type="button"
        onClick={() => {
          if (!loading) onRefresh();
        }}
        aria-disabled={loading}
        className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-blue-600 px-5 text-base font-semibold text-white shadow-sm transition-colors hover:bg-blue-700 active:bg-blue-800 aria-disabled:cursor-not-allowed aria-disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-neutral-950"
      >
        {loading && (
          <span aria-hidden className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />
        )}
        {loading ? "Refreshing…" : "Refresh"}
      </button>

      <button
        type="button"
        onClick={() => {
          if (!downloadDisabled) onDownload();
        }}
        aria-disabled={downloadDisabled}
        className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-black/15 px-4 text-sm font-semibold text-neutral-800 transition-colors hover:bg-neutral-100 active:bg-neutral-200 aria-disabled:cursor-not-allowed aria-disabled:opacity-60 dark:border-white/15 dark:text-neutral-100 dark:hover:bg-neutral-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-neutral-950"
      >
        {downloading ? "Preparing…" : "Download CSV"}
      </button>

      <label className="inline-flex min-h-11 cursor-pointer select-none items-center gap-2 text-sm text-neutral-700 dark:text-neutral-300">
        <input
          type="checkbox"
          checked={autoRefresh}
          onChange={(e) => onToggleAuto(e.target.checked)}
          className="h-4 w-4 accent-blue-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-neutral-950"
        />
        Auto-refresh (60s)
      </label>

      <span className="text-sm tabular-nums text-neutral-500 dark:text-neutral-400">
        Updated {formatTime(lastFetchedAt)}
      </span>

      {coverage && coverage.total > 0 && (
        <span
          role="status"
          className="inline-flex items-center gap-1.5 rounded-full bg-neutral-100 px-2.5 py-0.5 text-xs font-medium text-neutral-700 dark:bg-neutral-800 dark:text-neutral-200"
        >
          <span aria-hidden className={`h-2 w-2 rounded-full ${coverageDot}`} />
          {coverage.pending > 0 ? (
            <>
              Refreshing <span className="tabular-nums">{coverage.fetched}/{coverage.total}</span> accounts
            </>
          ) : (
            <>
              <span className="tabular-nums">{coverage.total}</span> account{coverage.total === 1 ? "" : "s"} up to date
            </>
          )}
          {coverage.failed > 0 && (
            <span className="text-red-600 dark:text-red-400">
              {" · "}
              <span className="tabular-nums">{coverage.failed}</span> failing
            </span>
          )}
        </span>
      )}

      <span className="ml-auto text-sm font-medium tabular-nums text-neutral-700 dark:text-neutral-300">
        {count === total ? `${count}` : `${count} of ${total}`} order{total === 1 ? "" : "s"}
      </span>
    </div>
  );
}
