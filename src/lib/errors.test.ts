import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AppError,
  describeUpstreamError,
  toErrorResponse,
} from "./errors";
import { logger } from "./logger";
import type { ErrorCode } from "./types";

describe("describeUpstreamError", () => {
  it("includes body= and caps the body at 500 chars", () => {
    const long = "a".repeat(1000);
    const out = describeUpstreamError(500, long);
    expect(out.startsWith("HTTP 500 | body=")).toBe(true);
    expect(out).toContain("body=");
    const bodyPart = out.slice("HTTP 500 | body=".length);
    expect(bodyPart).toHaveLength(500);
  });

  it("renders unknown status as ?", () => {
    expect(describeUpstreamError(undefined, "x")).toBe("HTTP ? | body=x");
  });
});

describe("toErrorResponse", () => {
  it("maps each ErrorCode to its HTTP status", () => {
    const cases: Record<ErrorCode, number> = {
      AUTH_EXPIRED: 401,
      UPSTREAM_ERROR: 502,
      PARSE_ERROR: 502,
      CONFIG_ERROR: 400,
      UNKNOWN: 500,
    };
    for (const [code, status] of Object.entries(cases) as [ErrorCode, number][]) {
      const { body, status: got } = toErrorResponse(new AppError(code, "m"));
      expect(got).toBe(status);
      expect(body.ok).toBe(false);
      if (!body.ok) expect(body.error.code).toBe(code);
    }
  });

  it("maps unknown throwables to UNKNOWN/500", () => {
    const { body, status } = toErrorResponse(new Error("boom"));
    expect(status).toBe(500);
    if (!body.ok) expect(body.error.code).toBe("UNKNOWN");
  });
});

describe("logger redaction", () => {
  afterEach(() => vi.restoreAllMocks());

  it("redacts cookie/authorization keys recursively", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    logger.info("test.redact", {
      cookie: "secret",
      Authorization: "bearer x",
      nested: { "set-cookie": "s", keep: "ok" },
    });
    expect(spy).toHaveBeenCalledTimes(1);
    const emitted = JSON.parse(spy.mock.calls[0][0] as string);
    expect(emitted.cookie).toBe("[REDACTED]");
    expect(emitted.Authorization).toBe("[REDACTED]");
    expect(emitted.nested["set-cookie"]).toBe("[REDACTED]");
    expect(emitted.nested.keep).toBe("ok");
  });
});
