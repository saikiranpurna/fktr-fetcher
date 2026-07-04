"use client";

import { useState } from "react";
import type { AccountMeta, AccountResult } from "@/lib/types";

const ADMIN_TOKEN_KEY = "fkrt.adminToken";

function chip(status: AccountResult | undefined): { label: string; className: string; title?: string } {
  if (!status) return { label: "Unknown", className: "bg-gray-100 text-gray-700 ring-gray-300" };
  if (status.ok) return { label: "Valid", className: "bg-green-100 text-green-800 ring-green-300" };
  return {
    label: status.error?.code ?? "Error",
    className: "bg-red-100 text-red-800 ring-red-300",
    title: status.error?.message,
  };
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
  const [label, setLabel] = useState("");
  const [text, setText] = useState("");
  const [adminToken, setAdminToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [inlineError, setInlineError] = useState<string | null>(null);
  const [fileMsg, setFileMsg] = useState<string | null>(null);

  function toggleOpen() {
    if (!open && typeof window !== "undefined") {
      setAdminToken(window.localStorage.getItem(ADMIN_TOKEN_KEY) ?? "");
    }
    setOpen((v) => !v);
  }

  function headers(): HeadersInit {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (adminToken.trim()) h["x-admin-token"] = adminToken.trim();
    return h;
  }

  function persistAdminToken() {
    if (typeof window === "undefined") return;
    if (adminToken.trim()) window.localStorage.setItem(ADMIN_TOKEN_KEY, adminToken.trim());
    else window.localStorage.removeItem(ADMIN_TOKEN_KEY);
  }

  async function postAccount(accountLabel: string, cookie: string): Promise<string | null> {
    const res = await fetch("/api/accounts", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ label: accountLabel, cookie }),
    });
    if (res.ok) return null;
    const body = await res.json().catch(() => null);
    return body?.error?.message ?? `HTTP ${res.status}`;
  }

  // Drop one or many cookie .json files -> one account per file (label = filename).
  async function addFiles(files: File[]) {
    const jsons = files.filter(
      (f) => f.name.toLowerCase().endsWith(".json") || f.type === "application/json",
    );
    if (!jsons.length) {
      setInlineError("Drop Cookie-Editor .json file(s).");
      return;
    }
    setBusy(true);
    setInlineError(null);
    setFileMsg(null);
    persistAdminToken();
    const failures: string[] = [];
    for (const file of jsons) {
      try {
        const cookie = await file.text();
        const err = await postAccount(file.name.replace(/\.json$/i, ""), cookie);
        if (err) failures.push(`${file.name}: ${err}`);
      } catch (err) {
        failures.push(`${file.name}: ${(err as Error).message}`);
      }
    }
    setBusy(false);
    setFileMsg(`Added ${jsons.length - failures.length}/${jsons.length} file(s).`);
    if (failures.length) setInlineError(failures.join(" · "));
    onChanged();
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
    setInlineError(null);
    persistAdminToken();
    try {
      const err = await postAccount(label, text);
      if (err) {
        setInlineError(err);
        return;
      }
      setText("");
      setLabel("");
      onChanged();
    } catch (err) {
      setInlineError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function removeAccount(id: string) {
    setBusy(true);
    setInlineError(null);
    try {
      const res = await fetch(`/api/accounts?id=${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers: headers(),
      });
      const body = await res.json();
      if (!res.ok) {
        setInlineError(body?.error?.message ?? "Failed to remove account.");
        return;
      }
      onChanged();
    } catch (err) {
      setInlineError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-xl border border-black/10 bg-white dark:border-white/15 dark:bg-neutral-900">
      <button
        type="button"
        onClick={toggleOpen}
        className="flex w-full items-center justify-between gap-2 p-4 text-left"
      >
        <span className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
          Accounts ({accounts.length})
        </span>
        <span className="text-xs text-neutral-500 dark:text-neutral-400">
          {open ? "Hide" : "Manage"}
        </span>
      </button>

      <div className="space-y-2 px-4 pb-2">
        {accounts.length === 0 && (
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            No accounts yet. Drop each Flipkart account&apos;s cookie <code>.json</code> file below.
          </p>
        )}
        {accounts.map((a) => {
          const c = chip(statuses.find((s) => s.id === a.id));
          return (
            <div
              key={a.id}
              className="flex items-center justify-between gap-2 rounded-lg border border-black/5 px-3 py-2 dark:border-white/10"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium text-neutral-900 dark:text-neutral-100">
                    {a.label}
                  </span>
                  <span
                    title={c.title}
                    className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ring-inset ${c.className}`}
                  >
                    {c.label}
                  </span>
                </div>
                <span className="text-[11px] text-neutral-500 dark:text-neutral-400">
                  {a.count} cookie{a.count === 1 ? "" : "s"}
                  {a.updatedAt ? ` · ${new Date(a.updatedAt).toLocaleString()}` : ""}
                </span>
              </div>
              <button
                type="button"
                onClick={() => void removeAccount(a.id)}
                disabled={busy}
                className="shrink-0 rounded-md border border-black/15 px-2 py-1 text-xs text-red-600 hover:bg-red-50 disabled:opacity-60 dark:border-white/15 dark:hover:bg-red-950/40"
              >
                Remove
              </button>
            </div>
          );
        })}
      </div>

      {open && (
        <div className="space-y-3 border-t border-black/10 p-4 dark:border-white/15">
          <label
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
            className={`flex cursor-pointer flex-col items-center justify-center gap-1 rounded-xl border-2 border-dashed p-6 text-center transition ${
              dragOver
                ? "border-blue-500 bg-blue-50 dark:bg-blue-950/30"
                : "border-black/20 hover:border-blue-400 dark:border-white/20"
            }`}
          >
            <span className="text-sm font-medium text-neutral-800 dark:text-neutral-100">
              {busy ? "Adding…" : "Drop cookie .json file(s) here"}
            </span>
            <span className="text-xs text-neutral-500 dark:text-neutral-400">
              or click to choose — one file per Flipkart account
            </span>
            <input type="file" accept=".json,application/json" multiple onChange={onPick} className="hidden" />
          </label>

          {fileMsg && <p className="text-xs font-medium text-green-700 dark:text-green-400">{fileMsg}</p>}

          <input
            type="password"
            value={adminToken}
            onChange={(e) => setAdminToken(e.target.value)}
            placeholder="Admin token (only if configured)"
            className="w-full rounded-lg border border-black/15 bg-neutral-50 p-2 text-xs dark:border-white/15 dark:bg-neutral-800"
          />

          <details className="text-xs text-neutral-500 dark:text-neutral-400">
            <summary className="cursor-pointer select-none">or paste a cookie manually</summary>
            <div className="mt-2 space-y-2">
              <input
                type="text"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="Account label (e.g. Home, mom@gmail.com)"
                className="w-full rounded-lg border border-black/15 bg-neutral-50 p-2 text-sm dark:border-white/15 dark:bg-neutral-800"
              />
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                rows={4}
                placeholder='[{"name":"SN","value":"..."}] or {"SN":"..."} or "SN=...; T=..."'
                className="w-full rounded-lg border border-black/15 bg-neutral-50 p-2 font-mono text-xs dark:border-white/15 dark:bg-neutral-800"
              />
              <button
                type="button"
                onClick={addPasted}
                disabled={busy || !text.trim() || !label.trim()}
                className="min-h-10 rounded-lg bg-blue-600 px-4 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-60"
              >
                Add account
              </button>
            </div>
          </details>

          {inlineError && <p className="text-xs font-medium text-red-600">{inlineError}</p>}
        </div>
      )}
    </section>
  );
}
