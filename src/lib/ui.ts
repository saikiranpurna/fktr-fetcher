import type { ErrorCode } from "./types";

// Operator-facing text for internal error codes, so the UI never shows raw enum values. Lower-case
// so it reads naturally mid-sentence ("Mom (session expired)"); capitalise it for a heading.
export const ERROR_TEXT: Record<ErrorCode, string> = {
  AUTH_EXPIRED: "session expired",
  UNAUTHORIZED: "admin token required",
  UPSTREAM_ERROR: "couldn't reach Flipkart",
  PARSE_ERROR: "unexpected response",
  CONFIG_ERROR: "not configured",
  INVOICE_UNAVAILABLE: "invoice not available yet",
  UNKNOWN: "unknown error",
};

// ERROR_TEXT lookup that degrades to "unknown error" for a missing code, or one a newer backend
// sends that this build doesn't know yet, instead of rendering "undefined".
export function errorText(code: ErrorCode | undefined): string {
  return (code && ERROR_TEXT[code]) || ERROR_TEXT.UNKNOWN;
}

// errorText capitalised for a heading or the start of a sentence ("Session expired").
export function errorHeading(code: ErrorCode | undefined): string {
  const text = errorText(code);
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// Shared status "tone" recipes: one source of truth for chip + dot colors (light AND dark),
// so StatusBadge (order status) and AccountsPanel (account health) can't drift apart.
export type Tone = "ok" | "pending" | "info" | "error" | "neutral";

export const TONE_CHIP: Record<Tone, string> = {
  ok: "bg-green-100 text-green-800 ring-green-300 dark:bg-green-950/40 dark:text-green-300 dark:ring-green-500/30",
  pending: "bg-amber-100 text-amber-800 ring-amber-300 dark:bg-amber-950/40 dark:text-amber-300 dark:ring-amber-500/30",
  info: "bg-blue-100 text-blue-800 ring-blue-300 dark:bg-blue-950/40 dark:text-blue-300 dark:ring-blue-500/30",
  error: "bg-red-100 text-red-800 ring-red-300 dark:bg-red-950/40 dark:text-red-300 dark:ring-red-500/30",
  neutral:
    "bg-neutral-100 text-neutral-700 ring-neutral-300 dark:bg-neutral-800 dark:text-neutral-300 dark:ring-white/15",
};

export const TONE_DOT: Record<Tone, string> = {
  ok: "bg-green-500",
  pending: "bg-amber-500",
  info: "bg-blue-500",
  error: "bg-red-500",
  neutral: "bg-neutral-400",
};
