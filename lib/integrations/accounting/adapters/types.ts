/**
 * Accounting export — the provider ADAPTER seam.
 *
 * The CSV path (lib/integrations/accounting/csv.ts) needs no credentials and
 * ships live. The API push to a bookkeeping package does: it is a DARK seam
 * behind each provider's OAuth. This file defines the contract every provider
 * satisfies, so activation is only ever "supply the credentials + flag", never a
 * code change to the export pipeline.
 *
 * THE DARK-BY-DEFAULT INVARIANT. An adapter reports `isAvailable()` false
 * whenever the connect substrate is not connectable for it (flag off OR client
 * credentials absent) — which is ALWAYS, today. When unavailable,
 * `pushInvoices` / `pushPayments` MUST return an `unavailable` result WITHOUT
 * constructing a client and WITHOUT making any network request. A provider is
 * never contacted without credentials; the single `fetch` per push lives
 * strictly AFTER the `isAvailable()` guard, so it is structurally unreachable
 * dark. The security suite proves this against the adapter source.
 *
 * TOKENS COME FROM THE CONNECTION, NOT THE ENV. A push acts on ONE org's
 * connected book, so the per-org access token + provider handle (Xero tenant id /
 * QBO realm id) are resolved from `accounting_connections` (service-role read of
 * the encrypted token columns) and handed in via {@link AccountingPushInput}.
 * The adapter itself holds no per-tenant env — only the OAuth CLIENT credentials
 * gate `isAvailable()`.
 */

import type { CanonicalAccountingRow } from "../canonical";

export type AccountingProvider = "xero" | "quickbooks";

/**
 * Everything an adapter needs to push ONE org's rows to its connected book —
 * resolved (and DECRYPTED) by the connections service only AFTER the connectable
 * guard, so none of this exists on the dark path.
 */
export type AccountingPushInput = {
  /** The canonical rows to push (invoices for pushInvoices, payments for pushPayments). */
  rows: readonly CanonicalAccountingRow[];
  /** DECRYPTED access token for the connected org. */
  accessToken: string;
  /** Xero tenant id — required by the `Xero-tenant-id` header. Null for QBO. */
  tenantId?: string | null;
  /** QBO realm id — the company path segment. Null for Xero. */
  realmId?: string | null;
  /**
   * Refresh-and-persist callback. On a provider 401 the adapter calls this ONCE
   * to obtain a fresh DECRYPTED access token; the callback owns the real refresh
   * (provider token endpoint) AND the encrypted persistence of the new tokens.
   * Returns the new access token, or null when refresh is impossible (no refresh
   * token / the refresh itself failed) — in which case the adapter does NOT retry.
   */
  refresh: () => Promise<string | null>;
};

/**
 * ONE invoice the push SKIPPED (never a whole-batch abort) — its number plus why.
 * The only skip cause today is an unmappable VAT rate (a rate outside {0,5,20},
 * which has no honest Xero TaxType / QBO VAT code): that ONE invoice is dropped
 * from the push and surfaced loudly here so the operator learns exactly which
 * invoice to fix, while every postable invoice in the same batch still syncs.
 * This is the C61 per-row-isolation posture on the accounting-push surface — a
 * single poison row can never zero the whole org's push.
 */
export type SkippedInvoice = { invoiceNumber: string; reason: string };

/**
 * Is this provider HTTP status a PERMANENT per-row rejection — the provider looked
 * at THIS row's data and will NEVER accept it on retry (e.g. 400 rejected field,
 * 422 validation / duplicate DocNumber, archived contact)? Such a row is ISOLATED
 * (skipped + surfaced loudly), NEVER a whole-batch abort, and stays UNRECORDED in
 * the push-once ledger so a corrected row retries on a later sync.
 *
 * THE DEFECT THIS CLOSES (C73-C, a C61/C67-B sibling). The per-row isolation
 * invariant used to cover only MAP-TIME skips (an unmappable VAT rate). A provider
 * REJECTION (HTTP non-2xx) aborted the whole run mid-loop, so a single
 * permanently-rejected invoice created EARLIER than the rest re-aborted before
 * every later invoice on EVERY sync — silently stranding the entire tail forever
 * while the connection read "connected". A 400/422 is a verdict on ONE row; it
 * must isolate that row, not the batch.
 *
 * THE COMPLEMENT — TRANSIENT / whole-connection failures worth aborting-and-
 * retrying the ENTIRE run — is everything else, and is deliberately NOT a per-row
 * skip:
 *   • 5xx  — provider server error; retry the whole run.
 *   • 429  — rate limit; back off and retry the whole run.
 *   • network error (status 0) — transport blip; retry.
 *   • 401  — token/auth. Handled by the shared refresh-retry; a 401 that SURVIVES
 *            refresh is a whole-run auth failure, NOT a per-row verdict. Skipping
 *            it would silently strand EVERY row as "skipped" while the connection
 *            still read connected — the exact failure mode we are closing.
 *   • 403  — scope/permission on the connection (reconnect with the right scope),
 *            not a rejection of one row's data.
 *   • 404  — wrong endpoint / missing target (a whole-run misconfiguration); also
 *            the code Xero returns for a payment whose invoice is absent, which
 *            must SELF-HEAL by retrying next sync, never be marked skipped-forever.
 *
 * Keeping 401/403/404 as aborts also preserves the PRE-EXISTING behaviour for
 * those codes: the only behaviour this predicate CHANGES is for the codes that are
 * unambiguously a permanent verdict on one row's data (400, 402, 405–428, 430–499,
 * and notably 422).
 */
export function isPermanentRowRejection(status: number): boolean {
  return (
    status >= 400 &&
    status < 500 &&
    status !== 401 &&
    status !== 403 &&
    status !== 404 &&
    status !== 429
  );
}

/**
 * The outcome of a push attempt.
 *   - ok               — rows accepted by the provider (unreachable today).
 *   - unavailable      — credentials absent; nothing was sent (the dark path).
 *   - error            — credentials present but the push failed (a TRANSPORT
 *                        failure — never a single bad-VAT-rate invoice, which is
 *                        a per-invoice SKIP, not a batch abort).
 *
 * `pushed` on the ERROR variant is the count the provider ACCEPTED before the
 * failure. `pushedSourceIds` / `pushedInvoiceNumbers` are the EXPLICIT identities
 * of the accepted invoices/payments — the caller records exactly these in the
 * push-once ledger and feeds the accepted invoice numbers to the payment-link
 * gate. They are the authoritative accepted set: an input-order prefix count is
 * NOT enough once a mid-batch invoice can be SKIPPED (an unmappable rate leaves a
 * hole, so the accepted set is no longer a contiguous prefix). `skipped` names the
 * invoices dropped for an unmappable VAT rate — surfaced loudly, never recorded,
 * never an error.
 */
export type AccountingPushResult =
  | {
      ok: true;
      provider: AccountingProvider;
      pushed: number;
      /** Immutable source ids the provider accepted (for the push-once ledger). */
      pushedSourceIds?: readonly string[];
      /** invoice_numbers the provider accepted (for the payment-link gate). */
      pushedInvoiceNumbers?: readonly string[];
      /** Invoices skipped for an unmappable VAT rate. Surfaced loudly; never recorded. */
      skipped?: readonly SkippedInvoice[];
    }
  | {
      ok: false;
      provider: AccountingProvider;
      reason: "unavailable" | "error";
      message: string;
      /** Rows the provider accepted before the failure. Default 0. */
      pushed?: number;
      /** Immutable source ids accepted before the failure (for the push-once ledger). */
      pushedSourceIds?: readonly string[];
      /** invoice_numbers accepted before the failure (for the payment-link gate). */
      pushedInvoiceNumbers?: readonly string[];
      /** Invoices skipped for an unmappable VAT rate before the failure. */
      skipped?: readonly SkippedInvoice[];
    };

export interface AccountingAdapter {
  readonly provider: AccountingProvider;
  /**
   * True only when this build has the provider's OAuth credentials. A pure
   * env check — no network, never throws. Drives readiness and the UI's
   * connected/coming-soon state.
   */
  isAvailable(): boolean;
  /** Push invoice (sale) rows. Returns `unavailable` — no network — when dark. */
  pushInvoices(input: AccountingPushInput): Promise<AccountingPushResult>;
  /** Push payment (receipt) rows. Returns `unavailable` — no network — when dark. */
  pushPayments(input: AccountingPushInput): Promise<AccountingPushResult>;
}

/** The `unavailable` result — the ONLY outcome the dark path may produce. */
export function unavailable(
  provider: AccountingProvider,
  message: string,
): AccountingPushResult {
  return { ok: false, provider, reason: "unavailable", message };
}

// ───────────────────────────────────────────────────────────────────────────
// IMPORT (PULL) SEAM — the INVERSE of the push adapter.
//
// The push adapter sends CrewFlow finance OUT to a bookkeeping package. The pull
// adapter reads a connected book's customers/contacts (and optionally invoices)
// IN, so the Migration OS can seed a new CrewFlow org straight from the account's
// existing data via the SAME import preview → dedupe → commit pipeline (the
// normalised rows are staged as `import_rows`; nothing is written to a live table
// until the operator commits).
//
// DARK BY THE SAME TWO-SWITCH GATE. `isAvailable()` is `isProviderConnectable`
// (feature flag + client credentials) — false ALWAYS today. Every pull method
// REFUSES with `pullUnavailable` as its FIRST statement when dark, so the single
// `fetch` per page is structurally unreachable without credentials. The per-org
// access token + provider handle (Xero tenant id / QBO realm id) arrive on
// {@link AccountingPullInput}, resolved by the connections service from the
// encrypted connection row — exactly like the push path. No new provider secret.
// ───────────────────────────────────────────────────────────────────────────

/**
 * Everything an adapter needs to PULL ONE org's data from its connected book —
 * resolved (and DECRYPTED) by the connections service only AFTER the connectable
 * guard, so none of this exists on the dark path. Mirrors AccountingPushInput
 * minus the rows.
 */
export type AccountingPullInput = {
  /** DECRYPTED access token for the connected org. */
  accessToken: string;
  /** Xero tenant id — required by the `Xero-tenant-id` header. Null for QBO. */
  tenantId?: string | null;
  /** QBO realm id — the company path segment. Null for Xero. */
  realmId?: string | null;
  /**
   * Refresh-and-persist callback. On a provider 401 the adapter calls this ONCE
   * to obtain a fresh DECRYPTED access token, then retries; null means refresh is
   * impossible and the pull surfaces the auth failure (never a silent empty pull).
   */
  refresh: () => Promise<string | null>;
};

/** ONE contact/customer pulled from a connected book. Provider-agnostic. */
export type PulledContact = {
  /** The provider's immutable id (Xero ContactID / QBO Customer.Id) — provenance. */
  sourceId: string;
  /** Display / company name. "" only when the provider row has none. */
  name: string;
  email: string | null;
  phone: string | null;
  addressLine1: string | null;
  city: string | null;
  postcode: string | null;
};

/** ONE sales invoice (ACCREC) pulled from a connected book. Provider-agnostic. */
export type PulledInvoice = {
  /** The provider's immutable id (Xero InvoiceID / QBO Invoice.Id) — provenance. */
  sourceId: string;
  /** The human invoice number (Xero InvoiceNumber / QBO DocNumber). "" when absent. */
  number: string;
  /** The bill-to customer name, or "" when the provider did not resolve one. */
  customerName: string;
  /** Ex-VAT net, fixed 2dp string. */
  net: string;
  /** VAT amount, fixed 2dp string. */
  vat: string;
  /** Gross amount, fixed 2dp string. */
  gross: string;
  /**
   * A best-effort CrewFlow-writable status (draft/sent/awaiting_payment/
   * partially_paid/paid). Anything else the import layer normalises to `sent`.
   */
  status: string;
  /** Tax-point / issue date, `YYYY-MM-DD`, or null when the source has none. */
  date: string | null;
};

/**
 * The outcome of a pull.
 *   - ok           — items read from the connected book (may be empty).
 *   - unavailable  — credentials absent; NOTHING was fetched (the dark path).
 *   - error        — credentials present but the pull failed (transport / auth).
 */
export type AccountingPullResult<T> =
  | { ok: true; provider: AccountingProvider; items: readonly T[] }
  | {
      ok: false;
      provider: AccountingProvider;
      reason: "unavailable" | "error";
      message: string;
    };

/** The import (pull) half of a provider adapter. Implemented by the SAME class. */
export interface AccountingImportAdapter {
  readonly provider: AccountingProvider;
  /** Same two-switch gate as the push adapter — a pure env read, no network. */
  isAvailable(): boolean;
  /** Pull every customer/contact. Returns `unavailable` (no network) when dark. */
  pullContacts(
    input: AccountingPullInput,
  ): Promise<AccountingPullResult<PulledContact>>;
  /** Pull every sales invoice. Returns `unavailable` (no network) when dark. */
  pullInvoices(
    input: AccountingPullInput,
  ): Promise<AccountingPullResult<PulledInvoice>>;
}

/** The `unavailable` pull result — the ONLY outcome the dark pull path may produce. */
export function pullUnavailable<T>(
  provider: AccountingProvider,
  message: string,
): AccountingPullResult<T> {
  return { ok: false, provider, reason: "unavailable", message };
}
