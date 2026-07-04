import { config } from "../config";
import { BrowserFlipkartClient } from "./browser-client";
import { HttpFlipkartClient, type FlipkartClient } from "./client";

export type { FlipkartClient, RawResult } from "./client";

// "browser" (default) renders My Orders in headless Chromium; "http" replays a
// known orders JSON endpoint directly.
export function getFlipkartClient(): FlipkartClient {
  return config.fetchMode === "http" ? new HttpFlipkartClient() : new BrowserFlipkartClient();
}
