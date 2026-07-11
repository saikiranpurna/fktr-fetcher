"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { API_BASE } from "@/lib/api";
import type { AccountMeta, AccountResult } from "@/lib/types";
import { TONE_CHIP, TONE_DOT, type Tone } from "@/lib/ui";

const ADMIN_TOKEN_KEY = "fkrt.adminToken";
const PAGE = 50; // window the account list so 1000+ accounts don't render at once

type HealthKey = "ok" | "pending" | "queued" | "expired" | "error";
type Health = { key: HealthKey; tone: Tone; label: string; rank: number; hint?: string };

// Account health from its last fetch result. rank sorts problems to the top (0 = worst).
function health(status: AccountResult | undefined): Health {
  if (!status) return { key: "queued", tone: "neutral", label: "Queued", rank: 1, hint: "Waiting for the first refresh." };
  if (status.pending) return { key: "pending", tone: "pending", label: "Refreshing", rank: 1, hint: "Refreshing now." };
  if (status.ok) return { key: "ok", tone: "ok", label: "Working", rank: 3 };
  if (status.error?.code === "AUTH_EXPIRED")
    return { key: "expired", tone: "error", label: "Session expired", rank: 0, hint: status.error?.message };
  return { key: "error", tone: "error", label: "Error", rank: 0, hint: status.error?.message };
}

const PILLS: { key: HealthKey; tone: Tone; label: string }[] = [
  { key: "expired", tone: "error", label: "Session expired" },
  { key: "error", tone: "error", label: "Error" },
  { key: "pending", tone: "pending", label: "Refreshing" },
  { key: "queued", tone: "neutral", label: "Queued" },
  { key: "ok", tone: "ok", label: "Working" },
];

function IconChevron({ open }: { open: boolean }) {
  return (
    <svg aria-hidden viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8"
      strokeLinecap="round" strokeLinejoin="round"
      className={`h-4 w-4 transition-transform duration-200 ${open ? "rotate-180" : ""}`}>
      <path d="m5 7.5 5 5 5-5" />
    </svg>
  );
}
function IconUpload() {
  return (
    <svg aria-hidden viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6"
      strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5">
      <path d="M10 13V4m0 0L6.5 7.5M10 4l3.5 3.5" />
      <path d="M4 13v2.5A1.5 1.5 0 0 0 5.5 17h9a1.5 1.5 0 0 0 1.5-1.5V13" />
    </svg>
  );
}
function IconSearch() {
  return (
    <svg aria-hidden viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7"
      strokeLinecap="round" className="h-4 w-4">
      <circle cx="9" cy="9" r="5.5" />
      <path d="m13.5 13.5 3 3" />
    </svg>
  );
}
function Spinner() {
  return (
    <span aria-hidden
      className="h-5 w-5 animate-spin rounded-full border-2 border-blue-500/30 border-t-blue-600 dark:border-blue-300/30 dark:border-t-blue-300" />
  );
}
function IconCheck() {
  return (
    <svg aria-hidden viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4 shrink-0">
      <path fillRule="evenodd" d="M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm3.7-9.3a1 1 0 0 0-1.4-1.4L9 10.6 7.7 9.3a1 1 0 1 0-1.4 1.4l2 2a1 1 0 0 0 1.4 0l4-4Z" clipRule="evenodd" />
    </svg>
  );
}
function IconAlert() {
  return (
    <svg aria-hidden viewBox="0 0 20 20" fill="currentColor" className="mt-0.5 h-4 w-4 shrink-0">
      <path fillRule="evenodd" d="M8.5 2.9a1.7 1.7 0 0 1 3 0l6.1 10.9A1.7 1.7 0 0 1 16.1 16H3.9a1.7 1.7 0 0 1-1.5-2.2L8.5 2.9ZM10 7a1 1 0 0 0-1 1v3a1 1 0 1 0 2 0V8a1 1 0 0 0-1-1Zm0 7.5a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z" clipRule="evenodd" />
    </svg>
  );
}

export function AccountsPanel({
  accounts,
  statuses,
  onChanged,
}: {
  accounts: AccountMeta[];
  statuses: AccountResult[];
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(true);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<HealthKey | null>(null);
  const [limit, setLimit] = useState(PAGE);
  const [label, setLabel] = useState("");
  const [text, setText] = useState("");
  const [adminToken, setAdminToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [fileMsg, setFileMsg] = useState<string | null>(null);
  const [pasteInvalid, setPasteInvalid] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const panelId = useId();
  const tokenId = useId();
  const labelId = useId();
  const cookieId = useId();
  const cookieHintId = useId();
  const searchId = useId();
  const dropHintId = useId();

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- seed from external store (localStorage)
    setAdminToken(window.localStorage.getItem(ADMIN_TOKEN_KEY) ?? "");
  }, []);

  // Move focus to Confirm when a row enters confirm mode (keyboard users don't lose their place).
  useEffect(() => {
    if (confirmingId) confirmRef.current?.focus();
  }, [confirmingId]);

  const statusById = useMemo(() => new Map(statuses.map((s) => [s.id, s])), [statuses]);

  const summary = useMemo(() => {
    const c: Record<HealthKey, number> = { ok: 0, pending: 0, queued: 0, expired: 0, error: 0 };
    for (const a of accounts) c[health(statusById.get(a.id)).key] += 1;
    return c;
  }, [accounts, statusById]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = accounts;
    if (q) list = list.filter((a) => a.label.toLowerCase().includes(q) || a.id.includes(q));
    if (statusFilter) list = list.filter((a) => health(statusById.get(a.id)).key === statusFilter);
    return [...list].sort((a, b) => {
      const r = health(statusById.get(a.id)).rank - health(statusById.get(b.id)).rank;
      return r !== 0 ? r : a.label.localeCompare(b.label);
    });
  }, [accounts, query, statusFilter, statusById]);
  const shown = filtered.slice(0, limit);

  function resetWindow() {
    setLimit(PAGE);
  }

  function headers(): HeadersInit {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (adminToken.trim()) h["x-admin-token"] = adminToken.trim();
    return h;
  }
  function persistAdminToken() {
    if (adminToken.trim()) window.localStorage.setItem(ADMIN_TOKEN_KEY, adminToken.trim());
    else window.localStorage.removeItem(ADMIN_TOKEN_KEY);
  }

  async function importContent(
    accountLabel: string,
    content: string,
  ): Promise<{ err: string | null; imported: number }> {
    const res = await fetch(`${API_BASE}/api/accounts/import`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ label: accountLabel, content }),
    });
    const body = await res.json().catch(() => null);
    if (res.ok) return { err: null, imported: body?.imported ?? 0 };
    return { err: body?.error?.message ?? `Import failed (HTTP ${res.status}).`, imported: 0 };
  }

  async function addFiles(files: File[]) {
    const picked = files.filter(
      (f) => /\.(json|txt)$/i.test(f.name) || f.type === "application/json" || f.type === "text/plain",
    );
    if (!picked.length) {
      setErrors(["Only .json or .txt cookie files are supported."]);
      return;
    }
    setBusy(true);
    setErrors([]);
    setFileMsg(null);
    persistAdminToken();
    const failures: string[] = [];
    let added = 0;
    setProgress({ done: 0, total: picked.length });
    for (let i = 0; i < picked.length; i++) {
      const file = picked[i];
      try {
        const content = await file.text();
        const name = file.name.replace(/\.(json|txt)$/i, "");
        const { err, imported } = await importContent(name, content);
        if (err) failures.push(`${file.name}: ${err}`);
        else added += imported;
      } catch (err) {
        failures.push(`${file.name}: ${(err as Error).message}`);
      }
      setProgress({ done: i + 1, total: picked.length });
    }
    setProgress(null);
    setBusy(false);
    setFileMsg(
      `Added ${added} account${added === 1 ? "" : "s"} from ${picked.length} file${picked.length === 1 ? "" : "s"}.`,
    );
    setErrors(failures);
    onChanged();
  }

  function onDragOver(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(true);
  }
  function onDragLeave(e: React.DragEvent) {
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setDragOver(false);
  }
  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    void addFiles(Array.from(e.dataTransfer.files));
  }
  function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    if (e.target.files) void addFiles(Array.from(e.target.files));
    e.target.value = "";
  }

  async function addPasted() {
    setBusy(true);
    setErrors([]);
    setFileMsg(null);
    setPasteInvalid(false);
    persistAdminToken();
    try {
      const { err, imported } = await importContent(label, text);
      if (err) {
        setErrors([err]);
        setPasteInvalid(true);
        return;
      }
      setFileMsg(`Added ${imported} account${imported === 1 ? "" : "s"}.`);
      setText("");
      setLabel("");
    } catch (err) {
      setErrors([(err as Error).message]);
      setPasteInvalid(true);
    } finally {
      setBusy(false);
      onChanged();
    }
  }

  async function removeAccount(id: string) {
    setBusy(true);
    setErrors([]);
    setFileMsg(null);
    try {
      const res = await fetch(`${API_BASE}/api/accounts?id=${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers: headers(),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setErrors([body?.error?.message ?? "Couldn't remove that account. Try again."]);
        requestAnimationFrame(() => document.getElementById(`fkrt-rm-${id}`)?.focus());
        return;
      }
      onChanged();
      requestAnimationFrame(() => listRef.current?.focus());
    } catch (err) {
      setErrors([(err as Error).message || "Network error while removing the account."]);
      requestAnimationFrame(() => document.getElementById(`fkrt-rm-${id}`)?.focus());
    } finally {
      setBusy(false);
      setConfirmingId(null);
    }
  }

  function cancelConfirm(id: string) {
    setConfirmingId(null);
    requestAnimationFrame(() => document.getElementById(`fkrt-rm-${id}`)?.focus());
  }

  function toggleFilter(key: HealthKey) {
    setStatusFilter((cur) => (cur === key ? null : key));
    resetWindow();
  }
  function clearFilters() {
    setQuery("");
    setStatusFilter(null);
    resetWindow();
  }

  const importingLabel =
    progress && progress.total > 1 ? `Importing ${progress.done} of ${progress.total}…` : "Adding…";
  const hasFilter = Boolean(query.trim() || statusFilter);

  return (
    <section className="overflow-hidden rounded-xl border border-black/10 bg-white shadow-sm dark:border-white/15 dark:bg-neutral-900">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={panelId}
        className="flex w-full items-center justify-between gap-2 p-4 text-left transition-colors hover:bg-neutral-50 dark:hover:bg-white/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500"
      >
        <span className="flex items-center gap-2 text-sm font-semibold text-neutral-900 dark:text-neutral-100">
          Accounts
          <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-xs font-medium tabular-nums text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">
            {accounts.length}
          </span>
        </span>
        <span className="flex items-center gap-1 text-xs font-medium text-neutral-500 dark:text-neutral-400">
          {open ? "Done" : "Add accounts"}
          <IconChevron open={open} />
        </span>
      </button>

      {/* status summary — each pill filters the list by that health state */}
      {accounts.length > 0 && (
        <div className="flex flex-wrap gap-1.5 px-4 pb-2">
          {PILLS.filter((p) => summary[p.key] > 0).map((p) => {
            const active = statusFilter === p.key;
            return (
              <button
                key={p.key}
                type="button"
                onClick={() => toggleFilter(p.key)}
                aria-pressed={active}
                className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${TONE_CHIP[p.tone]} ${active ? "ring-2 ring-blue-500" : ""}`}
              >
                <span className={`h-1.5 w-1.5 rounded-full ${TONE_DOT[p.tone]}`} aria-hidden />
                <span className="tabular-nums">{summary[p.key]}</span> {p.label}
              </button>
            );
          })}
          {hasFilter && (
            <button
              type="button"
              onClick={clearFilters}
              className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium text-neutral-500 underline-offset-2 hover:underline dark:text-neutral-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
            >
              Clear filter
            </button>
          )}
        </div>
      )}

      {/* search (only when the list is long enough to need it) */}
      {accounts.length > 8 && (
        <div className="px-4 pb-2">
          <label htmlFor={searchId} className="sr-only">Filter accounts by name</label>
          <div className="relative">
            <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-neutral-400" aria-hidden>
              <IconSearch />
            </span>
            <input
              id={searchId}
              type="search"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                resetWindow();
              }}
              placeholder={`Filter ${accounts.length} accounts`}
              className="w-full rounded-lg border border-black/15 bg-neutral-50 py-1.5 pl-8 pr-3 text-sm dark:border-white/15 dark:bg-neutral-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
            />
          </div>
        </div>
      )}

      <ul ref={listRef} tabIndex={-1} className="max-h-96 space-y-2 overflow-y-auto px-4 pb-2 focus:outline-none">
        {accounts.length === 0 ? (
          <li className="flex items-start gap-2 rounded-lg border border-dashed border-black/15 p-3 text-sm text-neutral-600 dark:border-white/15 dark:text-neutral-300">
            No accounts connected yet. Add a Flipkart cookie below to start tracking orders.
          </li>
        ) : shown.length === 0 ? (
          <li className="flex items-center justify-between gap-2 px-1 py-2 text-xs text-neutral-500 dark:text-neutral-400">
            No accounts match your filter.
            <button type="button" onClick={clearFilters} className="font-medium text-blue-600 hover:underline dark:text-blue-400">
              Clear
            </button>
          </li>
        ) : (
          shown.map((a) => {
            const h = health(statusById.get(a.id));
            const st = statusById.get(a.id);
            return (
              <li
                key={a.id}
                className="flex items-center justify-between gap-2 rounded-lg border border-black/5 px-3 py-2 dark:border-white/10"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium text-neutral-900 dark:text-neutral-100">
                      {a.label}
                    </span>
                    <span
                      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ring-inset ${TONE_CHIP[h.tone]}`}
                    >
                      <span className={`h-1.5 w-1.5 rounded-full ${TONE_DOT[h.tone]}`} aria-hidden />
                      {h.label}
                      {h.hint && (h.key === "queued" || h.key === "pending") && (
                        <span className="sr-only"> — {h.hint}</span>
                      )}
                    </span>
                  </div>
                  <span className="text-[11px] tabular-nums text-neutral-500 dark:text-neutral-400">
                    {a.count} cookie{a.count === 1 ? "" : "s"}
                    {a.updatedAt ? ` · added ${new Date(a.updatedAt).toLocaleDateString()}` : ""}
                  </span>
                  {st && !st.ok && !st.pending && st.error?.message && (
                    <p className="mt-0.5 text-[11px] text-red-600 dark:text-red-400">{st.error.message}</p>
                  )}
                </div>
                {confirmingId === a.id ? (
                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      ref={confirmRef}
                      type="button"
                      onClick={() => void removeAccount(a.id)}
                      disabled={busy}
                      aria-label={`Confirm removing ${a.label}`}
                      className="min-h-10 rounded-md bg-red-600 px-2.5 text-xs font-semibold text-white transition-colors hover:bg-red-700 active:bg-red-800 disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500"
                    >
                      Confirm
                    </button>
                    <button
                      type="button"
                      onClick={() => cancelConfirm(a.id)}
                      aria-label={`Cancel removing ${a.label}`}
                      className="min-h-10 rounded-md border border-black/15 px-2.5 text-xs font-medium text-neutral-600 transition-colors hover:bg-neutral-100 dark:border-white/15 dark:text-neutral-300 dark:hover:bg-neutral-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    id={`fkrt-rm-${a.id}`}
                    type="button"
                    onClick={() => setConfirmingId(a.id)}
                    disabled={busy}
                    aria-label={`Remove account ${a.label}`}
                    className="min-h-10 shrink-0 rounded-md border border-black/15 px-2.5 text-xs font-medium text-red-600 transition-colors hover:bg-red-50 active:bg-red-100 disabled:opacity-60 dark:border-white/15 dark:text-red-400 dark:hover:bg-red-950/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500"
                  >
                    Remove
                  </button>
                )}
              </li>
            );
          })
        )}
        {filtered.length > shown.length && (
          <li>
            <button
              type="button"
              onClick={() => setLimit((l) => l + PAGE)}
              className="w-full rounded-md border border-black/10 px-3 py-1.5 text-xs font-medium text-neutral-600 transition-colors hover:bg-neutral-100 dark:border-white/10 dark:text-neutral-300 dark:hover:bg-neutral-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
            >
              Show more · <span className="tabular-nums">{shown.length} of {filtered.length}</span> shown
            </button>
          </li>
        )}
      </ul>

      {/* Feedback lives OUTSIDE the collapsible drawer so remove errors show even when collapsed. */}
      <div className="space-y-2 px-4 pb-3">
        <div aria-live="polite" className="sr-only">
          {busy ? importingLabel : (fileMsg ?? "")}
        </div>
        {fileMsg && !busy && (
          <p className="flex items-center gap-1.5 text-xs font-medium text-green-700 dark:text-green-400">
            <IconCheck /> {fileMsg}
          </p>
        )}
        <div role="alert">
          {errors.length > 0 && (
            <div className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-500/40 dark:bg-red-950/40 dark:text-red-300">
              <p className="flex items-start gap-1.5 font-medium">
                <IconAlert />
                <span>{errors.length === 1 ? errors[0] : `${errors.length} items couldn't be added:`}</span>
              </p>
              {errors.length > 1 && (
                <ul className="mt-1 list-disc space-y-0.5 break-words pl-6">
                  {errors.slice(0, 8).map((e, i) => (
                    <li key={i}>{e}</li>
                  ))}
                  {errors.length > 8 && <li>+{errors.length - 8} more</li>}
                </ul>
              )}
            </div>
          )}
        </div>
      </div>

      <div id={panelId} hidden={!open} className="space-y-3 border-t border-black/10 p-4 dark:border-white/15">
        <div>
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            onDragOver={onDragOver}
            onDragEnter={onDragOver}
            onDragLeave={onDragLeave}
            onDrop={onDrop}
            aria-describedby={dropHintId}
            className={`flex w-full flex-col items-center justify-center gap-1.5 rounded-xl border-2 border-dashed p-6 text-center transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${
              dragOver
                ? "border-blue-500 bg-blue-50 dark:bg-blue-950/30"
                : "border-black/20 hover:border-blue-400 dark:border-white/20 dark:hover:border-blue-400"
            }`}
          >
            <span className="flex h-10 w-10 items-center justify-center rounded-full bg-blue-50 text-blue-600 dark:bg-blue-950/40 dark:text-blue-300">
              {busy ? <Spinner /> : <IconUpload />}
            </span>
            <span className="text-sm font-medium text-neutral-800 dark:text-neutral-100">
              {busy ? importingLabel : "Drop cookie files or click to browse"}
            </span>
            <span id={dropHintId} className="text-xs text-neutral-500 dark:text-neutral-400">
              .json or .txt — one account per file, or one file with several
            </span>
          </button>
          <input
            ref={inputRef}
            type="file"
            accept=".json,.txt,application/json,text/plain"
            multiple
            onChange={onPick}
            tabIndex={-1}
            aria-hidden
            className="sr-only"
          />
        </div>

        <div>
          <label htmlFor={tokenId} className="mb-1 block text-[11px] font-medium text-neutral-600 dark:text-neutral-400">
            Admin token <span className="font-normal">(only if your deployment sets one)</span>
          </label>
          <input
            id={tokenId}
            type="password"
            autoComplete="off"
            value={adminToken}
            onChange={(e) => setAdminToken(e.target.value)}
            placeholder="Leave blank for local use"
            className="w-full rounded-lg border border-black/15 bg-neutral-50 p-2 text-xs dark:border-white/15 dark:bg-neutral-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
          />
        </div>

        <details className="rounded-lg border border-black/10 dark:border-white/10">
          <summary className="cursor-pointer select-none rounded-lg px-3 py-2 text-xs font-medium text-neutral-600 transition-colors hover:bg-neutral-50 dark:text-neutral-300 dark:hover:bg-white/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500">
            Paste a cookie manually
          </summary>
          <div className="space-y-2 px-3 pb-3">
            <div>
              <label htmlFor={labelId} className="mb-1 block text-[11px] font-medium text-neutral-600 dark:text-neutral-400">
                Account label <span className="font-normal">(optional)</span>
              </label>
              <input
                id={labelId}
                type="text"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="e.g. Home, mom@gmail.com"
                className="w-full rounded-lg border border-black/15 bg-neutral-50 p-2 text-sm dark:border-white/15 dark:bg-neutral-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
              />
            </div>
            <div>
              <label htmlFor={cookieId} className="mb-1 block text-[11px] font-medium text-neutral-600 dark:text-neutral-400">
                Cookie data
              </label>
              <textarea
                id={cookieId}
                value={text}
                onChange={(e) => {
                  setText(e.target.value);
                  if (pasteInvalid) setPasteInvalid(false);
                }}
                aria-describedby={cookieHintId}
                aria-invalid={pasteInvalid}
                rows={4}
                placeholder="Paste your cookie data here"
                className="w-full rounded-lg border border-black/15 bg-neutral-50 p-2 font-mono text-xs dark:border-white/15 dark:bg-neutral-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 aria-[invalid=true]:border-red-400"
              />
              <p id={cookieHintId} className="mt-1 text-[11px] text-neutral-600 dark:text-neutral-400">
                One account: a Cookie-Editor JSON export, a <code>{"{name: value}"}</code> map, or a raw
                {" "}<code>name=value; …</code> header. Several: a JSON array of{" "}
                <code>{"{label, cookie}"}</code> or a <code>{"{label: cookie}"}</code> map.
              </p>
            </div>
            <button
              type="button"
              onClick={() => void addPasted()}
              disabled={busy || !text.trim()}
              className="min-h-10 w-full rounded-lg bg-blue-600 px-4 text-sm font-semibold text-white transition-colors hover:bg-blue-700 active:bg-blue-800 disabled:cursor-not-allowed disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
            >
              Add account
            </button>
          </div>
        </details>
      </div>
    </section>
  );
}
