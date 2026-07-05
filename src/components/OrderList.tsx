import type { Order } from "@/lib/types";
import { OrderCard } from "./OrderCard";

export function OrderList({ orders }: { orders: Order[] }) {
  if (orders.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-black/15 p-10 text-center text-neutral-500 dark:border-white/15 dark:text-neutral-400">
        No orders match the current filters.
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
      {orders.map((order, i) => (
        <OrderCard key={`${order.account}:${order.orderId}:${order.trackingId}:${i}`} order={order} />
      ))}
    </div>
  );
}
