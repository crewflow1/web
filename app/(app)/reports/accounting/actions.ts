"use server";

import { requireOrgContext } from "@/server/auth/session";
import {
  buildAccountingExport,
  recordAccountingExport,
} from "@/server/services/accounting-export";
import {
  getAccountingAdapter,
  type AccountingProvider,
} from "@/lib/integrations/accounting/adapters";

/**
 * Accounting provider-push action — the DARK path.
 *
 * The CSV export is a plain GET download (app/api/accounting/export). This
 * action drives the Xero / QuickBooks buttons. Because those adapters are
 * credential-less today they push NOTHING: the action resolves the adapter,
 * calls it, sees `unavailable`, and records a `skipped_dark` audit row — an
 * honest "the provider was not contacted because it is not connected", never a
 * fake success and never a live API call.
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

  const adapter = getAccountingAdapter(provider);

  // If the adapter is dark, do NOT build/push — record the skip and return.
  if (!adapter.isAvailable()) {
    await recordAccountingExport({
      orgId: ctx.org.id,
      createdBy: user.id,
      format: provider,
      status: "skipped_dark",
      rowCount: 0,
    });
    return {
      ok: false,
      provider,
      message:
        provider === "xero"
          ? "Xero is not connected yet. Use CSV export today; API push activates once Xero OAuth is configured."
          : "QuickBooks is not connected yet. Use CSV export today; API push activates once QuickBooks OAuth is configured.",
    };
  }

  // Credentialed path (unreachable today). Build the rows and attempt a push;
  // the adapter still makes no live call in this build.
  const { rows } = await buildAccountingExport({ orgId: ctx.org.id });
  const invoiceRows = rows.filter((r) => r.type === "invoice");
  const paymentRows = rows.filter((r) => r.type === "payment");
  const invRes = await adapter.pushInvoices(invoiceRows);
  const payRes = await adapter.pushPayments(paymentRows);

  if (invRes.ok && payRes.ok) {
    await recordAccountingExport({
      orgId: ctx.org.id,
      createdBy: user.id,
      format: provider,
      status: "pushed",
      rowCount: rows.length,
    });
    return { ok: true, provider, message: `Pushed ${rows.length} rows to ${provider}.` };
  }

  const reason = !invRes.ok ? invRes.message : !payRes.ok ? payRes.message : "Push failed.";
  return { ok: false, provider, message: reason };
}
