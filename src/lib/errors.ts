import type { ErrorCode, ErrorResponse } from "./types";

const HTTP: Record<ErrorCode, number> = {
  AUTH_EXPIRED: 401,
  UPSTREAM_ERROR: 502,
  PARSE_ERROR: 502,
  CONFIG_ERROR: 400,
  UNKNOWN: 500,
};

export class AppError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public cause?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }

  get httpStatus(): number {
    return HTTP[this.code];
  }
}

// user-facing message factories
export function authExpired(): AppError {
  return new AppError(
    "AUTH_EXPIRED",
    "Flipkart session expired or invalid. Update the cookie in the Session panel.",
  );
}

export function configError(message: string): AppError {
  return new AppError("CONFIG_ERROR", message);
}

export function upstream(message: string, cause?: unknown): AppError {
  return new AppError("UPSTREAM_ERROR", message, cause);
}

export function parseError(message: string, cause?: unknown): AppError {
  return new AppError("PARSE_ERROR", message, cause);
}

// surface-upstream-errors: extract body, cap 500 chars, never leak cookie
export function describeUpstreamError(status: number | undefined, body: string): string {
  return `HTTP ${status ?? "?"} | body=${(body || "").slice(0, 500)}`;
}

export function toErrorResponse(err: unknown): { body: ErrorResponse; status: number } {
  if (err instanceof AppError) {
    return {
      body: { ok: false, error: { code: err.code, message: err.message } },
      status: err.httpStatus,
    };
  }
  return {
    body: { ok: false, error: { code: "UNKNOWN", message: "Unexpected server error." } },
    status: 500,
  };
}
