import { useState } from "react";
import type { Snapshot } from "@flk/storage/snapshots";

function ageLabel(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const mins = Math.round((Date.now() - then) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

export function AccountsPanel({
  snapshots,
  onFetch,
  onRemove,
  busy,
}: {
  snapshots: Snapshot[];
  onFetch: (label: string) => void;
  onRemove: (label: string) => void;
  busy: boolean;
}) {
  const [label, setLabel] = useState("");
  const trimmed = label.trim();

  function fetchCurrent() {
    const name = trimmed || "My account";
    onFetch(name);
  }

  return (
    <section className="rounded-xl border border-black/10 bg-white p-4 dark:border-white/15 dark:bg-neutral-900">
      <h2 className="text-sm font-semibold text-neutral-800 dark:text-neutral-100">Accounts</h2>
      <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
        Log into a Flipkart account in this browser, name it, and Fetch. To add another account, log
        out, log into the next one, and Fetch again — every fetched account stays listed below.
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <input
          type="text"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Account label (e.g. Seller North)"
          className="min-w-52 flex-1 rounded-lg border border-black/15 bg-neutral-50 px-2 py-1.5 text-sm dark:border-white/15 dark:bg-neutral-800"
        />
        <button
          type="button"
          onClick={fetchCurrent}
          disabled={busy}
          className="inline-flex min-h-10 items-center rounded-lg bg-blue-600 px-4 text-sm font-semibold text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {busy ? "Fetching…" : "Fetch this account"}
        </button>
      </div>

      {snapshots.length === 0 ? (
        <p className="mt-3 text-xs text-neutral-400">No accounts fetched yet.</p>
      ) : (
        <ul className="mt-3 flex flex-col gap-2">
          {snapshots.map((s) => (
            <li
              key={s.label}
              className="flex items-center justify-between gap-2 rounded-lg border border-black/10 px-3 py-2 dark:border-white/10"
            >
              <span className="flex min-w-0 flex-col">
                <span className="truncate text-sm font-medium text-neutral-800 dark:text-neutral-100">
                  {s.label}
                </span>
                <span className="text-[11px] text-neutral-500 dark:text-neutral-400">
                  {s.orders.length} order{s.orders.length === 1 ? "" : "s"} · {ageLabel(s.fetchedAt)}
                </span>
              </span>
              <span className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => onFetch(s.label)}
                  disabled={busy}
                  className="rounded-md border border-black/15 px-2 py-1 text-xs font-medium text-neutral-700 hover:bg-neutral-100 disabled:opacity-60 dark:border-white/15 dark:text-neutral-200 dark:hover:bg-neutral-800"
                >
                  Refetch
                </button>
                <button
                  type="button"
                  onClick={() => onRemove(s.label)}
                  disabled={busy}
                  className="rounded-md border border-red-300 px-2 py-1 text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-60 dark:border-red-500/40 dark:text-red-300 dark:hover:bg-red-950/40"
                >
                  Remove
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
