import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import {
  MATERIAL_REQUEST_STATUSES,
  MATERIAL_REQUEST_TRANSITIONS,
  MATERIAL_REQUEST_DERIVED_STATUSES,
} from "@/lib/material-requests/schema";

/**
 * M4 — material requests: the trust-boundary proofs.
 *
 * Hermetic by design (filesystem + pure functions), like the rest of this
 * tier. The live-Postgres proofs — real RLS denial, real trigger refusals,
 * dual-org isolation — live in
 * __tests__/integration/rls/material-requests.test.ts.
 *
 * FOUR invariants, each pinned because breaking it is silent:
 *   1. THE FROZEN CROSS-LANE CONTRACT. My migrations reference NOTHING from
 *      the concurrent stock lane. A stray FK would make this branch unappliable
 *      on its own, and would make merge order load-bearing.
 *   2. NO ACTION SETS A DERIVED STATUS. Fulfilment is derived; a hand-set
 *      'fulfilled' is the one bug that makes the product lie about whether a
 *      site has its materials.
 *   3. EVERY READ AND WRITE IS ACTIVE-ORG PINNED. RLS admits every org the
 *      viewer belongs to; the pin is what makes "the company I am working in"
 *      real (#456/#459/#461/#463/#464/#468).
 *   4. THE DATABASE IS THE ENFORCER. The transition trigger, the lifecycle
 *      guard, the org-integrity guard and the rejection-reason CHECK all exist
 *      in SQL, so direct PostgREST cannot route around the app.
 */

const ROOT = resolve(__dirname, "..", "..");
const MIGRATIONS = resolve(ROOT, "supabase", "migrations");

const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

const MIG_66 = readFileSync(
  join(MIGRATIONS, "20261066000000_material_requests.sql"),
  "utf8",
);
const MIG_67 = readFileSync(
  join(MIGRATIONS, "20261067000000_material_request_lifecycle.sql"),
  "utf8",
);
const MY_SQL = `${MIG_66}\n${MIG_67}`;

const ACTIONS = read("app/(app)/materials/requests/actions.ts");
const SERVICE = read("server/services/material-requests.ts");
const SEAM = read("server/services/material-fulfilment.ts");
// Train 5: the draft create moved into a shared core so the offline write
// queue and the online form use ONE write path (offline-write-expansion).
const WRITE_CORE = read("server/services/material-request-writes.ts");
const QUEUE_PAGE = read("app/(app)/materials/requests/page.tsx");
const DETAIL_PAGE = read("app/(app)/materials/requests/[id]/page.tsx");
const NEW_PAGE = read("app/(app)/materials/requests/new/page.tsx");
const PANEL = read("app/(app)/jobs/[id]/_job-materials.tsx");

/** Strip SQL comments so a prose mention can't satisfy a code assertion. */
function sqlCode(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}
const MY_SQL_CODE = sqlCode(MY_SQL);

/** Strip // and /* *\/ comments so prose can't satisfy a code assertion. */
function tsCode(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

// ── 1. The frozen cross-lane contract ───────────────────────────────────────

describe("cross-lane contract — my migrations depend on NOTHING from the stock lane", () => {
  /**
   * The stock lane (stock_items / stock_movements / record_stock_issue) is
   * built concurrently and is not on this branch. If either of my migrations
   * referenced one of its objects, this branch could not be applied on its own
   * and merge ORDER would become load-bearing — the exact landmine the frozen
   * contract exists to avoid.
   */
  const STOCK_OBJECTS = [
    "stock_items",
    "stock_movements",
    "record_stock_issue",
    "record_stock_receipt_from_grn",
    "record_stock_adjustment",
    "record_stock_transfer",
    "record_stock_correction",
    "stock_balance",
  ];

  it("neither migration references any stock-lane table or function in CODE", () => {
    const offenders = STOCK_OBJECTS.filter((o) =>
      new RegExp(`\\b${o}\\b`).test(MY_SQL_CODE),
    );
    expect(
      offenders,
      `20261066/67 reference stock-lane objects (${offenders.join(", ")}). The lanes ` +
        `are independent by contract: a FK or a function call to a table that is not ` +
        `on this branch makes the migration unappliable and makes merge order matter.`,
    ).toEqual([]);
  });

  it("stock_item_id is declared as a PLAIN uuid with no FOREIGN KEY", () => {
    // The deferred-FK debt, pinned. If somebody later "tidies this up" by
    // adding the FK, the migration stops applying without the stock lane.
    expect(MIG_66).toMatch(/stock_item_id\s+uuid/);
    const line = MIG_66.split("\n").find((l) => /^\s*stock_item_id\s+uuid/.test(l)) ?? "";
    expect(line.toLowerCase(), "stock_item_id must not carry `references`").not.toContain(
      "references",
    );
  });

  it("the candidate keys a future composite FK will need already exist", () => {
    // So the deferred FK can be added later WITHOUT reshaping these tables.
    expect(MY_SQL_CODE).toMatch(/material_requests_id_org_key\s+unique\s*\(\s*id\s*,\s*org_id\s*\)/i);
    expect(
      MY_SQL_CODE,
    ).toMatch(/material_request_lines_id_org_key\s+unique\s*\(\s*id\s*,\s*org_id\s*\)/i);
  });

  it("the app-side seam FEATURE-DETECTS the stock lane rather than assuming it", () => {
    expect(SEAM).toMatch(/PGRST205/);
    expect(SEAM).toMatch(/isStockModuleAbsent/);
    expect(SEAM).toMatch(/stockModulePending/);
    // A real read failure must NOT be reported as "nothing issued": empty-on-
    // error is indistinguishable from healthy (the PGRST201 incident).
    expect(SEAM).toMatch(/stockModulePending:\s*true/);
  });

  it("the seam excludes CORRECTED issues (a reversal must not still count)", () => {
    // record_stock_correction() does NOT copy material_request_line_id onto the
    // correction row, so a naive sum over movement_type='issue' OVER-reports.
    expect(SEAM).toMatch(/corrects_movement_id/);
    expect(SEAM).toMatch(/corrected\.has|corrected\.add/);
  });
});

// ── 2. No action may set a derived status ───────────────────────────────────

describe("fulfilment is DERIVED — no application code sets it", () => {
  const APP_SOURCES: Array<[string, string]> = [
    ["actions.ts", ACTIONS],
    ["material-requests.ts", SERVICE],
    ["material-fulfilment.ts", SEAM],
    ["material-request-writes.ts", WRITE_CORE],
    ["queue page", QUEUE_PAGE],
    ["detail page", DETAIL_PAGE],
    ["new page", NEW_PAGE],
    ["job panel", PANEL],
  ];

  it("no source assigns 'partially_fulfilled' or 'fulfilled' to a status field", () => {
    const offenders: string[] = [];
    for (const [name, src] of APP_SOURCES) {
      const code = tsCode(src);
      for (const derived of MATERIAL_REQUEST_DERIVED_STATUSES) {
        // `status: "fulfilled"` / `status = "fulfilled"` — an UPDATE payload or
        // an assignment. Comparisons (`=== "fulfilled"`) are fine and expected.
        const assign = new RegExp(`status\\s*[:=](?!=)\\s*["'\`]${derived}["'\`]`);
        if (assign.test(code)) offenders.push(`${name}: sets status to ${derived}`);
      }
    }
    expect(
      offenders,
      offenders.join("\n") +
        "\n\nFulfilment is derived from stock issue movements and applied ONLY by " +
        "advance_material_request_fulfilment (20261067). The database refuses these " +
        "two values from any other path; app code must not try.",
    ).toEqual([]);
  });

  it("the ONLY status values the actions write are the human ones", () => {
    const written = new Set<string>();
    for (const m of tsCode(ACTIONS).matchAll(/status:\s*["'`]([a-z_]+)["'`]/g)) {
      written.add(m[1]!);
    }
    // 'decision' is a variable, not a literal — approve/reject go through it.
    // Train 5 moved the request's own `status: "draft"` into the shared write
    // core (asserted just below); the "draft" remaining HERE is the PO handoff
    // creating a draft purchase order.
    expect([...written].sort()).toEqual(["cancelled", "draft", "submitted"]);
    for (const derived of MATERIAL_REQUEST_DERIVED_STATUSES) {
      expect(written.has(derived), `actions.ts must never write ${derived}`).toBe(false);
    }
  });

  it("the shared write core writes 'draft' and nothing else (offline replay included)", () => {
    const OUTCOMES = ["accepted", "duplicate", "rejected", "retry"];
    const written = [...tsCode(WRITE_CORE).matchAll(/status:\s*["'`]([a-z_]+)["'`]/g)]
      .map((m) => m[1]!)
      .filter((s) => !OUTCOMES.includes(s)); // the outcome envelope, not row values
    expect(written).toEqual(["draft"]);
  });

  it("the advance RPC is the single writer, and it lives in SQL", () => {
    expect(MY_SQL_CODE).toMatch(/function public\.advance_material_request_fulfilment/);
    expect(SEAM).toMatch(/advance_material_request_fulfilment/);
    // Exactly one call site in the whole app.
    const callSites = [
      ACTIONS,
      SERVICE,
      SEAM,
      WRITE_CORE,
      QUEUE_PAGE,
      DETAIL_PAGE,
      PANEL,
    ].filter((s) => /rpc\(\s*["'`]advance_material_request_fulfilment/.test(s));
    expect(callSites.length, "one blessed writer, one call site").toBe(1);
  });

  it("the transition trigger refuses a derived status without the RPC's marker", () => {
    expect(MY_SQL_CODE).toMatch(/crewflow\.mr_fulfilment/);
    expect(MY_SQL_CODE).toMatch(/current_setting\(\s*'crewflow\.mr_fulfilment'\s*,\s*true\s*\)/);
    expect(MY_SQL_CODE).toMatch(/set_config\(\s*'crewflow\.mr_fulfilment'/);
    expect(MIG_67).toMatch(/DERIVED from stock issues, not set by hand/);
  });
});

// ── 3. Active-org pinning ───────────────────────────────────────────────────

describe("active-org pinning — RLS is the outer boundary, not the scope", () => {
  /**
   * Counted, not merely spot-checked. `current_org_ids()` returns EVERY org the
   * viewer belongs to, so any read or write that omits the pin blends a
   * dual-org member's two companies — the defect class this product has shipped
   * fixes for six times.
   */
  const orgPins = (src: string) =>
    [...src.matchAll(/\.eq\(\s*["'`]org_id["'`]/g)].length;

  it("the read service pins org_id on every table touch", () => {
    // gatherLines, gatherRequests, loadMaterialRequest = 3 pins minimum.
    expect(orgPins(SERVICE)).toBeGreaterThanOrEqual(3);
  });

  it("the stock seam pins org_id on every cross-lane read", () => {
    // issues, corrections, stock item check = 3.
    expect(orgPins(SEAM)).toBeGreaterThanOrEqual(3);
  });

  it("every mutating action pins org_id", () => {
    // submit, decide, cancel + the reads they do = 6 or more.
    expect(orgPins(ACTIONS)).toBeGreaterThanOrEqual(6);
  });

  it("no action UPDATEs material_requests without an org pin in the same chain", () => {
    const offenders: string[] = [];
    const code = tsCode(ACTIONS);
    for (const m of code.matchAll(/tbl\(supabase,\s*"material_requests"\)\s*\n?\s*\.update\(/g)) {
      // Look at the chain that follows, up to the terminal call.
      const chain = code.slice(m.index!, m.index! + 700);
      if (!/\.eq\(\s*"org_id"\s*,\s*ctx\.org\.id\s*\)/.test(chain)) {
        offenders.push(code.slice(m.index!, m.index! + 120).replace(/\s+/g, " "));
      }
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("the job picker and the queue pin the active org", () => {
    expect(NEW_PAGE).toMatch(/\.eq\("org_id",\s*ctx\.org\.id\)/);
    expect(QUEUE_PAGE).toMatch(/ctx\.org\.id/);
  });

  it("the PO handoff writes into the ACTIVE org, never the request's own org_id", () => {
    // Reading org_id off the fetched row and writing it back would carry a
    // foreign org through a compromised read. ctx.org.id is the only source.
    expect(ACTIONS).toMatch(/org_id:\s*ctx\.org\.id/);
    expect(tsCode(ACTIONS)).not.toMatch(/org_id:\s*(detail|request|row)\.[a-z_.]*org_id/);
  });
});

// ── 4. The database is the enforcer ─────────────────────────────────────────

describe("database-level enforcement", () => {
  it("a transition trigger exists on material_requests", () => {
    expect(MY_SQL_CODE).toMatch(/create trigger material_requests_transition/);
    expect(MY_SQL_CODE).toMatch(/before update on public\.material_requests/);
    expect(MY_SQL_CODE).toMatch(/function public\.tg_material_request_transition/);
  });

  it("a lifecycle trigger pins provenance and freezes a submitted request", () => {
    expect(MY_SQL_CODE).toMatch(/create trigger material_requests_lifecycle/);
    expect(MY_SQL_CODE).toMatch(/before insert or update on public\.material_requests/);
    // born-draft, and provenance the app cannot forge.
    expect(MIG_66).toMatch(/created as a draft/);
    expect(MY_SQL_CODE).toMatch(/new\.decided_by\s*:=\s*auth\.uid\(\)/);
    expect(MY_SQL_CODE).toMatch(/new\.submitted_at\s*:=\s*now\(\)/);
  });

  it("the action does NOT send decided_by/decided_at (the trigger owns them)", () => {
    const code = tsCode(ACTIONS);
    expect(code).not.toMatch(/decided_by:\s*/);
    expect(code).not.toMatch(/decided_at:\s*/);
    expect(code).not.toMatch(/submitted_at:\s*/);
  });

  it("a rejection reason is STRUCTURALLY required, not merely form-validated", () => {
    expect(MY_SQL_CODE).toMatch(/material_requests_rejection_reason_required/);
    expect(MY_SQL_CODE).toMatch(
      /check\s*\(status\s*<>\s*'rejected'\s*or\s*\(rejection_reason is not null/i,
    );
  });

  it("job_id and requested_by are org-guarded in the database", () => {
    expect(MY_SQL_CODE).toMatch(/function public\.tg_material_request_org_integrity/);
    expect(MY_SQL_CODE).toMatch(/is not in this org/);
    expect(MY_SQL_CODE).toMatch(/create trigger material_requests_org_integrity/);
  });

  it("lines are frozen once the request leaves draft", () => {
    expect(MY_SQL_CODE).toMatch(/function public\.tg_material_request_line_draft_only/);
    expect(MY_SQL_CODE).toMatch(/create trigger material_request_lines_draft_only/);
  });

  it("approve/reject is admin-only IN THE DATABASE, not only in the action", () => {
    expect(MY_SQL_CODE).toMatch(/is_org_admin/);
    expect(MIG_67).toMatch(/only an owner or admin can approve or reject/);
    // ...and the action agrees, for a clean error rather than a raw exception.
    expect(ACTIONS).toMatch(/role === "owner"|role === "admin"/);
  });

  it("the role gate reads ctx.membership and NEVER re-queries memberships unfiltered", () => {
    // The #471 lockout: `.eq("org_id", …).single()` on memberships returns
    // every member and errors in any org with ≥2 members.
    expect(ACTIONS).toMatch(/ctx\.membership\.role/);
    const code = tsCode(ACTIONS);
    // Any memberships read must carry BOTH an org pin and a role filter.
    for (const m of code.matchAll(/tbl\([^)]*,\s*"memberships"\)/g)) {
      const chain = code.slice(m.index!, m.index! + 400);
      expect(chain, "memberships read must be org-pinned").toMatch(/\.eq\("org_id"/);
      expect(chain, "memberships read must not use .single()").not.toMatch(/\.single\(\)/);
    }
  });

  it("RLS is enabled with member S/I/U and admin delete of DRAFTS ONLY", () => {
    expect(MY_SQL_CODE).toMatch(/alter table public\.material_requests enable row level security/);
    expect(
      MY_SQL_CODE,
    ).toMatch(/alter table public\.material_request_lines enable row level security/);
    // A submitted request is part of the site's record — even an owner cannot
    // make it disappear; the only exit is 'cancelled'.
    expect(MY_SQL_CODE).toMatch(/for delete to authenticated using \(public\.is_org_admin\(org_id\) and status = 'draft'\)/);
  });

  it("activity_log is written by a TRIGGER, never by the app", () => {
    expect(MY_SQL_CODE).toMatch(/create trigger material_requests_activity/);
    expect(MY_SQL_CODE).toMatch(/_record_activity\(/);
    // AFTER INSERT OR UPDATE only — an AFTER DELETE trigger would sit on the
    // org-teardown cascade path that 20261052 had to rescue.
    expect(MY_SQL_CODE).toMatch(/after insert or update on public\.material_requests/);
    expect(MY_SQL_CODE).not.toMatch(/after delete on public\.material_requests/);
    expect(tsCode(ACTIONS)).not.toMatch(/from\(["'`]activity_log/);
  });
});

// ── 4b. Navigation: no revalidatePath (the deep-swap commit race) ───────────

describe("navigation — redirectTo, never revalidatePath (the deep-swap race)", () => {
  it("the actions file performs NO revalidatePath / revalidateTag", () => {
    // The [id] route is force-dynamic and every button posts through StateForm
    // (useActionState). Next 15.5 re-renders a revalidated route INSIDE the
    // action response and strands the state commit — the write lands, the form
    // hangs, and "an operator would issue the same stock twice". The stock lane
    // bisected exactly this and the fleet lane documents the ban; these actions
    // drive every flow through redirectTo (a full document navigation) instead.
    expect(ACTIONS).not.toMatch(/revalidatePath\(/);
    expect(ACTIONS).not.toMatch(/revalidateTag\(/);
    // The reason must survive next to the absence, so it cannot creep back.
    expect(ACTIONS).toMatch(/deep-swap commit race/);
  });

  it("every exported action returns via formSuccess (redirectTo or a message), never redirect()", () => {
    // redirect() from a deep server action is the other half of the same race
    // (StateForm.tsx). The actions here must not call it.
    expect(tsCode(ACTIONS)).not.toMatch(/\bredirect\(/);
  });
});

// ── 5. SQL / TypeScript graph agreement ─────────────────────────────────────

describe("the TypeScript mirror agrees with the SQL enforcer", () => {
  it("every status in the TS union appears in the database CHECK", () => {
    const check = MIG_66.match(/check \(status in \(([^)]*)\)/s)?.[1] ?? "";
    const inSql = [...check.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
    expect([...inSql].sort()).toEqual([...MATERIAL_REQUEST_STATUSES].sort());
  });

  it("every legal TS edge is named in the SQL trigger", () => {
    const sql = sqlCode(MIG_67);
    const missing: string[] = [];
    for (const from of MATERIAL_REQUEST_STATUSES) {
      for (const to of MATERIAL_REQUEST_TRANSITIONS[from]) {
        // The trigger handles cancel and the derived pair in dedicated blocks;
        // the rest are explicit old/new comparisons.
        if (to === "cancelled") continue;
        if ((MATERIAL_REQUEST_DERIVED_STATUSES as readonly string[]).includes(to)) continue;
        const named =
          new RegExp(`old\\.status = '${from}'[\\s\\S]{0,120}'${to}'`).test(sql) ||
          new RegExp(`'${from}'[\\s\\S]{0,80}new\\.status in \\([^)]*'${to}'`).test(sql);
        if (!named) missing.push(`${from} → ${to}`);
      }
    }
    expect(missing, `edges absent from the SQL trigger: ${missing.join(", ")}`).toEqual([]);
  });

  it("the SQL trigger treats fulfilled/rejected/cancelled as final", () => {
    expect(sqlCode(MIG_67)).toMatch(
      /old\.status in \('fulfilled',\s*'rejected',\s*'cancelled'\)/,
    );
    expect(MIG_67).toMatch(/is final/);
  });

  it("the priority CHECK and the TS union are the same two values", () => {
    const check = MIG_66.match(/check \(priority in \(([^)]*)\)/)?.[1] ?? "";
    expect([...check.matchAll(/'([a-z]+)'/g)].map((m) => m[1]!).sort()).toEqual([
      "normal",
      "urgent",
    ]);
  });
});

// ── 6. Slot discipline ──────────────────────────────────────────────────────

describe("migration slots", () => {
  it("this lane owns exactly 20261066 and 20261067", () => {
    const mine = readdirSync(MIGRATIONS).filter((f) => /material_request/i.test(f));
    expect(mine.sort()).toEqual([
      "20261066000000_material_requests.sql",
      "20261067000000_material_request_lifecycle.sql",
    ]);
  });

  it("no duplicate migration version numbers exist", () => {
    const versions = readdirSync(MIGRATIONS)
      .filter((f) => f.endsWith(".sql"))
      .map((f) => f.split("_")[0]!);
    expect(new Set(versions).size, "duplicate migration slot").toBe(versions.length);
  });
});
