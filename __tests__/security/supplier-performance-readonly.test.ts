import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Supplier performance — the invariants that make this feature safe to ship.
 *
 * docs/roadmap/STATUS.md Phase 9 records subcontractor scoring and delay /
 * labour / material prediction as NOT BUILT, with the condition that they "must
 * ship as DETERMINISTIC metrics first, never labelled as prediction". This file
 * is that condition, enforced.
 *
 * The four risks a performance feature carries, and where each is pinned:
 *
 *   1. IT MUTATES WHAT IT MEASURES. A metric surface with a write path is a
 *      second, unaudited door into `finances` and the supplier record. §1.
 *   2. IT RE-DERIVES MONEY. A second definition of "settled" or "over-billed"
 *      that drifts from the authority is how a page comes to disagree with the
 *      ledger beside it. §2.
 *   3. IT BLENDS TWO COMPANIES. Merchants are shared between an owner's two
 *      companies, so an unpinned read computes ONE trading record out of TWO
 *      companies' history. §3.
 *   4. IT LIBELS A SUPPLIER. "100% late" from one delivery, or a score whose
 *      weights nobody can see. §4 and §5.
 *
 * SOURCE PINS, deliberately: these are RSC pages and a `server-only` service
 * coupled to createClient + cookies, and this repo has no Supabase mock harness
 * for them — the documented convention (see
 * __tests__/security/active-org-supplier-scoping.test.ts and
 * bank-match-invoice-org-scope.test.ts) is to pin the invariant on source here
 * and prove the runtime behaviour in the integration tier, which
 * __tests__/integration/rls/supplier-performance-active-org.test.ts does against
 * real Postgres with a real dual-org user.
 */

const ROOT = resolve(__dirname, "..", "..");
const src = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

const LIB = "lib/suppliers/performance.ts";
const SERVICE = "server/services/supplier-performance.ts";
const SECTIONS = "app/(app)/suppliers/_performance-sections.tsx";
const DETAIL_PAGE = "app/(app)/suppliers/[id]/performance/page.tsx";
const COMPARE_PAGE = "app/(app)/suppliers/compare/page.tsx";

/** Every file this feature owns. */
const OWNED = [LIB, SERVICE, SECTIONS, DETAIL_PAGE, COMPARE_PAGE];

/**
 * Source with comment lines removed. These pins assert things about CODE, and
 * the modules deliberately explain in prose the very things being banned ("no
 * score out of ten", "never called paid on time"), so scanning raw source would
 * fail on the explanations.
 */
function codeOf(path: string): string {
  return src(path)
    .split("\n")
    .filter((l) => {
      const t = l.trimStart();
      return !t.startsWith("*") && !t.startsWith("//") && !t.startsWith("/*");
    })
    .join("\n");
}

// ---------------------------------------------------------------------------
// 1. READ-ONLY
// ---------------------------------------------------------------------------

describe("supplier performance is read-only", () => {
  it("contains no write call anywhere in the feature", () => {
    // Measuring a supplier must not be able to change the supplier, and it must
    // certainly not be able to post to `finances` — receiving already deliberately
    // writes no money (20261059000000), and a metric page must not become the
    // path that does.
    for (const file of OWNED) {
      const code = codeOf(file);
      for (const write of [".insert(", ".update(", ".upsert(", ".delete(", ".rpc("]) {
        expect(code, `${file} performs a write: ${write}`).not.toContain(write);
      }
    }
  });

  it("exports no server action and declares no form action", () => {
    for (const file of OWNED) {
      const code = codeOf(file);
      expect(code, `${file} declares "use server"`).not.toContain('"use server"');
      expect(code, `${file} renders a form action`).not.toMatch(/<form[^>]*\saction=/);
    }
  });

  it("reaches finances, GRNs and the payment ledger with select only", () => {
    const code = codeOf(SERVICE);
    // Every .from(...) in the service must be immediately followed by .select.
    const froms = [...code.matchAll(/\.from\("([a-z_]+)"\)\s*\n?\s*\.([a-zA-Z]+)/g)];
    expect(froms.length, "no .from() calls found — the guard would pass vacuously").toBeGreaterThan(
      5,
    );
    for (const [, table, method] of froms) {
      expect(method, `${table} is reached with .${method}, not .select`).toBe("select");
    }
  });

  it("never uses the service-role client", () => {
    // This data is RLS-gated for a reason: `supplier_payments` is admin-only.
    // A service-role read here would hand a foreman the cash ledger.
    for (const file of OWNED) {
      const code = codeOf(file);
      expect(code, `${file} reaches for a service-role client`).not.toMatch(
        /service_?[Rr]ole|createServiceClient|SUPABASE_SERVICE_ROLE_KEY/,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// 2. NO RE-DERIVED MONEY
// ---------------------------------------------------------------------------

describe("supplier performance re-derives no money", () => {
  const code = codeOf(LIB);

  it("composes the settlement, billing and receipt authorities", () => {
    expect(code).toMatch(/from "@\/lib\/suppliers\/payments"/);
    expect(code).toContain("computeBillSettlements");
    expect(code).toMatch(/from "@\/lib\/purchase-orders\/billing"/);
    expect(code).toContain("computePoBilling");
    expect(code).toMatch(/from "@\/lib\/purchase-orders\/receiving"/);
    expect(code).toContain("computeReceiving");
  });

  it("decides which bills are settled ONLY via the settlement authority", () => {
    // A local re-implementation is how a page ends up disagreeing with the
    // ledger next to it. The status verdict must come from computeBillSettlements.
    expect(code).toMatch(/computeBillSettlements\(/);
    // No independent settlement comparison of its own.
    expect(code, "re-implements the settled/outstanding comparison").not.toMatch(
      /ALLOCATION_TOLERANCE|billGross\(|gross\s*-\s*settled/,
    );
  });

  it("performs no CIS arithmetic of any kind", () => {
    // Deduction rates, bases and withholding belong to lib/cis/** and the
    // frozen per-allocation snapshot. Performance counts, it does not compute tax.
    for (const banned of [
      "cis_deduction",
      "cis_basis",
      "cis_rate_applied",
      "deduction_rate",
      "rateForStatus",
      "0.2",
      "0.3",
    ]) {
      expect(code, `${LIB} does CIS arithmetic: ${banned}`).not.toContain(banned);
    }
  });

  it("routes every money figure through lib/money", () => {
    expect(code).toMatch(/from "@\/lib\/money"/);
    // No hand-rolled rounding: toFixed/Math.round on money is where float drift
    // and a penny of disagreement with the ledger come from.
    expect(code, "hand-rolls money rounding").not.toMatch(/toFixed\(2\)/);
    // The one Math.round in the module is the PERCENTAGE in ratio(), which is not
    // money. Pin that it is the only one, so a money rounding cannot join it.
    const rounds = code.match(/Math\.round\(/g) ?? [];
    expect(rounds.length, "more Math.round calls than the single percentage").toBe(1);
  });

  it("adds no date helper and does its day arithmetic through lib/time", () => {
    expect(code).toMatch(/from "@\/lib\/time\/compute"/);
    expect(code).toContain("addDaysIso");
    // Millisecond day maths on a plain `date` column is the off-by-one that
    // appears at the BST boundary. There must be none.
    for (const banned of ["86_400_000", "86400000", "getTime()", "setUTCDate", "Date.UTC"]) {
      expect(code, `${LIB} does millisecond date arithmetic: ${banned}`).not.toContain(banned);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. ACTIVE-ORG PINNED + LOUD READS
// ---------------------------------------------------------------------------

describe("supplier performance is active-org pinned", () => {
  const code = codeOf(SERVICE);

  it("pins every single read to the org, not just the first", () => {
    // RLS admits every org the viewer belongs to (`current_org_ids()`), so each
    // query needs its own predicate. Counting them is what stops a NEW read
    // being added later without one.
    const selects = code.match(/\.select</g) ?? [];
    const pins = code.match(/\.eq\("org_id", orgId\)/g) ?? [];
    expect(selects.length, "no reads found — the guard would pass vacuously").toBeGreaterThan(5);
    expect(pins.length, "a read is missing its org_id pin").toBe(selects.length);
  });

  it("scopes the supplier itself through the shared org-pinned loader", () => {
    for (const page of [DETAIL_PAGE]) {
      const pageCode = codeOf(page);
      expect(pageCode).toContain("loadSupplierForOrg");
      // …and treats another org's supplier as missing, not as viewable.
      expect(pageCode).toContain("notFound()");
    }
    // The comparison lists suppliers through the org-pinned lister.
    expect(codeOf(COMPARE_PAGE)).toContain("listSuppliersForOrg");
  });

  it("reaches child rows only through ids from an org-pinned parent read", () => {
    // GRNs have no supplier_id — they reach the supplier through the PO. If the
    // GRN read were not also constrained by `in(purchase_order_id, poIds)`, a
    // stray org_id pin alone would still admit every GRN in the org.
    expect(code).toMatch(/\.in\("purchase_order_id", poIds\)/);
    expect(code).toMatch(/\.in\("goods_received_note_id", grnIds\)/);
    // Allocations are fetched by payment id, so a row can never belong to a
    // payment we did not read (getSupplierLedger's rule).
    expect(code).toMatch(/\.in\(\s*"payment_id"/);
  });

  it("fails loudly on every read instead of rendering an empty record", () => {
    // An empty performance record and a failed query are indistinguishable once
    // the rows are gone, and the silent one is worse: a supplier with a poor
    // delivery record would render as a clean sheet.
    const selects = (code.match(/\.select</g) ?? []).length;
    const throws = (code.match(/throw readFailure\(/g) ?? []).length;
    expect(throws, "a read swallows its error").toBe(selects);
    // No silent fallback on a read result.
    expect(code, "swallows a read error into an empty array").not.toMatch(
      /\.data \?\? \[\][^;]*;\s*\/\/ *ok/,
    );
  });

  it("orders every capped read on a unique total order", () => {
    // Without an `id` tiebreak a capped read may drop a different row on each
    // request, so a rate would flicker between page loads.
    const limits = (code.match(/\.limit\(/g) ?? []).length;
    const idOrders = (code.match(/\.order\("id", \{ ascending: true \}\)/g) ?? []).length;
    const compositeOrders = (
      code.match(/\.order\("purchase_order_line_item_id", \{ ascending: true \}\)/g) ?? []
    ).length;
    expect(limits).toBeGreaterThan(5);
    expect(idOrders + compositeOrders, "a capped read has no unique tiebreak").toBe(limits);
  });
});

// ---------------------------------------------------------------------------
// 4. NO PREDICTION, NO SCORE, NO AI
// ---------------------------------------------------------------------------

describe("supplier performance is measurement, not prediction", () => {
  /**
   * The composite/prediction vocabulary.
   *
   * Matched as IDENTIFIERS, not as substrings, and the distinction is
   * load-bearing: the surfaces tell the operator in plain English that there is
   * deliberately "no overall mark, star rating or grade", so a substring ban
   * would fail on the very sentence that documents the constraint being
   * enforced. What must not exist is a `score:` field, a `rating =`, a
   * `predictDelay(` — a value the code computes and carries.
   */
  const COMPOSITE_TERMS = [
    "score",
    "scores",
    "rating",
    "ratings",
    "grade",
    "letterGrade",
    "stars",
    "weight",
    "weights",
    "weighted",
    "forecast",
    "predict",
    "prediction",
    "probability",
    "likelihood",
    "confidence",
  ];

  it("computes no composite value under any name", () => {
    // Phase 9's constraint. A single number needs weights, and no weight in this
    // domain is derivable from the data — it would be an opinion with a decimal
    // point. The unit tier additionally pins the record's exact key set.
    for (const file of OWNED) {
      const code = codeOf(file);
      for (const term of COMPOSITE_TERMS) {
        // A declaration, a property key, an assignment, a call, or a member read.
        const declared = new RegExp(
          `(?:const|let|var|function)\\s+${term}\\b|` + // const score
            `\\b${term}\\s*[:=]\\s*[^=]|` + //            score: … / score = …
            `\\b${term}\\s*\\(|` + //                     score(…)
            `\\.${term}\\b`, //                           x.score
          "i",
        );
        expect(
          declared.test(code),
          `${file} introduces a composite/prediction value: ${term}`,
        ).toBe(false);
      }
    }
  });

  it("keeps the vocabulary out of the computation layer entirely", () => {
    // The pure lib and the service carry no user-facing prose, so there the ban
    // can be absolute — not even a variable name may hint at a score.
    for (const file of [LIB, SERVICE]) {
      const code = codeOf(file).toLowerCase();
      for (const term of COMPOSITE_TERMS) {
        expect(code, `${file} mentions ${term} in code`).not.toContain(term.toLowerCase());
      }
    }
  });

  it("uses no AI, no model and no external call", () => {
    for (const file of OWNED) {
      const code = codeOf(file);
      for (const banned of [
        "@/lib/ai",
        "anthropic",
        "openai",
        "Anthropic",
        "OpenAI",
        "fetch(",
        "embedding",
      ]) {
        expect(code, `${file} reaches for AI or the network: ${banned}`).not.toContain(banned);
      }
    }
  });

  it("builds no merchant integration", () => {
    // Explicitly out of scope: no JP Corry / Jewson / Travis Perkins API, no
    // external price feed. Every figure comes from the company's own records.
    for (const file of OWNED) {
      const code = codeOf(file).toLowerCase();
      for (const banned of ["jewson", "corry", "travis", "buildbase", "api_key", "apikey"]) {
        expect(code, `${file} references an external merchant integration: ${banned}`).not.toContain(
          banned,
        );
      }
    }
  });

  it("keeps the pure metric layer free of I/O", () => {
    const code = codeOf(LIB);
    expect(code, "the metric layer imports Supabase").not.toContain("supabase");
    expect(code, "the metric layer became server-only").not.toContain("server-only");
    // No clock read: every figure must be reproducible from its inputs alone.
    expect(code, "the metric layer reads the clock").not.toMatch(/new Date\(\)|Date\.now\(\)/);
  });
});

// ---------------------------------------------------------------------------
// 5. THE SAMPLE-SIZE CONVENTION IS STRUCTURAL
// ---------------------------------------------------------------------------

describe("small samples cannot be rendered as rates", () => {
  it("declares the minimum-n convention in one place", () => {
    const code = codeOf(LIB);
    expect(code).toMatch(/export const MIN_RATED_SAMPLE = \d+/);
    // The threshold is applied by ratio() and nowhere else, so no surface can
    // pick its own.
    const uses = code.match(/MIN_RATED_SAMPLE/g) ?? [];
    expect(uses.length, "the threshold is referenced by more than its definition + guards")
      .toBeLessThanOrEqual(4);
  });

  it("makes an unearned rate NULL rather than a number", () => {
    const code = codeOf(LIB);
    // `pct: number | null` is what forces every render site to handle the
    // small-sample case. If this became `number`, a 100%-from-one could render.
    expect(code).toMatch(/pct: number \| null/);
    expect(code).toMatch(/rated && n > 0 \? Math\.round\(\(count \/ n\) \* 100\) : null/);
  });

  it("shows the sample size beside every rate on every surface", () => {
    // `formatRate`/`formatRateCompact` embed "of n" and degrade to counts, so a
    // surface that uses them cannot print a bare unearned percentage.
    for (const page of [SECTIONS, COMPARE_PAGE]) {
      const code = codeOf(page);
      expect(code, `${page} does not use the honest rate formatter`).toMatch(
        /formatRate|formatRateCompact/,
      );
      expect(code, `${page} does not guard on isRated`).toContain("isRated");
    }
  });

  it("never interpolates a raw pct without an isRated guard", () => {
    // The specific mistake: `{r.punctuality.pct}%` on its own renders "null%"
    // for a thin sample. Every `.pct}` in a surface must sit inside a branch
    // that has already checked isRated.
    for (const page of [SECTIONS, COMPARE_PAGE, DETAIL_PAGE]) {
      const code = codeOf(page);
      const pctUses = [...code.matchAll(/\.pct\}/g)];
      for (const use of pctUses) {
        const before = code.slice(Math.max(0, use.index! - 260), use.index!);
        expect(
          /isRated\(/.test(before),
          `${page} interpolates .pct without a nearby isRated guard`,
        ).toBe(true);
      }
    }
  });

  it("states on the surface why a percentage is missing", () => {
    const code = codeOf(SECTIONS);
    expect(code).toContain("sampleCaveat");
    expect(code).toContain("Too few to rate");
  });

  it("never colours an aggregate figure, because a colour ramp is a grade", () => {
    // An amber/red "late rate" needs a threshold at which lateness becomes bad,
    // and inventing that threshold is letter-grading spelled in Tailwind. The
    // aggregate tiles therefore take NO tone at all — the two components that
    // render them must neither accept nor forward one.
    const code = codeOf(SECTIONS);
    for (const component of ["RatioTile", "CountTile"]) {
      const start = code.indexOf(`function ${component}(`);
      expect(start, `${component} not found`).toBeGreaterThan(-1);
      const next = code.indexOf("\nfunction ", start + 1);
      const body = code.slice(start, next === -1 ? undefined : next);
      expect(body, `${component} takes or forwards a tone`).not.toMatch(/\btone\b/);
    }
    // Tone survives only on the per-record verdict badge and the sample caveat.
    const toned = [...code.matchAll(/tone=\{?["']?(\w+)/g)].map((m) => m[1]!);
    expect(toned.length, "no tones found — the guard would pass vacuously").toBeGreaterThan(0);
    for (const t of toned) {
      expect(
        ["slate", "emerald", "amber", "red", "v"].includes(t),
        `unexpected tone source '${t}' — a rate-driven tone would be a grade`,
      ).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 6. THE DEFINITIONS ARE ON THE PAGE
// ---------------------------------------------------------------------------

describe("the measurement rules are visible to the operator", () => {
  it("renders the definitions on both surfaces rather than hiding them in docs", () => {
    for (const page of [DETAIL_PAGE, COMPARE_PAGE]) {
      expect(codeOf(page), `${page} does not render HowMeasured`).toContain("HowMeasured");
    }
  });

  it("names what is NOT measured, including snag attribution", () => {
    const sections = src(SECTIONS);
    expect(sections).toContain("NotMeasuredSection");
    // The absence has to be stated on the page: an operator who reads a clean
    // delivery record as clean workmanship has been misled by silence.
    expect(sections.toLowerCase()).toContain("snag");
    for (const page of [DETAIL_PAGE, COMPARE_PAGE]) {
      expect(codeOf(page), `${page} hides the omissions`).toContain("NotMeasuredSection");
    }
  });

  it("does not attribute snags to a supplier anywhere in the feature", () => {
    // `public.snags` has no supplier_id and there is no work-package entity, so
    // any link would be manufactured from free-text `trade` vs `category`. This
    // fails if somebody wires one up without a real FK to hang it on.
    for (const file of OWNED) {
      const code = codeOf(file);
      expect(code, `${file} queries snags`).not.toMatch(/from\("snags"\)/);
      expect(code, `${file} matches trade against category`).not.toMatch(/trade.*categor/i);
    }
  });

  it("does not call our own payment speed 'on time'", () => {
    // No payment term is stored anywhere (`finances` has no due date), so "on
    // time" has no referent. Confusing OUR settlement speed with THEIR
    // punctuality is the one wording error that would misattribute a fact to
    // the wrong party.
    const code = codeOf(LIB);
    expect(code).toContain("SettlementSpeed");
    expect(code.toLowerCase(), "the settlement measure claims an agreed deadline").not.toMatch(
      /paid_on_time|paidontime|on_time_payment|overdue/,
    );
  });
});

// ---------------------------------------------------------------------------
// 7. THE FEATURE STAYS INSIDE ITS OWN FILES
// ---------------------------------------------------------------------------

describe("the feature adds no schema and no migration", () => {
  it("claims no migration slot", () => {
    // ZERO migrations: every metric is derived from tables that already exist
    // (20261046–55 CIS, 20261059/60 GRNs, 20261006/09 orders and bills).
    const dir = resolve(ROOT, "supabase", "migrations");
    const files = readdirSync(dir).filter((f) => f.endsWith(".sql"));
    const suspicious = files.filter((f) => /performance|supplier_score|scoring/i.test(f));
    expect(suspicious, `migrations added for this feature: ${suspicious.join(", ")}`).toEqual([]);
  });

  it("does not reach into another lane's protected files", () => {
    // The lib composes lib/purchase-orders/** by IMPORT only; it must not have
    // edited it. A cheap structural check that the composition boundary held.
    const walk = (dir: string): string[] => {
      const out: string[] = [];
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) out.push(...walk(full));
        else if (/\.tsx?$/.test(entry)) out.push(full);
      }
      return out;
    };
    const poLib = walk(resolve(ROOT, "lib", "purchase-orders"));
    for (const f of poLib) {
      expect(
        readFileSync(f, "utf8"),
        `${f} was made to depend on the performance module — the dependency must point the other way`,
      ).not.toContain("suppliers/performance");
    }
  });
});
