// Ported from backend/app/errors.py. The HTTP-status map is dropped (no HTTP layer
// in the extension); the ErrorCode taxonomy and messages are preserved.
import type { ErrorCode } from "@core/types";

export class AppError extends Error {
  code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = "AppError";
    this.code = code;
  }
}

export function authExpired(): AppError {
  // Message adapted for the extension flow (no cookie panel): the user must be
  // logged into flipkart.com in this browser.
  return new AppError(
    "AUTH_EXPIRED",
    "Flipkart session expired or not logged in. Open flipkart.com, log in, then Fetch again.",
  );
}

export function configError(message: string): AppError {
  return new AppError("CONFIG_ERROR", message);
}

export function upstream(message: string): AppError {
  return new AppError("UPSTREAM_ERROR", message);
}

export function parseError(message: string): AppError {
  return new AppError("PARSE_ERROR", message);
}

export function toErrorPayload(err: unknown): { code: ErrorCode; message: string } {
  if (err instanceof AppError) return { code: err.code, message: err.message };
  const message = err instanceof Error && err.message ? err.message : "Unexpected error.";
  return { code: "UNKNOWN", message };
}
