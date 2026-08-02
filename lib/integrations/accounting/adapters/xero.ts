/**
 * Xero accounting adapter — DARK.
 *
 * This adapter is a SEAM, not a live integration. It reads its OAuth
 * credentials from the environment and, because they are never set today,
 * reports itself unavailable and pushes NOTHING. There is deliberately no
 * `fetch`, no Xero SDK import and no client construction anywhere in this file:
 * a credential alone could not cause a network call, and the absence of one
 * guarantees the dark path. Activation is a pure configuration act — supply the
 * three env vars below and implement the push body behind the availability
 * guard — with no change to the export pipeline that feeds it.
 *
 * ACTIVATION (future): set XERO_CLIENT_ID, XERO_CLIENT_SECRET and
 * XERO_TENANT_ID, then build the Accounting API calls INSIDE `pushInvoices` /
 * `pushPayments`, AFTER the `isAvailable()` guard. Until then this stays a
 * no-op that can never reach a Xero server.
 */

import type {
  AccountingAdapter,
  AccountingPushResult,
} from "./types";
import { unavailable } from "./types";
import type { CanonicalAccountingRow } from "../canonical";

/** The env vars whose presence would make Xero available. */
const XERO_ENV = ["XERO_CLIENT_ID", "XERO_CLIENT_SECRET", "XERO_TENANT_ID"] as const;

const DARK_MESSAGE =
  "Xero is not connected. Add the Xero OAuth credentials to enable API push; " +
  "the CSV export works today without it.";

export class XeroAdapter implements AccountingAdapter {
  readonly provider = "xero" as const;

  isAvailable(): boolean {
    // Every credential must be present and non-empty. A pure env read.
    return XERO_ENV.every((k) => {
      const v = process.env[k];
      return typeof v === "string" && v.trim().length > 0;
    });
  }

  async pushInvoices(
    _rows: readonly CanonicalAccountingRow[],
  ): Promise<AccountingPushResult> {
    // DARK GUARD FIRST. With no credentials we return without touching the
    // network. The push body (Accounting API) belongs strictly after this
    // guard, so it is unreachable until credentials exist.
    if (!this.isAvailable()) return unavailable(this.provider, DARK_MESSAGE);
    // Credentials present but the push body is not yet implemented — still no
    // live call is made from this build.
    return {
      ok: false,
      provider: this.provider,
      reason: "error",
      message: "Xero push is configured but not yet activated in this build.",
    };
  }

  async pushPayments(
    _rows: readonly CanonicalAccountingRow[],
  ): Promise<AccountingPushResult> {
    if (!this.isAvailable()) return unavailable(this.provider, DARK_MESSAGE);
    return {
      ok: false,
      provider: this.provider,
      reason: "error",
      message: "Xero push is configured but not yet activated in this build.",
    };
  }
}
