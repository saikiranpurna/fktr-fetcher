import { STATUS_LABELS, type OrderStatus } from "@/lib/types";
import { TONE_CHIP, type Tone } from "@/lib/ui";

// Order status -> shared tone (dark-mode-safe via TONE_CHIP). Out-for-delivery is the amber
// "act now" state, delivered is green, arriving is informational blue, everything else neutral.
const TONE_BY_STATUS: Record<OrderStatus, Tone> = {
  OUT_FOR_DELIVERY: "pending",
  DELIVERED: "ok",
  ARRIVING: "info",
  CANCELLED: "error",
  OTHER: "neutral",
};

export function StatusBadge({ status }: { status: OrderStatus }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ring-inset ${TONE_CHIP[TONE_BY_STATUS[status]]}`}
    >
      {STATUS_LABELS[status]}
    </span>
  );
}
