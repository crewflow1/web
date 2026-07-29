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
 *  2. ERROR-USED — in the files this sweep and the active-org write slice BOTH
 *     touched, a destructured `error` must actually be USED. Merging two
 *     branches that edit the same read is exactly how `const { data, error }`
 *     survives while the `if (error) throw` below it is dropped: the code
 *     still compiles, still runs, still returns the empty state — and no
 *     behavioural test can see it, because the read only fails in production.
 *
 *  3. THE SHAPE LEDGER — counts of the three error-discarding shapes, FROZEN
 *     with `===` per scope. Not `<=`: a count that drifts down silently is a
 *     lost opportunity to retire a baseline, and a count that drifts down
 *     because a whole file moved is indistinguishable from progress. Any
 *     movement, either direction, must be a conscious line in the diff.
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
    // The invariant is the REFUSAL — `sent: false, reason: "load_failed"` when
    // the line-items read fails — not the text of `detail`. send-invoice no
    // longer echoes `linesError.message`: raw Postgres text can carry column
    // names, constraint bodies and row values, and `detail` is returned to the
    // API caller. Sentry carries the real error instead.
    const inv = src("lib/email/send-invoice.ts");
    expect(inv).toMatch(/if \(linesError\) \{/);
    expect(inv).toMatch(/reason: "load_failed"/);
    expect(inv, "the real error must still reach Sentry").toMatch(
      /Sentry\.captureException\(readFailure\("send-invoice: line items", linesError\)\)/,
    );
    expect(inv, "never echo raw Postgres text to a caller").not.toMatch(
      /detail: linesError\.message/,
    );
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

// ── 2. a destructured `error` must be USED ───────────────────────────────────

/**
 * The merge hazard, stated concretely. PR #480 (this sweep) and PR #479 (the
 * active-org write slice) edited the SAME reads in these files: #480 added
 * `error` + a throw, #479 added `.eq("org_id", ctx.org.id)` and, in places,
 * rewrote the surrounding lines. A resolution that keeps `const { data, error }`
 * but drops the `if (error) throw` type-checks, lints (the binding is "used" by
 * the destructure), and passes every behavioural test — while restoring the
 * exact defect this branch exists to remove. So assert it structurally.
 */
const MERGE_OVERLAP_FILES = [
  "app/(app)/payments/actions.ts",
  "app/(app)/purchase-orders/page.tsx",
  "app/(app)/purchase-orders/[id]/page.tsx",
  "app/(app)/purchase-orders/actions.ts",
  "app/(app)/site-reports/actions.ts",
  "app/(app)/snags/page.tsx",
  "app/(app)/snags/[id]/page.tsx",
  "app/(app)/toolbox/page.tsx",
  "app/(app)/toolbox/[id]/page.tsx",
  "lib/ai/aggregates.ts",
];

/** `const { data, error: NAME } = await …` → the bound error names. */
const ERROR_BIND_RE =
  /const \{[^}]*\berror(?::\s*([A-Za-z_$][A-Za-z0-9_$]*))?\s*[,}][^=]*=\s*await/g;

/** Is `name` inspected anywhere — thrown, branched on, reported, captured? */
function errorIsUsed(src: string, name: string): boolean {
  return new RegExp(
    `(?:if\\s*\\(\\s*!?${name}\\b` +
      `|throw readFailure\\([^)]*\\b${name}\\b` +
      `|reportReadFailure\\([^)]*\\b${name}\\b` +
      `|captureException\\([^)]*\\b${name}\\b` +
      `|\\b${name}\\s*(?:\\|\\||&&|\\?))`,
  ).test(src);
}

describe("merge guard — every destructured `error` is inspected", () => {
  for (const file of MERGE_OVERLAP_FILES) {
    it(`${file}: no bound error is left unused`, () => {
      const s = src(file);
      const names = new Set<string>();
      for (const m of s.matchAll(ERROR_BIND_RE)) names.add(m[1] ?? "error");
      const unused = [...names].filter((n) => !errorIsUsed(s, n));
      expect(
        unused,
        `${file} destructures ${unused.join(", ")} but never inspects ` +
          `${unused.length === 1 ? "it" : "them"}. This is the shape a bad merge ` +
          `resolution leaves behind: the binding survives, the ` +
          `\`if (error) throw readFailure(...)\` under it does not, and the read ` +
          `silently renders its empty state again. Restore the guard (or drop the ` +
          `binding if the read genuinely went away).`,
      ).toEqual([]);
    });
  }
});

// ── 3. the shape ledger ──────────────────────────────────────────────────────

/**
 * The FROZEN debt ledger — the REVIEWED best-effort residue at the time of the
 * sweep (docs/loud-read-failures.md, "The C ledger"), counted per scope across
 * the three shapes that carry this defect class:
 *
 *   discard   `const { data } = await …`        — error never bound
 *   softData  `res.data ?? []`, `(await …).data ?? []`
 *                                               — error bound nowhere, result
 *                                                 coalesced straight to empty
 *   countOnly `const { count } = await …`       — head:true count reads, where
 *                                                 `?? 0` is the reassuring answer
 *
 * `softData` skips a site when `<var>.error` appears in the same file, so a
 * result that IS inspected before its `?? []` is not counted as debt.
 *
 * These are `===`, not `<=`. A `<=` ratchet quietly absorbs movement: a file
 * deleted or a directory moved shows up as "progress" and buys headroom for a
 * real regression to slip in underneath. Any change to these numbers — up OR
 * down — must be a deliberate line in the diff, next to the reason. Going down
 * is good news: take the win and lower the baseline in the same commit.
 */
const RATCHET: Array<{
  scope: string;
  dirs: string[];
  discard: number;
  softData: number;
  countOnly: number;
}> = [
  { scope: "app/(app)", dirs: ["app/(app)"], discard: 56, softData: 52, countOnly: 5 },
  {
    scope: "app outside (app) — admin/api/portal/q/onboarding",
    dirs: ["app/admin", "app/api", "app/customer-portal", "app/q", "app/onboarding"],
    discard: 15,
    softData: 10,
    countOnly: 0,
  },
  {
    scope: "server + lib + components",
    dirs: ["server", "lib", "components"],
    discard: 32,
    softData: 59,
    countOnly: 4,
  },
];

const DISCARD_RE = /const \{ data(?:: [A-Za-z_$][A-Za-z0-9_$]*)? \} = await/g;
const COUNT_ONLY_RE = /const \{ count(?:: [A-Za-z_$][A-Za-z0-9_$]*)? \} = await/g;
/** `res.data ??` or `(await …).data ??` — capture the result identifier if there is one. */
const SOFT_DATA_RE = /(?:\)|\b([A-Za-z_$][A-Za-z0-9_$]*))\.data\s*\?\?/g;

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.(ts|tsx)$/.test(name) && !/\.(test|spec)\.tsx?$/.test(name)) yield p;
  }
}

type ShapeCounts = { discard: number; softData: number; countOnly: number };

function countShapes(dirs: string[]): {
  totals: ShapeCounts;
  byFile: Map<string, ShapeCounts>;
} {
  const byFile = new Map<string, ShapeCounts>();
  const totals: ShapeCounts = { discard: 0, softData: 0, countOnly: 0 };
  for (const dir of dirs) {
    for (const file of walk(resolve(ROOT, dir))) {
      const s = readFileSync(file, "utf8");
      const discard = (s.match(DISCARD_RE) ?? []).length;
      const countOnly = (s.match(COUNT_ONLY_RE) ?? []).length;
      let softData = 0;
      for (const m of s.matchAll(SOFT_DATA_RE)) {
        const v = m[1];
        // `<var>.error` inspected somewhere in the file ⇒ this `?? []` sits
        // behind a real check; not debt.
        if (v && new RegExp(`\\b${v}\\.error\\b`).test(s)) continue;
        softData++;
      }
      if (discard || softData || countOnly) {
        byFile.set(file.slice(ROOT.length + 1), { discard, softData, countOnly });
      }
      totals.discard += discard;
      totals.softData += softData;
      totals.countOnly += countOnly;
    }
  }
  return { totals, byFile };
}

describe("shape ledger — the frozen error-discarding debt", () => {
  for (const { scope, dirs, ...baseline } of RATCHET) {
    it(`${scope}: exactly ${baseline.discard} discard / ${baseline.softData} soft-data / ${baseline.countOnly} count-only`, () => {
      const { totals, byFile } = countShapes(dirs);
      const detail = [...byFile.entries()]
        .map(([f, c]) => `  ${f}: discard=${c.discard} softData=${c.softData} countOnly=${c.countOnly}`)
        .join("\n");
      expect(
        totals,
        `${scope} shape counts moved.\n` +
          `expected ${JSON.stringify(baseline)}\n` +
          `actual   ${JSON.stringify(totals)}\n\n` +
          `UP: a failed query must not render as an empty/healthy state. Bind ` +
          `\`error\` and throw readFailure(...) / render an explicit error state — or, ` +
          `if the read is genuinely best-effort, add it to the C ledger in ` +
          `docs/loud-read-failures.md and raise the baseline in the same commit, ` +
          `with the reason.\n` +
          `DOWN: good — you retired some debt. Lower the baseline here in the same ` +
          `commit so the next regression has nowhere to hide.\nPer file:\n${detail}`,
      ).toEqual(baseline);
    });
  }
});
