import type { Order } from "@/lib/types";
import { StatusBadge } from "./StatusBadge";

export function OrderCard({ order }: { order: Order }) {
  return (
    <article className="flex flex-col gap-3 rounded-xl border border-black/10 bg-white p-4 shadow-sm dark:border-white/15 dark:bg-neutral-900">
      <div className="flex items-start justify-between gap-2">
        <span className="font-mono text-sm text-neutral-500 dark:text-neutral-400">
          {order.orderId}
        </span>
        <StatusBadge status={order.status} />
      </div>

      <span className="inline-flex w-fit items-center rounded-md bg-neutral-100 px-2 py-0.5 text-xs font-medium text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">
        {order.account}
      </span>

      <div className="space-y-1">
        <p className="text-base font-bold text-neutral-900 dark:text-neutral-100">
          {order.customerName}
        </p>
        <p className="text-sm text-neutral-700 dark:text-neutral-300">{order.itemName}</p>
        <p className="break-words text-sm text-neutral-500 dark:text-neutral-400">
          {order.deliveryAddress}
        </p>
      </div>

      <div className="mt-auto rounded-lg bg-neutral-100 px-3 py-2 dark:bg-neutral-800">
        <span className="block text-[11px] font-medium uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
          OTP
        </span>
        <span
          className="font-mono text-2xl font-extrabold tracking-widest text-neutral-900 dark:text-neutral-50"
          aria-label={order.otp ? `OTP ${order.otp}` : "OTP unavailable"}
        >
          {order.otp ?? "—"}
        </span>
      </div>
    </article>
  );
}
