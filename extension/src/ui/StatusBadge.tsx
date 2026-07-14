import { STATUS_LABELS, type OrderStatus } from "@core/types";

const CLASS: Record<OrderStatus, string> = {
  OUT_FOR_DELIVERY: "bg-amber-100 text-amber-800 ring-amber-300",
  DELIVERED: "bg-green-100 text-green-800 ring-green-300",
  ARRIVING: "bg-blue-100 text-blue-800 ring-blue-300",
  CANCELLED: "bg-red-100 text-red-800 ring-red-300",
  OTHER: "bg-gray-100 text-gray-700 ring-gray-300",
};

export function StatusBadge({ status }: { status: OrderStatus }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ring-inset ${CLASS[status]}`}
    >
      {STATUS_LABELS[status]}
    </span>
  );
}
