"use client";

import { useState } from "react";
import type { Order } from "@/lib/types";
import { OrderCard } from "./OrderCard";

const PAGE = 60; // cap DOM nodes; large accounts can produce tens of thousands of orders

export function OrderList({
  orders,
  hasFilters = true,
  onClearFilters,
}: {
  orders: Order[];
  hasFilters?: boolean;
  onClearFilters?: () => void;
}) {
  const [limit, setLimit] = useState(PAGE);
  // Reset the window only when the CONTENT changes (filters applied / genuinely new data), not on
  // every 60s poll that returns an identical list — otherwise "Show more" snaps back each minute.
  const signature =
    orders.length === 0
      ? "empty"
      : `${orders.length}|${orders[0].account}:${orders[0].orderId}:${orders[0].trackingId}` +
        `|${orders[orders.length - 1].account}:${orders[orders.length - 1].orderId}:${orders[orders.length - 1].trackingId}`;
  const [prevSig, setPrevSig] = useState(signature);
  if (prevSig !== signature) {
    setPrevSig(signature);
    setLimit(PAGE);
  }

  if (orders.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-black/15 p-10 text-center text-neutral-500 dark:border-white/15 dark:text-neutral-400">
        {hasFilters ? (
          <div className="flex flex-col items-center gap-2">
            <p>No orders match the current filters.</p>
            {onClearFilters && (
              <button
                type="button"
                onClick={onClearFilters}
                className="rounded-lg border border-black/15 px-3 py-1.5 text-sm font-medium text-neutral-700 hover:bg-neutral-100 dark:border-white/15 dark:text-neutral-200 dark:hover:bg-neutral-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
              >
                Clear filters
              </button>
            )}
          </div>
        ) : (
          <p>No out-for-delivery or delivered orders right now.</p>
        )}
      </div>
    );
  }

  const shown = orders.slice(0, limit);

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {shown.map((order, i) => (
          <OrderCard key={`${order.account}:${order.orderId}:${order.trackingId}:${i}`} order={order} />
        ))}
      </div>
      {orders.length > shown.length && (
        <button
          type="button"
          onClick={() => setLimit((l) => l + PAGE)}
          className="mx-auto min-h-11 rounded-lg border border-black/15 px-5 text-sm font-semibold text-neutral-700 transition-colors hover:bg-neutral-100 dark:border-white/15 dark:text-neutral-200 dark:hover:bg-neutral-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
        >
          Show more · <span className="tabular-nums">{shown.length} of {orders.length}</span> shown
        </button>
      )}
    </div>
  );
}
