"use client";

import { useState } from "react";
import { downloadInvoice, InvoiceError, toInvoiceError } from "@/lib/invoice";
import type { Order } from "@/lib/types";
import { errorHeading } from "@/lib/ui";

// A card's own tax invoice (one PDF), picked by the backend out of the order's invoice bundle.
// Busy / error state is the card's own: the Dashboard's error slot is cleared by each auto-refresh,
// which would wipe a failed download's explanation.
export function InvoiceButton({ order }: { order: Order }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<InvoiceError | null>(null);

  async function onClick() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await downloadInvoice(order);
    } catch (err) {
      setError(toInvoiceError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        onClick={() => void onClick()}
        aria-disabled={busy}
        aria-label={`${busy ? "Downloading invoice" : "Download invoice"} for order ${order.orderId}`}
        className="inline-flex min-h-8 w-fit items-center gap-1.5 rounded-md border border-black/15 px-2.5 text-xs font-medium text-neutral-700 transition-colors hover:bg-neutral-100 aria-disabled:cursor-not-allowed aria-disabled:opacity-60 dark:border-white/15 dark:text-neutral-200 dark:hover:bg-neutral-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
      >
        {busy && (
          <span
            aria-hidden
            className="h-3 w-3 animate-spin rounded-full border-2 border-neutral-400/40 border-t-neutral-600 dark:border-t-neutral-200"
          />
        )}
        {busy ? "Downloading…" : "Download invoice"}
      </button>
      {error && (
        <p role="alert" className="text-[11px] text-red-600 dark:text-red-400">
          <span className="font-semibold">{errorHeading(error.code)}.</span> {error.message}
        </p>
      )}
    </div>
  );
}
