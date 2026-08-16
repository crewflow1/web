import "server-only";

import {
  getAccountingImportAdapter,
  type AccountingPullInput,
  type AccountingProvider,
} from "@/lib/integrations/accounting/adapters";
import { resolveProviderAccess } from "@/server/services/accounting-connections";
import {
  normaliseContact,
  normaliseInvoice,
  type NormalisedConnectorRow,
} from "@/lib/imports/connector-normalise";

/**
 * Direct-API import (PULL) service — the composition that turns a connected
 * bookkeeping account into staged import rows.
 *
 * WHAT IT DOES. Given an org + provider (Xero / QuickBooks), it pulls the account's
 * contacts (and optionally its sales invoices) through the credential-gated PULL
 * adapter and normalises each one into the SAME `mapped` shape a spreadsheet row
 * produces. The caller (the imports server action) stages those rows as
 * `import_rows` and runs them through the EXISTING preview → dedupe → commit
 * pipeline — this service duplicates none of it.
 *
 * DARK — REFUSE BEFORE FETCH. The adapter's `isAvailable()` (feature flag +
 * client credentials) is checked as the FIRST statement, BEFORE any token read or
 * network call, so a dark provider returns `skipped_dark` having touched neither
 * the connection secrets nor the provider. Even past that guard, each adapter
 * re-checks `isAvailable()` before its single `fetch`, so the dark path is
 * structural, not merely early-returned.
 *
 * ORG SCOPING. The access token + provider handle come from `resolveProviderAccess`
 * for the caller-supplied ACTIVE org only, so a pull can only ever read the org's
 * OWN connected book — never another tenant's.
 */

export type ConnectorPullResult =
  | {
      status: "ok";
      rows: NormalisedConnectorRow[];
      counts: { contacts: number; invoices: number };
    }
  | { status: "skipped_dark"; message: string }
  | { status: "error"; message: string };

export type PullOptions = {
  /** Also pull sales invoices (in addition to contacts). Default false. */
  includeInvoices?: boolean;
};

export async function pullFromAccountingProvider(
  orgId: string,
  provider: AccountingProvider,
  opts: PullOptions = {},
): Promise<ConnectorPullResult> {
  const adapter = getAccountingImportAdapter(provider);

  // REFUSE BEFORE FETCH. Dark ⇒ no token read, no network — an honest skip.
  if (!adapter.isAvailable()) {
    return {
      status: "skipped_dark",
      message: `${provider} is not connected; nothing was pulled. Connect the account to enable direct import.`,
    };
  }

  // ── LIVE PATH (unreachable dark) ───────────────────────────────────────────
  const access = await resolveProviderAccess(orgId, provider);
  if (!access.ok) return { status: "error", message: access.message };

  const base: AccountingPullInput = {
    accessToken: access.access.accessToken,
    tenantId: access.access.tenantId,
    realmId: access.access.realmId,
    refresh: access.access.refresh,
  };

  const contactsRes = await adapter.pullContacts(base);
  if (!contactsRes.ok) {
    return {
      status: contactsRes.reason === "unavailable" ? "skipped_dark" : "error",
      message: contactsRes.message,
    };
  }
  const rows: NormalisedConnectorRow[] = contactsRes.items.map((c) =>
    normaliseContact(provider, c),
  );

  let invoiceCount = 0;
  if (opts.includeInvoices) {
    const invoicesRes = await adapter.pullInvoices(base);
    if (!invoicesRes.ok) {
      return {
        status: invoicesRes.reason === "unavailable" ? "skipped_dark" : "error",
        message: invoicesRes.message,
      };
    }
    invoiceCount = invoicesRes.items.length;
    for (const inv of invoicesRes.items) rows.push(normaliseInvoice(provider, inv));
  }

  return {
    status: "ok",
    rows,
    counts: { contacts: contactsRes.items.length, invoices: invoiceCount },
  };
}
