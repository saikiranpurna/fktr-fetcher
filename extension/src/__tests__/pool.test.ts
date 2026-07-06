import { describe, it, expect } from "vitest";
import { mapPool } from "../background/pool";

describe("mapPool", () => {
  it("preserves input order in the results", async () => {
    const out = await mapPool([1, 2, 3, 4, 5], 2, async (n) => n * 2);
    expect(out).toEqual([2, 4, 6, 8, 10]);
  });

  it("never runs more than `limit` tasks at once", async () => {
    // Deterministic: each task blocks on its own resolver; no wall-clock timers.
    const gates = Array.from({ length: 5 }, () => Promise.withResolvers<void>());
    let active = 0;
    let peak = 0;
    const run = mapPool([0, 1, 2, 3, 4], 2, async (n) => {
      active += 1;
      peak = Math.max(peak, active);
      await gates[n].promise;
      active -= 1;
      return n;
    });
    for (const g of gates) g.resolve();
    await run;
    expect(peak).toBeLessThanOrEqual(2);
  });

  it("returns an empty array for empty input", async () => {
    expect(await mapPool<number, number>([], 4, async (n) => n)).toEqual([]);
  });
});
