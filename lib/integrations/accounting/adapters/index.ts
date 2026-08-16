/**
 * Accounting adapters — resolver + readiness.
 *
 * One place to obtain a provider adapter, and one place that answers "which
 * export paths are live in this build". The CSV path is a BUILD-TIME fact —
 * always ready, no credentials, mirroring the API-key readiness idiom
 * (lib/integrations/readiness.ts). The provider paths are RUNTIME facts, gated
 * on their OAuth credentials, so they read the environment through the adapters
 * — and both are dark today.
 */

import type {
  AccountingAdapter,
  AccountingImportAdapter,
  AccountingProvider,
} from "./types";
import { XeroAdapter } from "./xero";
import { QuickBooksAdapter } from "./quickbooks";

// One instance per provider satisfies BOTH the push (AccountingAdapter) and the
// pull (AccountingImportAdapter) contracts — same class, same two-switch gate.
const ADAPTERS: Record<AccountingProvider, XeroAdapter | QuickBooksAdapter> = {
  xero: new XeroAdapter(),
  quickbooks: new QuickBooksAdapter(),
};

/** Resolve the PUSH adapter for a provider. */
export function getAccountingAdapter(
  provider: AccountingProvider,
): AccountingAdapter {
  return ADAPTERS[provider];
}

/** Resolve the IMPORT (PULL) adapter for a provider. Same instance as the push adapter. */
export function getAccountingImportAdapter(
  provider: AccountingProvider,
): AccountingImportAdapter {
  return ADAPTERS[provider];
}

/** The CSV export needs no credentials — it is always ready. Build-time fact. */
export function accountingCsvReady(): boolean {
  return true;
}

/** Xero API push is ready only when its OAuth credentials are configured (dark today). */
export function xeroReady(): boolean {
  return ADAPTERS.xero.isAvailable();
}

/** QuickBooks API push is ready only when its OAuth credentials are configured (dark today). */
export function quickbooksReady(): boolean {
  return ADAPTERS.quickbooks.isAvailable();
}

export type AccountingReadiness = {
  csv: boolean;
  xero: boolean;
  quickbooks: boolean;
};

/** One snapshot of the accounting export paths' readiness. */
export function getAccountingReadiness(): AccountingReadiness {
  return {
    csv: accountingCsvReady(),
    xero: xeroReady(),
    quickbooks: quickbooksReady(),
  };
}

export type { AccountingAdapter, AccountingProvider } from "./types";
export type { AccountingPushResult, AccountingPushInput } from "./types";
export type {
  AccountingImportAdapter,
  AccountingPullInput,
  AccountingPullResult,
  PulledContact,
  PulledInvoice,
} from "./types";
