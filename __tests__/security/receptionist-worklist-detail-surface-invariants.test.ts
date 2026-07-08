import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve, relative, sep } from "node:path";

/**
 * Voice Receptionist AI — conversation worklist DETAIL SURFACE invariants
 * (the AI Receptionist Programme, R45 — CONVERSATION WORKLIST DETAIL SURFACE).
 *
 * R44 shipped the read-only operator surface that LISTS the worklists by consuming the R43 view model. R45
 * ships the single authorised read-only INSPECTION surface for ONE Conversation Worklist item:
 * `app/admin/ai-receptionist/worklist/[coordinationId]/page.tsx`, with its pure presentation core
 * `app/admin/ai-receptionist/worklist/[coordinationId]/detail-view.ts`. Where the operator surface reads a
 * worklist through the R43 → R42 → R41 → R40 spine, the detail surface reads a SINGLE coordination through the
 * R37 Coordination Read Model's org-scoped single-item seam, `getCoordinationById`, and RE-SHAPES that record
 * for display with the pure `projectCoordinationDetail`. The cardinal safety property is that the detail
 * surface CONSUMES ONLY AUTHORISED STACKS: it reads the coordination ONLY through the R37 reader and the current
 * claim ONLY through the R47 ownership reader (never a ledger, the read-model view directly, an engine, the
 * worklist read surface/API/client/session/view model, or a database client), it RE-DERIVES no fact (the
 * record's coded facets are RECORDED by the engines; the pure core only LABELS and ORDERS them, it recomputes
 * nothing and re-orders by nothing but a fixed causal SEQUENCE), and page.tsx itself introduces NO mutation — it
 * assigns nobody, dispatches nothing, notifies no one, schedules nothing, enqueues into nothing and retries
 * nothing. The ONE affordance it renders is the R47 claim panel, whose action consumes the R46 runtime; the page
 * performs no write of its own, and that claim path is pinned by the R47 claim-surface invariant suite.
 *
 * ORGANISATION ISOLATION IS PRESERVED — and here the surface's shape is the INVERSE of R44's. The operator
 * surface names no organisation because org is resolved down in the HTTP stack (it forwards a cookie). The
 * detail surface performs a DIRECT server read, so — exactly as the R40 API route does — it resolves the org
 * from the SESSION (`requireOrgContext` → `ctx.org.id`) and passes it as the mandatory `org_id` scope to
 * `getCoordinationById`. The organisation therefore comes from the caller's session, NEVER from the URL: a
 * coordination id belonging to another organisation resolves to null and 404s. This suite proves the page
 * DOES name `org_id` and sources it from `ctx.org.id`, while the pure presentation core names no organisation
 * at all — org is a read-scoping concern, never a display one.
 *
 * This suite proves the contract as a matter of SOURCE, not discipline — the house bar of the R36→R44
 * invariant suites:
 *
 *   • THE PAGE AND ITS CORE ARE READ-ONLY — the page authenticates, resolves the org, awaits its two single-item
 *     reads, projects them and renders. Neither page.tsx nor its pure core issues a `fetch(` of its own, carries
 *     an HTTP method (no `method:` literal), `.send(`s anything, declares a server action (`"use server"`), opens
 *     a database client or names a query verb — the WRITE is delegated to the claim panel's action, never
 *     performed here. There is provably no path through which these two artefacts mutate anything.
 *   • THE SURFACE CONSUMES ONLY AUTHORISED STACKS — the page's ENTIRE import surface is its TWO read seams (the
 *     R37 coordination reader + the R47 ownership reader), the R47 ownership view-core, the EXISTING HQ auth
 *     gate, the session/org chokepoint (for org resolution), `next/link`, `next/navigation`, its own pure
 *     presentation core and the R47 claim panel it renders; the core's ENTIRE surface is the R37 read-model
 *     TYPES alone. Neither imports the worklist view model, session, client, read surface, engine, an API
 *     contract or a database client. With R45 + R54 in the tree the R37 reader module is imported by EXACTLY the
 *     R38 worklist runtime + the detail page + the R54 reassignment-surface page (a SECOND authorised consumer of
 *     the single-item seam, for existence + isolation), and `getCoordinationById` is named by EXACTLY its
 *     definition (the reader) + those two pages.
 *   • THE READ STACK BELOW STAYS AUTHORITATIVE — the surface re-derives nothing and answers no query: it RENDERS
 *     the record the reader hands it. With R45 in the tree the Read Model view is STILL queried only by the R37
 *     reader, the worklist derivation STILL by exactly the two R38 modules, and the R43 view-model runtime is
 *     STILL imported by exactly the R44 operator page — the detail surface is a DISTINCT single-item read path,
 *     not a second consumer of the worklist spine.
 *   • ORGANISATION ISOLATION IS PRESERVED — the page resolves the org from the SESSION and scopes the read by it
 *     (`org_id: ctx.org.id`); it never reads the org from the URL. The pure presentation core names no
 *     organisation of any kind — a display projection has no business selecting a tenant.
 *   • NO DUPLICATE READ / DERIVATION LOGIC — the page re-declares none of the presentation core's view types and
 *     drives no worklist read; the pure core reaches no I/O, no clock and no RNG, sorts nothing and filters
 *     nothing — its causal ordering is STRUCTURAL, so the SAME record always projects to the SAME view.
 *   • NO ENGINE WRITER, NO NON-GOAL VERB — neither artefact names any engine writer, engine runtime, or non-goal
 *     operational verb (assign / dispatch / notify / schedule / enqueue / retry), names a ledger, or ships a
 *     migration. The one authorised affordance — claim — is delegated to the R46 runtime through the claim
 *     panel's action, not executed here; `claim` is deliberately NOT among the non-goal verbs above.
 *
 * The surface's rendering is pinned by the production build (it compiles + type-checks) and its projection
 * arithmetic by the unit suite (__tests__/receptionist/conversation-worklist-detail-surface.test.ts); its data
 * path over real Postgres by __tests__/integration/receptionist/worklist-detail-surface-pipeline.test.ts. This
 * tier is HERMETIC — a filesystem scan over comment-stripped source — so the prose documenting the contract can
 * neither satisfy a positive match nor trip a negative.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

/** Strip block + line comments so only executable TS source is matched. */
function codeOf(ts: string): string {
  return ts
    .replace(/\/\*[\s\S]*?\*\//g, "") // block comments (incl. JSDoc)
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1"); // line comments (keep `://` in URLs)
}

/** Strip block + `--` line comments so only executable SQL is matched (prose can't match). */
function sqlCodeOf(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, "") // block comments (defensive)
    .replace(/--[^\n]*/g, ""); // line comments
}

/** Every module specifier the source imports — `from "x"`, bare `import "x"`, and `export … from "x"`. */
function importSpecifiers(code: string): string[] {
  const specs: string[] = [];
  const fromRe = /\bfrom\s*["']([^"']+)["']/g;
  const bareRe = /\bimport\s+["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = fromRe.exec(code))) {
    if (m[1]) specs.push(m[1]);
  }
  while ((m = bareRe.exec(code))) {
    if (m[1]) specs.push(m[1]);
  }
  return specs;
}

/** Recursively collect every non-test .ts/.tsx source file under the given roots. */
function walkSources(roots: readonly string[]): string[] {
  const out: string[] = [];
  const visit = (dir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return; // a root that does not exist is simply skipped
    }
    for (const entry of entries) {
      const full = resolve(dir, entry);
      if (statSync(full).isDirectory()) {
        if (entry === "node_modules" || entry === ".next" || entry === "__tests__") continue;
        visit(full);
      } else if (/\.tsx?$/.test(entry)) {
        out.push(full);
      }
    }
  };
  for (const r of roots) visit(resolve(ROOT, r));
  return out;
}

/** A repo-relative, POSIX-style path for stable assertions across platforms. */
const rel = (full: string) => relative(ROOT, full).split(sep).join("/");

const SOURCE_ROOTS = ["app", "server", "lib"] as const;
const MIGRATIONS_DIR = "supabase/migrations";

/** Every source file whose executable code matches `re` — the token's owners across the tree. */
function namersOf(re: RegExp): string[] {
  return walkSources(SOURCE_ROOTS)
    .filter((full) => re.test(codeOf(read(rel(full)))))
    .map(rel)
    .sort();
}

/** Every source file that imports the given module specifier — the module's importers across the tree. */
function importersOf(moduleSpec: string): string[] {
  return walkSources(SOURCE_ROOTS)
    .filter((full) => importSpecifiers(codeOf(read(rel(full)))).includes(moduleSpec))
    .map(rel)
    .sort();
}

// The R45 artefacts — the detail surface page and its pure presentation core.
const DETAIL_PAGE = "app/admin/ai-receptionist/worklist/[coordinationId]/page.tsx";
const DETAIL_VIEW = "app/admin/ai-receptionist/worklist/[coordinationId]/detail-view.ts";
const DETAIL_FILES = [DETAIL_PAGE, DETAIL_VIEW] as const;

// The R54 Conversation Work Reassignment Surface page — a SECOND authorised consumer of the R37 single-item
// seam. Like the detail page it reads the coordination ONLY through `getCoordinationById`, org-scoped from the
// session, to establish existence + organisation isolation (a foreign coordination resolves to null and 404s)
// before projecting the transfer view. Its co-tenancy on the R37 reader is therefore part of the pinned
// importer/namer set; the reassignment surface's OWN invariants are pinned by its dedicated suite
// (__tests__/security/receptionist-reassignment-surface-invariants.test.ts).
const REASSIGN_PAGE = "app/admin/ai-receptionist/worklist/[coordinationId]/reassign/page.tsx";

// The R37 Coordination Read Model — the ONE read stack the detail surface consumes.
const R37_READER = "server/services/receptionist-coordination-view.ts";
const R37_READER_MODULE = "@/server/services/receptionist-coordination-view";
const R37_CORE_MODULE = "@/lib/receptionist/conversation-coordination-view";

// The R38 Worklist Engine — the OTHER (pre-existing) consumer of the R37 reader; the detail surface must not
// reach it, but its co-tenancy on the reader is part of the pinned importer set.
const R38_CORE = "lib/receptionist/conversation-coordination-worklist.ts";
const R38_RUNTIME = "server/services/receptionist-coordination-worklist.ts";
const R38_CORE_MODULE = "@/lib/receptionist/conversation-coordination-worklist";
const R38_RUNTIME_MODULE = "@/server/services/receptionist-coordination-worklist";

// The EXISTING HQ page gate — the detail surface's authentication.
const HQ_AUTH_MODULE = "@/server/auth/hq";
// The single auth + org chokepoint — the detail page DOES import it (to resolve the org for the scoped read),
// exactly as the R40 API route does. This is the INVERSE of the R44 operator surface, which forwards a cookie.
const SESSION_AUTH_MODULE = "@/server/auth/session";

// The R43 view model + the R42/R41/R40/R39 worklist spine — the detail surface is a DISTINCT single-item read
// path and must reach none of them.
const VM_CORE_MODULE = "@/lib/receptionist/conversation-worklist-view-model";
const VM_RUNTIME_MODULE = "@/server/services/receptionist-worklist-view-model";
const SESSION_CORE_MODULE = "@/lib/receptionist/conversation-worklist-session";
const SESSION_RUNTIME_MODULE = "@/server/services/receptionist-worklist-session";
const CLIENT_CORE_MODULE = "@/lib/receptionist/conversation-worklist-client";
const CLIENT_RUNTIME_MODULE = "@/server/services/receptionist-worklist-client";
const R39_CORE_MODULE = "@/lib/receptionist/conversation-worklist-read-surface";
const R39_RUNTIME_MODULE = "@/server/services/receptionist-worklist-read-surface";
const R40_CORE_MODULE = "@/lib/receptionist/conversation-worklist-api";

// The R44 operator page — the sole importer of the R43 view-model runtime; the detail surface must NOT join it.
const OPERATOR_PAGE = "app/admin/ai-receptionist/worklist/page.tsx";

// The R47 CONVERSATION WORK CLAIM SURFACE additions to the detail page. R45 shipped a purely read-only page; R47
// wires the single authorised claim affordance onto it. The page therefore gains THREE imports: the org-scoped
// ownership READER (a second read seam, alongside the R37 coordination reader), the pure ownership VIEW-CORE that
// projects it, and the client CLAIM PANEL that renders it. The page itself still performs no write — the panel's
// action consumes the R46 runtime, pinned by __tests__/security/receptionist-claim-surface-invariants.test.ts.
const CLAIM_READER_MODULE = "@/server/services/receptionist-claim-view";
const CLAIM_VIEW_CORE_MODULE = "@/lib/receptionist/conversation-claim-view";
const CLAIM_PANEL_MODULE = "./claim-panel";

/** The exact import surface the detail PAGE is permitted — its TWO read seams (the R37 coordination reader + the
 *  R47 ownership reader), the R47 ownership view-core, the HQ gate, the session/org chokepoint, the two Next
 *  primitives it renders with, its own presentation core, and the R47 claim panel it renders. Nothing else. */
const ALLOWED_PAGE_IMPORTS = [
  R37_READER_MODULE,
  CLAIM_READER_MODULE,
  CLAIM_VIEW_CORE_MODULE,
  HQ_AUTH_MODULE,
  SESSION_AUTH_MODULE,
  "next/link",
  "next/navigation",
  "./detail-view",
  CLAIM_PANEL_MODULE,
].sort();

/** The exact import surface the pure presentation CORE is permitted — the R37 read-model TYPES alone. */
const ALLOWED_DETAIL_VIEW_IMPORTS = [R37_CORE_MODULE];

/** The R37 read-model projection — the relation the surface must NEVER name (it calls the reader function). */
const READ_MODEL_VIEW = /\breceptionist_coordination_read_model\b/;

/** The coordination ledger and its six sibling ledgers — the seven relations the surface must never name. */
const LEDGER_RELATIONS = [
  /\breceptionist_conversation_coordinations\b/i,
  /\breceptionist_conversation_orchestrations\b/i,
  /\breceptionist_conversation_lifecycles\b/i,
  /\breceptionist_conversation_resolutions\b/i,
  /\breceptionist_conversation_recoveries\b/i,
  /\breceptionist_conversation_verifications\b/i,
  /\breceptionist_conversation_fulfilments\b/i,
] as const;

/** Every engine write primitive + runtime writer + the coordination resolver — the execution path a
 *  read-only surface must NEVER name. `record_receptionist_conversation_` covers all seven writers. */
const EXECUTION_TOKENS = [
  /record_receptionist_conversation_/i,
  /\bresolveConversationCoordination\b/,
  /\bcoordinateConversationLifecycle\b/,
  /\borchestrateConversationLifecycle\b/,
  /\bgovernConversationLifecycle\b/,
  /\bresolveConversationCompletion\b/,
  /\brecoverVerifiedFulfilment\b/,
  /\bverifyApprovedFulfilment\b/,
  /\bfulfilApprovedBooking\b/,
] as const;

/** The worklist SPINE primitives — the detail surface reads ONE item via `getCoordinationById`; it names none
 *  of the worklist LIST read/derive/session/view-model primitives. */
const WORKLIST_SPINE_TOKENS = [
  /\bderiveWorklists\b/,
  /\bqueryOrgWorklist\b/,
  /\bqueryWorklist\b/,
  /\bqueryConversationWorklist\b/,
  /\bfetchOrgWorklist\b/,
  /\bcreateWorklistViewModel\b/,
  /\bderiveWorklistViewModel\b/,
  /\bcreateWorklistSession\b/,
] as const;

/** The R45 non-goals as SOURCE tokens — assignment, dispatch, notification, scheduling, queueing, retries.
 *  A read-only inspection surface names none of them: it renders a recorded decision, it never acts on it. */
const OPERATIONAL_TOKENS = [
  /\bassign\w*/i,
  /\bdispatch\w*/i,
  /\bnotif\w*/i, // notify / notification
  /\bschedul\w*/i, // schedule / scheduling
  /\benqueue\w*/i,
  /\bretr(?:y|ies)\b/i,
] as const;

/** The presentation-core view TYPES the page imports but must NEVER re-declare — the core is their sole source. */
const DETAIL_VIEW_TYPES = [
  "CoordinationDetailView",
  "CoordinationHeadlineView",
  "DetailSection",
  "DetailField",
  "TimelineStep",
] as const;

/** The pure functions the presentation core owns — the page consumes the projection, never these primitives. */
const DETAIL_VIEW_EXPORTS = [
  "humaniseToken",
  "formatBool",
  "orDash",
  "formatInstant",
  "buildTimeline",
  "projectCoordinationDetail",
] as const;

/** Any database client constructor — the surface touches no DB; it reads through the R37 reader. */
const DB_CLIENT = /createAdminClient|createServiceRoleClient|createClient/;

/** Any database query verb — the surface names NONE. */
const QUERY_VERB = /\.(from|select|insert|update|delete|upsert|rpc)\b/;

/** The three organisation spellings — the page DOES name `org_id` (it scopes the read); the pure core names none. */
const ORG_TOKENS = [/\borg[_-]?id\b/i, /\borganisation\b/i, /\borganization\b/i] as const;

/** The HTTP methods a read-only surface must NOT issue, in a `method:` position of a fetch init. */
const WRITE_METHODS = ["POST", "PUT", "PATCH", "DELETE"] as const;

// =====================================================================
// 0. The surface ships — the detail page + its pure presentation core.
// =====================================================================

describe("receptionist worklist detail surface — the surface ships", () => {
  it(`ships the page ${DETAIL_PAGE} and the presentation core ${DETAIL_VIEW}`, () => {
    expect(existsSync(resolve(ROOT, DETAIL_PAGE)), DETAIL_PAGE).toBe(true);
    expect(existsSync(resolve(ROOT, DETAIL_VIEW)), DETAIL_VIEW).toBe(true);
  });

  it("the page is a default-exported async server component gated by the HQ auth", () => {
    const code = codeOf(read(DETAIL_PAGE));
    expect(code).toMatch(/export default async function\b/);
    expect(code, "the page gates on the EXISTING HQ auth").toMatch(/\brequireHqPage\s*\(/);
  });

  it("the page resolves the org from the session, reads the single item, projects and 404s a miss", () => {
    const code = codeOf(read(DETAIL_PAGE));
    expect(code, "resolves the org from the SESSION").toMatch(/\brequireOrgContext\s*\(/);
    expect(code, "reads the single item via the R37 seam").toMatch(/\bgetCoordinationById\s*\(/);
    expect(code, "projects the record for display").toMatch(/\bprojectCoordinationDetail\s*\(/);
    expect(code, "a foreign / absent record 404s").toMatch(/\bnotFound\s*\(/);
  });

  it("the presentation core exports the humanisers, the timeline builder and the projection", () => {
    const code = codeOf(read(DETAIL_VIEW));
    for (const fn of DETAIL_VIEW_EXPORTS) {
      expect(code, `the core exports ${fn}`).toMatch(new RegExp(`export function ${fn}\\b`));
    }
  });
});

// =====================================================================
// 1. THE PAGE AND ITS CORE ARE READ-ONLY — the page authenticates, resolves the org, awaits its two reads, projects and renders.
// =====================================================================

describe("receptionist worklist detail surface — the page and its core are read-only", () => {
  it("issues NO fetch of its own — its data path is the R37 single-item reader", () => {
    for (const path of DETAIL_FILES) {
      expect(codeOf(read(path)), `${path} must not fetch directly`).not.toMatch(/\bfetch\s*\(/);
    }
  });

  it("performs NO HTTP method itself — there is no transport here (no method: literal)", () => {
    for (const path of DETAIL_FILES) {
      const code = codeOf(read(path));
      expect(code, `${path} performs no HTTP method`).not.toMatch(/method:\s*["']/);
      for (const method of WRITE_METHODS) {
        expect(code, `${path} must not issue a ${method} request`).not.toMatch(
          new RegExp(`method:\\s*["']${method}["']`, "i"),
        );
      }
    }
  });

  it("declares NO server action and sends nothing — a read-only surface mutates nothing", () => {
    for (const path of DETAIL_FILES) {
      const code = codeOf(read(path));
      expect(code, `${path} declares no server action`).not.toMatch(/["']use server["']/);
      expect(code, `${path} must not send`).not.toMatch(/\.send\s*\(/);
    }
  });

  it("opens NO database client and names NO query verb — it reads through the reader, not the DB", () => {
    for (const path of DETAIL_FILES) {
      const code = codeOf(read(path));
      expect(code, `${path} creates no database client`).not.toMatch(DB_CLIENT);
      expect(code, `${path} uses no database query verb`).not.toMatch(QUERY_VERB);
    }
  });

  it("names NO ledger relation and NOT the read-model view — it calls the reader function", () => {
    for (const path of DETAIL_FILES) {
      const code = codeOf(read(path));
      expect(code, `${path} must not name the Read Model view`).not.toMatch(READ_MODEL_VIEW);
      for (const ledger of LEDGER_RELATIONS) {
        expect(code, `${path} must not name ${ledger}`).not.toMatch(ledger);
      }
    }
  });
});

// =====================================================================
// 2. THE SURFACE CONSUMES ONLY AUTHORISED STACKS — it reaches around nothing.
// =====================================================================

describe("receptionist worklist detail surface — it consumes only authorised stacks", () => {
  it("the page's ENTIRE import surface is its two read seams, the HQ gate, the session chokepoint, next primitives, its core and the claim panel", () => {
    const imports = new Set(importSpecifiers(codeOf(read(DETAIL_PAGE))));
    expect([...imports].sort()).toEqual(ALLOWED_PAGE_IMPORTS);
  });

  it("the page imports NO worklist view model, session, client, read surface, engine, API contract or R37 core", () => {
    const imports = importSpecifiers(codeOf(read(DETAIL_PAGE)));
    for (const forbidden of [
      VM_RUNTIME_MODULE,
      VM_CORE_MODULE,
      SESSION_RUNTIME_MODULE,
      SESSION_CORE_MODULE,
      CLIENT_RUNTIME_MODULE,
      CLIENT_CORE_MODULE,
      R39_RUNTIME_MODULE,
      R39_CORE_MODULE,
      R38_RUNTIME_MODULE,
      R38_CORE_MODULE,
      R40_CORE_MODULE,
      R37_CORE_MODULE, // the page reaches the read model ONLY through the reader, never its core directly
    ]) {
      expect(imports, `the page must not import ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("the presentation core's ENTIRE import surface is the R37 read-model TYPES alone", () => {
    const imports = importSpecifiers(codeOf(read(DETAIL_VIEW)));
    expect(imports).toEqual(ALLOWED_DETAIL_VIEW_IMPORTS);
  });

  it("with R45 + R54 in the tree, the R37 reader module is imported by EXACTLY the R38 runtime + the detail page + the reassign page", () => {
    expect(importersOf(R37_READER_MODULE)).toEqual([DETAIL_PAGE, REASSIGN_PAGE, R38_RUNTIME].sort());
  });

  it("with R45 + R54 in the tree, getCoordinationById is named by EXACTLY its definition (the reader) + the detail page + the reassign page", () => {
    expect(namersOf(/\bgetCoordinationById\b/)).toEqual([DETAIL_PAGE, REASSIGN_PAGE, R37_READER].sort());
  });

  it("the surface reaches around the reader to nothing — it names no worklist spine primitive", () => {
    for (const path of DETAIL_FILES) {
      const code = codeOf(read(path));
      for (const token of WORKLIST_SPINE_TOKENS) {
        expect(code, `${path} must not name ${token} — the detail surface is a single-item read path`).not.toMatch(
          token,
        );
      }
    }
  });
});

// =====================================================================
// 3. THE READ STACK BELOW STAYS AUTHORITATIVE — the lower invariants hold with R45 in the tree.
// =====================================================================

describe("receptionist worklist detail surface — the read stack below stays authoritative", () => {
  it("the Read Model view is STILL queried by exactly the R37 reader", () => {
    expect(namersOf(READ_MODEL_VIEW)).toEqual([R37_READER]);
  });

  it("the worklist derivation is STILL owned by exactly the two R38 modules", () => {
    expect(namersOf(/\bderiveWorklists\b/)).toEqual([R38_CORE, R38_RUNTIME].sort());
  });

  it("the R43 view-model runtime is STILL imported by exactly the R44 operator page — the detail surface joins nobody to it", () => {
    expect(importersOf(VM_RUNTIME_MODULE)).toEqual([OPERATOR_PAGE]);
  });

  it("the surface re-derives, re-orders and re-paginates nothing — no sort, no filter anywhere", () => {
    for (const path of DETAIL_FILES) {
      const code = codeOf(read(path));
      expect(code, `${path} must not sort — the timeline order is STRUCTURAL`).not.toMatch(/\.sort\s*\(/);
      expect(code, `${path} must not filter`).not.toMatch(/\.filter\s*\(/);
    }
  });
});

// =====================================================================
// 4. ORGANISATION ISOLATION IS PRESERVED — the page scopes the read by the SESSION org, never the URL.
// =====================================================================

describe("receptionist worklist detail surface — organisation isolation is preserved", () => {
  it("the page resolves the org from the SESSION and scopes the read by it (org_id: ctx.org.id)", () => {
    const code = codeOf(read(DETAIL_PAGE));
    expect(code, "the page resolves the org from the session context").toMatch(/\brequireOrgContext\s*\(/);
    expect(code, "the page scopes the read by an org_id").toMatch(/\borg_id\b/);
    expect(code, "the org is the SESSION's, never the URL's").toMatch(/org_id:\s*ctx\.org\.id/);
  });

  it("the page imports BOTH the HQ gate and the session/org chokepoint — auth AND scoped org resolution", () => {
    const imports = importSpecifiers(codeOf(read(DETAIL_PAGE)));
    expect(imports, "the page uses the HQ page gate").toContain(HQ_AUTH_MODULE);
    expect(imports, "the page resolves the org from the session chokepoint").toContain(SESSION_AUTH_MODULE);
  });

  it("the pure presentation core names NO organisation of any kind — org is a read-scoping concern, never display", () => {
    const code = codeOf(read(DETAIL_VIEW));
    for (const token of ORG_TOKENS) {
      expect(code, `the presentation core must not name an organisation (${token})`).not.toMatch(token);
    }
  });
});

// =====================================================================
// 5. NO DUPLICATE READ / DERIVATION LOGIC — the core owns presentation; the page only binds it; the core is pure.
// =====================================================================

describe("receptionist worklist detail surface — it forks no read or derivation logic", () => {
  it("the page RE-DECLARES none of the presentation core's view types — it imports them", () => {
    const code = codeOf(read(DETAIL_PAGE));
    for (const typeName of DETAIL_VIEW_TYPES) {
      expect(code, `the page must not redeclare ${typeName}`).not.toMatch(
        new RegExp(`\\b(?:type|interface)\\s+${typeName}\\b\\s*[={]`),
      );
    }
  });

  it("the presentation core reaches no I/O, no clock and no RNG — its projection is deterministic", () => {
    const code = codeOf(read(DETAIL_VIEW));
    expect(code, "no fetch").not.toMatch(/\bfetch\s*\(/);
    expect(code, "no clock, no RNG, no crypto").not.toMatch(/Math\.random|Date\.now|new Date\b|crypto\./);
    expect(code, "no database client").not.toMatch(DB_CLIENT);
    expect(code, "no query verb").not.toMatch(QUERY_VERB);
    // The presentation core depends on NOTHING but the R37 read-model TYPES.
    const imports = importSpecifiers(code);
    expect(imports).not.toContain("server-only");
    expect(imports).not.toContain(R37_READER_MODULE);
    expect(imports).not.toContain(SESSION_AUTH_MODULE);
  });
});

// =====================================================================
// 6. NO ENGINE WRITER, NO NON-GOAL VERB — neither artefact names any engine writer, runtime, or non-goal verb.
// =====================================================================

describe("receptionist worklist detail surface — the page and its core name no engine writer or non-goal verb", () => {
  it("neither artefact names ANY engine writer, runtime, or non-goal operational verb", () => {
    for (const path of DETAIL_FILES) {
      const code = codeOf(read(path));
      for (const token of EXECUTION_TOKENS) {
        expect(code, `${path} must not name ${token} — a read-only surface executes nothing`).not.toMatch(token);
      }
      for (const token of OPERATIONAL_TOKENS) {
        expect(
          code,
          `${path} must not name ${token} — the surface renders a recorded decision, it never acts or retries`,
        ).not.toMatch(token);
      }
    }
  });

  it("ships NO migration that names the detail surface — no view, no table, no column", () => {
    const files = readdirSync(resolve(ROOT, MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql"));
    const byName = files.filter((f) => /detail[_-]?surface|coordination[_-]?detail/i.test(f));
    expect(byName, "no migration file is named for the detail surface").toEqual([]);
    const byBody = files.filter((f) =>
      /detail[_-]?surface|coordination[_-]?detail/i.test(sqlCodeOf(read(`${MIGRATIONS_DIR}/${f}`))),
    );
    expect(byBody, "no migration's executable SQL names the detail surface").toEqual([]);
  });
});
