/**
 * QuickBooks Online accounting adapter — DARK.
 *
 * The Xero adapter's twin: a credential-gated SEAM with no live behaviour. It
 * reads its OAuth credentials from the environment, finds none (always, today),
 * and reports itself unavailable so `pushInvoices` / `pushPayments` return
 * without any network call. There is no `fetch`, no Intuit SDK import and no
 * client construction in this file — the dark path is structural, not a runtime
 * flag someone could flip by accident.
 *
 * ACTIVATION (future): set QUICKBOOKS_CLIENT_ID, QUICKBOOKS_CLIENT_SECRET and
 * QUICKBOOKS_REALM_ID, then implement the QBO API calls INSIDE the push methods
 * AFTER the `isAvailable()` guard. The export pipeline feeding this adapter does
 * not change.
 */

import type {
  AccountingAdapter,
  AccountingPushResult,
} from "./types";
import { unavailable } from "./types";
import type { CanonicalAccountingRow } from "../canonical";

/** The env vars whose presence would make QuickBooks available. */
const QBO_ENV = [
  "QUICKBOOKS_CLIENT_ID",
  "QUICKBOOKS_CLIENT_SECRET",
  "QUICKBOOKS_REALM_ID",
] as const;

const DARK_MESSAGE =
  "QuickBooks is not connected. Add the QuickBooks OAuth credentials to enable " +
  "API push; the CSV export works today without it.";

export class QuickBooksAdapter implements AccountingAdapter {
  readonly provider = "quickbooks" as const;

  isAvailable(): boolean {
    return QBO_ENV.every((k) => {
      const v = process.env[k];
      return typeof v === "string" && v.trim().length > 0;
    });
  }

  async pushInvoices(
    _rows: readonly CanonicalAccountingRow[],
  ): Promise<AccountingPushResult> {
    if (!this.isAvailable()) return unavailable(this.provider, DARK_MESSAGE);
    return {
      ok: false,
      provider: this.provider,
      reason: "error",
      message:
        "QuickBooks push is configured but not yet activated in this build.",
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
      message:
        "QuickBooks push is configured but not yet activated in this build.",
    };
  }
}
