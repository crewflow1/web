import "server-only";
import { createHash } from "node:crypto";

import { isProviderConnectable } from "../oauth";
import type {
  AccountingAdapter,
  AccountingImportAdapter,
  AccountingPullInput,
  AccountingPullResult,
  AccountingPushInput,
  AccountingPushResult,
  PulledContact,
  PulledInvoice,
  SkippedInvoice,
} from "./types";
import { isPermanentRowRejection, pullUnavailable, unavailable } from "./types";
import {
  buildSageInvoiceBody,
  buildSagePaymentBody,
  sageSalesTaxRatePercentage,
} from "../provider-payloads";
import {
  assertKnownVatRate,
  effectiveVatRate,
  money2,
  UnknownVatRateError,
  type CanonicalAccountingRow,
} from "../canonical";

/**
 * The reason ONE invoice must be SKIPPED (never a batch abort) for an unmappable
 * VAT rate, or null when every rate the invoice needs is postable (0/5/20).
 * Checked BEFORE any network work so a poison invoice costs no lookups. It is the
 * Sage twin of QBO's `unmappableVatRate`: an unmappable rate has no honest Sage
 * tax rate, so that one invoice is dropped and surfaced loudly rather than
 * stranding the postable tail (the C61 posture on this surface). A genuinely
 * MISSING-but-valid rate id (or a transport error) is NOT a skip — it stays a loud
 * hard error, resolved by resolveTaxRateId below.
 */
function unmappableVatRate(row: CanonicalAccountingRow): string | null {
  try {
    if (row.taxLines && row.taxLines.length > 0) {
      for (const bucket of row.taxLines) {
        assertKnownVatRate(bucket.rate, "Sage sales tax rate");
      }
    } else {
      const vat = Number(row.vat);
      if (Number.isFinite(vat) && vat > 0) {
        // Throws UnknownVatRateError when the header-derived rate isn't 0/5/20.
        effectiveVatRate(Number(row.net || row.gross), vat);
      }
    }
    return null;
  } catch (e) {
    if (e instanceof UnknownVatRateError) return e.message;
    // A reconciliation / arithmetic failure for this one invoice is also a skip
    // (it must not abort the postable rest of the batch).
    return e instanceof Error ? e.message : "unmappable VAT rate";
  }
}

/**
 * Sage Business Cloud Accounting adapter.
 *
 * ── DARK BY DEFAULT ──────────────────────────────────────────────────────────
 * `isAvailable()` is the connect substrate's two-switch gate (feature flag +
 * SAGE_CLIENT_ID/SECRET) via `isProviderConnectable("sage")` — false ALWAYS
 * today. Each push / pull method REFUSES with `unavailable` / `pullUnavailable` as
 * its FIRST statement when dark, so every `fetch` is structurally unreachable
 * without credentials. No Sage SDK import, no client construction; the only
 * network is `fetch`, strictly after the guard.
 *
 * ── ACTIVATION IS CREDENTIALS + FLAG ─────────────────────────────────────────
 * The per-org access token + Sage BUSINESS id arrive on {@link AccountingPushInput}
 * (the business id rides on `tenantId`, resolved by the connections service from
 * the encrypted connection row and sent as the `X-Business` header — the twin of
 * Xero's tenant id). Set SAGE_CLIENT_ID + SAGE_CLIENT_SECRET and flip
 * FEATURE_ACCOUNTING_CONNECT and this adapter posts real invoices / receipts.
 * Sage cannot resolve a contact / ledger account / tax rate inline by name, so —
 * like QBO — this adapter resolves (querying, creating the contact when absent)
 * the contact id, a sales ledger account id and a tax rate id before each create.
 * The one activation precondition beyond credentials is that the Sage business has
 * a sales ledger account and a bank account (or that SAGE_SALES_LEDGER_ACCOUNT_ID
 * / SAGE_BANK_ACCOUNT_ID pin them explicitly).
 *
 * ── REFRESH ──────────────────────────────────────────────────────────────────
 * A 401 on ANY call triggers ONE token refresh (the input's `refresh` callback)
 * and a retry with the new token, shared across the multi-call push via a small
 * mutable auth context — identical to the QBO adapter's AuthCtx.
 *
 * ── IDEMPOTENCY ──────────────────────────────────────────────────────────────
 * The AUTHORITATIVE push-once guard is the ledger (accounting_pushed_entities),
 * exactly as for Xero / QBO. Sage's own API exposes no dedupe key, so as
 * defence-in-depth every create carries a STABLE `Idempotency-Key` header seeded
 * by the immutable CrewFlow row id (`sourceId`) — identical across every sync that
 * re-pushes the same row, and DISTINCT for two different rows even when their
 * bodies are byte-identical (e.g. two same-day, same-amount part-payments). The
 * key is harmless if Sage ignores it and protective if it honours it; either way
 * it is never body-seeded, so it can never collapse a legitimate second payment
 * into a replay of the first. Mirrors Xero's per-entity Idempotency-Key.
 */

const DEFAULT_SAGE_API = "https://api.accounting.sage.com/v3.1";

/** Sage's stable base transaction type id for a customer receipt. */
const CUSTOMER_RECEIPT = "CUSTOMER_RECEIPT";
/** Sage's stable base contact type id for a customer. */
const CUSTOMER_CONTACT_TYPE = "CUSTOMER";

function sageBase(): string {
  return process.env.SAGE_API_BASE_URL?.trim() || DEFAULT_SAGE_API;
}

/**
 * Stable idempotency key for ONE entity (<=64 chars). Seeded by the immutable
 * CrewFlow row id (`sourceId`) when present, else the request body as a
 * deterministic fallback. Seeding by the row id — NOT a hash of the body — is what
 * makes a genuine re-push of the SAME row reuse the SAME key, while two DISTINCT
 * rows that serialise to a byte-identical body get DISTINCT keys and both create.
 */
function idempotencyKey(kind: string, businessId: string, seed: string): string {
  const h = createHash("sha256")
    .update(`${kind}:${businessId}:${seed}`)
    .digest("hex");
  return `crewflow-sage-${kind}-${h.slice(0, 40)}`;
}

type AuthCtx = {
  token: string;
  businessId: string;
  refreshed: boolean;
  refresh: () => Promise<string | null>;
};

type JsonResult = {
  ok: boolean;
  status: number;
  json?: unknown;
  networkError?: string;
};

/** Sage caps a page at 200; page with page/items_per_page. */
const SAGE_PAGE_SIZE = 100;
const SAGE_MAX_PAGES = 1000;

export class SageAdapter implements AccountingAdapter, AccountingImportAdapter {
  readonly provider = "sage" as const;

  isAvailable(): boolean {
    return isProviderConnectable(this.provider);
  }

  // ── IMPORT (PULL) ──────────────────────────────────────────────────────────

  /**
   * Pull every contact from the connected Sage business, F-1 paginated
   * (page/items_per_page). DARK GUARD FIRST — no credentials / flag off ⇒
   * `unavailable`, no network.
   */
  async pullContacts(
    input: AccountingPullInput,
  ): Promise<AccountingPullResult<PulledContact>> {
    return this.pullPaged<PulledContact>(input, "contacts", (json) => {
      const list = sageItems(json);
      return list.map((c) => {
        const obj = c as SageContact;
        const addr = firstSageAddress(obj.addresses) ?? obj.main_address;
        return {
          sourceId: str(obj.id),
          name: str(obj.name ?? obj.displayed_as),
          email: nonEmpty(obj.email),
          phone: nonEmpty(obj.telephone ?? obj.mobile),
          addressLine1: nonEmpty(addr?.address_line_1),
          city: nonEmpty(addr?.city),
          postcode: nonEmpty(addr?.postal_code),
        };
      });
    });
  }

  /**
   * Pull every sales invoice from the connected Sage business, F-1 paginated.
   * Sage `sales_invoices` are always sales (the AR document), so no type filter is
   * needed. DARK GUARD FIRST — no credentials / flag off ⇒ `unavailable`, no
   * network.
   */
  async pullInvoices(
    input: AccountingPullInput,
  ): Promise<AccountingPullResult<PulledInvoice>> {
    return this.pullPaged<PulledInvoice>(input, "sales_invoices", (json) => {
      const list = sageItems(json);
      return list.map((c) => {
        const obj = c as SageInvoice;
        const net = num(obj.net_amount);
        const vat = num(obj.tax_amount);
        const gross =
          obj.total_amount !== undefined && obj.total_amount !== null
            ? num(obj.total_amount)
            : net + vat;
        const outstanding =
          obj.outstanding_amount !== undefined && obj.outstanding_amount !== null
            ? num(obj.outstanding_amount)
            : gross;
        return {
          sourceId: str(obj.id),
          number: str(obj.invoice_number ?? obj.reference ?? obj.displayed_as),
          customerName: str(obj.contact?.displayed_as ?? obj.contact_name),
          net: money2(net),
          vat: money2(vat),
          gross: money2(gross),
          status: mapSageInvoiceStatus(gross, outstanding),
          date: sageDate(obj.date),
        };
      });
    });
  }

  /**
   * The shared paged pull. Walks `page=1,2,…` (Sage is 1-indexed) with
   * items_per_page until a short (or empty) page, reusing `authedJson` — so the
   * 401→refresh→retry path and the single `fetch` in `raw` (both strictly after
   * the dark guard) are shared with the push path. Any transport failure aborts
   * the whole pull with an `error` — never a silent partial.
   */
  private async pullPaged<T>(
    input: AccountingPullInput,
    collection: "contacts" | "sales_invoices",
    mapPage: (json: unknown) => T[],
  ): Promise<AccountingPullResult<T>> {
    if (!this.isAvailable()) {
      return pullUnavailable<T>(
        this.provider,
        "Sage is not connected. Add the Sage OAuth credentials and enable " +
          "FEATURE_ACCOUNTING_CONNECT to enable the import sync; CSV import works today.",
      );
    }
    if (!input.tenantId) {
      return {
        ok: false,
        provider: this.provider,
        reason: "error",
        message: "Sage import has no business id; reconnect the Sage account.",
      };
    }
    const ctx: AuthCtx = {
      token: input.accessToken,
      businessId: input.tenantId,
      refreshed: false,
      refresh: input.refresh,
    };
    const items: T[] = [];

    for (let page = 1; page <= SAGE_MAX_PAGES; page++) {
      const res = await this.authedJson(
        ctx,
        "GET",
        `/${collection}?items_per_page=${SAGE_PAGE_SIZE}&page=${page}`,
      );
      if (!res.ok) {
        return {
          ok: false,
          provider: this.provider,
          reason: "error",
          message: this.reason(`${collection} pull`, res),
        };
      }
      const pageItems = mapPage(res.json);
      for (const it of pageItems) items.push(it);
      // A short page (or empty) is the last page — stop.
      if (pageItems.length < SAGE_PAGE_SIZE) break;
    }

    return { ok: true, provider: this.provider, items };
  }

  // ── PUSH ────────────────────────────────────────────────────────────────────

  async pushInvoices(input: AccountingPushInput): Promise<AccountingPushResult> {
    const guard = this.guard(input);
    if (guard) return guard;
    if (input.rows.length === 0) return { ok: true, provider: this.provider, pushed: 0 };

    const ctx: AuthCtx = {
      token: input.accessToken,
      businessId: input.tenantId as string,
      refreshed: false,
      refresh: input.refresh,
    };

    // Resolve the sales ledger account id up front (shared by every line).
    const ledger = await this.resolveLedgerAccountId(ctx);
    if (!ledger.ok) return this.err(ledger.message);

    // The business's tax rate ids keyed by whole-percent rate — loaded lazily,
    // once, only when a VAT-bearing invoice needs one.
    let taxRateByPercent: Map<number, string> | null = null;
    const ensureTaxRates = async (): Promise<
      { ok: true; map: Map<number, string> } | { ok: false; message: string }
    > => {
      if (taxRateByPercent) return { ok: true, map: taxRateByPercent };
      const loaded = await this.loadTaxRateMap(ctx);
      if (!loaded.ok) return loaded;
      taxRateByPercent = loaded.map;
      return { ok: true, map: taxRateByPercent };
    };

    let pushed = 0;
    const pushedSourceIds: string[] = [];
    const pushedInvoiceNumbers: string[] = [];
    const skipped: SkippedInvoice[] = [];
    const acc = () => ({ pushedSourceIds, pushedInvoiceNumbers, skipped });

    for (const row of input.rows) {
      // PER-INVOICE ISOLATION. An unmappable VAT rate (not 0/5/20) has no honest
      // Sage rate, so SKIP this ONE invoice — surfaced loudly, no network — rather
      // than stranding the postable tail of the batch. Checked FIRST so a poison
      // row costs zero lookups; a valid rate whose id is merely absent still fails
      // loud below (resolveTaxRateId).
      const skipReason = unmappableVatRate(row);
      if (skipReason !== null) {
        skipped.push({ invoiceNumber: row.invoice_number || "(no number)", reason: skipReason });
        continue;
      }

      const contact = await this.resolveContactId(ctx, row.customer);
      if (!contact.ok) return this.err(contact.message, pushed, acc());

      // Resolve the Sage tax rate id for EVERY rate the invoice posts (incl. 0, so
      // a zero-rated line posts zero-rated, not out-of-scope). A known rate whose
      // id is absent in the business fails loud (never a silent exempt post).
      let rowTaxRateByRate: Map<number, string> | undefined;
      let taxRateId: string | null = null;
      if (row.taxLines && row.taxLines.length > 0) {
        rowTaxRateByRate = new Map();
        for (const bucket of row.taxLines) {
          const resolved = await this.resolveTaxRateId(ensureTaxRates, bucket.rate);
          if (!resolved.ok) return this.err(resolved.message, pushed, acc());
          rowTaxRateByRate.set(bucket.rate, resolved.id);
        }
      } else {
        const vat = Number(row.vat);
        if (Number.isFinite(vat) && vat > 0) {
          // The rate is already known-postable (unmappableVatRate gated it above),
          // so effectiveVatRate cannot throw here; the guard is defensive only.
          let rate: number;
          try {
            rate = effectiveVatRate(Number(row.net || row.gross), vat);
          } catch (e) {
            return this.err(
              e instanceof Error ? e.message : "unsupported VAT rate",
              pushed,
              acc(),
            );
          }
          const resolved = await this.resolveTaxRateId(ensureTaxRates, rate);
          if (!resolved.ok) return this.err(resolved.message, pushed, acc());
          taxRateId = resolved.id;
        }
      }

      const body = buildSageInvoiceBody(row, {
        contactId: contact.id,
        ledgerAccountId: ledger.id,
        taxRateId,
        taxRateByRate: rowTaxRateByRate,
      });
      const res = await this.authedJson(
        ctx,
        "POST",
        "/sales_invoices",
        body,
        idempotencyKey("inv", ctx.businessId, row.sourceId ?? JSON.stringify(body)),
      );
      if (!res.ok) {
        if (isPermanentRowRejection(res.status)) {
          // PERMANENT per-row rejection (400 validation / rejected field, 422
          // duplicate, …). Sage will never accept THIS invoice's data on retry,
          // so ISOLATE it — skip + surface loudly, keep pushing the tail — like the
          // map-time unmappable-rate skip above. Left UNRECORDED (no `pushed++`, no
          // id captured) so a corrected row retries later; an EARLIER poison invoice
          // no longer re-aborts every later invoice on every sync (C73-C).
          skipped.push({
            invoiceNumber: row.invoice_number || "(no number)",
            reason: this.reason("invoice", res),
          });
          continue;
        }
        // TRANSIENT (5xx / 429 / network / auth): abort-and-retry the whole run.
        return this.err(this.reason("invoice", res), pushed, acc());
      }
      pushed += 1;
      if (row.sourceId) pushedSourceIds.push(row.sourceId);
      if (row.invoice_number) pushedInvoiceNumbers.push(row.invoice_number);
    }
    return {
      ok: true,
      provider: this.provider,
      pushed,
      pushedSourceIds,
      pushedInvoiceNumbers,
      skipped,
    };
  }

  async pushPayments(input: AccountingPushInput): Promise<AccountingPushResult> {
    const guard = this.guard(input);
    if (guard) return guard;
    if (input.rows.length === 0) return { ok: true, provider: this.provider, pushed: 0 };

    const ctx: AuthCtx = {
      token: input.accessToken,
      businessId: input.tenantId as string,
      refreshed: false,
      refresh: input.refresh,
    };

    // Resolve the bank account the receipts land in, once (shared by every row).
    const bank = await this.resolveBankAccountId(ctx);
    if (!bank.ok) return this.err(bank.message);

    let pushed = 0;
    // Payments carry no VAT rate, so they never MAP-skip; but a PERMANENT provider
    // rejection of one payment (4xx except 429) is isolated the same way an invoice
    // rejection is — skip + surface, never abort the tail.
    const pushedSourceIds: string[] = [];
    const skipped: SkippedInvoice[] = [];
    const acc = () => ({ pushedSourceIds, skipped });

    for (const row of input.rows) {
      const contact = await this.resolveContactId(ctx, row.customer);
      if (!contact.ok) return this.err(contact.message, pushed, acc());
      // Resolve the Sage invoice this receipt allocates to (by reference). Every
      // payment that reaches this adapter has passed the syncToProvider PAYMENT-LINK
      // GATE (c53), which only lets a payment through once its invoice EXISTS at the
      // provider. So the lookup MUST find it; anything else is anomalous and MUST
      // NOT post an unallocated receipt (which every future export would exclude,
      // stranding it forever). Fail instead so it retries next sync — the same
      // loud-error posture as the QBO adapter's resolveInvoiceId.
      const invoice = await this.resolveInvoiceId(ctx, row.invoice_number);
      if (!invoice.ok) return this.err(invoice.message, pushed, acc());
      if (!invoice.id) {
        return this.err(
          `Sage could not find invoice "${row.invoice_number}" for a payment whose ` +
            "invoice is guaranteed to exist (payment-link gate); not posting an unallocated " +
            "receipt. It will retry on the next sync.",
          pushed,
          acc(),
        );
      }
      const body = buildSagePaymentBody(row, {
        contactId: contact.id,
        bankAccountId: bank.id,
        transactionTypeId: CUSTOMER_RECEIPT,
        invoiceId: invoice.id,
      });
      const res = await this.authedJson(
        ctx,
        "POST",
        "/contact_payments",
        body,
        idempotencyKey("pay", ctx.businessId, row.sourceId ?? JSON.stringify(body)),
      );
      if (!res.ok) {
        if (isPermanentRowRejection(res.status)) {
          skipped.push({
            invoiceNumber: row.invoice_number || "(no number)",
            reason: this.reason("payment", res),
          });
          continue;
        }
        return this.err(this.reason("payment", res), pushed, acc());
      }
      pushed += 1;
      if (row.sourceId) pushedSourceIds.push(row.sourceId);
    }
    return { ok: true, provider: this.provider, pushed, pushedSourceIds, skipped };
  }

  // ── guards + result helpers ────────────────────────────────────────────────

  /** DARK GUARD + business-id presence. Returns a refusal result, or null to proceed. */
  private guard(input: AccountingPushInput): AccountingPushResult | null {
    if (!this.isAvailable()) {
      return unavailable(
        this.provider,
        "Sage is not connected. Add the Sage OAuth credentials and enable " +
          "FEATURE_ACCOUNTING_CONNECT to enable API push; CSV export works today.",
      );
    }
    if (!input.tenantId) {
      return {
        ok: false,
        provider: this.provider,
        reason: "error",
        message: "Sage push has no business id; reconnect the Sage account.",
      };
    }
    return null;
  }

  private err(
    message: string,
    pushed = 0,
    extra: {
      pushedSourceIds?: readonly string[];
      pushedInvoiceNumbers?: readonly string[];
      skipped?: readonly SkippedInvoice[];
    } = {},
  ): AccountingPushResult {
    return { ok: false, provider: this.provider, reason: "error", message, pushed, ...extra };
  }

  private reason(kind: string, res: JsonResult): string {
    if (res.networkError) return `Sage ${kind} push failed: ${res.networkError}`;
    return `Sage ${kind} push returned ${res.status}`;
  }

  // ── entity resolution ──────────────────────────────────────────────────────

  /**
   * Resolve the sales ledger account id. Prefers an explicit
   * SAGE_SALES_LEDGER_ACCOUNT_ID (config, not a secret) so an operator can pin the
   * exact revenue account; otherwise resolves the first sales-visible ledger
   * account. Fails loud when neither yields one.
   */
  private async resolveLedgerAccountId(
    ctx: AuthCtx,
  ): Promise<{ ok: true; id: string } | { ok: false; message: string }> {
    const pinned = process.env.SAGE_SALES_LEDGER_ACCOUNT_ID?.trim();
    if (pinned) return { ok: true, id: pinned };
    const res = await this.authedJson(
      ctx,
      "GET",
      "/ledger_accounts?visible_in_sales_invoice=true&items_per_page=1",
    );
    if (!res.ok) return { ok: false, message: this.reason("ledger account lookup", res) };
    const id = firstSageItemId(res.json);
    if (!id) {
      return {
        ok: false,
        message:
          "Sage has no sales ledger account to post invoice lines against; create one " +
          "in Sage (or set SAGE_SALES_LEDGER_ACCOUNT_ID) first.",
      };
    }
    return { ok: true, id };
  }

  /**
   * Resolve the bank account customer receipts land in. Prefers an explicit
   * SAGE_BANK_ACCOUNT_ID (config, not a secret); otherwise the first bank account.
   * Fails loud when neither yields one.
   */
  private async resolveBankAccountId(
    ctx: AuthCtx,
  ): Promise<{ ok: true; id: string } | { ok: false; message: string }> {
    const pinned = process.env.SAGE_BANK_ACCOUNT_ID?.trim();
    if (pinned) return { ok: true, id: pinned };
    const res = await this.authedJson(ctx, "GET", "/bank_accounts?items_per_page=1");
    if (!res.ok) return { ok: false, message: this.reason("bank account lookup", res) };
    const id = firstSageItemId(res.json);
    if (!id) {
      return {
        ok: false,
        message:
          "Sage has no bank account for customer receipts; create one in Sage " +
          "(or set SAGE_BANK_ACCOUNT_ID) first.",
      };
    }
    return { ok: true, id };
  }

  /**
   * Load the business's tax rates as a whole-percent → id map, ONCE. Sage returns
   * each rate's `percentage`; a standard UK business exposes 20 / 5 / 0. Rounding
   * the percentage to a whole number keys it to the canonical rate buckets.
   */
  private async loadTaxRateMap(
    ctx: AuthCtx,
  ): Promise<{ ok: true; map: Map<number, string> } | { ok: false; message: string }> {
    const res = await this.authedJson(ctx, "GET", "/tax_rates?items_per_page=200");
    if (!res.ok) return { ok: false, message: this.reason("tax rate lookup", res) };
    const map = new Map<number, string>();
    for (const item of sageItems(res.json)) {
      const obj = item as SageTaxRate;
      const id = str(obj.id);
      const pct = num(obj.percentage);
      if (!id) continue;
      const whole = Math.round(pct);
      // First id wins for a percentage — a business rarely has two rates at the
      // same whole percentage; the standard UK rate is the one that matters.
      if (!map.has(whole)) map.set(whole, id);
    }
    return { ok: true, map };
  }

  /**
   * Resolve the Sage tax rate id for a canonical rate. Validates the rate (fail
   * loud on an unknown one — never a silent exempt post), loads the rate map lazily
   * once, then maps the percentage to the business's id. A known rate absent from
   * the business is a loud hard error (mirrors QBO's missing-VAT-code refusal).
   */
  private async resolveTaxRateId(
    ensureTaxRates: () => Promise<
      { ok: true; map: Map<number, string> } | { ok: false; message: string }
    >,
    rate: number,
  ): Promise<{ ok: true; id: string } | { ok: false; message: string }> {
    let percent: number;
    try {
      percent = sageSalesTaxRatePercentage(rate);
    } catch (e) {
      return {
        ok: false,
        message: e instanceof Error ? e.message : `Unsupported VAT rate ${rate}%.`,
      };
    }
    const rates = await ensureTaxRates();
    if (!rates.ok) return rates;
    const id = rates.map.get(percent);
    if (!id) {
      return {
        ok: false,
        message:
          `Sage has no tax rate at ${percent}% for this business; ` +
          "create it in Sage (Settings → Tax Rates) first.",
      };
    }
    return { ok: true, id };
  }

  /**
   * Resolve a contact id by name, creating it when absent (Sage cannot resolve
   * inline by name). Get-or-create keyed on the display name.
   */
  private async resolveContactId(
    ctx: AuthCtx,
    name: string,
  ): Promise<{ ok: true; id: string } | { ok: false; message: string }> {
    const displayName = name || "Unknown customer";
    const found = await this.authedJson(
      ctx,
      "GET",
      `/contacts?search=${encodeURIComponent(displayName)}&items_per_page=100`,
    );
    if (!found.ok) return { ok: false, message: this.reason("contact lookup", found) };
    // Sage `search` is fuzzy; match the exact name (or displayed_as) so we never
    // reuse a similarly-named contact.
    const existing = sageItems(found.json).find((c) => {
      const obj = c as SageContact;
      return str(obj.name) === displayName || str(obj.displayed_as) === displayName;
    });
    const existingId = existing ? str((existing as SageContact).id) : "";
    if (existingId) return { ok: true, id: existingId };

    const body = {
      contact: { name: displayName, contact_type_ids: [CUSTOMER_CONTACT_TYPE] },
    };
    const created = await this.authedJson(
      ctx,
      "POST",
      "/contacts",
      body,
      idempotencyKey("contact", ctx.businessId, displayName),
    );
    if (!created.ok) return { ok: false, message: this.reason("contact create", created) };
    const id = sageEntityId(created.json);
    if (!id) return { ok: false, message: "Sage contact create returned no id." };
    return { ok: true, id };
  }

  /**
   * Resolve a Sage sales-invoice id by its reference (the CrewFlow invoice number).
   * Returns a DISCRIMINATED result, mirroring QBO's resolveInvoiceId so a TRANSPORT
   * failure is never conflated with a genuine not-found:
   *   • {ok:false, message}   — a transport error (!ok: 5xx / network / refresh dead).
   *   • {ok:true, id:string}  — the invoice was found.
   *   • {ok:true, id:null}    — a genuine empty result (or no reference).
   */
  private async resolveInvoiceId(
    ctx: AuthCtx,
    reference: string,
  ): Promise<{ ok: true; id: string | null } | { ok: false; message: string }> {
    if (!reference) return { ok: true, id: null };
    const res = await this.authedJson(
      ctx,
      "GET",
      `/sales_invoices?search=${encodeURIComponent(reference)}&items_per_page=100`,
    );
    if (!res.ok) return { ok: false, message: this.reason("invoice lookup", res) };
    const match = sageItems(res.json).find((inv) => {
      const obj = inv as SageInvoice;
      return (
        str(obj.reference) === reference || str(obj.invoice_number) === reference
      );
    });
    return { ok: true, id: match ? str((match as SageInvoice).id) || null : null };
  }

  // ── HTTP with shared single-refresh ────────────────────────────────────────

  /**
   * One authed JSON call. On a 401 it refreshes the token ONCE (shared across the
   * whole push via `ctx.refreshed`) and retries with the new token. Never throws.
   */
  private async authedJson(
    ctx: AuthCtx,
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    idempKey?: string,
  ): Promise<JsonResult> {
    let res = await this.raw(ctx.token, ctx.businessId, method, path, body, idempKey);
    if (res.status === 401 && !ctx.refreshed) {
      ctx.refreshed = true;
      const fresh = await ctx.refresh();
      if (!fresh) return res; // refresh impossible → surface the 401
      ctx.token = fresh;
      res = await this.raw(ctx.token, ctx.businessId, method, path, body, idempKey);
    }
    return res;
  }

  private async raw(
    token: string,
    businessId: string,
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    idempKey?: string,
  ): Promise<JsonResult> {
    const url = `${sageBase()}${path}`;
    try {
      const res = await fetch(url, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          // Scope the call to the connected business — the twin of Xero-tenant-id.
          "X-Business": businessId,
          accept: "application/json",
          ...(body ? { "content-type": "application/json" } : {}),
          ...(idempKey ? { "Idempotency-Key": idempKey } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      const ok = res.status >= 200 && res.status < 300;
      let json: unknown;
      try {
        json = await res.json();
      } catch {
        json = undefined;
      }
      return { ok, status: res.status, json };
    } catch (e) {
      return { ok: false, status: 0, networkError: e instanceof Error ? e.message : "network error" };
    }
  }
}

// ── pure JSON shape helpers (Sage v3.1 responses) ────────────────────────────

type SageAddress = {
  address_line_1?: string;
  city?: string;
  postal_code?: string;
};
type SageContact = {
  id?: string;
  name?: string;
  displayed_as?: string;
  email?: string;
  telephone?: string;
  mobile?: string;
  main_address?: SageAddress;
  addresses?: SageAddress[];
};
type SageInvoice = {
  id?: string;
  displayed_as?: string;
  invoice_number?: string;
  reference?: string;
  contact?: { displayed_as?: string };
  contact_name?: string;
  net_amount?: number | string;
  tax_amount?: number | string;
  total_amount?: number | string;
  outstanding_amount?: number | string;
  date?: string;
};
type SageTaxRate = { id?: string; percentage?: number | string };

/** The `$items` array of a Sage collection response, or []. */
function sageItems(json: unknown): unknown[] {
  const items = (json as { $items?: unknown } | null)?.$items;
  return Array.isArray(items) ? items : [];
}

/** The id of the first item in a Sage collection response, or null. */
function firstSageItemId(json: unknown): string | null {
  const list = sageItems(json);
  if (list.length === 0) return null;
  const id = (list[0] as { id?: unknown }).id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

/** The id from a Sage create response's top-level `{ id }`, or null. */
function sageEntityId(json: unknown): string | null {
  const id = (json as { id?: unknown } | null)?.id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

/** The first address that carries a street line, else the first address. */
function firstSageAddress(addresses: SageAddress[] | undefined): SageAddress | undefined {
  const list = Array.isArray(addresses) ? addresses : [];
  return list.find((a) => nonEmpty(a.address_line_1)) ?? list[0];
}

function str(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}
function nonEmpty(v: unknown): string | null {
  const s = str(v).trim();
  return s.length > 0 ? s : null;
}
function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}
/** A Sage date (already `YYYY-MM-DD` or ISO) → the calendar day, or null. */
function sageDate(value: string | undefined): string | null {
  if (!value) return null;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(value);
  return m ? m[1]! : null;
}
/** Derive a CrewFlow-writable status from a Sage invoice's gross + outstanding. */
function mapSageInvoiceStatus(gross: number, outstanding: number): string {
  if (gross > 0 && outstanding <= 0) return "paid";
  if (outstanding > 0 && outstanding < gross) return "partially_paid";
  return "sent";
}
