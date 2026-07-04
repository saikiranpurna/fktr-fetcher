import { afterEach, describe, expect, it } from "vitest";
import { config } from "../config";
import { getProxyDispatcher, resolveProxyUrl } from "./proxy";

const ORIG = { ...config };
afterEach(() => Object.assign(config, ORIG));

describe("resolveProxyUrl", () => {
  it("substitutes and sanitizes a per-account {session} token", () => {
    const template = "http://user-session-{session}:pass@gate.decodo.com:7000";
    expect(resolveProxyUrl(template, "mock-a")).toBe(
      "http://user-session-mocka:pass@gate.decodo.com:7000",
    );
  });

  it("returns the template unchanged when there is no {session} token", () => {
    const template = "http://user:pass@gate.decodo.com:7000";
    expect(resolveProxyUrl(template, "anything")).toBe(template);
  });

  it("falls back to 'default' for an empty session key", () => {
    expect(resolveProxyUrl("http://x-{session}", "")).toBe("http://x-default");
  });
});

describe("getProxyDispatcher", () => {
  it("returns undefined when no proxy is configured", () => {
    config.proxyUrl = "";
    expect(getProxyDispatcher("mock-a")).toBeUndefined();
  });
});
