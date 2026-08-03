import "server-only";
import { createHash } from "node:crypto";

import { isProviderConnectable } from "../oauth";
import type {
  AccountingAdapter,
  AccountingPushInput,
  AccountingPushResult,
} from "./types";
import { unavailable } from "./types";
import {
  buildXeroInvoicesBody,
  buildXeroPaymentsBody,
} from "../provider-payloads";

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
 * ── THE PUSH ─────────────────────────────────────────────────────────────────
 * Canonical rows → the pure body builders (provider-payloads.ts) → POST to the
 * Xero Accounting API with `Authorization: Bearer` + `Xero-tenant-id`. On a 401
 * the request is retried ONCE after a token refresh (the input's `refresh`
 * callback). An `Idempotency-Key` derived from the payload lets Xero collapse a
 * duplicate push (e.g. a retried action) into a single write.
 */

const XERO_API = "https://api.xero.com/api.xro/2.0";

/** Stable idempotency key for a request body — identical rows ⇒ identical key. */
function idempotencyKey(kind: string, tenantId: string, body: unknown): string {
  const h = createHash("sha256")
    .update(`${kind}:${tenantId}:${JSON.stringify(body)}`)
    .digest("hex");
  return `crewflow-xero-${kind}-${h.slice(0, 32)}`;
}

export class XeroAdapter implements AccountingAdapter {
  readonly provider = "xero" as const;

  isAvailable(): boolean {
    return isProviderConnectable(this.provider);
  }

  async pushInvoices(input: AccountingPushInput): Promise<AccountingPushResult> {
    return this.push("invoices", input, buildXeroInvoicesBody(input.rows));
  }

  async pushPayments(input: AccountingPushInput): Promise<AccountingPushResult> {
    // Bank account code the receipts land in. Configurable via env with a sane
    // Xero default ("090" is Xero's standard Bank account code); not a secret.
    const bankCode = process.env.XERO_BANK_ACCOUNT_CODE?.trim() || "090";
    return this.push(
      "payments",
      input,
      buildXeroPaymentsBody(input.rows, bankCode),
    );
  }

  /** Shared POST with Bearer + tenant header, idempotency, and 401→refresh→retry. */
  private async push(
    kind: "invoices" | "payments",
    input: AccountingPushInput,
    body: { Invoices?: unknown[]; Payments?: unknown[] },
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
    const count = input.rows.length;
    if (count === 0) return { ok: true, provider: this.provider, pushed: 0 };

    const url = `${XERO_API}/${kind === "invoices" ? "Invoices" : "Payments"}`;
    const key = idempotencyKey(kind, input.tenantId, body);

    // ── LIVE PATH (unreachable dark) ─────────────────────────────────────────
    let res = await this.post(url, input.accessToken, input.tenantId, key, body);
    if (res.status === 401) {
      // Expired/invalid token → refresh ONCE and retry with the new token.
      const fresh = await input.refresh();
      if (!fresh) {
        return {
          ok: false,
          provider: this.provider,
          reason: "error",
          message: "Xero rejected the token and it could not be refreshed.",
        };
      }
      res = await this.post(url, fresh, input.tenantId, key, body);
    }

    if (res.networkError) {
      return {
        ok: false,
        provider: this.provider,
        reason: "error",
        message: `Xero push failed: ${res.networkError}`,
      };
    }
    if (res.status < 200 || res.status >= 300) {
      return {
        ok: false,
        provider: this.provider,
        reason: "error",
        message: `Xero ${kind} push returned ${res.status}`,
      };
    }
    return { ok: true, provider: this.provider, pushed: count };
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
