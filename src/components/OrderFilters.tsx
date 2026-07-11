"use client";

import type { DateScope, OrderFilters as Filters } from "@/lib/orders/filters";
import { DEFAULT_FILTERS } from "@/lib/orders/filters";
import { STATUS_LABELS, type OrderStatus } from "@/lib/types";
import { AccountFilter } from "./AccountFilter";

const STATUS_ORDER: OrderStatus[] = ["OUT_FOR_DELIVERY", "ARRIVING", "DELIVERED", "OTHER"];
const DATE_SCOPES: { value: DateScope; label: string }[] = [
  { value: "all", label: "All dates" },
  { value: "today", label: "Today" },
  { value: "tomorrow", label: "Tomorrow" },
  { value: "next7", label: "Next 7 days" },
  { value: "past7", label: "Last 7 days" },
];

export function OrderFilters({
  filters,
  onChange,
  accounts,
}: {
  filters: Filters;
  onChange: (next: Filters) => void;
  accounts: string[];
}) {
  function toggleStatus(s: OrderStatus) {
    const has = filters.statuses.includes(s);
    onChange({
      ...filters,
      statuses: has ? filters.statuses.filter((x) => x !== s) : [...filters.statuses, s],
    });
  }

  const isDefault =
    filters.statuses.length === 0 &&
    filters.date === "all" &&
    filters.accounts.length === 0 &&
    filters.search === "";

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
            </button>
          );
        })}
        <span className="text-[11px] text-neutral-400">
          {filters.statuses.length === 0 ? "(all statuses)" : ""}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <select
          value={filters.date}
          onChange={(e) => onChange({ ...filters, date: e.target.value as DateScope })}
          className="rounded-lg border border-black/15 bg-neutral-50 px-2 py-1.5 text-sm dark:border-white/15 dark:bg-neutral-800"
        >
          {DATE_SCOPES.map((d) => (
            <option key={d.value} value={d.value}>
              {d.label}
            </option>
          ))}
        </select>

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
          className="min-w-40 flex-1 rounded-lg border border-black/15 bg-neutral-50 px-2 py-1.5 text-sm dark:border-white/15 dark:bg-neutral-800"
        />

        {!isDefault && (
          <button
            type="button"
            onClick={() => onChange(DEFAULT_FILTERS)}
            className="rounded-lg border border-black/15 px-3 py-1.5 text-xs font-medium text-neutral-600 hover:bg-neutral-100 dark:border-white/15 dark:text-neutral-300 dark:hover:bg-neutral-800"
          >
            Clear
          </button>
        )}
      </div>
    </div>
  );
}
