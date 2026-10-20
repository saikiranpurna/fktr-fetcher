import type { Order } from "@/lib/types";
import { TONE_CHIP, TONE_DOT, type Tone } from "@/lib/ui";
import { StatusBadge } from "./StatusBadge";

const INR = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" });

// "₹1,499.00" for a finite amount; null when the backend has no figure.
function inr(n: number | null | undefined): string | null {
  return typeof n === "number" && Number.isFinite(n) ? INR.format(n) : null;
}

// One date formatter per timezone, shared by every card: a page renders up to 60 cards with several
// dates each, and constructing Intl formatters is the expensive part.
const DATE_FORMATTERS = new Map<string, Intl.DateTimeFormat>();
function dateFormatter(timeZone: string): Intl.DateTimeFormat {
  let fmt = DATE_FORMATTERS.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-IN", {
      timeZone,
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZoneName: "short",
    });
    DATE_FORMATTERS.set(timeZone, fmt);
  }
  return fmt;
}

type Moment = { iso: string; short: string; full: string };

// A timestamp rendered in the dashboard's timezone: compact "2 Jul, 01:30" for the card, and the
// full "2 Jul 2026, 01:30 IST" for the tooltip. Assembled from formatToParts so locale punctuation
// can't drift. null for a missing or unparseable timestamp.
function moment(iso: string | null | undefined, timeZone: string): Moment | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const p: Partial<Record<Intl.DateTimeFormatPartTypes, string>> = {};
  for (const part of dateFormatter(timeZone).formatToParts(d)) p[part.type] = part.value;
  return {
    iso: d.toISOString(),
    short: `${p.day} ${p.month}, ${p.hour}:${p.minute}`,
    full: `${p.day} ${p.month} ${p.year}, ${p.hour}:${p.minute} ${p.timeZoneName}`,
  };
}

function When({ at }: { at: Moment }) {
  return (
    <time dateTime={at.iso} title={at.full} className="tabular-nums">
      {at.short}
    </time>
  );
}

type LifecycleEntry = { key: string; label: string; tone: Tone; at: Moment | null };

// Cancel / replacement / refund events for the compact history list, in lifecycle order. Each entry
// needs its own date, except the refund, which shows whenever any refund fact (amount, status or
// date) exists, because an initiated refund may not carry every field yet.
function lifecycle(o: Order, timeZone: string): LifecycleEntry[] {
  const out: LifecycleEntry[] = [];
  const dated = (key: string, label: string, tone: Tone, iso: string | null | undefined) => {
    const at = moment(iso, timeZone);
    if (at) out.push({ key, label, tone, at });
  };
  dated("cancelled", "Cancelled", "error", o.cancelledDateIso);
  dated("replacement", "Replacement requested", "info", o.replacementDateIso);
  dated("replacement-delivered", "Replacement delivered", "ok", o.replacementDeliveredDateIso);
  dated("replacement-cancelled", "Replacement cancelled", "error", o.replacementCancelledDateIso);

  const refunded = typeof o.refundAmount === "number" && o.refundAmount > 0 ? inr(o.refundAmount) : null;
  if (refunded || o.refundStatus || o.refundDateIso) {
    out.push({
      key: "refund",
      label: ["Refund", refunded, o.refundStatus].filter(Boolean).join(" "),
      tone: o.refundStatus === "completed" ? "ok" : o.refundStatus === "initiated" ? "pending" : "neutral",
      at: moment(o.refundDateIso, timeZone),
    });
  }
  return out;
}

export function OrderCard({ order, timezone = "Asia/Kolkata" }: { order: Order; timezone?: string }) {
  const paid = inr(order.pricePaid);
  // Delivered beats Expected. A cancelled shipment is never "expected", so its promise date is
  // left to the CSV rather than shown as if it were still coming.
  const delivered = moment(order.deliveredDateIso, timezone);
  const expected = order.status === "CANCELLED" ? null : moment(order.expectedDateIso, timezone);
  const eta = delivered
    ? { label: "Delivered", at: delivered }
    : expected
      ? { label: "Expected", at: expected }
      : null;
  const events = lifecycle(order, timezone);

  return (
    <article className="flex flex-col gap-3 rounded-xl border border-black/10 bg-white p-4 shadow-sm dark:border-white/15 dark:bg-neutral-900">
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-base font-bold text-neutral-900 dark:text-neutral-100">
            {order.customerName}
          </span>
          <span className="font-mono text-[11px] text-neutral-500 dark:text-neutral-400">{order.orderId}</span>
          {order.trackingId && (
            <span className="font-mono text-[11px] text-neutral-500 dark:text-neutral-400">
              {order.trackingId}
            </span>
          )}
        </div>
        <StatusBadge status={order.status} />
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <span className="inline-flex w-fit items-center rounded-md bg-neutral-100 px-2 py-0.5 text-xs font-medium text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">
          {order.account}
        </span>
        {/* A replacement shipment has its own row; this links it back to the original shipment. */}
        {order.replacementOf && (
          <span
            className={`inline-flex min-w-0 items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${TONE_CHIP.info}`}
          >
            Replacement of <span className="truncate font-mono">{order.replacementOf}</span>
          </span>
        )}
      </div>

      <div className="space-y-1">
        <p className="text-sm text-neutral-700 dark:text-neutral-300">{order.itemName}</p>
        {(paid || eta) && (
          <p className="flex flex-wrap gap-x-3 gap-y-0.5 text-sm text-neutral-600 dark:text-neutral-300">
            {paid && (
              <span>
                Paid{" "}
                <span className="font-semibold tabular-nums text-neutral-900 dark:text-neutral-100">{paid}</span>
              </span>
            )}
            {eta && (
              <span>
                {eta.label} <When at={eta.at} />
              </span>
            )}
          </p>
        )}
        <p className="break-words text-sm text-neutral-500 dark:text-neutral-400">{order.deliveryAddress}</p>
        {order.phone && (
          <p className="text-sm text-neutral-600 dark:text-neutral-300">Mobile: {order.phone}</p>
        )}
        {/* Only "failed" earns a note: "skipped" is routine (not targeted), and "ok" with empty
            fields genuinely means "none". */}
        {order.detailStatus === "failed" && (
          <p
            className="text-xs font-medium text-amber-700 dark:text-amber-400"
            title="The shipment detail lookup failed: address, mobile, OTP, GSTIN and cancel/replacement/refund info may be missing."
          >
            Details unavailable
          </p>
        )}
      </div>

      {events.length > 0 && (
        <ul
          aria-label="Shipment history"
          className="space-y-1 rounded-lg border border-black/10 px-3 py-2 text-xs text-neutral-700 dark:border-white/10 dark:text-neutral-300"
        >
          {events.map((e) => (
            <li key={e.key} className="flex items-center gap-2">
              <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${TONE_DOT[e.tone]}`} />
              <span className="min-w-0 flex-1">{e.label}</span>
              {e.at && (
                <span className="shrink-0 text-neutral-500 dark:text-neutral-400">
                  <When at={e.at} />
                </span>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="mt-auto rounded-lg bg-neutral-100 px-3 py-2 dark:bg-neutral-800">
        <span className="block text-[11px] font-medium uppercase tracking-wide text-neutral-600 dark:text-neutral-400">
          OTP
        </span>
        <span className="font-mono text-2xl font-extrabold tracking-widest text-neutral-900 dark:text-neutral-50">
          {order.otp ?? (
            <>
              <span aria-hidden>—</span>
              <span className="sr-only">unavailable</span>
            </>
          )}
        </span>
      </div>
    </article>
  );
}
