import { config } from "./config";

type Level = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const REDACT_KEYS: Record<string, true> = { cookie: true, authorization: true, "set-cookie": true };

// Recursively replace values of sensitive keys with "[REDACTED]" (case-insensitive key match).
function redact(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redact);
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = REDACT_KEYS[k.toLowerCase()] ? "[REDACTED]" : redact(v);
    }
    return out;
  }
  return value;
}

function emit(level: Level, msg: string, ctx?: object): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[config.logLevel]) return;
  const line = { ts: new Date().toISOString(), level, msg, ...(redact(ctx ?? {}) as object) };
  const serialized = JSON.stringify(line);
  if (level === "error") console.error(serialized);
  else if (level === "warn") console.warn(serialized);
  else if (level === "debug") console.debug(serialized);
  else console.log(serialized);
}

export const logger = {
  debug(msg: string, ctx?: object): void {
    emit("debug", msg, ctx);
  },
  info(msg: string, ctx?: object): void {
    emit("info", msg, ctx);
  },
  warn(msg: string, ctx?: object): void {
    emit("warn", msg, ctx);
  },
  error(msg: string, ctx?: object): void {
    emit("error", msg, ctx);
  },
};
