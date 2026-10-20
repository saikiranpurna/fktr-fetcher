"use client";

import type { DateScope, OrderFilters as Filters, OrderFlag, RefundFilter } from "@/lib/orders/filters";
import { DEFAULT_FILTERS, isDefaultFilters } from "@/lib/orders/filters";
import { STATUS_LABELS, type OrderStatus } from "@/lib/types";
import { AccountFilter } from "./AccountFilter";

const STATUS_ORDER: OrderStatus[] = ["OUT_FOR_DELIVERY", "ARRIVING", "DELIVERED", "CANCELLED", "OTHER"];
const DATE_SCOPES: { value: DateScope; label: string }[] = [
  { value: "all", label: "All dates" },
  { value: "today", label: "Today" },
  { value: "tomorrow", label: "Tomorrow" },
  { value: "next7", label: "Next 7 days" },
  { value: "past7", label: "Last 7 days" },
  { value: "custom", label: "Custom range…" },
];
const REFUND_OPTIONS: { value: RefundFilter; label: string }[] = [
  { value: "all", label: "Any refund" },
  { value: "completed", label: "Refund completed" },
  { value: "initiated", label: "Refund in progress" },
  { value: "none", label: "No refund" },
];
const FLAG_OPTIONS: { value: OrderFlag; label: string }[] = [
  { value: "hasOtp", label: "Has OTP" },
  { value: "replacement", label: "Replacement" },
  { value: "hasGstin", label: "Has GSTIN" },
  { value: "detailFailed", label: "Details failed" },
];

const FIELD =
  "rounded-lg border border-black/15 bg-neutral-50 px-2 py-1.5 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:border-white/15 dark:bg-neutral-800";

// "" (cleared input) and anything non-numeric mean "no bound".
function parsePrice(value: string): number | null {
  if (value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function OrderFilters({
  filters,
  onChange,
  accounts,
  statusCounts,
}: {
  filters: Filters;
  onChange: (next: Filters) => void;
  accounts: string[];
  statusCounts?: Partial<Record<OrderStatus, number>>;
}) {
  function toggleStatus(s: OrderStatus) {
    const has = filters.statuses.includes(s);
    onChange({
      ...filters,
      statuses: has ? filters.statuses.filter((x) => x !== s) : [...filters.statuses, s],
    });
  }

  const flags = filters.flags ?? [];
  function toggleFlag(flag: OrderFlag) {
    onChange({ ...filters, flags: flags.includes(flag) ? flags.filter((x) => x !== flag) : [...flags, flag] });
  }

  const isDefault = isDefaultFilters(filters);

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-black/10 bg-white p-3 dark:border-white/15 dark:bg-neutral-900">
      <div className="flex flex-wrap items-center gap-2">
        {STATUS_ORDER.map((s) => {
          const active = filters.statuses.includes(s);
          return (
            <button
              key={s}
              type="button"
              onClick={() => toggleStatus(s)}
              className={`rounded-full px-3 py-1 text-xs font-semibold ring-1 ring-inset transition ${
                active
                  ? "bg-blue-600 text-white ring-blue-600"
                  : "bg-transparent text-neutral-600 ring-black/15 hover:bg-neutral-100 dark:text-neutral-300 dark:ring-white/15 dark:hover:bg-neutral-800"
              }`}
            >
              {STATUS_LABELS[s]}
              {statusCounts?.[s] != null && (
                <span className="ml-1 tabular-nums opacity-70">({statusCounts[s]})</span>
              )}
            </button>
          );
        })}
        <span className="text-[11px] text-neutral-400">
          {filters.statuses.length === 0 ? "(all statuses)" : ""}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label="Date"
          value={filters.date}
          onChange={(e) => onChange({ ...filters, date: e.target.value as DateScope })}
          className={FIELD}
        >
          {DATE_SCOPES.map((d) => (
            <option key={d.value} value={d.value}>
              {d.label}
            </option>
          ))}
        </select>

        {filters.date === "custom" && (
          <>
            <input
              type="date"
              aria-label="From date"
              value={filters.dateFrom ?? ""}
              max={filters.dateTo || undefined}
              onChange={(e) => onChange({ ...filters, dateFrom: e.target.value })}
              className={FIELD}
            />
            <span className="text-xs text-neutral-500 dark:text-neutral-400">to</span>
            <input
              type="date"
              aria-label="To date"
              value={filters.dateTo ?? ""}
              min={filters.dateFrom || undefined}
              onChange={(e) => onChange({ ...filters, dateTo: e.target.value })}
              className={FIELD}
            />
          </>
        )}

        {accounts.length > 1 && (
          <AccountFilter
            accounts={accounts}
            selected={filters.accounts}
            onChange={(next) => onChange({ ...filters, accounts: next })}
          />
        )}

        <input
          type="search"
          value={filters.search}
          onChange={(e) => onChange({ ...filters, search: e.target.value })}
          placeholder="Search item / order id…"
          className={`min-w-40 flex-1 ${FIELD}`}
        />

        {!isDefault && (
          <button
            type="button"
            onClick={() => onChange(DEFAULT_FILTERS)}
            className="rounded-lg border border-black/15 px-3 py-1.5 text-xs font-medium text-neutral-600 hover:bg-neutral-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:border-white/15 dark:text-neutral-300 dark:hover:bg-neutral-800"
          >
            Clear
          </button>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <select
          aria-label="Refund"
          value={filters.refund ?? "all"}
          onChange={(e) => onChange({ ...filters, refund: e.target.value as RefundFilter })}
          className={FIELD}
        >
          {REFUND_OPTIONS.map((r) => (
            <option key={r.value} value={r.value}>
              {r.label}
            </option>
          ))}
        </select>

        <div className="flex items-center gap-1.5 text-sm text-neutral-600 dark:text-neutral-300">
          <span className="text-xs">Price ₹</span>
          <input
            type="number"
            inputMode="decimal"
            min={0}
            aria-label="Minimum price"
            placeholder="Min"
            value={filters.priceMin ?? ""}
            onChange={(e) => onChange({ ...filters, priceMin: parsePrice(e.target.value) })}
            className={`w-24 ${FIELD}`}
          />
          <span className="text-xs">–</span>
          <input
            type="number"
            inputMode="decimal"
            min={0}
            aria-label="Maximum price"
            placeholder="Max"
            value={filters.priceMax ?? ""}
            onChange={(e) => onChange({ ...filters, priceMax: parsePrice(e.target.value) })}
            className={`w-24 ${FIELD}`}
          />
        </div>

        <fieldset className="flex flex-wrap items-center gap-3">
          <legend className="sr-only">Only show orders that</legend>
          {FLAG_OPTIONS.map((f) => (
            <label
              key={f.value}
              className="flex cursor-pointer items-center gap-1.5 text-sm text-neutral-700 dark:text-neutral-300"
            >
              <input
                type="checkbox"
                checked={flags.includes(f.value)}
                onChange={() => toggleFlag(f.value)}
                className="h-4 w-4 rounded border-black/20 accent-blue-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:border-white/20"
              />
              {f.label}
            </label>
          ))}
        </fieldset>
      </div>
    </div>
  );
}
