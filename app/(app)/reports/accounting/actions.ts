"use server";

import { revalidatePath } from "next/cache";

import { requireOrgContext } from "@/server/auth/session";
import {
  disconnectAccountingProvider,
  syncToProvider,
} from "@/server/services/accounting-connections";
import type { AccountingProvider } from "@/lib/integrations/accounting/adapters";

/**
 * Accounting provider-push action.
 *
 * The CSV export is a plain GET download (app/api/accounting/export). This
 * action drives the Xero / QuickBooks buttons: it gates the caller (admin) and
 * delegates to the ONE push composition, `syncToProvider`, which resolves the
 * org's connection tokens (service-role), refreshes when needed, and pushes the
 * canonical rows through the provider adapter.
 *
 * DARK: while a provider is not connectable (flag off / no OAuth credentials —
 * ALWAYS today) `syncToProvider` refuses BEFORE any network call, records a
 * `skipped_dark` audit row, and returns an honest "not connected" — never a fake
 * success and never a live API call. On activation (credentials + flag) the SAME
 * path performs the real push with no further code change.
 *
 * AUTHORISATION IS DOUBLED. The role check produces a sentence for the operator;
 * the admin-write RLS on accounting_export_log is the real boundary for the log
 * insert. Org-pinned throughout. Route depth is 1 (`/reports`), so no server
 * navigation is performed — the action returns state the client renders inline.
 */

export type AccountingPushState = {
  ok: boolean;
  message: string;
  provider?: AccountingProvider;
};

function isAdminRole(role: string): boolean {
  return role === "owner" || role === "admin";
}

export async function requestAccountingPush(
  _prev: AccountingPushState | null,
  formData: FormData,
): Promise<AccountingPushState> {
  const providerRaw = String(formData.get("provider") ?? "");
  if (providerRaw !== "xero" && providerRaw !== "quickbooks") {
    return { ok: false, message: "Unknown accounting provider." };
  }
  const provider = providerRaw as AccountingProvider;

  const { ctx, user } = await requireOrgContext();
  if (!isAdminRole(ctx.membership.role)) {
    return {
      ok: false,
      provider,
      message: "Only an owner or admin may push to an accounting provider.",
    };
  }

  // ONE push composition. Dark ⇒ refuses before any network call and records
  // skipped_dark; live (activation) ⇒ resolves tokens, refreshes, pushes.
  const result = await syncToProvider(ctx.org.id, provider, user.id);
  if (result.status === "skipped_dark") {
    return {
      ok: false,
      provider,
      message:
        provider === "xero"
          ? "Xero is not connected yet. Use CSV export today; API push activates once Xero OAuth is configured."
          : "QuickBooks is not connected yet. Use CSV export today; API push activates once QuickBooks OAuth is configured.",
    };
  }
  return { ok: result.ok, provider, message: result.message };
}

/**
 * Disconnect an accounting provider — the admin action that wires the panel's
 * "Disconnect" control to `disconnectAccountingProvider`. Clears the tokens +
 * account handle and returns the row to `disconnected`.
 *
 * AUTHORISATION IS DOUBLED. The role check here refuses a non-admin loudly; the
 * admin-write RLS on accounting_connections (20261095) is the real boundary for
 * the UPDATE, which runs under the caller's JWT. Org-pinned via ctx.org.id.
 * LOUD: a failed disconnect throws rather than silently reporting success.
 *
 * A plain form-action (FormData → void) so the panel needs no client JS; on
 * success the page is revalidated so the connected state disappears.
 */
export async function disconnectAccountingConnection(
  formData: FormData,
): Promise<void> {
  const providerRaw = String(formData.get("provider") ?? "");
  if (providerRaw !== "xero" && providerRaw !== "quickbooks") {
    throw new Error("Unknown accounting provider.");
  }
  const provider = providerRaw as AccountingProvider;

  const { ctx } = await requireOrgContext();
  if (!isAdminRole(ctx.membership.role)) {
    throw new Error(
      "Only an owner or admin may disconnect an accounting provider.",
    );
  }

  const res = await disconnectAccountingProvider(ctx.org.id, provider);
  if (!res.ok) {
    throw new Error(res.error ?? "Disconnect failed.");
  }

  revalidatePath("/reports");
}
