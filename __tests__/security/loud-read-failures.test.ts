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
    // send-quote now gets the identical treatment across all three of its
    // load-failure sites (quote, token, line items): refusal + Sentry capture,
    // and the raw form is gone.
    const q = src("lib/email/send-quote.ts");
    expect(q).toMatch(/if \(linesError\) \{/);
    expect(q).toMatch(
      /Sentry\.captureException\(readFailure\("send-quote: line items", linesError\)\)/,
    );
    expect(q).toMatch(
      /Sentry\.captureException\(readFailure\("send-quote: quote", qErr\)\)/,
    );
    expect(q).toMatch(
      /Sentry\.captureException\(readFailure\("send-quote: token", tErr\)\)/,
    );
    expect(q, "never echo raw Postgres text to a caller").not.toMatch(
      /detail: (linesError|qErr|tErr)\.message/,
    );
    // …and the two remaining route/lib siblings named in the follow-up.
    expect(src("app/api/quotes/[id]/send/route.ts")).not.toMatch(/detail: qErr\.message/);
    expect(src("app/api/invoices/[id]/remind/route.ts")).not.toMatch(/detail: invErr\.message/);
    expect(src("lib/email/send-invoice.ts")).not.toMatch(/detail: iErr\.message/);
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

    // GUARD-EVASION PIN. The six throws above are necessary but NOT sufficient:
    // an outer try/catch that returns the empty schedule downgrades every one of
    // them to a silent empty state at RUNTIME while this string check still
    // passes. That is exactly the shape this loader used to carry — the sole
    // portal loader with a blanket `} catch (err) { return EMPTY }` — so a
    // transient DB error hid a customer's agreed payment schedule + retention
    // release date behind a healthy-looking empty panel. readFailure is DESIGNED
    // to propagate to the route-group error boundary; a catch that swallows it
    // negates the pin. Forbid any catch clause that returns the empty schedule
    // (`return EMPTY`) or fabricates a `hasSchedule: false` schedule on the
    // error path. A string-only pin can never again pass while the runtime path
    // stays silent.
    expect(
      s,
      "an outer catch that returns EMPTY negates all six loud reads at runtime",
    ).not.toMatch(/catch\s*\([^)]*\)\s*\{[^{}]*return EMPTY/);
    expect(
      s,
      "no catch may fabricate a hasSchedule:false schedule on the error path",
    ).not.toMatch(/catch\s*\([^)]*\)[\s\S]{0,400}hasSchedule:\s*false/);
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

  /**
   * The Daily Briefing loader is LOUD-OR-WHOLE. Its outer try/catch degrades the
   * whole section to an honest empty state, but that only fires on a THROWN error
   * — so every read must THROW on failure, never coalesce to a partial/empty set.
   * The shipped bug: `pagedRows` did `const { data } = await fetchAllRows(...)`,
   * discarding the error, and `fetchAllRows` returns the rows-so-far PLUS the
   * error on a mid-page failure. A single-table statement timeout / RLS blip
   * therefore zeroed ONE signal (a false all-clear on overdue invoices / stale
   * quotes / cold leads / retention / upcoming compliance-document expiry) while
   * every other signal rendered healthy — the outer catch never saw it.
   */
  it("the daily briefing pages loud — pagedRows throws on any read error, never a partial set", () => {
    const s = src("server/services/briefing.ts");
    expect(s, "must bind error from fetchAllRows, not `const { data } =`").toMatch(
      /const \{ data, error \} = await fetchAllRows/,
    );
    expect(s, "a paged read error must throw so the WHOLE briefing degrades").toMatch(
      /if \(error\) throw readFailure\(`briefing: \$\{table\}`, error as SupabaseReadError\);/,
    );
  });

  it("the daily briefing's direct reads are loud (compliance expiry, jobs-tomorrow, dismissals)", () => {
    const s = src("server/services/briefing.ts");
    expect(s).toMatch(
      /if \(complianceRes\.error\) throw readFailure\("briefing: compliance documents", complianceRes\.error as SupabaseReadError\);/,
    );
    expect(s).toMatch(
      /if \(jobsTomorrowRes\.error\) throw readFailure\("briefing: jobs unassigned tomorrow", jobsTomorrowRes\.error as SupabaseReadError\);/,
    );
    expect(s).toMatch(
      /if \(dismissRes\.error\) throw readFailure\("briefing: dismissals", dismissRes\.error as SupabaseReadError\);/,
    );
  });
});

/**
 * SEV-A — a safety control that failed OPEN.
 *
 * The job hub's H&S panel reads RAMS, permits and toolbox talks, and it HIDES
 * ITSELF when all three come back empty. With `data ?? []` and no `error`
 * binding, a rejected query produced the single most reassuring output the
 * product can render: the section vanished, and with it the "No issued RAMS is
 * current for this job" warning and every unsigned toolbox talk. Severity (b)
 * in the model above — a false claim about legal compliance, made exactly when
 * the database is unhealthy.
 *
 * This block is the red-if-reverted proof. Restoring the bare `?? []` shape
 * drops the `<res>.error` bindings, and BOTH the named pins and the structural
 * sweep below go red.
 */
describe("SEV-A: the job safety panel fails CLOSED", () => {
  const FILE = "app/(app)/jobs/[id]/_job-safety.tsx";

  it("reports every one of the three safety reads by name", () => {
    const s = src(FILE);
    expect(s).toMatch(/reportReadFailure\("job safety: RAMS on job", ramsRes\.error\)/);
    expect(s).toMatch(/reportReadFailure\("job safety: permits on job", permitsRes\.error\)/);
    expect(s).toMatch(
      /reportReadFailure\("job safety: toolbox talks on job", talksRes\.error\)/,
    );
  });

  it("renders an explicit error block instead of hiding the section", () => {
    const s = src(FILE);
    // The panel's healthy empty path is `return null` (it hides). On failure it
    // must return VISIBLE markup that denies the all-clear reading.
    expect(s).toMatch(/if \(failed\) \{/);
    expect(s).toMatch(/border-red-200 bg-red-50/);
    expect(s, "the error state must say it is not an all-clear").toMatch(
      /This is NOT an all-clear/,
    );
  });

  it("ANY failing read blocks the render — a partial safety picture is a false all-clear", () => {
    const s = src(FILE);
    // Three separate reports, one shared `failed` latch: permits loading while
    // RAMS is rejected must not render "this job has no risk assessment".
    expect((s.match(/failed = true/g) ?? []).length).toBe(3);
  });

  it("the read cast carries `error` — typing a read error-blind is the root cause", () => {
    const s = src(FILE);
    expect(s).toMatch(/data: unknown\[\] \| null; error: SupabaseReadError \| null/);
    expect(s, "an error-blind promise type makes the bug uncatchable").not.toMatch(
      /Promise<\{ data: unknown\[\] \| null \}>/,
    );
  });

  it("no result is coalesced to empty without its error being inspected", () => {
    // The generalisation: for every `<name>Res.data ??` in the file there must
    // be a matching `<name>Res.error`. Catches a PARTIAL revert that the named
    // pins above would miss (e.g. one read quietly restored to `?? []`).
    const s = src(FILE);
    const unchecked = [...s.matchAll(/\b([A-Za-z_$][A-Za-z0-9_$]*)\.data\s*\?\?/g)]
      .map((m) => m[1]!)
      .filter((v) => !new RegExp(`\\b${v}\\.error\\b`).test(s));
    expect(
      [...new Set(unchecked)],
      `${FILE} coalesces a read straight to empty without checking its error. ` +
        `On a SAFETY surface that renders as "no outstanding RAMS / no missing ` +
        `sign-offs" — the false all-clear this programme exists to kill.`,
    ).toEqual([]);
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
  {
    scope: "app/(app)",
    dirs: ["app/(app)"],
    // 60 → 57 (#456 active-org read-side class): diary/[id], snags/[id] and
    // site-reports/[id] each resolved their job-name label with a discarding
    // `const { data: job } = await supabase.from("jobs")…` (error dropped, then
    // `job?.customer?.name ?? "Job"` rendered on failure). All three were routed
    // through the LOUD lib/jobs/load.ts chokepoint (loadJobForOrg — binds `error`
    // and throws readFailure), which also pins the active org. 3 discards retired.
    // 57 → 56 (F-1 picker-completion wave): app/(app)/fleet/_components/load.ts
    // ::loadSupplierOptions dropped its inline bare `const { data } = await
    // supabase.from("suppliers")…` (a read PostgREST silently clamped at 1000)
    // and now routes through the paged, org-pinned listSuppliersForOrg chokepoint,
    // which binds + throws `error`. 1 discard retired.
    // 56 → 55 (C66 cast-form de-vacuum): countPostedReceipts (app/(app)/
    // purchase-orders/_receiving-data.ts) dropped its inline bare `const { data }
    // = await …in(purchaseOrderIds).limit(1000)` (which discarded the error) when
    // it was rewritten to CHUNK + PAGE via fetchAllRows and now binds + throws on
    // `error`. 1 discard retired.
    discard: 55 /* +4 inherited from Trains 24-26, see docs/loud-read-failures.md */,
    // 52 → 49: the job hub's H&S panel (_job-safety.tsx) bound `error` on all
    // three of its reads (RAMS, permits, toolbox talks), so their `?? []` now
    // sits behind a real check and stops counting as debt. A SAFETY control
    // that hid itself on read failure — see the marquee pin above.
    // 49 → 40 (C35b jobs): jobs/[id]/page.tsx (5 reads) + jobs/[id]/commercial/page.tsx
    // (4 reads) routed through fetchAllRows with bound+thrown `error` — 9 leave the ledger.
    // 40 → 36 (C35b services): imports/actions.ts::annotateDuplicates moved its four
    // best-effort dedupe REFERENCE reads (customers/invoices/memberships/leads) onto
    // fetchAllRows — the paged reads use non-null `.data` directly, so 4 more leave the
    // soft-data ledger. Cumulative F-1 bare-select elimination: 49 → 36.
    // 36 → 33 (F-1 time_entries/quote_line_items sweep): me/page.tsx (week + month
    // hours) and staff/[id]/timesheet/page.tsx (month entries) moved off bare reads
    // onto fetchAllRows with bound + thrown `error`, so their `?? []` now sits behind
    // a real check and stops counting as debt — 3 leave the soft-data ledger.
    // 33 → 34 (active-org write-pin class): jobs/[id]/billing/actions.ts
    // generateStageInvoice gained a fail-CLOSED active-org assert
    // (`.select("id").eq("id", stageId).eq("org_id", ctx.org.id)`) BEFORE the
    // generate_stage_invoice RPC — the RPC only checks is_org_admin(org_id), not
    // the active org. On a read error the `?? []` yields [] → the RPC is skipped
    // (no invoice generated), which is the safe outcome; matches the file's other
    // best-effort billing reads. See docs/loud-read-failures.md (C ledger).
    softData: 34,
    // 5 → 4: train "offl" moved createSiteReport's cosmetic report-number count
    // (`nextReportNumber`, a head:true count read) OUT of the action and INTO the
    // shared write core (server/services/site-report-writes.ts), so the online
    // form and the offline queue replay allocate it identically. The count-only
    // shape moved with it — it is now counted under "server + lib + components".
    countOnly: 4,
  },
  {
    scope: "app outside (app) — admin/api/portal/q/onboarding",
    dirs: ["app/admin", "app/api", "app/customer-portal", "app/q", "app/onboarding"],
    // 15 → 13 (cert-PDF letterhead fix): both completion-certificate PDF routes
    // — app/api/completion-certificates/[id]/pdf/route.tsx and
    // app/customer-portal/[token]/certificates/[id]/pdf/route.tsx — read org
    // branding with a discarding `const { data: org } = await …` (error dropped,
    // org→{} → BLANK letterhead + no logo on a live contractual PDF). Both now
    // bind `error` and fail loud (throw readFailure / 500), so the reads leave
    // the ledger. 2 discards retired.
    discard: 13,
    softData: 10,
    countOnly: 0,
  },
  {
    scope: "server + lib + components",
    dirs: ["server", "lib", "components"],
    // 35 → 36: server/services/hq-outreach.ts (the Outreach AI task-engine runner,
    // Directive 010 Phase 4) reuses the sibling runners' decorative `loadCompanyNames`
    // read verbatim — a missing company NAME renders as null on the recent-runs feed,
    // never as a healthy empty state, so the error is deliberately discarded (identical
    // to hq-research.ts / hq-qualification.ts). See docs/loud-read-failures.md.
    // 36 → 35 (briefing loud-or-whole): server/services/briefing.ts::pagedRows bound
    // `error` from fetchAllRows and now THROWS readFailure on a (mid-page) read error
    // instead of `const { data } = await …` discarding it — a partial paged set was
    // silently under-counting one signal into a false all-clear. 1 discard retired.
    // 35 → 36 (F-1 picker-completion wave): server/services/sites.ts::listSitesForOrg
    // was split into a BOUNDED sample branch and a COMPLETE paged (fetchAllRows)
    // picker branch — the old single `const { data } = await …` swallow becomes two
    // (one per branch). This reader is best-effort BY DESIGN: every picker reaches it
    // via listSiteOptionsForOrg's try/catch (degrades to []), and the fleet home-site
    // <select> preserve-injects the saved id, so a partial/empty list can never
    // silent-NULL a saved site. The net across the codebase is neutral (app/(app)
    // retired one clamped bare read, above). See docs/loud-read-failures.md (C ledger).
    // 36 → 38 (P2 blueprint pins wave): two best-effort DISPLAY-NAME joins were
    // added, each a `const { data } = await …` that deliberately drops `error`
    // exactly like the pre-existing snag-title join beside it —
    // (a) server/services/blueprint-pins.ts::listPinsForVersion resolves task-pin
    //     ASSIGNEE names (.in(assigneeIds) on users); a failed lookup shows the
    //     assignee as "Member"/null, it never blanks or hides a pin.
    // (b) server/services/blueprint-pin-comments.ts::listPinComments resolves
    //     comment AUTHOR names (.in(authorIds) on users); a failed lookup shows the
    //     author as "Member", it never drops a comment.
    // Both PRIMARY reads (the pins list; the paged comment thread) bind + throw
    // readFailure, so a real read failure is still loud — only the decorative name
    // enrichment degrades. See docs/loud-read-failures.md (C ledger).
    // 38 → 39 (P3 reporting): lib/reports/export-render.ts::loadReportOrg reads the
    // org letterhead (name/phone/VAT/logo/address) for the shared report PDF and
    // deliberately drops `error` — a missing/errored letterhead falls back to
    // "CrewFlow" and null fields, exactly like the pre-existing best-effort
    // letterhead read in app/api/site-reports/[id]/pdf. The report's DATA is
    // composed by buildReportDocument, whose every underlying read is loud
    // (readFailure) + F-1-paged; only the decorative header degrades, never a
    // figure. See docs/loud-read-failures.md (C ledger).
    // 39 → 37 (MP site-timeline): server/services/job-site-hub.ts's paged helpers
    // (pagedByJob / pagedByIds) previously discarded fetchAllRows' `error`; they
    // now bind it and throw readFailure(...) so the LOUD /jobs/[id]/timeline route
    // surfaces a failed read instead of an empty feed. The best-effort job-page
    // panels keep their try/catch, so they still degrade gracefully — two silent
    // discards retired.
    discard: 37,
    // 61 → 62: server/services/hq-support-snapshot.ts `listSupportTicketRowsForHq`
    // is the lean, message-free board reader (HQ Support AI) — it degrades to `[]`
    // exactly like its sibling `listSupportTicketsForHq` in the same file, and the
    // pure board layer then renders an all-`insufficient` board rather than fake
    // data. See docs/loud-read-failures.md.
    // 62 (unchanged): the new Product AI reader `listFeatureSignalRowsForHq`
    // (same file) inspects its read error and returns `null` on failure — the
    // honest loud-degrade path, so it is genuinely guarded and self-skips. It
    // names its result `sigRes` (NOT `res`) on purpose: the ratchet excludes a
    // `<var>.data ?? []` read once any `<var>.error` check exists file-wide, so a
    // `res.error` guard here would have masked the two pre-existing, genuinely
    // UNGUARDED `res`-named soft reads in this file (`listSupportTicketsForHq`
    // L~110 and `listSupportTicketRowsForHq` L~227 — both still `res.data ?? []`
    // with no error check of their own, degrading silently). Using a distinct
    // `sigRes` keeps `res.error` absent file-wide, so those two remain COUNTED
    // and the ratchet still sees any future unguarded `res.data ?? []` here.
    // The new reader adds no soft-data debt; baseline is unchanged from before
    // this PR. See docs/loud-read-failures.md.
    // 62 → 59 (briefing loud-or-whole): server/services/briefing.ts now binds and
    // THROWS on the `error` of its three direct (non-pagedRows) reads —
    // complianceRes (the ONLY expiry signal), jobsTomorrowRes (unassigned jobs
    // tomorrow) and dismissRes (the viewer's dismissals). Each `<res>.error` check
    // now sits before its `<res>.data ?? []`, so all three leave the soft-data
    // ledger. A swallowed error on any of them was a false all-clear / dropped
    // dismissals while the rest of the briefing rendered healthy. 3 soft-data retired.
    // 59 → 55 (F-1 HQ support paging): server/services/hq-support-snapshot.ts had
    // FOUR unpaged cross-tenant `<res>.data ?? []` reads whose full row set was
    // mapped/counted into "fact" figures on live HQ surfaces — the tickets +
    // messages reads in `listSupportTicketsForHq` (res, msgRes), the board reader
    // `listSupportTicketRowsForHq` (res), and the detail thread in
    // `loadSupportTicketDetailForHq` (mRes). All four now page via fetchAllRows and
    // bind + THROW `readFailure` on error (`listFeatureSignalRowsForHq` keeps its
    // null-degrade, already guarded), so their `?? []` is gone entirely. A silent
    // 1000-row clamp was truncating the CEO/triage figures; see the F-1 bare-select
    // guard's HIGH_VALUE_TABLES (support_tickets/support_messages added same wave).
    // 4 soft-data retired. See docs/loud-read-failures.md.
    // 55 → 54 (same wave, live-read guard proof): once the F-1 bare-select guard
    // learned the `function table(name){ return c.from(name) }` DECLARATION-wrapper
    // form, it bit the LIVE cross-tenant support_tickets read in
    // server/services/hq-health-deep-dive.ts (`table("support_tickets")…in(org_id)…
    // order()`, counted per-org in JS). That read now pages via fetchAllRows and
    // binds + logs its error, so its `ticketsRes.data ?? []` leaves the ledger. Its
    // sibling org/health-event/billing/notification reads carry the same risk and
    // are tracked for the reported detection follow-up. 1 soft-data retired.
    // 54 → 47: the .from(as never) cast-form F-1 wave paged + made LOUD several
    // reads that previously swallowed their error and degraded to `?? []`:
    // customer-support-service.ts (my-tickets list + ticket messages now throw
    // readFailure), and the hq-snapshot / hq-analytics / hq-alerts / hq-billing /
    // hq-customer / hq-health-recompute / hq-health-deep-dive estate reads now bind
    // the fetchAllRows error (thrown, or logged for the best-effort snapshots) and
    // consume `res.data` directly instead of `res.data ?? []`. 7 soft-data retired.
    softData: 47,
    // 4 → 5: server/services/hq-outreach.ts `countOutreach` is a head:true count read
    // for the CEO metrics tile, mirroring countResearch/countQualification — an honest
    // zero when nothing has run yet is the correct reassuring answer here.
    // 5 → 6: train "offl" moved createSiteReport's cosmetic report-number count read
    // (`nextReportNumber`) into the shared write core
    // (server/services/site-report-writes.ts) — same head:true count, now here
    // instead of under app/(app); a duplicate label on a race is harmless (there
    // is no unique constraint on report_number).
    countOnly: 6,
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
