import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { config } from "../config";
import { configError } from "../errors";
import { logger } from "../logger";
import type { AccountMeta } from "../types";

export type CookieItem = {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  [k: string]: unknown;
};

type PersistedAccount = { id: string; label: string; items: CookieItem[]; updatedAt: string };
type Persisted = { accounts: PersistedAccount[]; updatedAt: string };

// A resolved account ready to fetch with.
export type ActiveAccount = { id: string; label: string; cookieHeader: string };

// Accept a Cookie-Editor JSON array, an object map {name:value}, OR a raw "k=v; k2=v2" header.
export function normalizeCookieInput(input: string): CookieItem[] {
  const trimmed = (input || "").trim();
  if (!trimmed) throw configError("Cookie is empty.");

  if (trimmed.startsWith("[")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      throw configError(`Cookie JSON is invalid: ${(err as Error).message}`);
    }
    if (!Array.isArray(parsed)) throw configError("Cookie JSON array is invalid.");
    return parsed.map((raw, i) => {
      const item = raw as Record<string, unknown>;
      if (typeof item?.name !== "string" || typeof item?.value !== "string") {
        throw configError(`Cookie JSON item ${i} must have string name and value.`);
      }
      return item as CookieItem;
    });
  }

  if (trimmed.startsWith("{")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      throw configError(`Cookie JSON is invalid: ${(err as Error).message}`);
    }
    if (!parsed || typeof parsed !== "object") throw configError("Cookie JSON object is invalid.");
    return Object.entries(parsed as Record<string, unknown>).map(([name, value]) => ({
      name,
      value: String(value),
    }));
  }

  // Raw "k=v; k2=v2" header.
  return trimmed
    .split(/;\s*/)
    .map((pair) => pair.trim())
    .filter(Boolean)
    .map((pair) => {
      const eq = pair.indexOf("=");
      const name = eq === -1 ? pair : pair.slice(0, eq);
      const value = eq === -1 ? "" : pair.slice(eq + 1);
      return { name: name.trim(), value };
    });
}

export function toCookieHeader(items: CookieItem[]): string {
  return items
    .filter((it) => it.name && it.name.trim())
    .map((it) => `${it.name}=${it.value}`)
    .join("; ");
}

// Stable id from a human label so re-uploading the same account replaces it.
function accountId(label: string): string {
  const slug = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || `acct-${Date.now().toString(36)}`;
}

function readPersisted(): Persisted | null {
  try {
    if (!existsSync(config.sessionStorePath)) return null;
    const parsed = JSON.parse(readFileSync(config.sessionStorePath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const obj = parsed as Record<string, unknown>;
    if (Array.isArray(obj.accounts)) return obj as unknown as Persisted;
    // Migrate the legacy single-cookie format { items, updatedAt }.
    if (Array.isArray(obj.items)) {
      const updatedAt = typeof obj.updatedAt === "string" ? obj.updatedAt : new Date().toISOString();
      return {
        accounts: [{ id: "default", label: "Default", items: obj.items as CookieItem[], updatedAt }],
        updatedAt,
      };
    }
    return null;
  } catch (err) {
    logger.debug("session.store.read_failed", { message: (err as Error).message });
    return null;
  }
}

function writePersisted(persisted: Persisted): void {
  try {
    writeFileSync(config.sessionStorePath, JSON.stringify(persisted), { mode: 0o600 });
  } catch (err) {
    throw configError(`Could not persist account: ${(err as Error).message}`);
  }
}

function removeRuntimeFile(): void {
  try {
    if (existsSync(config.sessionStorePath)) unlinkSync(config.sessionStorePath);
  } catch (err) {
    logger.warn("session.store.clear_failed", { message: (err as Error).message });
  }
}

export function addAccount(label: string, input: string): AccountMeta[] {
  const trimmedLabel = (label || "").trim();
  if (!trimmedLabel) throw configError("Account label is required.");
  const items = normalizeCookieInput(input);
  const now = new Date().toISOString();
  const id = accountId(trimmedLabel);
  const persisted = readPersisted() ?? { accounts: [], updatedAt: now };
  const account: PersistedAccount = { id, label: trimmedLabel, items, updatedAt: now };
  const idx = persisted.accounts.findIndex((a) => a.id === id);
  if (idx >= 0) persisted.accounts[idx] = account;
  else persisted.accounts.push(account);
  persisted.updatedAt = now;
  writePersisted(persisted);
  logger.info("session.account.updated", { id, count: items.length });
  return listAccounts();
}

export function removeAccount(id: string): AccountMeta[] {
  const persisted = readPersisted();
  if (persisted) {
    const next = persisted.accounts.filter((a) => a.id !== id);
    if (next.length) writePersisted({ accounts: next, updatedAt: new Date().toISOString() });
    else removeRuntimeFile();
    logger.info("session.account.removed", { id });
  }
  return listAccounts();
}

export function clearAllAccounts(): AccountMeta[] {
  removeRuntimeFile();
  logger.info("session.accounts.cleared", {});
  return listAccounts();
}

// Accounts come only from dropped cookie files (the runtime store) — no env fallback.
export function getActiveAccounts(): ActiveAccount[] {
  const persisted = readPersisted();
  if (!persisted) return [];
  return persisted.accounts
    .map((a) => ({ id: a.id, label: a.label, cookieHeader: toCookieHeader(a.items) }))
    .filter((a) => a.cookieHeader);
}

export function listAccounts(): AccountMeta[] {
  const persisted = readPersisted();
  if (!persisted) return [];
  return persisted.accounts.map((a) => ({
    id: a.id,
    label: a.label,
    updatedAt: a.updatedAt,
    count: a.items.length,
  }));
}
