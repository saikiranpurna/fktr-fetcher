"use client";

import { useMemo, useState } from "react";
import { downloadInvoicesZip, INVOICE_ZIP_MAX, InvoiceError, invoiceOrders, toInvoiceError } from "@/lib/invoice";
import type { Order } from "@/lib/types";
import { errorHeading } from "@/lib/ui";

type Outcome = { from: number; to: number; result?: { files: number; missing: number }; error?: InvoiceError };
type Progress = { selection: string; start: number; outcome: Outcome | null };

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

// The tax invoices of exactly the cards the list shows (the same filtered rows as the list and the
// CSV): one ZIP with a folder per order and a PDF per shipment. Flipkart serves invoices per order,
// so a ZIP takes the cards of at most `max` orders; with more, each click saves the next batch.
// Progress and the last outcome belong to the exact selection they were made for, so changing the
// filters (or new deliveries arriving) starts over instead of describing a different set of cards.
export function InvoiceZipButton({ orders, max = INVOICE_ZIP_MAX }: { orders: Order[]; max?: number }) {
  const groups = useMemo(() => invoiceOrders(orders), [orders]);
  const selection = useMemo(
    () => groups.map((g) => `${g.orderId}:${g.accountIds.join("+")}:${g.unitIds.join("+")}`).join(","),
    [groups],
  );
  const [progress, setProgress] = useState<Progress | null>(null);
  const [busy, setBusy] = useState(false);

  const mine = progress?.selection === selection ? progress : null;
  const total = groups.length;
  const start = mine && mine.start < total ? mine.start : 0;
  const batch = groups.slice(start, start + max);
  const end = start + batch.length;
  const batched = total > max;
  const cards = batch.reduce((n, g) => n + g.unitIds.length, 0);
  const disabled = busy || cards === 0;
  const outcome = mine?.outcome ?? null;

  async function onClick() {
    if (disabled) return;
    setBusy(true);
    setProgress({ selection, start, outcome: null });
    try {
      const result = await downloadInvoicesZip(batch);
      // The next click takes the next batch; after the last one it starts over.
      setProgress({ selection, start: end < total ? end : 0, outcome: { from: start + 1, to: end, result } });
    } catch (err) {
      setProgress({ selection, start, outcome: { from: start + 1, to: end, error: toInvoiceError(err) } });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={() => void onClick()}
        aria-disabled={disabled}
        aria-label={
          busy
            ? "Preparing invoices ZIP"
            : `Invoices (ZIP), ${plural(cards, "invoice")}${batched ? ` from orders ${start + 1} to ${end} of ${total}` : ""}`
        }
        title={cards === 0 ? "No delivered shipments in the current view" : undefined}
        className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-black/15 px-4 text-sm font-semibold text-neutral-800 transition-colors hover:bg-neutral-100 active:bg-neutral-200 aria-disabled:cursor-not-allowed aria-disabled:opacity-60 dark:border-white/15 dark:text-neutral-100 dark:hover:bg-neutral-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-neutral-950"
      >
        {busy ? (
          "Preparing ZIP…"
        ) : (
          <>
            Invoices (ZIP){" "}
            <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-xs font-medium tabular-nums text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">
              {cards}
            </span>
          </>
        )}
      </button>
      {batched && !outcome && (
        <span className="text-xs text-neutral-500 dark:text-neutral-400">
          Orders {start + 1}–{end} of {total} (up to {plural(max, "order")} per ZIP); each click saves the next batch.
        </span>
      )}
      {outcome?.result && (
        <span role="status" className="text-xs text-neutral-600 dark:text-neutral-300">
          Saved {plural(outcome.result.files, "invoice")}
          {batched && ` (orders ${outcome.from}–${outcome.to} of ${total})`}
          {outcome.result.missing > 0 && `; ${outcome.result.missing} without one (listed in missing.txt)`}.
        </span>
      )}
      {outcome?.error && (
        <span role="alert" className="text-xs text-red-600 dark:text-red-400">
          <span className="font-semibold">{errorHeading(outcome.error.code)}.</span> {outcome.error.message}
        </span>
      )}
    </div>
  );
}
