function formatTime(iso: string | null): string {
  if (!iso) return "never";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "never";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
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
}) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <button
        type="button"
        onClick={onRefresh}
        disabled={loading}
        className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-blue-600 px-5 text-base font-semibold text-white shadow-sm transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {loading && (
          <span
            aria-hidden
            className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white"
          />
        )}
        {loading ? "Refreshing…" : "Refresh"}
      </button>

      <button
        type="button"
        onClick={onDownload}
        disabled={downloading || count === 0}
        className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-black/15 px-4 text-sm font-semibold text-neutral-800 transition hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-60 dark:border-white/15 dark:text-neutral-100 dark:hover:bg-neutral-800"
      >
        {downloading ? "Preparing…" : "Download CSV"}
      </button>

      <label className="inline-flex cursor-pointer select-none items-center gap-2 text-sm text-neutral-700 dark:text-neutral-300">
        <input
          type="checkbox"
          checked={autoRefresh}
          onChange={(e) => onToggleAuto(e.target.checked)}
          className="h-4 w-4"
        />
        Auto-refresh (60s)
      </label>

      <span className="text-sm text-neutral-500 dark:text-neutral-400">
        Updated {formatTime(lastFetchedAt)}
      </span>
      <span className="ml-auto text-sm font-medium text-neutral-700 dark:text-neutral-300">
        {count === total ? `${count}` : `${count} of ${total}`} order{total === 1 ? "" : "s"}
      </span>
    </div>
  );
}
