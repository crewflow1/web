import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";

/**
 * Loud read failures — pins + ratchet for the silent-empty-state class.
 *
 * The incident (see docs/loud-read-failures.md and the sibling
 * postgrest-embed-ambiguity test): sites destructure `const { data } = await`
 * discarding `error`, then render `data ?? []` — so a REJECTED query renders
 * the empty/healthy state. /assets/holdings showed "Nothing is checked out"
 * for weeks while every request PGRST201-failed.
 *
 * Two layers here:
 *
 *  1. MARQUEE PINS — the conversions whose regression would be worst are
 *     pinned on source: fail-open guards (a failed read must BLOCK the
 *     guarded send/write, not allow it), read-modify-write aborts (a failed
 *     read must never clobber state or stamp false success), tax/statutory
 *     reads, and the highest-blast-radius loaders.
 *
 *  2. THE RATCHET — the count of `const { data } = await` destructures that
 *     omit `error` may only go DOWN per scope. The remaining baseline is the
 *     REVIEWED best-effort residue (enrichment joins, storage-cleanup
 *     pre-reads, documented fetchAllRows posture, DB-backstopped dedupe
 *     guards — the C ledger in docs/loud-read-failures.md). A new swallowed
 *     read fails this tier until it handles `error` — or, if it is genuinely
 *     best-effort, gets a reviewed entry in the C ledger and a baseline bump
 *     in the same PR.
 */

const ROOT = resolve(__dirname, "..", "..");
const src = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

// ── 1. marquee pins ──────────────────────────────────────────────────────────

describe("the helper module", () => {
  const helper = src("lib/supabase/read-failure.ts");
  it("exposes the throw path and the panel-report path", () => {
    expect(helper).toMatch(/export function readFailure\(/);
    expect(helper).toMatch(/export function reportReadFailure\(/);
    expect(helper, "panel path must capture — nothing else will").toMatch(
      /Sentry\.captureException/,
    );
  });
});

describe("fail-open guards now block on read failure", () => {
  it("hq-comms suppression gate (do-not-contact) throws instead of failing open", () => {
    const s = src("server/services/hq-comms.ts");
    expect(s).toMatch(/if \(error\) throw readFailure\("hq-comms: suppression check", error\);/);
  });

  it("receptionist SMS dedup probe throws instead of allowing a duplicate send", () => {
    const s = src("server/services/receptionist.ts");
    expect(s).toMatch(/throw readFailure\("receptionist: sent-transport dedup probe", error\);/);
  });

  it("receptionist inbound lead insert is checked (the try/catch alone is dead code)", () => {
    const s = src("server/services/receptionist.ts");
    expect(s).toMatch(/if \(leadError\) throw readFailure\("receptionist: inbound lead insert", leadError\);/);
  });

  it("rota overlap guard throws instead of double-booking", () => {
    const s = src("server/services/rota.ts");
    expect(s).toMatch(/throw readFailure\("rota: user shifts on day", error\);/);
  });

  it("staff last-owner-lock and remove-owner guards throw instead of silently passing", () => {
    const s = src("app/(app)/staff/actions.ts");
    expect(s).toMatch(/throw readFailure\("staff: owner count guard", ownerCountError\);/);
    expect(s).toMatch(/throw readFailure\("staff: role-change target", targetError\);/);
    expect(s).toMatch(/throw readFailure\("staff: remove-target role", targetError\);/);
  });
});

describe("read-modify-write actions abort before the write", () => {
  it("imports commit/rollback cannot stamp success off a failed read", () => {
    const s = src("app/(app)/imports/actions.ts");
    expect(s).toMatch(/throw readFailure\("imports: commit rows", rowsError\);/);
    expect(s).toMatch(/throw readFailure\("imports: rollback audit", auditError\);/);
  });

  it("onboarding_state merges never write over a failed read", () => {
    expect(src("app/(app)/dashboard/_retention-actions.ts")).toMatch(/throw readFailure\("dashboard: onboarding state/);
    expect(src("app/(app)/onboarding/setup/actions.ts")).toMatch(/throw readFailure\("onboarding setup: state", error\);/);
    expect(src("app/admin/customers/actions.ts")).toMatch(/throw readFailure\("admin markSetupComplete: onboarding_state", rowError\);/);
  });

  it("settings forms never render empty (re-save would clobber real org/bank details)", () => {
    const s = src("app/(app)/settings/page.tsx");
    expect(s).toMatch(/throw readFailure\("settings: profile", profileError\);/);
    expect(s).toMatch(/throw readFailure\("settings: organisation", orgError\);/);
  });
});

describe("tax/statutory reads are loud", () => {
  it("CIS month snapshots can never build a NIL return from a failed read", () => {
    const s = src("server/services/cis-statements.ts");
    expect(s).toMatch(/throw readFailure\("cis: month payment snapshots", error\);/);
    expect(s, "voided-payment filter must not fail open").toMatch(
      /throw readFailure\("cis: snapshot payments join", paymentsError\);/,
    );
    expect(s).toMatch(/throw readFailure\("cis: statement payments", error\);/);
  });

  it("invoice/quote emails refuse to send a PDF with zero line items", () => {
    expect(src("lib/email/send-invoice.ts")).toMatch(/reason: "load_failed", detail: linesError\.message/);
    expect(src("lib/email/send-quote.ts")).toMatch(/reason: "load_failed", detail: linesError\.message/);
  });

  it("the tax page throws rather than rendering £0 HMRC estimates", () => {
    const s = src("app/(app)/tax/page.tsx");
    expect(s).toMatch(/throw readFailure\("tax: invoices", invoicesError\);/);
    expect(s).toMatch(/throw readFailure\("tax: payroll lines", payrollError\);/);
  });

  it("payroll runs cannot save with silently-empty members/hours", () => {
    const s = src("app/(app)/payroll/actions.ts");
    expect(s).toMatch(/throw readFailure\("payroll create: members", membersError\);/);
    expect(s).toMatch(/throw readFailure\("payroll create: hours", entriesError\);/);
    expect(s, "finalise must lock entries or fail").toMatch(
      /throw readFailure\("payroll finalise: lines", linesError\);/,
    );
  });
});

describe("highest-blast-radius loaders", () => {
  it("lib/jobs/load throws on error — a transient failure must not 404 every job page", () => {
    expect(src("lib/jobs/load.ts")).toMatch(/throw readFailure\("jobs: load by id", error\);/);
  });

  it("the customer portal payment schedule is loud on all its reads", () => {
    const s = src("app/customer-portal/[token]/_schedule.ts");
    for (const ctx of [
      "portal schedule: jobs",
      "portal schedule: billing plans",
      "portal schedule: invoices",
      "portal schedule: invoice payments",
      "portal schedule: retention releases",
      "portal schedule: billing stages",
    ]) {
      expect(s, `${ctx} must throw`).toContain(`throw readFailure("${ctx}"`);
    }
  });

  it("the public quote page never tells a customer a live link is invalid on a failed read", () => {
    const s = src("app/q/[token]/page.tsx");
    expect(s).toMatch(/throw readFailure\("public quote: load", quoteError\);/);
    expect(s).toMatch(/throw readFailure\("public quote: line items", lineItemsError\);/);
  });

  it("the shared attachments panel renders an explicit error block, never 'Attachments (0)'", () => {
    const s = src("components/attachments/AttachmentsPanel.tsx");
    expect(s).toMatch(/reportReadFailure\("attachments: panel list", error\);/);
    expect(s).toMatch(/Couldn&apos;t load attachments/);
  });
});

// ── 2. the ratchet ───────────────────────────────────────────────────────────

/**
 * Baselines = the REVIEWED best-effort residue at the time of the sweep
 * (docs/loud-read-failures.md, "The C ledger"). Lower is always fine — update
 * downward freely. Raising one requires a reviewed C-ledger entry in the same
 * PR explaining why the new read is deliberately soft.
 */
const RATCHET: Array<{ scope: string; dirs: string[]; max: number }> = [
  { scope: "app/(app)", dirs: ["app/(app)"], max: 59 },
  {
    scope: "app outside (app) — admin/api/portal/q/onboarding",
    dirs: ["app/admin", "app/api", "app/customer-portal", "app/q", "app/onboarding"],
    max: 15,
  },
  { scope: "server + lib + components", dirs: ["server", "lib", "components"], max: 33 },
];

const DISCARD_RE = /const \{ data(?:: [A-Za-z_$][A-Za-z0-9_$]*)? \} = await/g;

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.(ts|tsx)$/.test(name) && !/\.(test|spec)\.tsx?$/.test(name)) yield p;
  }
}

function countDiscards(dirs: string[]): { total: number; byFile: Map<string, number> } {
  const byFile = new Map<string, number>();
  let total = 0;
  for (const dir of dirs) {
    for (const file of walk(resolve(ROOT, dir))) {
      const matches = readFileSync(file, "utf8").match(DISCARD_RE);
      if (matches?.length) {
        byFile.set(file.slice(ROOT.length + 1), matches.length);
        total += matches.length;
      }
    }
  }
  return { total, byFile };
}

describe("ratchet — error-discarding reads may only decrease", () => {
  for (const { scope, dirs, max } of RATCHET) {
    it(`${scope}: ≤ ${max} \`const { data } = await\` destructures`, () => {
      const { total, byFile } = countDiscards(dirs);
      const detail = [...byFile.entries()].map(([f, n]) => `  ${f}: ${n}`).join("\n");
      expect(
        total,
        `${scope} has ${total} error-discarding destructures (baseline ${max}).\n` +
          `A failed query must not render as an empty/healthy state: destructure ` +
          `\`error\` and throw readFailure(...) / render an explicit error state — or, if ` +
          `the read is genuinely best-effort, add it to the C ledger in ` +
          `docs/loud-read-failures.md and bump the baseline in the same PR.\nPer file:\n${detail}`,
      ).toBeLessThanOrEqual(max);
    });
  }
});
