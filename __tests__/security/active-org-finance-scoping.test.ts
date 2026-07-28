import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Active-org scoping — the FINANCE / COMMERCIAL slice must pin by-id access to
 * ctx.org.id. Companion to __tests__/security/active-org-scoping.test.ts, which
 * covers the jobs domain (#456).
 *
 * Why this tier and this style: these are Server Actions / route handlers
 * coupled to createClient + requireOrgContext + cookies(), and the repo has no
 * Supabase mock harness for them — so the invariants are pinned on SOURCE, the
 * documented convention already used by
 * __tests__/security/bank-match-invoice-org-scope.test.ts. The runtime proof
 * against a real multi-org user lives in the integration tier:
 * __tests__/integration/rls/active-org-finance-scoping.test.ts.
 *
 * The invariant: RLS's `current_org_ids()` returns EVERY org the viewer belongs
 * to, and `is_org_admin(org_id)` passes for every org they administer. Neither
 * constrains a query to the ACTIVE org (the `active_org_id` cookie). So a by-id
 * read or write on money — quotes, invoices, customers, leads, expenses,
 * compliance documents, notifications — MUST carry its own org predicate.
 *
 * Every assertion here fails against the pre-fix source.
 */

const ROOT = resolve(__dirname, "..", "..");
const src = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

/** Extract a single exported function body so a sibling can't satisfy an assertion. */
function fn(source: string, name: string): string {
  const start = source.indexOf(`export async function ${name}`);
  expect(start, `${name} not found`).toBeGreaterThan(-1);
  const next = source.indexOf("\nexport async function", start + 1);
  return source.slice(start, next === -1 ? undefined : next);
}

/** The idiom every fixed site must show: capture ctx, then scope by it. */
function expectScopedByCtx(body: string, label: string) {
  expect(body, `${label} must capture the org context`).toMatch(
    /const \{[^}]*\bctx\b[^}]*\} = await requireOrgContext\(\)/,
  );
  expect(body, `${label} must constrain by the active org`).toMatch(
    /\.eq\("org_id", ctx\.org\.id\)/,
  );
}

// ---------------------------------------------------------------- send paths

describe("outward-facing sends — wrong org must never reach the transport", () => {
  it("the invoice SEND route resolves + compares the org BEFORE calling the helper", () => {
    const SRC = src("app/api/invoices/[id]/send/route.ts");
    const F = fn(SRC, "POST");
    expect(F).toMatch(/const \{ ctx \} = await requireOrgContext\(\)/);
    expect(F).toMatch(/inv\.org_id !== ctx\.org\.id/);
    // Ordering is the whole point: a check after the send proves nothing.
    // Both offsets target real code — matching bare identifiers would also hit
    // the surrounding prose and pass for the wrong reason.
    const gate = F.indexOf("inv.org_id !== ctx.org.id");
    const send = F.indexOf("await sendInvoiceEmail(");
    expect(gate).toBeGreaterThan(-1);
    expect(send).toBeGreaterThan(-1);
    expect(gate, "the org gate must precede the send").toBeLessThan(send);
    expect(F, "a foreign id must look missing, not forbidden").toMatch(
      /"not_found"[\s\S]{0,40}status: 404/,
    );
  });

  it("the quote SEND route resolves + compares the org BEFORE calling the helper", () => {
    const SRC = src("app/api/quotes/[id]/send/route.ts");
    const F = fn(SRC, "POST");
    expect(F).toMatch(/const \{ ctx \} = await requireOrgContext\(\)/);
    expect(F).toMatch(/q\.org_id !== ctx\.org\.id/);
    const gate = F.indexOf("q.org_id !== ctx.org.id");
    const send = F.indexOf("await sendQuoteEmail(");
    expect(gate).toBeGreaterThan(-1);
    expect(send).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(send);
  });

  it("the REMIND route keeps its pre-existing org gate (no regression)", () => {
    const F = fn(src("app/api/invoices/[id]/remind/route.ts"), "POST");
    expect(F).toMatch(/inv\.org_id !== ctx\.org\.id/);
    const gate = F.indexOf("inv.org_id !== ctx.org.id");
    const send = F.indexOf("await sendInvoiceEmail(");
    expect(gate).toBeGreaterThan(-1);
    expect(send).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(send);
  });

  it("all three interactive send callers pass the org through to the helper", () => {
    for (const p of [
      "app/api/invoices/[id]/send/route.ts",
      "app/api/invoices/[id]/remind/route.ts",
      "app/api/quotes/[id]/send/route.ts",
    ]) {
      expect(src(p), `${p} should pass orgId`).toMatch(/orgId: ctx\.org\.id/);
    }
  });

  it("sendInvoiceEmail applies orgId to its load, so the helper is a chokepoint", () => {
    const SRC = src("lib/email/send-invoice.ts");
    expect(SRC).toMatch(/orgId\?: string/);
    expect(SRC).toMatch(/\.eq\("org_id", options\.orgId\)/);
    // The predicate must be on the LOAD, before anything is rendered or sent.
    const scope = SRC.indexOf('.eq("org_id", options.orgId)');
    const send = SRC.indexOf("await sendEmail(");
    expect(scope).toBeGreaterThan(-1);
    expect(send).toBeGreaterThan(-1);
    expect(scope).toBeLessThan(send);
  });

  it("sendQuoteEmail applies orgId to its load AND to the portal-token mint", () => {
    const SRC = src("lib/email/send-quote.ts");
    expect(SRC).toMatch(/orgId\?: string/);
    // Three sites: the load, the public_token allocation, the post-send update.
    const hits = SRC.match(/\.eq\("org_id", options\.orgId\)/g) ?? [];
    expect(hits.length, "load + token mint + post-send update").toBeGreaterThanOrEqual(3);
  });

  it("the service-role senders (cron, portal accept) are NOT forced to supply an org", () => {
    // orgId must stay optional: the reminder cron and the public quote-accept
    // path have no active org and own their own scoping. Making it required
    // would either break them or invite a bogus value.
    expect(src("lib/email/send-invoice.ts")).toMatch(/orgId\?: string/);
    expect(src("app/api/cron/invoice-reminders/route.ts")).not.toMatch(/orgId:/);
  });
});

// -------------------------------------------------------------- PDF surfaces

describe("PDF routes — the letterhead and bank details must come from the active org", () => {
  it("the invoice PDF scopes its by-id read", () => {
    const F = fn(src("app/api/invoices/[id]/pdf/route.ts"), "GET");
    expectScopedByCtx(F, "invoice PDF");
    expect(F).toMatch(/\.eq\("id", id\)[\s\S]*?\.eq\("org_id", ctx\.org\.id\)/);
  });

  it("the quote PDF scopes its by-id read", () => {
    const F = fn(src("app/api/quotes/[id]/pdf/route.ts"), "GET");
    expectScopedByCtx(F, "quote PDF");
    expect(F).toMatch(/\.eq\("id", id\)[\s\S]*?\.eq\("org_id", ctx\.org\.id\)/);
  });
});

// ------------------------------------------------------- money route handlers

describe("money route handlers — by-id writes are pinned to the active org", () => {
  it("PATCH /api/invoices/[id] scopes the UPDATE", () => {
    const F = fn(src("app/api/invoices/[id]/route.ts"), "PATCH");
    expectScopedByCtx(F, "invoice PATCH");
    expect(F).toMatch(/\.update\(patch, \{ count: "exact" \}\)[\s\S]*?\.eq\("org_id", ctx\.org\.id\)/);
  });

  it("DELETE /api/invoices/[id] scopes the DELETE", () => {
    const F = fn(src("app/api/invoices/[id]/route.ts"), "DELETE");
    expectScopedByCtx(F, "invoice DELETE");
    expect(F).toMatch(/\.delete\(\{ count: "exact" \}\)[\s\S]*?\.eq\("org_id", ctx\.org\.id\)/);
  });

  it("PATCH /api/finances/[id] scopes the UPDATE", () => {
    const F = fn(src("app/api/finances/[id]/route.ts"), "PATCH");
    expectScopedByCtx(F, "finance PATCH");
    expect(F).toMatch(/\.update\(patch, \{ count: "exact" \}\)[\s\S]*?\.eq\("org_id", ctx\.org\.id\)/);
  });

  it("PATCH /api/finances/[id] STILL maps DB guard refusals to 409 (CIS regression)", () => {
    // The org predicate must not displace the settlement/CIS refusal mapping —
    // a foreign row now matches nothing and 404s, but a genuine in-org row must
    // still surface the guard's 409 with its recovery path.
    const F = fn(src("app/api/finances/[id]/route.ts"), "PATCH");
    expect(F).toMatch(/financeWriteRefusal\(error\.code, error\.message\)/);
    expect(F).toMatch(/status: refusal\.status/);
    // The predicate is applied on the query; the refusal mapping happens after
    // it, on the resulting error — so the guard can still fire for in-org rows.
    const scope = F.indexOf('.eq("org_id", ctx.org.id)');
    const refusal = F.indexOf("financeWriteRefusal(error.code");
    expect(scope).toBeGreaterThan(-1);
    expect(refusal).toBeGreaterThan(-1);
    expect(scope).toBeLessThan(refusal);
  });

  it("DELETE /api/finances/[id] scopes BOTH the receipt lookup and the delete", () => {
    const F = fn(src("app/api/finances/[id]/route.ts"), "DELETE");
    expectScopedByCtx(F, "finance DELETE");
    // The receipt read gates a service-role storage removal, so it must agree
    // with the delete's scope or a foreign id could surface another org's path.
    const hits = F.match(/\.eq\("org_id", ctx\.org\.id\)/g) ?? [];
    expect(hits.length, "receipt lookup + delete").toBeGreaterThanOrEqual(2);
  });
});

// ------------------------------------------------------------ quotes actions

describe("quotes actions — reads and writes pinned to the active org", () => {
  const ACTIONS = src("app/(app)/quotes/actions.ts");

  for (const name of [
    "updateQuote",
    "sendQuote",
    "requestQuoteApproval",
    "reviewQuote",
    "deleteQuote",
    "acceptQuoteAsOwner",
    "declineQuoteAsOwner",
  ]) {
    it(`${name} captures ctx and scopes by org_id`, () => {
      expectScopedByCtx(fn(ACTIONS, name), name);
    });
  }

  it("updateQuote bails when the quote is not resolvable in the active org", () => {
    // The line-item replacement below it is a DELETE keyed on quote_id, so
    // proceeding past an unresolvable quote would wipe another org's lines.
    const F = fn(ACTIONS, "updateQuote");
    const guard = F.indexOf("if (!existing)");
    const del = F.indexOf('from("quote_line_items")');
    expect(guard, "must refuse before the destructive replacement").toBeGreaterThan(-1);
    expect(del).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(del);
  });

  it("updateQuote scopes the line-item delete and stamps lines from ctx, not a re-read row", () => {
    const F = fn(ACTIONS, "updateQuote");
    expect(F).toMatch(/from\("quote_line_items"\)[\s\S]*?\.eq\("quote_id", id\)[\s\S]*?\.eq\("org_id", ctx\.org\.id\)/);
    expect(F).toMatch(/org_id: ctx\.org\.id/);
    // The retention-ledger shape from #456: copying a row's own org_id
    // faithfully writes into whichever org it belonged to.
    expect(F).not.toMatch(/org_id: parent\.org_id/);
  });

  it("deleteQuote scopes the DELETE to match its org-scoped dependency guard", () => {
    // The invoice dependency check is scoped to ctx.org.id. An unscoped delete
    // made that guard actively misleading for a foreign quote: it found no
    // dependents in the ACTIVE org and then deleted the row anyway.
    const F = fn(ACTIONS, "deleteQuote");
    expect(F).toMatch(/from\("quotes"\)[\s\S]*?\.delete\(\)[\s\S]*?\.eq\("id", id\)[\s\S]*?\.eq\("org_id", ctx\.org\.id\)/);
  });

  it("acceptQuoteAsOwner stamps every downstream row from ctx, never from the quote row", () => {
    const F = fn(ACTIONS, "acceptQuoteAsOwner");
    // Job, invoice, number allocation and automation dispatch all used to be
    // stamped from quote.org_id — so accepting another org's quote created a
    // job and an invoice, and emailed it, in THAT org.
    expect(F).not.toMatch(/org_id: quote\.org_id/);
    expect(F).not.toMatch(/target_org: quote\.org_id/);
    expect(F).toMatch(/target_org: ctx\.org\.id/);
    expect(F).toMatch(/org_id: ctx\.org\.id/);
  });

  it("acceptQuoteAsOwner scopes the accepting UPDATE before anything downstream runs", () => {
    const F = fn(ACTIONS, "acceptQuoteAsOwner");
    const scope = F.indexOf('.eq("org_id", ctx.org.id)');
    const job = F.indexOf('from("jobs")');
    expect(scope).toBeGreaterThan(-1);
    expect(job).toBeGreaterThan(-1);
    expect(scope).toBeLessThan(job);
  });

  it("acceptQuoteAsOwner passes the active org into the auto-email", () => {
    expect(fn(ACTIONS, "acceptQuoteAsOwner")).toMatch(/orgId: ctx\.org\.id/);
  });

  it("reviewQuote scopes the quote read, so approver rights are spent in the right org", () => {
    // requireQuoteApprover(ctx.org.id) proves owner/admin of the ACTIVE org.
    // An unscoped read let that right be exercised on another org's quote.
    const F = fn(ACTIONS, "reviewQuote");
    expect(F).toMatch(/from\("quotes"\)[\s\S]*?\.eq\("id", id\)[\s\S]*?\.eq\("org_id", ctx\.org\.id\)/);
    const approver = F.indexOf("requireQuoteApprover");
    const read = F.indexOf('.eq("org_id", ctx.org.id)');
    expect(approver).toBeLessThan(read);
  });

  it("createVariation resolves the job through the active-org chokepoint", () => {
    const F = fn(ACTIONS, "createVariation");
    expect(F).toMatch(/loadJobForOrg[\s\S]{0,200}?ctx\.org\.id/);
    expect(F).not.toMatch(/from\("jobs"\)[\s\S]{0,160}?\.eq\("id", jobId\)\s*\.maybeSingle\(\)/);
    // Everything the variation is stamped with came from the job row.
    expect(F).not.toMatch(/org_id: job\.org_id/);
    expect(F).not.toMatch(/target_org: job\.org_id/);
    const load = F.indexOf("loadJobForOrg");
    const insert = F.indexOf('from("quotes")');
    expect(load).toBeLessThan(insert);
  });

  it("createQuote scopes the lead it advances (blended dropdown, #456's form-helpers class)", () => {
    const F = fn(ACTIONS, "createQuote");
    expect(F).toMatch(/from\("leads"\)[\s\S]*?\.eq\("id", parsed\.data\.lead_id\)[\s\S]*?\.eq\("org_id", ctx\.org\.id\)/);
  });
});

// --------------------------------------------------------- customers actions

describe("customers actions — by-id writes pinned to the active org", () => {
  const ACTIONS = src("app/(app)/customers/actions.ts");

  for (const name of ["updateCustomer", "rotateCustomerPortalToken", "deleteCustomer"]) {
    it(`${name} captures ctx and scopes by org_id`, () => {
      expectScopedByCtx(fn(ACTIONS, name), name);
    });
  }

  it("rotateCustomerPortalToken cannot invalidate another org's live portal link", () => {
    // Rotation immediately kills the link the customer already holds, with no
    // trace on the screen that did it.
    expect(fn(ACTIONS, "rotateCustomerPortalToken")).toMatch(
      /\.eq\("id", id\)[\s\S]*?\.eq\("org_id", ctx\.org\.id\)/,
    );
  });
});

// ------------------------------------------------------------- leads actions

describe("leads actions — by-id writes pinned to the active org", () => {
  const ACTIONS = src("app/(app)/leads/actions.ts");

  for (const name of ["updateLead", "moveLeadStage", "deleteLead"]) {
    it(`${name} captures ctx and scopes by org_id`, () => {
      expectScopedByCtx(fn(ACTIONS, name), name);
    });
  }

  it("deleteLead — the irreversible one — carries the predicate", () => {
    expect(fn(ACTIONS, "deleteLead")).toMatch(
      /\.delete\(\{ count: "exact" \}\)[\s\S]*?\.eq\("org_id", ctx\.org\.id\)/,
    );
  });

  it("acknowledgeLead's follow-up writes restate the scope its guard establishes", () => {
    const F = fn(ACTIONS, "acknowledgeLead");
    const hits = F.match(/\.eq\("org_id", ctx\.org\.id\)/g) ?? [];
    expect(hits.length, "resolve guard + both status writes").toBeGreaterThanOrEqual(3);
  });
});

// -------------------------------------------------------- compliance actions

describe("compliance actions — the signed-URL read is scoped", () => {
  it("getComplianceDocSignedUrl scopes its read to the active org", () => {
    // Whatever path this read returns WILL be signed by the service-role
    // client below it, so the read is the only gate.
    const F = fn(src("app/(app)/compliance/actions.ts"), "getComplianceDocSignedUrl");
    expectScopedByCtx(F, "getComplianceDocSignedUrl");
    expect(F).toMatch(/\.eq\("id", id\)[\s\S]*?\.eq\("org_id", ctx\.org\.id\)/);
    const scope = F.indexOf('.eq("org_id", ctx.org.id)');
    const sign = F.indexOf("createSignedUrl");
    expect(scope).toBeLessThan(sign);
  });

  it("the storage-path check is kept as a SEPARATE control, not replaced", () => {
    // storagePathBelongsToOrg proves the path matches the ROW's org; the new
    // predicate proves the row is in the ACTIVE org. Different questions.
    const F = fn(src("app/(app)/compliance/actions.ts"), "getComplianceDocSignedUrl");
    expect(F).toMatch(/storagePathBelongsToOrg\(row\.storage_path, row\.org_id\)/);
  });
});

// ----------------------------------------------------- notifications actions

describe("notification mutations — pinned to the active org", () => {
  const ACTIONS = src("app/(app)/notifications/actions.ts");
  const SVC = src("server/services/notifications-service.ts");

  for (const name of ["markRead", "markAllRead", "dismiss"]) {
    it(`${name} captures ctx and passes the active org to the service`, () => {
      const F = fn(ACTIONS, name);
      expect(F).toMatch(/const \{ ctx \} = await requireOrgContext\(\)/);
      expect(F).toMatch(/orgId: ctx\.org\.id/);
    });
  }

  it("the tenant-side service applies orgId on the user-JWT branch", () => {
    expect(SVC).toMatch(/\.eq\("org_id" as never, options\.orgId\)/);
    expect(SVC).toMatch(/\.eq\("org_id" as never, scope\.orgId\)/);
  });

  it("markAllNotificationsRead — no id, no filter — is confined by orgId", () => {
    // The widest write in the slice: one click marked every unread row across
    // every org the viewer belonged to.
    const F = fn(SVC, "markAllNotificationsRead");
    expect(F).toMatch(/scope\.orgId[\s\S]*?\.eq\("org_id" as never, scope\.orgId\)/);
  });

  it("the HQ (admin-client) branches stay cross-org by design", () => {
    // app/admin/notifications/** is HQ-internal and has no tenant org context;
    // forcing a predicate there would be wrong, not safer.
    expect(src("app/admin/notifications/actions.ts")).not.toMatch(/orgId: ctx\.org\.id/);
  });
});

// ------------------------------------------------------------------- skipped

describe("scope note — what this slice deliberately does not claim", () => {
  it("expenses approve/reject were ALREADY protected upstream (no change needed)", () => {
    // approveExpenseDraftAction delegates to approveExpenseDraft, which does its
    // own requireOrgContext + `.eq("org_id", ctx.org.id)` resolve before any
    // write. Pinned so a future refactor cannot quietly remove that and leave
    // the thin action looking safe.
    const SVC = src("server/services/expense-drafts.ts");
    const F = fn(SVC, "approveExpenseDraft");
    expect(F).toMatch(/const \{ ctx[^}]*\} = await requireOrgContext\(\)/);
    expect(F).toMatch(/\.eq\("id", parsed\.draft_id\)[\s\S]*?\.eq\("org_id", ctx\.org\.id\)/);
    const scope = F.indexOf('.eq("org_id", ctx.org.id)');
    const insert = F.indexOf('from("finances")');
    expect(scope, "the org resolve must precede the finances INSERT").toBeLessThan(insert);
  });

  it("suppliers/actions.ts is NO LONGER excluded — the deferred slice has shipped", () => {
    // WAS: "EXCLUDED from this slice (concurrent CIS lane)" — a placeholder that
    // only asserted the file existed, documenting a gap rather than covering it.
    // The CIS M4 lane it was waiting on has landed, so the gap is closed. Full
    // coverage of the supplier surface now lives in
    //   __tests__/security/active-org-supplier-scoping.test.ts   (source pins)
    //   __tests__/integration/rls/supplier-active-org.test.ts    (real Postgres)
    // The two write predicates are restated HERE as well, so deleting the
    // dedicated file cannot quietly reopen the hole this slice deferred.
    const SRC = src("app/(app)/suppliers/actions.ts");
    expect(fn(SRC, "updateSupplier")).toMatch(
      /\.eq\("id", id\)[\s\S]*?\.eq\("org_id", ctx\.org\.id\)/,
    );
    expect(fn(SRC, "deleteSupplier")).toMatch(
      /\.eq\("id", id\)[\s\S]*?\.eq\("org_id", ctx\.org\.id\)/,
    );
  });
});
