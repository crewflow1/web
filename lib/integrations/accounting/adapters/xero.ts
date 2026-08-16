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
  buildXeroInvoicesBody,
  buildXeroPaymentsBody,
} from "../provider-payloads";
import { money2, type CanonicalAccountingRow } from "../canonical";

/**
 * Build ONE row's provider body, or signal that this ONE row must be SKIPPED
 * (never abort the whole batch). `{ one }` is the built body object; `{ skip }`
 * is the loud reason the row was dropped (an unmappable VAT rate).
 */
type BuiltRow = { one: unknown } | { skip: string };

/**
 * Xero accounting adapter.
 *
 * ── DARK BY DEFAULT ──────────────────────────────────────────────────────────
 * `isAvailable()` is the connect substrate's two-switch gate (feature flag +
 * XERO_CLIENT_ID/SECRET) via `isProviderConnectable("xero")` — false ALWAYS
 * today. Each push method REFUSES with `unavailable` as its FIRST statement when
 * dark, so the single `fetch` per push is structurally unreachable without
 * credentials. There is no Xero SDK import and no client construction; the only
 * network is `fetch`, strictly after the guard.
 *
 * ── ACTIVATION IS CREDENTIALS + FLAG ─────────────────────────────────────────
 * The per-org access token + tenant id arrive on {@link AccountingPushInput}
 * (resolved by the connections service from the encrypted connection row). No
 * per-tenant env is read here. Set XERO_CLIENT_ID + XERO_CLIENT_SECRET and flip
 * FEATURE_ACCOUNTING_CONNECT and this adapter posts real invoices / payments.
 *
 * ── THE PUSH (PER-ENTITY) ────────────────────────────────────────────────────
 * Canonical rows → the pure body builders (provider-payloads.ts) → ONE POST PER
 * ROW to the Xero Accounting API with `Authorization: Bearer` + `Xero-tenant-id`.
 * On a 401 the push refreshes the token ONCE (the input's `refresh` callback,
 * shared across the whole loop) and retries. Each POST carries a STABLE per-entity
 * `Idempotency-Key` seeded by the CrewFlow row id (`sourceId`), so re-pushing the
 * SAME invoice is a no-op at Xero even within its key-retention window.
 *
 * WHY PER-ROW, NOT PER-BATCH. A single batch POST carries ONE Idempotency-Key
 * hashed over the WHOLE body, so adding a new invoice to a later sync changes the
 * key and Xero re-creates the earlier invoices (it permits duplicate
 * InvoiceNumbers). A per-entity key keyed on the immutable row id is idempotent
 * regardless of what else is in the sync — the defence-in-depth behind the
 * push-once ledger (accounting_pushed_entities), which is the primary guard.
 */

const XERO_API = "https://api.xero.com/api.xro/2.0";

/**
 * Stable idempotency key for ONE entity. Seeded by the immutable CrewFlow row id
 * when present (so the key is identical across every sync that re-pushes the same
 * row), else by the row body as a deterministic fallback.
 */
function idempotencyKey(kind: string, tenantId: string, seed: string): string {
  const h = createHash("sha256").update(`${kind}:${tenantId}:${seed}`).digest("hex");
  return `crewflow-xero-${kind}-${h.slice(0, 32)}`;
}

/** Xero pages the Accounting API at 100 rows/page; loop until a short page. */
const XERO_PAGE_SIZE = 100;
/** Hard cap on pages walked, so a misbehaving provider can never loop forever. */
const XERO_MAX_PAGES = 1000;

export class XeroAdapter implements AccountingAdapter, AccountingImportAdapter {
  readonly provider = "xero" as const;

  isAvailable(): boolean {
    return isProviderConnectable(this.provider);
  }

  // ── IMPORT (PULL) ──────────────────────────────────────────────────────────

  /**
   * Pull every Contact from the connected Xero tenant, F-1 paginated (100/page).
   * DARK GUARD FIRST — no credentials / flag off ⇒ `unavailable`, no network.
   */
  async pullContacts(
    input: AccountingPullInput,
  ): Promise<AccountingPullResult<PulledContact>> {
    return this.pullPaged<PulledContact>(input, "Contacts", (json) => {
      const list = asArray((json as XeroContactsResponse | null)?.Contacts);
      return list.map((c) => ({
        sourceId: str(c.ContactID),
        name: str(c.Name),
        email: nonEmpty(c.EmailAddress),
        phone: firstXeroPhone(c.Phones),
        addressLine1: firstXeroAddressField(c.Addresses, "AddressLine1"),
        city: firstXeroAddressField(c.Addresses, "City"),
        postcode: firstXeroAddressField(c.Addresses, "PostalCode"),
      }));
    });
  }

  /**
   * Pull every ACCREC (sales) invoice from the connected Xero tenant, F-1
   * paginated. Purchase bills (ACCPAY) are excluded server-side via `where`.
   * DARK GUARD FIRST — no credentials / flag off ⇒ `unavailable`, no network.
   */
  async pullInvoices(
    input: AccountingPullInput,
  ): Promise<AccountingPullResult<PulledInvoice>> {
    return this.pullPaged<PulledInvoice>(
      input,
      "Invoices",
      (json) => {
        const list = asArray((json as XeroInvoicesResponse | null)?.Invoices);
        return list
          // Defence in depth behind the server-side where= filter: never seed a
          // purchase bill as a CrewFlow sales invoice.
          .filter((inv) => (inv.Type ?? "ACCREC") === "ACCREC")
          .map((inv) => {
            const net = num(inv.SubTotal);
            const vat = num(inv.TotalTax);
            const gross =
              inv.Total !== undefined && inv.Total !== null
                ? num(inv.Total)
                : net + vat;
            return {
              sourceId: str(inv.InvoiceID),
              number: str(inv.InvoiceNumber),
              customerName: str(inv.Contact?.Name),
              net: money2(net),
              vat: money2(vat),
              gross: money2(gross),
              status: mapXeroInvoiceStatus(inv.Status),
              date: xeroDate(inv.DateString ?? inv.Date),
            };
          });
      },
      `where=${encodeURIComponent('Type=="ACCREC"')}`,
    );
  }

  /**
   * The shared paged GET loop. Walks `page=1,2,…` until a page returns fewer than
   * a full page (or empty), accumulating each page's mapped rows. A 401 on any
   * page refreshes the token ONCE (shared across the loop) and retries that page.
   * Any non-2xx / network failure aborts the whole pull with an `error` — never a
   * silent partial. The single `fetch` (in `get`) lives strictly AFTER the dark
   * guard, so it is unreachable without credentials.
   */
  private async pullPaged<T>(
    input: AccountingPullInput,
    endpoint: "Contacts" | "Invoices",
    mapPage: (json: unknown) => T[],
    extraQuery?: string,
  ): Promise<AccountingPullResult<T>> {
    if (!this.isAvailable()) {
      return pullUnavailable<T>(
        this.provider,
        "Xero is not connected. Add the Xero OAuth credentials and enable " +
          "FEATURE_ACCOUNTING_CONNECT to enable the import sync; CSV import works today.",
      );
    }
    if (!input.tenantId) {
      return {
        ok: false,
        provider: this.provider,
        reason: "error",
        message: "Xero import has no tenant id; reconnect the Xero account.",
      };
    }
    const tenantId = input.tenantId;
    const ctx = { token: input.accessToken, refreshed: false };
    const items: T[] = [];

    for (let page = 1; page <= XERO_MAX_PAGES; page++) {
      const query = [extraQuery, `page=${page}`, `pageSize=${XERO_PAGE_SIZE}`]
        .filter(Boolean)
        .join("&");
      const url = `${XERO_API}/${endpoint}?${query}`;

      let res = await this.get(url, ctx.token, tenantId);
      if (res.status === 401 && !ctx.refreshed) {
        ctx.refreshed = true;
        const fresh = await input.refresh();
        if (!fresh) {
          return {
            ok: false,
            provider: this.provider,
            reason: "error",
            message: "Xero rejected the token and it could not be refreshed.",
          };
        }
        ctx.token = fresh;
        res = await this.get(url, ctx.token, tenantId);
      }
      if (res.networkError) {
        return {
          ok: false,
          provider: this.provider,
          reason: "error",
          message: `Xero import failed: ${res.networkError}`,
        };
      }
      if (res.status < 200 || res.status >= 300) {
        return {
          ok: false,
          provider: this.provider,
          reason: "error",
          message: `Xero ${endpoint} pull returned ${res.status}`,
        };
      }
      const pageItems = mapPage(res.json);
      for (const it of pageItems) items.push(it);
      // A short page (or empty) is the last page — stop.
      if (pageItems.length < XERO_PAGE_SIZE) break;
    }

    return { ok: true, provider: this.provider, items };
  }

  /** One authed GET. Never throws — a network failure is reported on the result. */
  private async get(
    url: string,
    accessToken: string,
    tenantId: string,
  ): Promise<{ status: number; json?: unknown; networkError?: string }> {
    try {
      const res = await fetch(url, {
        method: "GET",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "Xero-tenant-id": tenantId,
          accept: "application/json",
        },
      });
      let json: unknown;
      try {
        json = await res.json();
      } catch {
        json = undefined;
      }
      return { status: res.status, json };
    } catch (e) {
      return { status: 0, networkError: e instanceof Error ? e.message : "network error" };
    }
  }

  async pushInvoices(input: AccountingPushInput): Promise<AccountingPushResult> {
    // Revenue account the AUTHORISED ACCREC lines post to. Configurable via env
    // with a sane Xero default ("200" is Xero's standard Sales account); not a
    // secret. Xero rejects an AUTHORISED sales invoice whose lines name no
    // account, so this is required — the twin of the bank code on payments.
    const salesCode = process.env.XERO_SALES_ACCOUNT_CODE?.trim() || "200";
    // PER-INVOICE ISOLATION. Build+validate EACH invoice body ALONE inside the
    // loop. Mapping a line's rate to a Xero TaxType throws (UnknownVatRateError)
    // for a rate outside {0,5,20}, and bucketInvoiceTaxLines throws on a snapshot
    // that doesn't reconcile — either throw is a per-invoice SKIP surfaced loudly,
    // NEVER a whole-batch abort. Postable invoices still post; the operator learns
    // exactly which invoice to fix. (Genuine transport errors still fail the sync.)
    return this.push("invoices", "Invoices", input, (row) => {
      try {
        return { one: buildXeroInvoicesBody([row], salesCode).Invoices[0] };
      } catch (e) {
        return { skip: e instanceof Error ? e.message : "unmappable VAT rate" };
      }
    });
  }

  async pushPayments(input: AccountingPushInput): Promise<AccountingPushResult> {
    // Bank account code the receipts land in. Configurable via env with a sane
    // Xero default ("090" is Xero's standard Bank account code); not a secret.
    const bankCode = process.env.XERO_BANK_ACCOUNT_CODE?.trim() || "090";
    // Payments carry no VAT rate, so they never skip; the builder always yields a body.
    return this.push("payments", "Payments", input, (row) => ({
      one: buildXeroPaymentsBody([row], bankCode).Payments[0],
    }));
  }

  /**
   * Push each row as its OWN POST, carrying a stable per-entity idempotency key.
   * Bearer + tenant header, 401→refresh→retry (refreshed ONCE, shared across the
   * loop).
   *
   * PER-ROW ISOLATION. `bodyFor` builds+validates ONE row: `{ skip }` drops just
   * that invoice (an unmappable VAT rate), `{ one }` posts it. A build throw for a
   * single invoice can NEVER zero the whole org's push — the batch-poisoning
   * (C61) posture on the accounting surface. A PERMANENT provider REJECTION of one
   * row (HTTP 4xx except 429 — see isPermanentRowRejection) is isolated the SAME
   * way (skip + surface), NOT a whole-batch abort; only a TRANSIENT failure (5xx /
   * 429 / network / auth) aborts the run for a retry (C73-C). Returns the EXPLICIT accepted set
   * (`pushedSourceIds` / `pushedInvoiceNumbers`) plus `skipped`, so the caller
   * records exactly what Xero took and re-pushes only the tail — a mid-batch skip
   * leaves a hole, so an input-order prefix count is not enough.
   */
  private async push(
    kind: "invoices" | "payments",
    endpoint: "Invoices" | "Payments",
    input: AccountingPushInput,
    bodyFor: (row: CanonicalAccountingRow) => BuiltRow,
  ): Promise<AccountingPushResult> {
    // DARK GUARD FIRST. With no credentials / flag off we return without touching
    // the network. Everything below is unreachable until connectable.
    if (!this.isAvailable()) {
      return unavailable(
        this.provider,
        "Xero is not connected. Add the Xero OAuth credentials and enable " +
          "FEATURE_ACCOUNTING_CONNECT to enable API push; CSV export works today.",
      );
    }
    if (!input.tenantId) {
      return {
        ok: false,
        provider: this.provider,
        reason: "error",
        message: "Xero push has no tenant id; reconnect the Xero account.",
      };
    }
    const tenantId = input.tenantId;
    const rows = input.rows;
    if (rows.length === 0) return { ok: true, provider: this.provider, pushed: 0 };

    const url = `${XERO_API}/${endpoint}`;
    // Refresh is shared across the whole loop: a single 401 refreshes ONCE and
    // every subsequent row uses the new token (like the QBO adapter's AuthCtx).
    const ctx = { token: input.accessToken, refreshed: false };

    let pushed = 0;
    const pushedSourceIds: string[] = [];
    const pushedInvoiceNumbers: string[] = [];
    const skipped: SkippedInvoice[] = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      const built = bodyFor(row);
      if ("skip" in built) {
        // ISOLATE this ONE invoice — drop it, surface it loudly, keep going.
        skipped.push({ invoiceNumber: row.invoice_number || "(no number)", reason: built.skip });
        continue;
      }
      const one = built.one;
      const body = kind === "invoices" ? { Invoices: [one] } : { Payments: [one] };
      // Stable per-entity key: seed by the immutable CrewFlow row id when we have
      // it, else the row body (deterministic fallback).
      const seed = row.sourceId ?? JSON.stringify(one);
      const key = idempotencyKey(kind, tenantId, seed);

      // ── LIVE PATH (unreachable dark) ───────────────────────────────────────
      let res = await this.post(url, ctx.token, tenantId, key, body);
      if (res.status === 401 && !ctx.refreshed) {
        // Expired/invalid token → refresh ONCE and retry this row with the new token.
        ctx.refreshed = true;
        const fresh = await input.refresh();
        if (!fresh) {
          return {
            ok: false,
            provider: this.provider,
            reason: "error",
            message: "Xero rejected the token and it could not be refreshed.",
            pushed,
            pushedSourceIds,
            pushedInvoiceNumbers,
            skipped,
          };
        }
        ctx.token = fresh;
        res = await this.post(url, ctx.token, tenantId, key, body);
      }

      if (res.networkError) {
        return {
          ok: false,
          provider: this.provider,
          reason: "error",
          message: `Xero push failed: ${res.networkError}`,
          pushed,
          pushedSourceIds,
          pushedInvoiceNumbers,
          skipped,
        };
      }
      if (res.status < 200 || res.status >= 300) {
        if (isPermanentRowRejection(res.status)) {
          // PERMANENT per-row rejection (400 rejected field, 422 duplicate
          // InvoiceNumber / archived contact, …). Xero will never accept THIS
          // row's data on retry, so ISOLATE it — skip + surface loudly, keep
          // pushing the tail — exactly like a map-time skip. Leaving it
          // UNRECORDED (we do NOT increment `pushed` or push its id) lets a
          // corrected row retry on a later sync. An EARLIER poison row no longer
          // re-aborts every later row on every sync.
          skipped.push({
            invoiceNumber: row.invoice_number || "(no number)",
            reason: `Xero rejected this ${kind === "invoices" ? "invoice" : "payment"} (HTTP ${res.status})`,
          });
          continue;
        }
        // TRANSIENT (5xx / 429 / network handled above / 3xx / auth-after-refresh):
        // worth aborting-and-retrying the WHOLE run.
        return {
          ok: false,
          provider: this.provider,
          reason: "error",
          message: `Xero ${kind} push returned ${res.status}`,
          pushed,
          pushedSourceIds,
          pushedInvoiceNumbers,
          skipped,
        };
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

  /** One POST attempt. Never throws — a network failure is reported on the result. */
  private async post(
    url: string,
    accessToken: string,
    tenantId: string,
    idempKey: string,
    body: unknown,
  ): Promise<{ status: number; networkError?: string }> {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "Xero-tenant-id": tenantId,
          "Idempotency-Key": idempKey,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify(body),
      });
      return { status: res.status };
    } catch (e) {
      return { status: 0, networkError: e instanceof Error ? e.message : "network error" };
    }
  }
}

// ── pure JSON shape helpers (Xero Contacts / Invoices responses) ─────────────

type XeroPhone = {
  PhoneType?: string;
  PhoneNumber?: string;
  PhoneAreaCode?: string;
  PhoneCountryCode?: string;
};
type XeroAddress = {
  AddressType?: string;
  AddressLine1?: string;
  City?: string;
  PostalCode?: string;
};
type XeroContact = {
  ContactID?: string;
  Name?: string;
  EmailAddress?: string;
  Phones?: XeroPhone[];
  Addresses?: XeroAddress[];
};
type XeroContactsResponse = { Contacts?: XeroContact[] };
type XeroInvoice = {
  InvoiceID?: string;
  InvoiceNumber?: string;
  Type?: string;
  Status?: string;
  Contact?: { Name?: string };
  SubTotal?: number | string;
  TotalTax?: number | string;
  Total?: number | string;
  Date?: string;
  DateString?: string;
};
type XeroInvoicesResponse = { Invoices?: XeroInvoice[] };

function asArray<T>(v: T[] | undefined | null): T[] {
  return Array.isArray(v) ? v : [];
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

/** The first non-empty Xero phone, assembled from country/area/number parts. */
function firstXeroPhone(phones: XeroPhone[] | undefined): string | null {
  for (const p of asArray(phones)) {
    const parts = [p.PhoneCountryCode, p.PhoneAreaCode, p.PhoneNumber]
      .map((x) => str(x).trim())
      .filter((x) => x.length > 0);
    if (parts.length > 0) return parts.join(" ");
  }
  return null;
}

/**
 * The named field of the first address that carries it, preferring a STREET
 * address over a PO box (Xero returns both types).
 */
function firstXeroAddressField(
  addresses: XeroAddress[] | undefined,
  field: "AddressLine1" | "City" | "PostalCode",
): string | null {
  const list = asArray(addresses);
  const preferred = list.find((a) => a.AddressType === "STREET") ?? list[0];
  return nonEmpty(preferred?.[field]);
}

/** A Xero timestamp/date-string → `YYYY-MM-DD`, or null. Handles `/Date(…)/`. */
function xeroDate(value: string | undefined): string | null {
  if (!value) return null;
  // Xero often returns the .NET epoch form `/Date(1512345600000+0000)/`.
  const epoch = /\/Date\((\d+)/.exec(value);
  if (epoch) {
    const ms = Number(epoch[1]);
    if (Number.isFinite(ms)) return new Date(ms).toISOString().slice(0, 10);
  }
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(value);
  return m ? m[1]! : null;
}

/** Map a Xero invoice Status onto a CrewFlow-writable status (else `sent`). */
function mapXeroInvoiceStatus(status: string | undefined): string {
  switch ((status ?? "").toUpperCase()) {
    case "DRAFT":
      return "draft";
    case "PAID":
      return "paid";
    case "SUBMITTED":
    case "AUTHORISED":
      return "sent";
    default:
      return "sent";
  }
}
