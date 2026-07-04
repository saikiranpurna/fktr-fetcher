import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { config } from "../config";
import { AppError } from "../errors";
import {
  addAccount,
  clearAllAccounts,
  getActiveAccounts,
  listAccounts,
  normalizeCookieInput,
  removeAccount,
  toCookieHeader,
} from "./store";

const ORIG = { ...config };
const STORE = join(tmpdir(), `fkrt-session-${process.pid}-${Date.now()}.json`);

afterEach(() => {
  if (existsSync(STORE)) rmSync(STORE);
  Object.assign(config, ORIG);
});

describe("normalizeCookieInput", () => {
  it("parses a Cookie-Editor JSON array", () => {
    expect(normalizeCookieInput('[{"name":"SN","value":"abc"},{"name":"T","value":"1"}]')).toEqual([
      { name: "SN", value: "abc" },
      { name: "T", value: "1" },
    ]);
  });

  it("parses an object map", () => {
    expect(normalizeCookieInput('{"SN":"abc","T":"1"}')).toEqual([
      { name: "SN", value: "abc" },
      { name: "T", value: "1" },
    ]);
  });

  it("parses a raw header string", () => {
    expect(normalizeCookieInput("SN=abc; T=1")).toEqual([
      { name: "SN", value: "abc" },
      { name: "T", value: "1" },
    ]);
  });

  it("throws CONFIG_ERROR on invalid JSON and empty input", () => {
    expect(() => normalizeCookieInput("[oops")).toThrow(AppError);
    try {
      normalizeCookieInput("[oops");
    } catch (err) {
      expect((err as AppError).code).toBe("CONFIG_ERROR");
    }
    expect(() => normalizeCookieInput("   ")).toThrow(AppError);
  });
});

describe("toCookieHeader", () => {
  it("joins name=value by '; ' and skips empty names", () => {
    expect(
      toCookieHeader([
        { name: "SN", value: "abc" },
        { name: "", value: "skip" },
        { name: "T", value: "1" },
      ]),
    ).toBe("SN=abc; T=1");
  });
});

describe("multi-account store", () => {
  it("adds multiple accounts, resolves headers, and lists metadata", () => {
    config.sessionStorePath = STORE;

    addAccount("Seller North", '[{"name":"SN","value":"north"}]');
    const metas = addAccount("Seller South", '{"SN":"south"}');

    expect(metas.map((m) => m.id).sort()).toEqual(["seller-north", "seller-south"]);

    const active = getActiveAccounts();
    expect(active.map((a) => `${a.label}:${a.cookieHeader}`).sort()).toEqual([
      "Seller North:SN=north",
      "Seller South:SN=south",
    ]);
  });

  it("replaces an account re-added under the same label", () => {
    config.sessionStorePath = STORE;

    addAccount("Seller North", '[{"name":"SN","value":"v1"}]');
    const metas = addAccount("Seller North", '[{"name":"SN","value":"v2"},{"name":"X","value":"y"}]');

    expect(metas).toHaveLength(1);
    expect(metas[0].count).toBe(2);
    expect(getActiveAccounts()[0].cookieHeader).toBe("SN=v2; X=y");
  });

  it("removes one account, and clearing all leaves none (no fallback)", () => {
    config.sessionStorePath = STORE;

    addAccount("Seller North", '[{"name":"SN","value":"north"}]');
    addAccount("Seller South", '[{"name":"SN","value":"south"}]');

    let metas = removeAccount("seller-north");
    expect(metas.map((m) => m.id)).toEqual(["seller-south"]);

    metas = clearAllAccounts();
    expect(metas).toEqual([]);
    expect(getActiveAccounts()).toEqual([]);
  });

  it("reports no accounts when nothing has been added", () => {
    config.sessionStorePath = STORE;
    expect(listAccounts()).toEqual([]);
    expect(getActiveAccounts()).toEqual([]);
  });

  it("requires a label when adding", () => {
    config.sessionStorePath = STORE;
    expect(() => addAccount("", '[{"name":"SN","value":"x"}]')).toThrow(AppError);
  });
});
