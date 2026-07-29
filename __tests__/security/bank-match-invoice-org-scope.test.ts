import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * confirmBankMatch — cross-tenant write on invoice_id.
 *
 * `confirmBankMatch` org-checked the bank statement line but took `invoice_id`
 * straight from the form, UUID-validated it, and inserted it. Nothing
 * downstream re-checked it, because nothing downstream can:
 *
 *   1. invoice_payments' INSERT policy is
 *        with check (public.is_org_member(org_id))
 *      (20260524000000_payment_tracking.sql:69-71). It constrains only the
 *      `org_id` column — which the action sets to the CALLER's own org — and
 *      never references `invoice_id`. An insert naming another org's invoice
 *      satisfies the policy.
 *   2. _tg_invoice_payments_sync_status is `security definer`
 *      (20260618000000_fix_invoice_payments_sync_trigger.sql:23). It then reads
 *      the named invoice and writes its status with RLS bypassed.
 *
 * So a member of org A could record a payment against org B's invoice and move
 * that invoice's status — a cross-tenant write. RLS could not stop it: the
 * policy protects the row being inserted, not the foreign key it points at.
 *
 * The guard therefore has to live in the action, which is why these assertions
 * exist. The sibling `addInvoicePayment` already resolves its invoice through
 * the RLS client; this brings confirmBankMatch to the same standard.
 *
 * Source-contract test per the repo's documented convention for server actions:
 * they are coupled to createClient/requireOrgContext/redirect and there is no
 * Supabase mock harness, so the invariants are pinned on source (see the header
 * of __tests__/payments/record-payment.test.ts). These assertions fail against
 * the pre-fix source.
 */

const ROOT = resolve(__dirname, "..", "..");
const SRC = readFileSync(resolve(ROOT, "app/(app)/payments/actions.ts"), "utf8");

/** confirmBankMatch's body only — so nothing here can be satisfied by a sibling action. */
const FN = (() => {
  const start = SRC.indexOf("export async function confirmBankMatch");
  expect(start).toBeGreaterThan(-1);
  const next = SRC.indexOf("\nexport async function", start + 1);
  return SRC.slice(start, next === -1 ? undefined : next);
})();

describe("confirmBankMatch — the invoice must belong to the caller's org", () => {
  it("resolves the target invoice before recording a payment against it", () => {
    expect(FN).toMatch(/\.from\("invoices"\)[\s\S]*?\.eq\("id", targetInvoiceId\)/);
  });

  it("re-checks the resolved invoice's org_id against the caller's org", () => {
    expect(FN).toMatch(/inv\.org_id !== ctx\.org\.id/);
  });

  it("fails closed when the invoice does not resolve", () => {
    // Another org's invoice is filtered out by the invoices SELECT policy
    // (`org_id in (select current_org_ids())`), so it arrives here as no row.
    // The action returns FormState (see the file header for the router race),
    // so failing closed is `return formError(...)`, not a redirect.
    expect(FN).toMatch(/if \(!inv\) return formError\(/);
  });

  it("performs BOTH checks before the invoice_payments insert, not after", () => {
    const orgCheckIdx = FN.indexOf("inv.org_id !== ctx.org.id");
    const insertIdx = FN.indexOf('.from("invoice_payments")');
    expect(orgCheckIdx).toBeGreaterThan(-1);
    expect(insertIdx).toBeGreaterThan(-1);
    expect(orgCheckIdx).toBeLessThan(insertIdx);
  });

  it("resolves the invoice on the RLS client, never the admin client", () => {
    // createAdminClient would bypass the very policy that scopes invoices to
    // the caller's orgs, reducing this to the explicit check alone.
    expect(FN).not.toMatch(/createAdminClient/);
    expect(SRC).toMatch(/import \{ createClient \} from "@\/lib\/supabase\/server"/);
  });

  it("still org-checks the bank line — the pre-existing guard is untouched", () => {
    expect(FN).toMatch(/line\.org_id !== ctx\.org\.id/);
  });

  it("keeps writing the caller's own org_id on the payment row", () => {
    // The insert must never adopt the invoice's org_id to 'satisfy' the check —
    // that would re-open the hole in a subtler way.
    expect(FN).toMatch(/org_id: ctx\.org\.id/);
    expect(FN).not.toMatch(/org_id: inv\.org_id/);
  });
});
