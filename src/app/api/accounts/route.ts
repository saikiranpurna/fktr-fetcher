import { config } from "@/lib/config";
import { AppError, configError, toErrorResponse } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { addAccount, clearAllAccounts, listAccounts, removeAccount } from "@/lib/session/store";
import type { AccountsResponse, ErrorResponse } from "@/lib/types";

export const runtime = "nodejs";

const adminRequired: ErrorResponse = {
  ok: false,
  error: { code: "AUTH_EXPIRED", message: "Admin token required." },
};

// Returns a Response (401) when the admin token is required and missing/wrong, else null.
function requireAdmin(req: Request): Response | null {
  if (!config.adminToken) return null;
  if (req.headers.get("x-admin-token") === config.adminToken) return null;
  return Response.json(adminRequired, { status: 401 });
}

export async function GET() {
  return Response.json({ accounts: listAccounts() } satisfies AccountsResponse);
}

export async function POST(req: Request) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  try {
    const body = (await req.json().catch(() => null)) as { label?: unknown; cookie?: unknown } | null;
    const label = typeof body?.label === "string" ? body.label : "";
    const cookie = typeof body?.cookie === "string" ? body.cookie : "";
    if (!cookie.trim()) throw configError("Request body must include a non-empty 'cookie' string.");
    const accounts = addAccount(label, cookie);
    return Response.json({ accounts } satisfies AccountsResponse);
  } catch (err) {
    const { body, status } = toErrorResponse(err);
    if (!(err instanceof AppError)) logger.error("api.accounts.post.fail", { message: String(err) });
    return Response.json(body, { status });
  }
}

export async function DELETE(req: Request) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  const id = new URL(req.url).searchParams.get("id");
  const accounts = id ? removeAccount(id) : clearAllAccounts();
  return Response.json({ accounts } satisfies AccountsResponse);
}
