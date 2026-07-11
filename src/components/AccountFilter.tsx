"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";

const CAP = 200; // render at most this many checkboxes; narrow the rest with search

// Accessible multi-select for the account filter. Trigger button + popover of native checkboxes
// (a real checkbox group, not a faked listbox), searchable and windowed so it scales to 1000+.
export function AccountFilter({
  accounts,
  selected,
  onChange,
}: {
  accounts: string[];
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popId = useId();

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setOpen(false);
        btnRef.current?.focus();
      }
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? accounts.filter((a) => a.toLowerCase().includes(q)) : accounts;
  }, [accounts, query]);
  const shown = filtered.slice(0, CAP);

  function toggle(label: string) {
    const next = new Set(selected);
    if (next.has(label)) next.delete(label);
    else next.add(label);
    onChange([...next]);
  }

  const triggerLabel =
    selected.length === 0 ? "All accounts" : selected.length === 1 ? selected[0] : `${selected.length} accounts`;

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls={open ? popId : undefined}
        className="inline-flex min-h-9 max-w-56 items-center gap-1.5 rounded-lg border border-black/15 bg-neutral-50 px-2.5 py-1.5 text-sm text-neutral-800 transition-colors hover:bg-neutral-100 dark:border-white/15 dark:bg-neutral-800 dark:text-neutral-100 dark:hover:bg-neutral-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
      >
        <span className="truncate">{triggerLabel}</span>
        {selected.length > 0 && (
          <span className="rounded-full bg-blue-600 px-1.5 text-[11px] font-semibold tabular-nums text-white">
            {selected.length}
          </span>
        )}
        <svg
          aria-hidden
          viewBox="0 0 20 20"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={`h-4 w-4 shrink-0 text-neutral-500 transition-transform duration-150 ${open ? "rotate-180" : ""}`}
        >
          <path d="m5 7.5 5 5 5-5" />
        </svg>
      </button>

      {open && (
        <div
          id={popId}
          className="absolute left-0 z-20 mt-1 w-64 overflow-hidden rounded-lg border border-black/10 bg-white shadow-lg dark:border-white/15 dark:bg-neutral-900"
        >
          <div className="border-b border-black/10 p-2 dark:border-white/10">
            <input
              type="search"
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={`Filter ${accounts.length} accounts`}
              aria-label="Search accounts to filter by"
              className="w-full rounded-md border border-black/15 bg-neutral-50 px-2 py-1.5 text-sm dark:border-white/15 dark:bg-neutral-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
            />
          </div>

          <div role="group" aria-label="Filter by account" className="max-h-64 overflow-y-auto p-1">
            {shown.map((a) => {
              const sel = selectedSet.has(a);
              return (
                <label
                  key={a}
                  className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm text-neutral-800 hover:bg-neutral-100 dark:text-neutral-100 dark:hover:bg-neutral-800"
                >
                  <input
                    type="checkbox"
                    checked={sel}
                    onChange={() => toggle(a)}
                    className="h-4 w-4 shrink-0 accent-blue-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                  />
                  <span className="truncate">{a}</span>
                </label>
              );
            })}
            {filtered.length > shown.length && (
              <p className="px-2 py-1 text-[11px] text-neutral-500 dark:text-neutral-400">
                +{filtered.length - shown.length} more — narrow with search
              </p>
            )}
            {filtered.length === 0 && (
              <p className="px-2 py-2 text-xs text-neutral-500 dark:text-neutral-400">No accounts match.</p>
            )}
          </div>

          {selected.length > 0 && (
            <div className="border-t border-black/10 p-2 dark:border-white/10">
              <button
                type="button"
                onClick={() => onChange([])}
                className="w-full rounded-md px-2 py-1 text-xs font-medium text-blue-600 hover:bg-blue-50 dark:text-blue-400 dark:hover:bg-blue-950/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
              >
                Clear selection ({selected.length})
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
