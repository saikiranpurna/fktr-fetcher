// Service worker: opens the dashboard tab and, on a RUN_FETCH from the UI, runs the
// full pipeline (fetch orders -> enrich details -> parse), streaming progress back.
import type { Order } from "@core/types";
import { toErrorPayload } from "@flk/core/errors";
import { parseOrders } from "@flk/core/parser";
import type { FromWorker, ToWorker } from "@flk/messaging/protocol";
import { fetchOrders } from "./flipkart";
import { enrichDetails } from "./enrich";

chrome.action.onClicked.addListener(() => {
  void chrome.tabs.create({ url: chrome.runtime.getURL("src/ui/index.html") });
});

chrome.runtime.onConnect.addListener((port) => {
  port.onMessage.addListener((message: ToWorker) => {
    if (message?.type === "RUN_FETCH") void runFetch(port, message.accountLabel);
  });
});

async function runFetch(port: chrome.runtime.Port, accountLabel: string): Promise<void> {
  const send = (m: FromWorker): void => port.postMessage(m);
  try {
    const raw = await fetchOrders();
    send({ type: "PROGRESS", phase: "orders", done: raw.length, total: raw.length });
    const details = await enrichDetails(raw, (done, total) =>
      send({ type: "PROGRESS", phase: "details", done, total }),
    );
    const orders: Order[] = parseOrders(raw, details).map((o) => ({ ...o, account: accountLabel }));
    send({ type: "RESULT", orders, fetchedAt: new Date().toISOString() });
  } catch (err) {
    send({ type: "ERROR", error: toErrorPayload(err) });
  }
}
