import "server-only";
import { createHash } from "node:crypto";

import { isProviderConnectable } from "../oauth";
import type {
  AccountingAdapter,
  AccountingPushInput,
  AccountingPushResult,
  SkippedInvoice,
} from "./types";
import { isPermanentRowRejection, unavailable } from "./types";
import {
  buildQboInvoiceBody,
  buildQboPaymentBody,
  qboSalesTaxCodeName,
} from "../provider-payloads";
import {
  assertKnownVatRate,
  effectiveVatRate,
  UnknownVatRateError,
  type CanonicalAccountingRow,
} from "../canonical";

/**
 * The reason ONE invoice must be SKIPPED (never a batch abort) for an unmappable
 * VAT rate, or null when every rate the invoice needs is postable (0/5/20). This
 * is checked BEFORE any network work so a poison invoice costs no lookups. It is
 * the QBO twin of Xero's per-invoice build-throw skip: an unmappable rate has no
 * honest QBO VAT code, so that one invoice is dropped and surfaced loudly rather
 * than stranding the whole tail of the batch (the C61 posture on this surface).
 * A genuinely MISSING-but-valid code (or a transport error) is NOT a skip — it
 * stays a loud hard error, resolved by resolveTaxCodeId below.
 */
function unmappableVatRate(row: CanonicalAccountingRow): string | null {
  try {
    if (row.taxLines && row.taxLines.length > 0) {
      for (const bucket of row.taxLines) {
        assertKnownVatRate(bucket.rate, "QuickBooks sales VAT code");
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
 * QuickBooks Online accounting adapter.
 *
 * ── DARK BY DEFAULT ──────────────────────────────────────────────────────────
 * `isAvailable()` is the connect substrate's two-switch gate (feature flag +
 * QBO_CLIENT_ID/SECRET) via `isProviderConnectable("quickbooks")` — false ALWAYS
 * today. Each push method REFUSES with `unavailable` as its FIRST statement when
 * dark, so every `fetch` is structurally unreachable without credentials. No
 * Intuit SDK import, no client construction; the only network is `fetch`,
 * strictly after the guard.
 *
 * ── ACTIVATION IS CREDENTIALS + FLAG ─────────────────────────────────────────
 * The per-org access token + realm id arrive on {@link AccountingPushInput}
 * (resolved by the connections service from the encrypted connection row). Set
 * QBO_CLIENT_ID + QBO_CLIENT_SECRET and flip FEATURE_ACCOUNTING_CONNECT and this
 * adapter posts real invoices / payments. QBO cannot resolve a customer or item
 * inline by name, so — unlike Xero — this adapter resolves (querying, creating
 * the customer when absent) the CustomerRef and a Service ItemRef before each
 * create; the one activation precondition beyond credentials is that the QBO
 * company has at least one Service item.
 *
 * ── REFRESH ──────────────────────────────────────────────────────────────────
 * A 401 on ANY call triggers ONE token refresh (the input's `refresh` callback)
 * and a retry with the new token, shared across the multi-call push via a small
 * mutable auth context. Creates carry a stable `requestid` seeded by the immutable
 * CrewFlow row id (`sourceId`) — so re-pushing the SAME row is idempotent at
 * Intuit, while two distinct rows with a byte-identical body (e.g. two same-day
 * same-amount part-payments) stay DISTINCT and both create. Mirrors Xero's
 * per-entity Idempotency-Key.
 */

const DEFAULT_QBO_API = "https://quickbooks.api.intuit.com";
const MINOR_VERSION = "65";

function qboBase(): string {
  return process.env.QBO_API_BASE_URL?.trim() || DEFAULT_QBO_API;
}

/** Escape a QBO query string literal — single quotes are doubled. */
function q(value: string): string {
  return value.replace(/'/g, "''");
}

/**
 * Stable idempotency `requestid` (<=50 chars) for a create. Seeded by the
 * immutable CrewFlow row id (`sourceId`) when present, else the request body as a
 * deterministic fallback. Seeding by the row id — NOT a hash of the body — is what
 * makes this true idempotency: a genuine re-push of the SAME row reuses the SAME
 * requestid (Intuit treats it as a replay, so no duplicate), while two DISTINCT
 * rows that happen to serialise to a byte-identical body (e.g. two same-day,
 * same-amount part-payments on one invoice) get DISTINCT requestids and both
 * create. Body-hashing would collapse that second, legitimate payment into a
 * replay of the first — a silent, permanent financial loss.
 */
function requestId(kind: string, realmId: string, seed: string): string {
  const h = createHash("sha256")
    .update(`${kind}:${realmId}:${seed}`)
    .digest("hex");
  return `cf-${kind}-${h.slice(0, 40)}`;
}

type AuthCtx = {
  token: string;
  refreshed: boolean;
  refresh: () => Promise<string | null>;
};

type JsonResult = {
  ok: boolean;
  status: number;
  json?: unknown;
  networkError?: string;
};

export class QuickBooksAdapter implements AccountingAdapter {
  readonly provider = "quickbooks" as const;

  isAvailable(): boolean {
    return isProviderConnectable(this.provider);
  }

  async pushInvoices(input: AccountingPushInput): Promise<AccountingPushResult> {
    const guard = this.guard(input);
    if (guard) return guard;
    if (input.rows.length === 0) return { ok: true, provider: this.provider, pushed: 0 };

    const realmId = input.realmId as string;
    const ctx: AuthCtx = { token: input.accessToken, refreshed: false, refresh: input.refresh };

    // Resolve one Service item id up front (shared by every line).
    const item = await this.resolveServiceItemId(ctx, realmId);
    if (!item.ok) return this.err(item.message);

    // Memoise the org's VAT code id per rate — resolved lazily, once per rate.
    const taxCodeByRate = new Map<number, string>();

    let pushed = 0;
    const pushedSourceIds: string[] = [];
    const pushedInvoiceNumbers: string[] = [];
    const skipped: SkippedInvoice[] = [];
    const acc = () => ({ pushedSourceIds, pushedInvoiceNumbers, skipped });
    for (const row of input.rows) {
      // PER-INVOICE ISOLATION. An unmappable VAT rate (not 0/5/20) has no honest
      // QBO code, so SKIP this ONE invoice — surfaced loudly, no network — rather
      // than stranding the postable tail of the batch. Checked FIRST so a poison
      // row costs zero lookups; a valid rate whose code is merely absent still
      // fails loud below (resolveTaxCodeId).
      const skipReason = unmappableVatRate(row);
      if (skipReason !== null) {
        skipped.push({ invoiceNumber: row.invoice_number || "(no number)", reason: skipReason });
        continue;
      }

      const customer = await this.resolveCustomerId(ctx, realmId, row.customer);
      if (!customer.ok) return this.err(customer.message, pushed, acc());

      // Resolve (and cache) the org's QBO VAT code for EVERY rate the invoice
      // posts. QBO ignores an explicit TotalTax for a UK company unless each line
      // NAMES its code, so a zero-rated line must ALSO carry the '0.0% Z' code —
      // otherwise it posts out-of-scope, not zero-rated. An unknown rate makes
      // resolveTaxCodeId fail loud (never a silent exempt post).
      let rowTaxCodeByRate: Map<number, string> | undefined;
      let taxCodeId: string | null = null;
      if (row.taxLines && row.taxLines.length > 0) {
        // PUSH PATH: one code per DISTINCT bucket rate (0 / 5 / 20).
        rowTaxCodeByRate = new Map();
        for (const bucket of row.taxLines) {
          const rate = bucket.rate;
          let id = taxCodeByRate.get(rate);
          if (id === undefined) {
            const resolved = await this.resolveTaxCodeId(ctx, realmId, rate);
            if (!resolved.ok) return this.err(resolved.message, pushed, acc());
            taxCodeByRate.set(rate, resolved.id);
            id = resolved.id;
          }
          rowTaxCodeByRate.set(rate, id);
        }
      } else {
        // LEGACY single-line path (a directly-built row without taxLines): resolve
        // the one code for a VAT-bearing line. An unknown derived rate fails loud.
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
          const cached = taxCodeByRate.get(rate);
          if (cached) {
            taxCodeId = cached;
          } else {
            const resolved = await this.resolveTaxCodeId(ctx, realmId, rate);
            if (!resolved.ok) return this.err(resolved.message, pushed, acc());
            taxCodeByRate.set(rate, resolved.id);
            taxCodeId = resolved.id;
          }
        }
      }

      const body = buildQboInvoiceBody(row, {
        customerId: customer.id,
        itemId: item.id,
        taxCodeId,
        taxCodeByRate: rowTaxCodeByRate,
      });
      // Seed the idempotency requestid off the immutable row id, not the body:
      // two distinct invoices with a byte-identical body still get distinct keys.
      const res = await this.authedJson(
        ctx,
        "POST",
        `/v3/company/${realmId}/invoice`,
        body,
        requestId("inv", realmId, row.sourceId ?? JSON.stringify(body)),
      );
      if (!res.ok) {
        if (isPermanentRowRejection(res.status)) {
          // PERMANENT per-row rejection (400 validation / rejected field, 422
          // duplicate DocNumber / archived contact, …). QBO will never accept
          // THIS invoice's data on retry, so ISOLATE it — skip + surface loudly,
          // keep pushing the tail — like the map-time unmappable-rate skip above.
          // Left UNRECORDED (no `pushed++`, no id captured) so a corrected row
          // retries later; an EARLIER poison invoice no longer re-aborts every
          // later invoice on every sync (C73-C).
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

    const realmId = input.realmId as string;
    const ctx: AuthCtx = { token: input.accessToken, refreshed: false, refresh: input.refresh };

    let pushed = 0;
    // Payments carry no VAT rate, so they never MAP-skip; but a PERMANENT provider
    // rejection of one payment (4xx except 429) is isolated the same way an invoice
    // rejection is — skip + surface, never abort the tail. Track the accepted
    // identities so the caller records EXACTLY the payments that landed.
    const pushedSourceIds: string[] = [];
    const skipped: SkippedInvoice[] = [];
    const acc = () => ({ pushedSourceIds, skipped });
    for (const row of input.rows) {
      const customer = await this.resolveCustomerId(ctx, realmId, row.customer);
      if (!customer.ok) return this.err(customer.message, pushed, acc());
      // Resolve the QBO invoice this payment links to (by DocNumber). Every
      // payment that reaches this adapter has already passed the syncToProvider
      // PAYMENT-LINK GATE (c53), which only lets a payment through once its invoice
      // EXISTS at QBO — created this run or on a prior successful run. So the
      // lookup MUST find it; anything else is anomalous and MUST NOT post:
      //   • {ok:false}  — a transient transport failure (5xx / network / refresh
      //     dead). Posting anyway is impossible (we have no id), and QBO would
      //     accept a LinkedTxn-less body as a 2xx UNAPPLIED receipt that every
      //     future export then excludes — stranding it forever. Fail instead so it
      //     retries next sync (mirrors Xero's non-2xx self-heal).
      //   • {ok:true,id:null} — a genuine empty QueryResponse. For a GATED-IN
      //     payment the invoice is guaranteed to exist, so an empty result is
      //     either eventual-consistency lag on an invoice created seconds ago or a
      //     real anomaly; either way, recording an unapplied payment would strand
      //     it, so fail and retry rather than post unlinked.
      const invoice = await this.resolveInvoiceId(ctx, realmId, row.invoice_number);
      if (!invoice.ok) return this.err(invoice.message, pushed, acc());
      if (!invoice.id) {
        return this.err(
          `QuickBooks could not find invoice "${row.invoice_number}" for a payment whose ` +
            "invoice is guaranteed to exist (payment-link gate); not posting an unapplied " +
            "receipt. It will retry on the next sync.",
          pushed,
          acc(),
        );
      }
      const body = buildQboPaymentBody(row, { customerId: customer.id, invoiceId: invoice.id });
      // Seed off the immutable payment row id, NOT the body. Two distinct
      // invoice_payments rows on one invoice for the same customer, day and amount
      // (real: two identical part-payments/deposits) serialise to a byte-identical
      // body; body-seeding would give them the same requestid and Intuit would drop
      // the second as a replay — the payment silently lost. The row id keeps them
      // distinct, while a genuine re-push of the SAME row reuses its requestid.
      const res = await this.authedJson(
        ctx,
        "POST",
        `/v3/company/${realmId}/payment`,
        body,
        requestId("pay", realmId, row.sourceId ?? JSON.stringify(body)),
      );
      if (!res.ok) {
        if (isPermanentRowRejection(res.status)) {
          // PERMANENT per-row rejection — QBO refuses THIS payment's data (e.g.
          // 400 malformed link/amount). Isolate it: skip + surface, keep the tail
          // going, leave it unrecorded so a corrected row retries later.
          skipped.push({
            invoiceNumber: row.invoice_number || "(no number)",
            reason: this.reason("payment", res),
          });
          continue;
        }
        // TRANSIENT (5xx / 429 / network / auth): abort-and-retry the whole run.
        return this.err(this.reason("payment", res), pushed, acc());
      }
      pushed += 1;
      if (row.sourceId) pushedSourceIds.push(row.sourceId);
    }
    return { ok: true, provider: this.provider, pushed, pushedSourceIds, skipped };
  }

  // ── guards + result helpers ────────────────────────────────────────────────

  /** DARK GUARD + realm presence. Returns a refusal result, or null to proceed. */
  private guard(input: AccountingPushInput): AccountingPushResult | null {
    if (!this.isAvailable()) {
      return unavailable(
        this.provider,
        "QuickBooks is not connected. Add the QuickBooks OAuth credentials and " +
          "enable FEATURE_ACCOUNTING_CONNECT to enable API push; CSV export works today.",
      );
    }
    if (!input.realmId) {
      return {
        ok: false,
        provider: this.provider,
        reason: "error",
        message: "QuickBooks push has no realm id; reconnect the QuickBooks account.",
      };
    }
    return null;
  }

  /**
   * An error result carrying the count the provider ACCEPTED before failing
   * (default 0) plus the EXPLICIT accepted identities (`pushedSourceIds` /
   * `pushedInvoiceNumbers`) and any `skipped` invoices seen before the failure.
   * The caller records exactly the accepted set (not a prefix count — a mid-batch
   * skip leaves a hole) and re-pushes only the tail.
   */
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
    if (res.networkError) return `QuickBooks ${kind} push failed: ${res.networkError}`;
    return `QuickBooks ${kind} push returned ${res.status}`;
  }

  // ── entity resolution ──────────────────────────────────────────────────────

  private async resolveServiceItemId(
    ctx: AuthCtx,
    realmId: string,
  ): Promise<{ ok: true; id: string } | { ok: false; message: string }> {
    const res = await this.authedJson(
      ctx,
      "GET",
      `/v3/company/${realmId}/query?query=${encodeURIComponent(
        "select Id from Item where Type='Service' maxresults 1",
      )}`,
    );
    if (!res.ok) return { ok: false, message: this.reason("item lookup", res) };
    const id = firstEntityId(res.json, "Item");
    if (!id) {
      return {
        ok: false,
        message:
          "QuickBooks has no Service item to post invoice lines against; create one in QuickBooks first.",
      };
    }
    return { ok: true, id };
  }

  /**
   * Resolve the org's VAT code id for a rate, by NAME (mirrors the Service-item
   * lookup). QBO ignores an explicit TotalTax for a UK company unless a
   * TxnTaxCodeRef names the code, so a VAT-bearing invoice MUST resolve one —
   * failing loudly (like the missing-item case) is safer than silently posting
   * an invoice with the VAT dropped.
   */
  private async resolveTaxCodeId(
    ctx: AuthCtx,
    realmId: string,
    rate: number,
  ): Promise<{ ok: true; id: string } | { ok: false; message: string }> {
    // FAIL LOUD on an unmappable rate: qboSalesTaxCodeName throws rather than
    // returning 'Exempt (0%)', so a wrong rate aborts the push here (mirroring the
    // missing-VAT-code refusal below) instead of posting VAT out of scope.
    let name: string;
    try {
      name = qboSalesTaxCodeName(rate);
    } catch (e) {
      return {
        ok: false,
        message: e instanceof Error ? e.message : `Unsupported VAT rate ${rate}%.`,
      };
    }
    const res = await this.authedJson(
      ctx,
      "GET",
      `/v3/company/${realmId}/query?query=${encodeURIComponent(
        `select Id from TaxCode where Name = '${q(name)}'`,
      )}`,
    );
    if (!res.ok) return { ok: false, message: this.reason("tax code lookup", res) };
    const id = firstEntityId(res.json, "TaxCode");
    if (!id) {
      return {
        ok: false,
        message:
          `QuickBooks has no VAT code named "${name}" for the ${rate}% rate; ` +
          "create it in QuickBooks (Taxes) first.",
      };
    }
    return { ok: true, id };
  }

  private async resolveCustomerId(
    ctx: AuthCtx,
    realmId: string,
    name: string,
  ): Promise<{ ok: true; id: string } | { ok: false; message: string }> {
    const displayName = name || "Unknown customer";
    const found = await this.authedJson(
      ctx,
      "GET",
      `/v3/company/${realmId}/query?query=${encodeURIComponent(
        `select Id from Customer where DisplayName = '${q(displayName)}'`,
      )}`,
    );
    if (!found.ok) return { ok: false, message: this.reason("customer lookup", found) };
    const existing = firstEntityId(found.json, "Customer");
    if (existing) return { ok: true, id: existing };

    // Create the customer when absent (QBO cannot resolve inline by name). This is
    // get-or-create keyed on a unique DisplayName (not part of the row-id defect
    // class — there is no row sourceId in scope here), so seed the requestid off
    // the body: identical to prior behaviour.
    const body = { DisplayName: displayName };
    const created = await this.authedJson(
      ctx,
      "POST",
      `/v3/company/${realmId}/customer`,
      body,
      requestId("cust", realmId, JSON.stringify(body)),
    );
    if (!created.ok) return { ok: false, message: this.reason("customer create", created) };
    const id = entityId(created.json, "Customer");
    if (!id) return { ok: false, message: "QuickBooks customer create returned no id." };
    return { ok: true, id };
  }

  /**
   * Resolve a QBO invoice id by DocNumber. Returns a DISCRIMINATED result,
   * mirroring resolveCustomerId / resolveServiceItemId / resolveTaxCodeId so a
   * TRANSPORT failure is never conflated with a genuine not-found:
   *   • {ok:false, message}   — a transport error (!res.ok: 5xx / network /
   *     refresh dead). The caller must NOT treat this as "invoice absent".
   *   • {ok:true, id:string}  — the invoice was found.
   *   • {ok:true, id:null}    — a genuine empty QueryResponse (or no DocNumber).
   *
   * Historically this returned a bare `string | null` and mapped `!res.ok → null`,
   * making a transient blip indistinguishable from a real absence — which let
   * pushPayments post an UNAPPLIED payment that then stranded forever. The
   * discriminated result restores the loud-error posture of its siblings.
   */
  private async resolveInvoiceId(
    ctx: AuthCtx,
    realmId: string,
    docNumber: string,
  ): Promise<{ ok: true; id: string | null } | { ok: false; message: string }> {
    if (!docNumber) return { ok: true, id: null };
    const res = await this.authedJson(
      ctx,
      "GET",
      `/v3/company/${realmId}/query?query=${encodeURIComponent(
        `select Id from Invoice where DocNumber = '${q(docNumber)}'`,
      )}`,
    );
    if (!res.ok) return { ok: false, message: this.reason("invoice lookup", res) };
    return { ok: true, id: firstEntityId(res.json, "Invoice") };
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
    reqId?: string,
  ): Promise<JsonResult> {
    let res = await this.raw(ctx.token, method, path, body, reqId);
    if (res.status === 401 && !ctx.refreshed) {
      ctx.refreshed = true;
      const fresh = await ctx.refresh();
      if (!fresh) return res; // refresh impossible → surface the 401
      ctx.token = fresh;
      res = await this.raw(ctx.token, method, path, body, reqId);
    }
    return res;
  }

  private async raw(
    token: string,
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    reqId?: string,
  ): Promise<JsonResult> {
    const sep = path.includes("?") ? "&" : "?";
    let url = `${qboBase()}${path}${sep}minorversion=${MINOR_VERSION}`;
    if (reqId) url += `&requestid=${encodeURIComponent(reqId)}`;
    try {
      const res = await fetch(url, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/json",
          ...(body ? { "content-type": "application/json" } : {}),
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

// ── pure JSON shape helpers (QBO query + create responses) ───────────────────

/** The Id of the first entity in a QBO query response's QueryResponse[Entity]. */
function firstEntityId(json: unknown, entity: string): string | null {
  const qr = (json as { QueryResponse?: Record<string, unknown> } | null)?.QueryResponse;
  const list = qr?.[entity];
  if (!Array.isArray(list) || list.length === 0) return null;
  const id = (list[0] as { Id?: unknown }).Id;
  return typeof id === "string" ? id : null;
}

/** The Id from a QBO create response's top-level {Entity:{Id}}. */
function entityId(json: unknown, entity: string): string | null {
  const obj = (json as Record<string, unknown> | null)?.[entity];
  const id = (obj as { Id?: unknown } | undefined)?.Id;
  return typeof id === "string" ? id : null;
}
