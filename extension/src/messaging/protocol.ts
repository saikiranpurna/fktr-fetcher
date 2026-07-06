// Typed messages exchanged over a chrome.runtime.Port between the dashboard page
// and the background service worker.
import type { Order, ErrorCode } from "@core/types";

// UI -> worker
export interface FetchRun {
  type: "RUN_FETCH";
  accountLabel: string;
}
export type ToWorker = FetchRun;

// worker -> UI
export interface Progress {
  type: "PROGRESS";
  phase: "orders" | "details";
  done: number;
  total: number;
}
export interface Result {
  type: "RESULT";
  orders: Order[]; // parsed rows, each tagged with the account label
  fetchedAt: string; // ISO
}
export interface Failure {
  type: "ERROR";
  error: { code: ErrorCode; message: string };
}
export type FromWorker = Progress | Result | Failure;
