import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Active-org scoping — the WRITE slice. Every by-id MUTATION in these action
 * files must pin to `ctx.org.id`.
 *
 * The read side of this defect class is closed (#456 jobs, #459 finance reads +
 * route handlers, #461 rota, #463 suppliers, #464 asset/QR, #468 list pages).
 * Train 22's sweep then enumerated what was left: unpinned by-id reads and
 * writes *inside* Server Actions. That is this file.
 *
 * The invariant, unchanged across the whole class: every policy in this schema
 * is `org_id in current_org_ids()` or `is_org_admin(org_id)`, and BOTH admit
 * EVERY org the viewer belongs to. Neither constrains a query to the ACTIVE org
 * (the `active_org_id` cookie → `requireOrgContext()`). RLS is the outer tenant
 * boundary and is untouched by anything here; this is the inner, active-org
 * scope. A dual-org member is a legitimate member of both orgs, so these are
 * correctness / data-integrity defects rather than cross-tenant breaches — but
 * on the financial surfaces the consequences are money and irreversible state.
 *
 * Why this tier and this style: these are "use server" Server Actions coupled to
 * `createClient` + `requireOrgContext` + `cookies()`, and the repo has no
 * Supabase mock harness for them — so the invariants are pinned on SOURCE, the
 * documented convention already used by the companion files:
 *   __tests__/security/active-org-scoping.test.ts          (jobs, #456)
 *   __tests__/security/active-org-finance-scoping.test.ts  (finance, #459)
 *   __tests__/security/active-org-supplier-scoping.test.ts (suppliers, #463)
 *   __tests__/security/active-org-assets-scoping.test.ts   (asset/QR, #464)
 *   __tests__/security/active-org-list-scoping.test.ts     (lists, #468)
 * The runtime proof — the exact predicate pairs replayed against real Postgres
 * with a real dual-org user's JWT, including the storage-bytes proof for
 * deleteBlueprint — lives in
 * __tests__/integration/rls/active-org-write-slice.test.ts.
 *
 * Every assertion here fails against the pre-fix source.
 */

const ROOT = resolve(__dirname, "..", "..");
const src = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

/** Extract one exported function body so a sibling can't satisfy an assertion. */
function fn(source: string, name: string): string {
  const start = source.indexOf(`export async function ${name}`);
  expect(start, `${name} not found`).toBeGreaterThan(-1);
  const next = source.indexOf("\nexport async function", start + 1);
  return source.slice(start, next === -1 ? undefined : next);
}

/** Same, for a module-private helper. */
function localFn(source: string, name: string): string {
  const start = source.indexOf(`async function ${name}`);
  expect(start, `${name} not found`).toBeGreaterThan(-1);
  const next = source.indexOf("\nasync function", start + 1);
  return source.slice(start, next === -1 ? undefined : next);
}

/** The canonical pin. `ctx` comes from `requireOrgContext()`, never a form. */
const CTX_PIN_G = () =>
  /\.eq\(\s*["']org_id["'](?:\s+as\s+never)?,\s*ctx\.org\.id(?:\s+as\s+never)?\s*\)/g;
const countPins = (s: string) => (s.match(CTX_PIN_G()) ?? []).length;
/** The membership-shaped variant used by support/actions.ts. */
const MEMBERSHIP_PIN_G = () =>
  /\.eq\(\s*["']org_id["'](?:\s+as\s+never)?,\s*ctx\.membership\.org_id(?:\s+as\s+never)?\s*\)/g;
/** The pin as it appears in a helper taking the active org as an argument. */
const ARG_PIN_G = () => /\.eq\(\s*["']org_id["'],\s*orgId\s*\)/g;

/** A function that pins by ctx.org.id must actually destructure ctx. */
const CAPTURES_CTX = /const \{[^}]*\bctx\b[^}]*\} = await requireOrgContext\(\)/;
/** Same, for files whose actions take ctx from a local requireAdmin() wrapper
 *  (certificate/actions.ts) that itself destructures ctx from requireOrgContext(). */
const CAPTURES_ADMIN_CTX = /const \{[^}]*\bctx\b[^}]*\} = await requireAdmin\(\)/;

// ---------------------------------------------------------------------------
// 1. deleteBlueprint — the read + DELETE pair
//
// The headline defect of the slice. `blueprints_delete` is
// `is_org_admin(org_id)`, satisfied by an owner of BOTH orgs, so an unpinned
// DELETE let a dual-org owner working in org A destroy org B's drawing.
//
// The pair matters as much as either half. Pinning only the DELETE leaves the
// path-gathering read reaching across orgs; pinning only the READ is WORSE —
// the wrong-org read yields no paths while the unpinned DELETE still removes
// the row, orphaning every stored byte with nothing left pointing at it.
// ---------------------------------------------------------------------------

describe("server/services/blueprints — deleteBlueprint moves read and DELETE together", () => {
  const SRC = () => src("server/services/blueprints.ts");
  const F = () => fn(SRC(), "deleteBlueprint");

  it("captures ctx (it used to take only `user` and throw the org away)", () => {
    expect(F()).toMatch(/const \{ ctx, user \} = await requireOrgContext\(\)/);
  });

  it("pins the storage-path read to the active org", () => {
    // Anchored on the exact chain, not a lazy [\s\S]*? — a loose pattern would
    // happily match the DELETE's pin further down the function and stay green
    // while the read was stripped.
    expect(
      F(),
      "the blueprint_versions read must be scoped, or paths are gathered cross-org",
    ).toMatch(
      /from\("blueprint_versions"\)\.select\("storage_path"\)\.eq\("blueprint_id", blueprintId\)\.eq\("org_id", ctx\.org\.id\)/,
    );
  });

  it("pins the DELETE to the active org", () => {
    expect(F()).toMatch(
      /from\("blueprints"\)\.delete\(\{ count: "exact" \}\)\.eq\("id", blueprintId\)\.eq\("org_id", ctx\.org\.id\)/,
    );
  });

  it("carries BOTH pins — a partial strip is the orphaning case", () => {
    // The count is the tripwire. An "at least one pin" assertion would stay
    // green while someone removed the pin from the read and left it on the
    // DELETE — precisely the variant that orphans storage bytes.
    const n = countPins(F());
    expect(
      n,
      `deleteBlueprint must carry 2 active-org predicates (the versions read ` +
        `AND the blueprints DELETE); found ${n}`,
    ).toBe(2);
  });

  it("still counts rows and refuses to touch storage when nothing was deleted", () => {
    // This is what makes the wrong-org path a true no-op: zero rows → early
    // return BEFORE `admin.storage.remove`, so the other org's bytes survive.
    const f = F();
    expect(f).toMatch(/\.delete\(\{ count: "exact" \}\)/);
    const guard = f.indexOf("if (!count) return");
    const remove = f.indexOf("admin.storage.from(BUCKET).remove(paths)");
    expect(guard, "the zero-row guard must exist").toBeGreaterThan(-1);
    expect(remove, "the storage cleanup must exist").toBeGreaterThan(-1);
    expect(
      guard,
      "the zero-row guard must come BEFORE the storage removal, or a refused " +
        "delete still wipes bytes",
    ).toBeLessThan(remove);
  });

  it("treats a foreign drawing exactly like one it may not delete (no oracle)", () => {
    expect(F()).toMatch(/Only owners\/admins can delete a drawing\./);
  });

  it("does NOT switch the viewer's active org to match the id", () => {
    // Auto-switching would turn a scoping fix into a silent context change —
    // a product decision this slice must not assume. Same stance as #456/#463.
    const s = SRC();
    expect(s).not.toMatch(/cookies\(/);
    expect(s).not.toMatch(/setActiveOrg/);
  });

  it("the sibling revision path keeps its resolve-then-compare (regression)", () => {
    // addBlueprintRevision was already safe by comparing org_id after the read.
    // Pinned so the idiom cannot be dropped while attention is on delete.
    expect(fn(SRC(), "addBlueprintRevision")).toMatch(
      /if \(shell\.org_id !== ctx\.org\.id\) return \{ ok: false, error: "Drawing not found\." \}/,
    );
  });
});

describe("blueprint status writes are pinned too (the enumeration missed this one)", () => {
  const SRC = () => src("app/(app)/jobs/[id]/blueprints/actions.ts");

  it("setBlueprintStatus pins its UPDATE to the active org", () => {
    const F = fn(SRC(), "setBlueprintStatus");
    expect(F).toMatch(CAPTURES_CTX);
    expect(
      F,
      "the isAdmin check is on the ACTIVE org's membership, but blueprints_update " +
        "admits every org the caller belongs to",
    ).toMatch(/\.eq\("id", blueprintId\)[\s\S]*?\.eq\("org_id", ctx\.org\.id\)/);
  });

  it("setBlueprintStatus still requires a row to have matched", () => {
    expect(fn(SRC(), "setBlueprintStatus")).toMatch(/if \(error \|\| !count\)/);
  });
});

// ---------------------------------------------------------------------------
// 2. Notifications — user-scoped is not org-scoped
// ---------------------------------------------------------------------------

describe("notifications read-state actions pin to the active org", () => {
  const SRC = () => src("app/(app)/_components/notifications-actions.ts");

  it("uses requireOrgContext, not requireUser (it had no org context at all)", () => {
    const s = SRC();
    expect(s).toMatch(/import \{ requireOrgContext \} from "@\/server\/auth\/session"/);
    expect(s, "requireUser alone cannot scope to the active org").not.toMatch(
      /requireUser/,
    );
  });

  it("markNotificationsRead scopes by user AND org", () => {
    const F = fn(SRC(), "markNotificationsRead");
    expect(F).toMatch(/\.eq\("user_id", user\.id\)/);
    expect(
      F,
      "without the org pin, 'mark all read' clears the OTHER company's badge",
    ).toMatch(/\.eq\("org_id", ctx\.org\.id\)/);
    expect(F).toMatch(/\.is\("read_at", null\)/);
  });

  it("markOneNotificationRead scopes by user AND org", () => {
    const F = fn(SRC(), "markOneNotificationRead");
    expect(F).toMatch(/\.eq\("user_id", user\.id\)/);
    expect(F).toMatch(/\.eq\("org_id", ctx\.org\.id\)/);
  });

  it("both actions carry exactly one pin each", () => {
    const n = countPins(SRC());
    expect(n, `expected 2 active-org predicates in this file, found ${n}`).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 3. PAYROLL — the highest-severity financial writes in the slice
// ---------------------------------------------------------------------------

describe("payroll writes — a cross-org write here is money", () => {
  const SRC = () => src("app/(app)/payroll/actions.ts");

  it("createPayrollRun pins the time_entries read that FEEDS every line", () => {
    // The corruption: hoursByUser groups on user_id alone, so an unpinned read
    // summed a dual-org worker's OTHER employer's shifts into this run —
    // inflating gross_pay, paye_estimate, ni_estimate and net_pay.
    const F = fn(SRC(), "createPayrollRun");
    expect(F).toMatch(
      /from\("time_entries"\)\s*\.select\("id, user_id, job_id, started_at, ended_at, breaks"\)\s*\.eq\("org_id", ctx\.org\.id\)/,
    );
  });

  it("createPayrollRun's open-entry guard stays pinned (it always was)", () => {
    // The guard and the hour sum disagreed before the fix; they must now agree.
    expect(fn(SRC(), "createPayrollRun")).toMatch(
      /from\("time_entries"\)[\s\S]*?\.eq\("org_id", ctx\.org\.id\)[\s\S]*?\.is\("ended_at", null\)/,
    );
  });

  it("createPayrollRun stamps the active org on the run and its lines", () => {
    const F = fn(SRC(), "createPayrollRun");
    expect(F).toMatch(/from\("payroll_runs"\)\s*\.insert\(\{\s*org_id: ctx\.org\.id/);
    expect(F).toMatch(/org_id: ctx\.org\.id,\s*payroll_run_id: run\.id/);
  });

  it("finalisePayrollRun pins the run read — finalising is IRREVERSIBLE", () => {
    const F = fn(SRC(), "finalisePayrollRun");
    expect(F).toMatch(
      /from\("payroll_runs"\)[\s\S]*?\.eq\("id", runId\)\s*\.eq\("org_id", ctx\.org\.id\)\s*\.maybeSingle\(\)/,
    );
  });

  it("finalisePayrollRun pins the time_entries LOCK — the widest write in the file", () => {
    // This UPDATE is keyed on user_id + a date window, with no id at all, so it
    // is the one write here that could reach an unbounded set of another
    // company's rows and freeze their timesheets against an invisible line.
    expect(fn(SRC(), "finalisePayrollRun")).toMatch(
      /from\("time_entries"\)\s*\.update\(\{ payroll_line_id: l\.id \}\)\s*\.eq\("org_id", ctx\.org\.id\)\s*\.eq\("user_id", l\.user_id\)/,
    );
  });

  it("finalisePayrollRun pins the status flip and the lines read", () => {
    const F = fn(SRC(), "finalisePayrollRun");
    expect(F).toMatch(/from\("payroll_lines"\)[\s\S]*?\.eq\("org_id", ctx\.org\.id\)/);
    expect(F).toMatch(/status: "finalised"[\s\S]*?\.eq\("org_id", ctx\.org\.id\)/);
  });

  it("deletePayrollRun pins BOTH the read and the cascading DELETE", () => {
    const F = fn(SRC(), "deletePayrollRun");
    expect(F).toMatch(
      /from\("payroll_runs"\)\s*\.select\("status"\)\s*\.eq\("id", runId\)\s*\.eq\("org_id", ctx\.org\.id\)/,
    );
    expect(F).toMatch(
      /from\("payroll_runs"\)\s*\.delete\(\)\s*\.eq\("id", runId\)\s*\.eq\("org_id", ctx\.org\.id\)/,
    );
  });

  it("deletePayrollRun keeps the finalised-run immutability refusal (regression)", () => {
    expect(fn(SRC(), "deletePayrollRun")).toMatch(/error=cannot_delete_finalised/);
  });

  it("every payroll mutation site carries a pin (count tripwire)", () => {
    // 8 = createPayrollRun open-entry guard, memberships, time_entries hours,
    // rollback DELETE; finalisePayrollRun run read, lines read, time_entries
    // lock, status flip; deletePayrollRun read + DELETE. Floor, not equality:
    // the two org_id-stamping INSERTs are counted separately below.
    const n = countPins(SRC());
    expect(
      n,
      `payroll/actions.ts: expected at least 10 active-org predicates, found ${n}`,
    ).toBeGreaterThanOrEqual(10);
  });
});

// ---------------------------------------------------------------------------
// 4. PAYMENTS — bank reconciliation
// ---------------------------------------------------------------------------

describe("payments — the bank matcher must score one company's ledger", () => {
  const SRC = () => src("app/(app)/payments/actions.ts");

  it("uploadBankCsv pins the invoice set it scores against", () => {
    const F = fn(SRC(), "uploadBankCsv");
    expect(
      F,
      "unpinned, org A's bank lines were auto-matched to org B's invoices",
    ).toMatch(/from\("invoices"\)[\s\S]*?\.eq\("org_id", ctx\.org\.id\)\s*\.in\("status"/);
  });

  it("uploadBankCsv no longer claims RLS scopes that read", () => {
    // The old comment said "(RLS scopes to org)" — untrue for a dual-org member,
    // and the reason this site was not spotted earlier.
    expect(fn(SRC(), "uploadBankCsv")).not.toMatch(/RLS scopes to org/);
  });

  it("uploadBankCsv stamps the active org on the statement and its lines", () => {
    const F = fn(SRC(), "uploadBankCsv");
    expect(F).toMatch(/from\("bank_statements"\)\s*\.insert\(\{\s*org_id: ctx\.org\.id/);
    expect(F).toMatch(/org_id: ctx\.org\.id,\s*bank_statement_id: stmt\.id/);
  });

  it("confirmBankMatch keeps BOTH resolve-then-compare gates (already safe → pinned)", () => {
    // This action was already correct: it resolves the bank line and the
    // form-supplied invoice through the RLS client and compares org_id on each.
    // The invoice check is a prior security fix (a crafted invoice_id recorded a
    // payment against another org's invoice) — restated here so the write slice
    // cannot regress it while adding predicates around it.
    const F = fn(SRC(), "confirmBankMatch");
    // The REFUSAL style changed in #472 (redirect → FormState formError); the
    // security property is the compare-and-refuse itself, so the pin anchors on
    // the comparison plus an immediate return/redirect — either style passes,
    // a dropped gate does not.
    expect(F).toMatch(/if \(line\.org_id !== ctx\.org\.id\) (return formError\(|redirect\()/);
    expect(F).toMatch(/if \(inv\.org_id !== ctx\.org\.id\) (return formError\(|redirect\()/);
  });

  it("confirmBankMatch's later writes are derived from the org-checked line", () => {
    // No pin of their own by design: every subsequent write keys off `line.id` /
    // `line.bank_statement_id`, and `line` was org-compared above. Pinned so a
    // refactor that starts writing by a raw form id has to face this test.
    const F = fn(SRC(), "confirmBankMatch");
    expect(F).toMatch(/from\("bank_statement_lines"\)[\s\S]*?\.eq\("id", line\.id\)/);
    expect(F).toMatch(/from\("bank_statements"\)[\s\S]*?\.eq\("id", line\.bank_statement_id\)/);
  });

  it("ignoreBankLine was already pinned and stays pinned (regression)", () => {
    expect(fn(SRC(), "ignoreBankLine")).toMatch(
      /\.eq\("id", bankLineId\)\s*\.eq\("org_id", ctx\.org\.id\)/,
    );
  });
});

// ---------------------------------------------------------------------------
// 5. IMPORTS — the widest blast radius, and the only service-role writes
// ---------------------------------------------------------------------------

describe("imports — service-role writes have NO RLS behind them", () => {
  const SRC = () => src("app/(app)/imports/actions.ts");

  const ENTRY_POINTS: Array<[string, string]> = [
    ["uploadImportFiles", "importId"],
    ["commitImport", "importId"],
    ["rollbackImport", "importId"],
    ["overrideSheetEntity", "importId"],
  ];

  for (const [name] of ENTRY_POINTS) {
    it(`${name} pins its imports read to the active org`, () => {
      const F = fn(SRC(), name);
      expect(F).toMatch(CAPTURES_CTX);
      expect(
        F,
        `${name}: every policy in this domain is is_org_admin(org_id), which a ` +
          `dual-org admin satisfies for BOTH orgs`,
      ).toMatch(/from\("imports"\)[\s\S]*?\.eq\("id", importId\)\s*\.eq\("org_id", ctx\.org\.id\)/);
    });
  }

  it("uploadImportFiles no longer selects org_id and ignores it", () => {
    // The pre-fix read asked for org_id and never compared it — a tell that the
    // scoping was intended and lost.
    const F = fn(SRC(), "uploadImportFiles");
    const sel = F.indexOf('.select("id, org_id, status")');
    expect(sel).toBeGreaterThan(-1);
    expect(F.slice(sel, sel + 200)).toMatch(/\.eq\("org_id", ctx\.org\.id\)/);
  });

  it("commitImport pins the SERVICE-ROLE row read that feeds insertOne", () => {
    // insertOne re-stamps every row as ctx.org.id and writes it into live
    // business tables via the admin client. Unpinned, committing another org's
    // import copied their whole migration — customers, invoices, finances,
    // jobs, quotes, payments — into this org.
    expect(fn(SRC(), "commitImport")).toMatch(
      /await admin\s*\.from\("import_rows"\)[\s\S]*?\.eq\("import_id", importId\)\s*\.eq\("org_id", ctx\.org\.id\)/,
    );
  });

  it("rollbackImport pins the SERVICE-ROLE audit read", () => {
    expect(fn(SRC(), "rollbackImport")).toMatch(
      /from\("import_audit"\)[\s\S]*?\.eq\("import_id", importId\)\s*\.eq\("org_id", ctx\.org\.id\)/,
    );
  });

  it("rollbackImport pins the SERVICE-ROLE mass DELETE across eight live tables", () => {
    // The most destructive statement in the slice: `admin.from(table).delete()`
    // over invoice_payments/jobs/quotes/invoices/finances/leads/memberships/
    // customers, with RLS bypassed.
    expect(fn(SRC(), "rollbackImport")).toMatch(
      /\.from\(table as never\)\s*\.delete\(\)\s*\.in\("id", ids\)\s*\.eq\("org_id" as never, ctx\.org\.id as never\)/,
    );
  });

  it("rollbackImport still walks children-before-parents (regression)", () => {
    const F = fn(SRC(), "rollbackImport");
    const order = F.indexOf("const REVERSE_ORDER");
    expect(order).toBeGreaterThan(-1);
    expect(F.slice(order, order + 300)).toMatch(
      /"invoice_payments",[\s\S]*?"jobs",[\s\S]*?"quotes",[\s\S]*?"invoices",[\s\S]*?"customers",/,
    );
  });

  it("sendStaffInvitesFromImport pins the read BEFORE it emails third parties", () => {
    // It mails every address it finds with `invited_org_id: ctx.org.id`, so an
    // unpinned read invited another company's staff list into THIS org.
    const F = fn(SRC(), "sendStaffInvitesFromImport");
    expect(F).toMatch(
      /from\("import_rows"\)[\s\S]*?\.eq\("import_id", importId\)\s*\.eq\("org_id", ctx\.org\.id\)\s*\.eq\("entity_type", "staff"\)/,
    );
    const read = F.indexOf('.eq("entity_type", "staff")');
    const invite = F.indexOf("inviteUserByEmail");
    expect(read, "the org pin must precede the invite send").toBeLessThan(invite);
  });

  it("ignoreDuplicateRow no longer discards ctx", () => {
    const F = fn(SRC(), "ignoreDuplicateRow");
    expect(F, "`void ctx` was the smoking gun here").not.toMatch(/void ctx;/);
    expect(F).toMatch(/\.eq\("id", rowId\)\s*\.eq\("org_id", ctx\.org\.id\)\s*\.maybeSingle\(\)/);
    expect(F).toMatch(/status: "skipped"[\s\S]*?\.eq\("id", rowId\)\s*\.eq\("org_id", ctx\.org\.id\)/);
  });

  it("resolveReviewRow pins the read and BOTH confirm branches", () => {
    const F = fn(SRC(), "resolveReviewRow");
    expect(F).toMatch(
      /from\("import_rows"\)[\s\S]*?\.eq\("id", rowId\)\s*\.eq\("org_id", ctx\.org\.id\)\s*\.maybeSingle\(\)/,
    );
    // read + skip + reclassify-confirm + confirm-as-detected = 4.
    const n = countPins(F);
    expect(
      n,
      `resolveReviewRow: expected 4 active-org predicates (read, skip, and both ` +
        `confirm branches), found ${n}`,
    ).toBe(4);
  });

  it("annotateDuplicates pins its service-role read and write to the passed org", () => {
    const F = localFn(SRC(), "annotateDuplicates");
    const n = (F.match(ARG_PIN_G()) ?? []).length;
    expect(
      n,
      `annotateDuplicates: expected 6 org predicates (import_rows read, the four ` +
        `reference sets, and the duplicate write), found ${n}`,
    ).toBe(6);
  });

  it("the parent resolvers stay org-scoped (already safe → pinned)", () => {
    const s = SRC();
    expect(localFn(s, "resolveCustomerByName")).toMatch(ARG_PIN_G());
    expect(localFn(s, "resolveInvoiceByNumber")).toMatch(ARG_PIN_G());
  });

  it("no by-id mutation in the file is left unpinned (count tripwire)", () => {
    // A floor across the whole file: the fix added predicates to 21 sites and
    // 6 were already correct. A partial strip drops below this immediately.
    const n = countPins(SRC()) + (SRC().match(ARG_PIN_G()) ?? []).length;
    expect(
      n,
      `imports/actions.ts: expected at least 27 active-org predicates, found ${n}`,
    ).toBeGreaterThanOrEqual(27);
  });
});

// ---------------------------------------------------------------------------
// 6. Reviews, support, inbox
// ---------------------------------------------------------------------------

describe("reviews — lifecycle writes and the outbound email", () => {
  const SRC = () => src("app/(app)/reviews/actions.ts");

  for (const name of ["markReviewCompletedAction", "cancelReviewRequestAction"]) {
    it(`${name} captures ctx and pins its UPDATE`, () => {
      const F = fn(SRC(), name);
      expect(F).toMatch(CAPTURES_CTX);
      expect(F).toMatch(/\.eq\("id", id\)\s*(?:\/\/[^\n]*\n\s*)?\.eq\("org_id", ctx\.org\.id\)/);
    });
  }

  it("emailReviewRequestNow pins the read that decides WHO gets emailed", () => {
    // The letterhead defect: the request was resolved unpinned but the email was
    // composed from ctx.org.id, so org B's customer received a message signed
    // with org A's company name. Same class as the #456 job certificates.
    const F = fn(SRC(), "emailReviewRequestNow");
    expect(F).toMatch(
      /\.eq\("id", id\)\s*\.eq\("org_id", ctx\.org\.id\)\s*\.maybeSingle\(\)/,
    );
    const read = F.indexOf('.maybeSingle()');
    const send = F.indexOf("await sendEmail(");
    expect(read, "the pin must precede the send").toBeLessThan(send);
  });

  it("emailReviewRequestNow pins the sent-stamp too", () => {
    const F = fn(SRC(), "emailReviewRequestNow");
    expect(F).toMatch(/status: "sent"[\s\S]*?\.eq\("id", id\)[\s\S]*?\.eq\("org_id", ctx\.org\.id\)/);
    // read + sent-stamp = 2 (the org-name lookup uses ctx.org.id via `.eq("id", …)`).
    const n = countPins(F);
    expect(n, `emailReviewRequestNow: expected 2 pins, found ${n}`).toBe(2);
  });

  it("createReviewRequestAction still stamps the active org (regression)", () => {
    expect(fn(SRC(), "createReviewRequestAction")).toMatch(/org_id: ctx\.org\.id/);
  });
});

describe("support — a reply must land in this org's thread", () => {
  const SRC = () => src("app/(app)/support/actions.ts");

  it("replyToSupportTicket pins the ticket read", () => {
    const F = fn(SRC(), "replyToSupportTicket");
    const n = (F.match(MEMBERSHIP_PIN_G()) ?? []).length;
    expect(
      n,
      "the ticket read must be pinned, or a reply is posted into another org's " +
        "thread while the message row is stamped with THIS org",
    ).toBe(1);
    expect(F).toMatch(
      /\.eq\("id" as never, parsed\.data\.ticket_id\)\s*\.eq\("org_id" as never, ctx\.membership\.org_id as never\)/,
    );
  });

  it("replyToSupportTicket no longer claims RLS alone scopes that read", () => {
    expect(fn(SRC(), "replyToSupportTicket")).not.toMatch(
      /RLS scopes this read to the caller's org/,
    );
  });

  it("replyToSupportTicket keeps the fail-closed not-found path (regression)", () => {
    expect(fn(SRC(), "replyToSupportTicket")).toMatch(
      /if \(!tInfo\) \{\s*redirect\(`\/support\?error=not_found`\)/,
    );
  });

  it("createSupportTicket still stamps the active org (regression)", () => {
    expect(fn(SRC(), "createSupportTicket")).toMatch(/org_id: ctx\.membership\.org_id/);
  });
});

describe("inbox — enquiry triage", () => {
  const SRC = () => src("app/(app)/inbox/actions.ts");

  it("markEnquiryStatus captures ctx and pins its UPDATE", () => {
    const F = fn(SRC(), "markEnquiryStatus");
    expect(F).toMatch(CAPTURES_CTX);
    expect(
      F,
      "unpinned, a member working in org A could bury a real lead in org B by " +
        "marking their enquiry ignored",
    ).toMatch(/\.eq\("id", id\)\s*(?:\/\/[^\n]*\n\s*)*\.eq\("org_id", ctx\.org\.id\)/);
  });
});

// ---------------------------------------------------------------------------
// 6b. Completion certificates — a CONTRACTUAL instrument stamped with the org
//
// The enumeration missed this file the same way it missed the reviews
// letterhead defect. `completion_certificates` UPDATE is member-level and
// org-wide (`org_id in current_org_ids()`), so a member of orgs A and B can
// capture a valid server-action blob for org B's certificate while browsing B,
// then replay it with active org = A. issueCertificate freezes B's cert stamped
// with `contractorName = ctx.org.name` (A) — org A's identity leaking onto org
// B's customer portal — and setPortal toggles B's portal visibility. Every
// sibling pins org_id (warranties/actions.ts, jobs/actions.ts); the certificate
// actions were the lone exception. Same source-pinning style as the rest of
// this file: these are "use server" actions with no Supabase mock harness.
// ---------------------------------------------------------------------------

describe("completion certificates — issue/publish must pin the ACTIVE org", () => {
  const SRC = () => src("app/(app)/jobs/[id]/certificate/actions.ts");

  it("issueCertificate pins the certificate read to the active org", () => {
    // The read decides WHICH cert gets frozen under ctx.org.name's letterhead.
    // It flows through loadCertificate(supabase, certId, ctx.org.id), which pins
    // both id and org_id — a raw unpinned `.eq("id", certId).maybeSingle()`
    // fails this.
    const F = fn(SRC(), "issueCertificate");
    // ctx reaches these actions via the module's requireAdmin() wrapper, which
    // itself destructures ctx from requireOrgContext() — so the pin's ctx is the
    // active org, not a form value.
    expect(F).toMatch(CAPTURES_ADMIN_CTX);
    expect(
      F,
      "the cert read must be scoped to ctx.org.id, or a sibling-org cert is " +
        "frozen under this org's identity",
    ).toMatch(/loadCertificate\(supabase, certId, ctx\.org\.id\)/);
  });

  it("issueCertificate pins the freeze UPDATE to the active org", () => {
    expect(fn(SRC(), "issueCertificate")).toMatch(
      /\.eq\("id", certId\)\s*\.eq\("org_id", ctx\.org\.id\)\s*\.eq\("status", "draft"\)/,
    );
  });

  it("issueCertificate guards a missing/foreign job before freezing a snapshot", () => {
    // Without the guard, loadJobForOrg returning null still builds a snapshot
    // from empty context and freezes it — createCertificate always had this
    // guard; issueCertificate did not.
    const F = fn(SRC(), "issueCertificate");
    expect(F).toMatch(/if \(!job\) return formError\("Job not found\."\)/);
  });

  it("setPortal captures ctx and pins BOTH the read and the toggle UPDATE", () => {
    // setPortal is module-private (publishCertificate/withdrawCertificate wrap
    // it), so it is asserted directly via localFn.
    const F = localFn(SRC(), "setPortal");
    expect(F).toMatch(CAPTURES_ADMIN_CTX);
    expect(F).toMatch(/loadCertificate\(supabase, certId, ctx\.org\.id\)/);
    expect(F).toMatch(
      /\.eq\("id", certId\)\s*\.eq\("org_id", ctx\.org\.id\)\s*\.eq\("status", "issued"\)/,
    );
  });

  it("loadCertificate pins both id AND org_id (the single choke point)", () => {
    // Factored so the next action cannot forget the pin, exactly like
    // warranties/actions.ts loadWarranty.
    const F = localFn(SRC(), "loadCertificate");
    expect(F).toMatch(
      /\.eq\("id", certId\)\s*\.eq\("org_id", orgId\)\s*\.maybeSingle\(\)/,
    );
  });

  it("no by-id write in the file mutates a cert without the active-org pin (tripwire)", () => {
    // 4 pins: loadCertificate read (used by both issue and portal), the issue
    // freeze UPDATE, and the setPortal toggle UPDATE. loadCertificate's pin uses
    // the `orgId` arg form; the two UPDATEs use ctx.org.id.
    const s = SRC();
    const n = countPins(s) + (s.match(/\.eq\(\s*["']org_id["'],\s*orgId\s*\)/g) ?? []).length;
    expect(
      n,
      `certificate/actions.ts: expected at least 3 active-org predicates, found ${n}`,
    ).toBeGreaterThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// 7. me/actions.ts — the site the enumeration got WRONG
// ---------------------------------------------------------------------------

describe("me/actions.ts is user-scoped BY DESIGN — do not 'fix' it", () => {
  const SRC = () => src("app/(app)/me/actions.ts");

  it("the DB allows exactly one open time entry per USER, globally", () => {
    // 20260525000000_field_operations.sql:
    //   create unique index time_entries_one_open_per_user
    //     on public.time_entries (user_id) where ended_at is null;
    // The index key is user_id ALONE — there is no org_id in it. So "am I
    // clocked in?" is a question about the person, not the company, and the
    // clock actions are correctly scoped by user_id.
    const ddl = src("supabase/migrations/20260525000000_field_operations.sql");
    expect(ddl).toMatch(
      /create unique index if not exists time_entries_one_open_per_user\s*\n\s*on public\.time_entries \(user_id\) where ended_at is null;/,
    );
  });

  it("clockIn's guard matches that index — adding an org pin would BREAK it", () => {
    // With an org pin the guard would miss an open entry in the other org, let
    // the INSERT through, and the unique index would reject it — turning a
    // clear "already clocked in" into an opaque clock_in_failed.
    const F = fn(SRC(), "clockIn");
    expect(F).toMatch(/from\("time_entries"\)[\s\S]*?\.eq\("user_id", user\.id\)\s*\.is\("ended_at", null\)/);
    expect(F).not.toMatch(CTX_PIN_G());
  });

  it("clockIn still stamps the ACTIVE org on the new entry", () => {
    // The write side IS org-scoped: the shift belongs to the company you are
    // working in. That is what makes the payroll pin above meaningful.
    expect(fn(SRC(), "clockIn")).toMatch(/org_id: ctx\.org\.id/);
  });

  for (const name of ["clockOut", "startBreak", "endBreak"]) {
    it(`${name} acts on the caller's single open entry, by user (not org)`, () => {
      const F = fn(SRC(), name);
      expect(F).toMatch(/\.eq\("user_id", user\.id\)\s*\.is\("ended_at", null\)/);
      expect(F).toMatch(/\.eq\("id", open\.id\)/);
    });
  }
});

// ---------------------------------------------------------------------------
// 8. Scope note — what this slice deliberately does NOT claim
// ---------------------------------------------------------------------------

describe("scope note — the excluded surface", () => {
  it("purchase-orders/actions.ts is EXCLUDED (a concurrent build lane owns it)", () => {
    // Deliberate: a warehouse/PO-receiving lane is editing this file, so the
    // write slice leaves it alone rather than collide. Its unpinned sites are
    // real and are handed off, not fixed here:
    //   updatePurchaseOrder      — read :175, UPDATE :197, line-items DELETE :210
    //   setPurchaseOrderStatus   — ctx discarded :228, read :245, UPDATE :259
    //   deletePurchaseOrder      — ctx discarded :279, DELETE :289
    //   recordSupplierBill       — PO read :375 (job_id/supplier_id inherited)
    // This test documents the gap so it cannot be mistaken for coverage, and
    // fails if the file disappears (which would mean the handoff is stale).
    const SRC = src("app/(app)/purchase-orders/actions.ts");
    expect(SRC.length, "file still exists; its scoping is the NEXT slice").toBeGreaterThan(0);
    expect(
      SRC,
      "if this file has become fully pinned, delete this placeholder and fold " +
        "purchase-orders into the coverage above",
    ).toMatch(/export async function deletePurchaseOrder/);
  });

  it("this slice adds no migration and changes no RLS policy", () => {
    // The pins are application-layer scoping INSIDE the RLS boundary. If a
    // policy ever changed, the argument that RLS is the outer boundary — the
    // premise of the whole defect class — would need re-proving.
    const s = [
      src("server/services/blueprints.ts"),
      src("app/(app)/payroll/actions.ts"),
      src("app/(app)/payments/actions.ts"),
      src("app/(app)/imports/actions.ts"),
    ].join("\n");
    expect(s).not.toMatch(/create policy|alter policy|drop policy/i);
  });
});
