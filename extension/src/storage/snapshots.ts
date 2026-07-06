// Multi-account without a server: each fetched account's rows are cached in
// chrome.storage.local, keyed by label. The dashboard unions all snapshots so a
// browser that can only be logged into one Flipkart account at a time still shows
// every account the user has fetched (log in -> Fetch -> log into the next -> Fetch).
import type { Order } from "@core/types";

export interface Snapshot {
  label: string;
  orders: Order[];
  fetchedAt: string; // ISO
}

const KEY = "fkrt.snapshots";
type Store = Record<string, Snapshot>;

function isSnapshot(v: unknown): v is Snapshot {
  if (!v || typeof v !== "object") return false;
  if (!("label" in v) || typeof v.label !== "string") return false;
  if (!("orders" in v) || !Array.isArray(v.orders)) return false;
  if (!("fetchedAt" in v) || typeof v.fetchedAt !== "string") return false;
  return true;
}

async function readStore(): Promise<Store> {
  const got = await chrome.storage.local.get(KEY);
  const raw: unknown = got[KEY];
  if (!raw || typeof raw !== "object") return {};
  const rec = raw as Record<string, unknown>; // persisted blob we wrote; validated per-entry below
  const store: Store = {};
  for (const [label, value] of Object.entries(rec)) {
    if (isSnapshot(value)) store[label] = value;
  }
  return store;
}

export async function listSnapshots(): Promise<Snapshot[]> {
  const store = await readStore();
  // Newest first.
  return Object.values(store).sort((a, b) => b.fetchedAt.localeCompare(a.fetchedAt));
}

export async function saveSnapshot(snapshot: Snapshot): Promise<void> {
  const store = await readStore();
  store[snapshot.label] = snapshot;
  await chrome.storage.local.set({ [KEY]: store });
}

export async function removeSnapshot(label: string): Promise<void> {
  const store = await readStore();
  delete store[label];
  await chrome.storage.local.set({ [KEY]: store });
}

export async function mergedOrders(): Promise<Order[]> {
  const store = await readStore();
  return Object.values(store).flatMap((s) => s.orders);
}
