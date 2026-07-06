import { describe, it, expect } from "vitest";
import { enrichDetails } from "../background/enrich";
import { ordersArray } from "../core/parser";
import type { FetchLike } from "../background/flipkart";
import page1 from "../__fixtures__/orders-page1.json";
import detailOfd from "../__fixtures__/detail-ofd.json";

function stub(body: unknown, status = 200): FetchLike {
  return async () => ({ status, json: async () => body });
}

describe("enrichDetails", () => {
  it("targets active units plus one address-only per inactive order, and reports total", async () => {
    const raw = ordersArray(page1) ?? [];
    let seenTotal = 0;
    const details = await enrichDetails(
      raw,
      (_done, total) => {
        seenTotal = total;
      },
      stub(detailOfd),
    );
    // order1 (OFD, active) + order2 (arriving, active) + order3 (delivered -> address-only) = 3
    expect(seenTotal).toBe(3);
    expect(Object.keys(details).sort()).toEqual([
      "OD100000000000000001",
      "OD100000000000000002",
      "OD100000000000000003",
    ]);
  });
});
