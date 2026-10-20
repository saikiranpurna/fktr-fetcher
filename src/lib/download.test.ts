import { afterEach, describe, expect, it, vi } from "vitest";
import { saveBlob } from "./download";

describe("saveBlob", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("clicks a temporary download link and revokes the object URL only later", () => {
    vi.useFakeTimers();
    const revoke = vi.fn();
    // jsdom has no object URLs.
    Object.defineProperty(URL, "createObjectURL", { value: () => "blob:fake", configurable: true });
    Object.defineProperty(URL, "revokeObjectURL", { value: revoke, configurable: true });
    const seen: { href: string; download: string }[] = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      seen.push({ href: this.href, download: this.download });
    });

    saveBlob(new Blob(["%PDF-1.4"]), "invoice-OD1.pdf");

    expect(click).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([{ href: "blob:fake", download: "invoice-OD1.pdf" }]);
    expect(document.querySelector("a")).toBeNull(); // the link is removed again
    expect(revoke).not.toHaveBeenCalled(); // revoking at once can cancel a big download
    vi.advanceTimersByTime(10_000);
    expect(revoke).toHaveBeenCalledWith("blob:fake");
  });
});
