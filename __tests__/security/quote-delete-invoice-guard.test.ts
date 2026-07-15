import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * deleteQuote — refuse when invoices still depend on the quote.
 *
 * `invoices.quote_id` is `on delete set null`, so deleting a quote never
 * errored. It silently orphaned the invoice, and every consequence was
 * invisible from the quote screen:
 *
 *   - the invoice DISAPPEARS from the customer's portal — both the overview and
 *     the invoices list scope by the customer's quote ids;
 *   - its portal PDF 404s — ownership resolves through quote -> customer;
 *   - its PDF and emailed copy render a correct total with NO line items, which
 *     are read from quote_line_items via quote_id;
 *   - the reminder cron stops chasing it FOREVER — the recipient also resolves
 *     through quote -> customer, and a missing address is silently counted as
 *     skipped.
 *
 * The money stays owed and nothing pursues it. Any member could trigger it, and
 * the confirm dialog disclosed only the reference-clearing, none of the above.
 *
 * This is the stop-the-bleeding guard: it prevents NEW orphans. Repairing
 * existing ones (denormalising customer_id) and snapshotting line items onto
 * invoices are separate, larger changes and are deliberately not attempted.
 *
 * Source-contract per the repo convention for server actions — they are coupled
 * to createClient/requireOrgContext/redirect and there is no Supabase mock
 * harness (see the header of __tests__/payments/record-payment.test.ts).
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

const ACTIONS = read("app/(app)/quotes/actions.ts");
const PAGE = read("app/(app)/quotes/[id]/page.tsx");

/** deleteQuote's own body — nothing here can be satisfied by a sibling action. */
const FN = (() => {
  const start = ACTIONS.indexOf("export async function deleteQuote");
  expect(start).toBeGreaterThan(-1);
  const next = ACTIONS.indexOf("\nexport async function", start + 1);
  return ACTIONS.slice(start, next === -1 ? undefined : next);
})();

/**
 * The same body with comments stripped.
 *
 * Assertions about what the code does NOT do must run against code alone: the
 * guard's comment legitimately names `on delete set null`, the reminder cron
 * and the portal to explain WHY it exists, and prose describing a hazard must
 * not be mistaken for committing it.
 */
const FN_CODE = FN.split("\n")
  .filter((line) => {
    const t = line.trim();
    return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
  })
  .join("\n");

describe("deleteQuote — quotes with dependent invoices cannot be deleted", () => {
  it("checks for dependent invoices before deleting", () => {
    expect(FN).toMatch(/\.from\("invoices"\)[\s\S]*?\.eq\("quote_id", id\)/);
  });

  it("runs the dependency check BEFORE the delete, not after", () => {
    const checkIdx = FN.indexOf('.from("invoices")');
    const deleteIdx = FN.indexOf('.from("quotes").delete()');
    expect(checkIdx).toBeGreaterThan(-1);
    expect(deleteIdx).toBeGreaterThan(-1);
    expect(checkIdx).toBeLessThan(deleteIdx);
  });

  it("rejects the deletion when any dependent invoice exists", () => {
    expect(FN).toMatch(/if \(\(dependents \?\? \[\]\)\.length > 0\)/);
    expect(FN).toMatch(/error=has_invoices/);
  });

  it("preserves the quote on rejection — the reject path never reaches the delete", () => {
    const rejectIdx = FN.indexOf("error=has_invoices");
    const deleteIdx = FN.indexOf('.from("quotes").delete()');
    expect(rejectIdx).toBeLessThan(deleteIdx);
    // redirect() throws, so the delete is unreachable once we reject.
    expect(FN).toMatch(/redirect\(`\/quotes\/\$\{id\}\?error=has_invoices`\)/);
  });
});

describe("deleteQuote — fails closed", () => {
  it("refuses the delete if the dependency check itself errors", () => {
    // A check that fails OPEN is worse than no check: it reads as a guarantee
    // while silently permitting the orphan.
    expect(FN).toMatch(/if \(depErr\)/);
    expect(FN).toMatch(/error=delete_check_failed/);
  });

  it("the error branch precedes the delete", () => {
    const errIdx = FN.indexOf("error=delete_check_failed");
    const deleteIdx = FN.indexOf('.from("quotes").delete()');
    expect(errIdx).toBeGreaterThan(-1);
    expect(errIdx).toBeLessThan(deleteIdx);
  });

  it("logs the failure rather than swallowing it", () => {
    expect(FN).toMatch(/console\.error\("\[quotes\] invoice dependency check failed"/);
  });
});

describe("deleteQuote — organisation isolation", () => {
  it("scopes the dependency check to the ACTIVE org, not merely to RLS", () => {
    // invoices' SELECT policy is `org_id in (select current_org_ids())`, which
    // spans EVERY org the caller belongs to. Without this, a multi-org user's
    // other org could decide this org's deletion.
    expect(FN).toMatch(/\.eq\("org_id", ctx\.org\.id\)/);
  });

  it("resolves org context before the check", () => {
    expect(FN).toMatch(/const \{ ctx \} = await requireOrgContext\(\)/);
    const ctxIdx = FN.indexOf("requireOrgContext()");
    const checkIdx = FN.indexOf('.from("invoices")');
    expect(ctxIdx).toBeLessThan(checkIdx);
  });

  it("pairs quote_id with org_id — neither filter alone", () => {
    expect(FN).toMatch(
      /\.eq\("quote_id", id\)[\s\S]*?\.eq\("org_id", ctx\.org\.id\)/,
    );
  });
});

describe("deleteQuote — quotes without invoices still delete exactly as before", () => {
  it("keeps the original delete, its error branch and redirects", () => {
    expect(FN).toMatch(/\.from\("quotes"\)\.delete\(\)\.eq\("id", id\)/);
    expect(FN).toMatch(/error=delete_failed/);
    expect(FN).toMatch(/revalidatePath\("\/quotes"\)/);
    expect(FN).toMatch(/redirect\("\/quotes"\)/);
  });

  it("adds no soft-delete and no schema DDL", () => {
    expect(FN_CODE).not.toMatch(/deleted_at|soft_delete/i);
    // Match the actual SQL clause, not the bare words: `/on delete/i` alone
    // matches the substring inside `functi[on delete]Quote` and would fire on
    // any correct implementation.
    expect(FN_CODE).not.toMatch(
      /alter table|on delete (cascade|set null|restrict)/i,
    );
  });
});

describe("deleteQuote — scope discipline", () => {
  it("does not repair existing orphans or denormalise customer data", () => {
    expect(FN_CODE).not.toMatch(/customer_id:/);
    expect(FN_CODE).not.toMatch(/\.update\(/);
  });

  it("does not touch conversion, reminders or portal behaviour", () => {
    expect(FN_CODE).not.toMatch(
      /invoice_line_items|createInvoice|reminder|portal/i,
    );
  });

  it("leaves quote_line_items to the existing FK cascade", () => {
    expect(FN_CODE).not.toMatch(/from\("quote_line_items"\)/);
  });
});

describe("user-facing explanation", () => {
  it("explains WHY the quote can't be deleted", () => {
    expect(PAGE).toMatch(/has_invoices:/);
    expect(PAGE).toMatch(/invoices were created from it/);
  });

  it("suggests no destructive workaround", () => {
    const msg = PAGE.slice(PAGE.indexOf("has_invoices:"), PAGE.indexOf("delete_check_failed:"));
    expect(msg).not.toMatch(/delete .*invoice|void|remove .*invoice/i);
  });

  it("explains the fail-closed case honestly (nothing was deleted)", () => {
    expect(PAGE).toMatch(/delete_check_failed:/);
    expect(PAGE).toMatch(/nothing was deleted/i);
  });

  it("delete copy no longer promises invoices merely lose their reference", () => {
    // The old copy described behaviour that can no longer happen; leaving it
    // would actively mislead.
    expect(PAGE).not.toMatch(/lose the quote reference/);
    expect(PAGE).not.toMatch(/quote reference cleared but otherwise stays put/);
  });
});
