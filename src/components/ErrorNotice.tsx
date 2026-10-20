import type { ErrorCode } from "@/lib/types";
import { errorHeading } from "@/lib/ui";

export function ErrorNotice({ code, message }: { code: ErrorCode; message: string }) {
  // Heading from the shared operator-facing text (never the raw enum), capitalised as a title.
  return (
    <div
      role="alert"
      className="rounded-lg border border-red-300 bg-red-50 p-4 text-red-800 dark:border-red-500/40 dark:bg-red-950/40 dark:text-red-200"
    >
      <p className="text-sm font-semibold">{errorHeading(code)}</p>
      <p className="mt-1 text-sm">{message}</p>
    </div>
  );
}
