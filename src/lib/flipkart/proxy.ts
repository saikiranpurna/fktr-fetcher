import { ProxyAgent } from "undici";
import type { Dispatcher } from "undici";
import { config } from "../config";

// Reuse one agent (and its connection pool) per resolved proxy URL.
const agentCache = new Map<string, Dispatcher>();

// Replace a literal "{session}" token with a sanitized, stable per-account key so each
// account pins its own sticky residential IP (e.g. Decodo session routing). Without the
// token every account shares the proxy's rotating pool.
export function resolveProxyUrl(template: string, sessionKey: string): string {
  if (!template.includes("{session}")) return template;
  const session = (sessionKey || "default").replace(/[^A-Za-z0-9]/g, "").slice(0, 32) || "default";
  return template.replaceAll("{session}", session);
}

// The undici dispatcher to route this account's fetch through, or undefined for a
// direct connection when no proxy is configured.
export function getProxyDispatcher(sessionKey: string): Dispatcher | undefined {
  if (!config.proxyUrl) return undefined;
  const url = resolveProxyUrl(config.proxyUrl, sessionKey);
  let agent = agentCache.get(url);
  if (!agent) {
    agent = new ProxyAgent(url);
    agentCache.set(url, agent);
  }
  return agent;
}
