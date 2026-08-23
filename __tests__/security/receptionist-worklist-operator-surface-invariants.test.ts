import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve, relative, sep } from "node:path";

/**
 * Voice Receptionist AI — conversation worklist OPERATOR SURFACE invariants
 * (the AI Receptionist Programme, R44 — READ-ONLY WORKLIST OPERATOR SURFACE).
 *
 * R43 shipped the Conversation Worklist View Model: the single authorised PRESENTATION MODEL over the R42
 * session — a presentation-ready {@link WorklistViewModel} and the total derivations that project it, plus a
 * runtime that holds a live session and projects it. R44 is the FIRST consumer of that spine made visible: a
 * READ-ONLY operator surface (`app/admin/ai-receptionist/worklist/page.tsx`, with its pure navigation helper
 * `app/admin/ai-receptionist/worklist/navigation.ts`) that binds a view model to pixels for an HQ operator.
 * The cardinal safety property is that the surface CONSUMES the R43 view model and does nothing else: it reads
 * worklists ONLY through the view model runtime (never around it to the R42 session, the R41 client, the R40
 * endpoint, the R39 read surface, the R38 engine, the R37 reader or a ledger), it re-derives / re-orders /
 * re-paginates no worklist (the view model — and behind it the session, client and API — stays authoritative),
 * it forks no vocabulary and duplicates no presentation logic, it names no organisation (so organisation
 * isolation is inherited from the API, structurally), and it introduces NO mutation and NO execution path — it
 * assigns nobody, claims nothing, dispatches nothing, notifies no one, schedules nothing, enqueues into nothing
 * and retries nothing. This suite proves that contract as a matter of SOURCE, not discipline — the house bar of
 * the R36→R43 invariant suites:
 *
 *   • THE SURFACE IS READ-ONLY — it opens a view model, awaits one read, and renders it. It issues NO `fetch(`
 *     of its own and does not name the client's `fetchOrgWorklist`: its one data path is
 *     `createWorklistViewModel` + the runtime's `refresh`. It carries no HTTP method (no `method:` literal),
 *     `.send(`s nothing, and declares no server action (`"use server"`). There is provably no path through
 *     which the surface mutates anything.
 *   • THE SURFACE CONSUMES ONLY THE VIEW MODEL — the page's ENTIRE import surface is the R43 view-model runtime,
 *     the R43 view-model core (types), the EXISTING HQ auth gate, `next/link`, `next/headers` and its own
 *     navigation helper; the helper's ENTIRE surface is the view-model core (the view TYPE alone). Neither
 *     imports the session, the client, a read surface, engine, reader, the org chokepoint, an API contract or a
 *     database client. With R44 in the tree the view-model runtime is imported by EXACTLY the surface page, and
 *     `createWorklistViewModel` is named by EXACTLY the runtime (its definition) + the surface (its one consumer).
 *   • THE VIEW MODEL / SESSION / CLIENT / API STAY AUTHORITATIVE — the surface shapes no request vocabulary and
 *     re-implements no derivation: it RENDERS the view model the runtime hands it. With R44 in the tree the
 *     client read (`fetchOrgWorklist`) is STILL named by exactly the client + session runtimes, the read surface
 *     (`queryOrgWorklist`) STILL by exactly the R40 route + R39 runtime, the endpoint literal STILL by the client
 *     core, the worklist DERIVATION (`deriveWorklists`) STILL by the two R38 modules, the Read Model view STILL by
 *     the R37 reader, the composition (`deriveWorklistViewModel`) STILL by exactly the view-model core + runtime,
 *     and the view-model type STILL by the view-model core.
 *   • ORGANISATION ISOLATION IS PRESERVED — STRUCTURALLY. The surface names no organisation of any kind: it
 *     forwards only the caller's session cookie and lets the API resolve the scope. It does not import the org
 *     chokepoint; the organisation it presents can ONLY be the API's. A caller cannot move this surface to
 *     another organisation's worklist — the vocabulary does not exist.
 *   • NO DUPLICATE PRESENTATION LOGIC — the surface re-declares no view-model type, writes none of the view
 *     model's display copy, names no per-facet derivation, and drives no session transition. The pure core owns
 *     presentation; the surface only binds it.
 *   • NO MUTATION, NO EXECUTION PATH — neither surface artefact names any engine writer, engine runtime, or
 *     operational verb (assign / dispatch / notify / schedule / enqueue / retry), creates a database client, uses
 *     a query verb, names a ledger, or ships a migration.
 *
 * The surface's rendering is pinned by the production build (it compiles + type-checks) and its navigation
 * arithmetic by the unit suite (__tests__/receptionist/conversation-worklist-operator-surface.test.ts); its
 * data path over real Postgres by
 * __tests__/integration/receptionist/worklist-operator-surface-pipeline.test.ts. This tier is HERMETIC — a
 * filesystem scan over comment-stripped source — so the prose documenting the contract can neither satisfy a
 * positive match nor trip a negative.
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
        if (!full.endsWith("/lib/supabase/types.ts")) out.push(full);
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

// The R44 artefacts — the operator surface page and its pure navigation helper.
const SURFACE_PAGE = "app/admin/ai-receptionist/worklist/page.tsx";
const SURFACE_NAV = "app/admin/ai-receptionist/worklist/navigation.ts";
const SURFACE_FILES = [SURFACE_PAGE, SURFACE_NAV] as const;

// The R43 view model the surface consumes — its pure core (types) and its runtime (the sole read path).
const VM_CORE = "lib/receptionist/conversation-worklist-view-model.ts";
const VM_RUNTIME = "server/services/receptionist-worklist-view-model.ts";
const VM_CORE_MODULE = "@/lib/receptionist/conversation-worklist-view-model";
const VM_RUNTIME_MODULE = "@/server/services/receptionist-worklist-view-model";

// The R42 session BELOW the view model — the surface must reach neither its core nor its runtime.
const SESSION_CORE = "lib/receptionist/conversation-worklist-session.ts";
const SESSION_CORE_MODULE = "@/lib/receptionist/conversation-worklist-session";
const SESSION_RUNTIME = "server/services/receptionist-worklist-session.ts";
const SESSION_RUNTIME_MODULE = "@/server/services/receptionist-worklist-session";

// The R41 client BELOW the session — the surface must reach neither.
const CLIENT_CORE = "lib/receptionist/conversation-worklist-client.ts";
const CLIENT_RUNTIME = "server/services/receptionist-worklist-client.ts";
const CLIENT_CORE_MODULE = "@/lib/receptionist/conversation-worklist-client";
const CLIENT_RUNTIME_MODULE = "@/server/services/receptionist-worklist-client";

// The ONE endpoint the client consumes — the R40 API. The route is the sole caller of the R39 read surface.
const WORKLIST_API_PATH = "/api/receptionist/worklists";
const ROUTE = "app/api/receptionist/worklists/route.ts";
const R40_CORE_MODULE = "@/lib/receptionist/conversation-worklist-api";

// The R39 read surface — the surface must never name it.
const R39_RUNTIME = "server/services/receptionist-worklist-read-surface.ts";
// R58 — the Conversation Attention Queue: R39's authorised SECOND consumer of the worklist read surface
// (the "queue" R39's own doc-comment anticipates). It reads `prioritised` worklist pages through R39 and
// groups them by ownership; it never names the R38 reader, so it is not a read path around R39.
const R58_QUEUE_RUNTIME = "server/services/receptionist-attention-queue.ts";
const R39_CORE_MODULE = "@/lib/receptionist/conversation-worklist-read-surface";
const R39_RUNTIME_MODULE = "@/server/services/receptionist-worklist-read-surface";

// The R38 Worklist Engine — the surface must never reach it.
const R38_CORE = "lib/receptionist/conversation-coordination-worklist.ts";
const R38_RUNTIME = "server/services/receptionist-coordination-worklist.ts";
const R38_CORE_MODULE = "@/lib/receptionist/conversation-coordination-worklist";
const R38_RUNTIME_MODULE = "@/server/services/receptionist-coordination-worklist";

// The R37 read layer — the surface must never name it.
const R37_READER = "server/services/receptionist-coordination-view.ts";
const R37_READER_MODULE = "@/server/services/receptionist-coordination-view";
const R37_CORE_MODULE = "@/lib/receptionist/conversation-coordination-view";

// The single auth + org chokepoint — the surface must NOT import it (the API route owns org resolution; the
// surface merely forwards a session cookie it never inspects).
const SESSION_AUTH_MODULE = "@/server/auth/session";
// The EXISTING HQ page gate — the surface's authentication, and the ONLY auth module it may import.
const HQ_AUTH_MODULE = "@/server/auth/hq";

/** The exact import surface the operator PAGE is permitted — its view-model runtime + core (types), the HQ
 *  auth gate, the two Next primitives it renders with, and its own navigation helper. Nothing else. */
const ALLOWED_PAGE_IMPORTS = [
  VM_RUNTIME_MODULE,
  VM_CORE_MODULE,
  HQ_AUTH_MODULE,
  "next/link",
  "next/headers",
  "./navigation",
].sort();

/** The R37 read-model projection — the relation the surface must NEVER name. */
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

/** The R38 worklist-DERIVATION primitives + the R39 read operations — naming any would RE-DERIVE or
 *  RE-ANSWER a worklist. The surface RENDERS the view model; it does neither. */
const WORKLIST_LOGIC = [
  /\bderiveWorklists\b/,
  /\bderiveCoordinationPriority\b/,
  /\bbelongsToWorklist\b/,
  /\bworklistCategoriesOf\b/,
  /\btoWorklistEntry\b/,
  /\bcompareWorklistEntries\b/,
  /\borderWorklistEntries\b/,
  /\bqueryWorklist\b/,
  /\bqueryOrgWorklist\b/,
  /\bqueryConversationWorklist\b/,
  /\bgetCoordinationWorklists\b/,
  /\breadWorklistView\b/,
  /\bmatchesWorklistFilter\b/,
  /\bfilterWorklistEntries\b/,
  /\bpaginateWorklistEntries\b/,
] as const;

/** The R42 session TRANSITIONS — naming any would re-drive the session's state machine. The surface never
 *  touches the session at all; it consumes the view model runtime. */
const SESSION_TRANSITIONS = [
  /\binitWorklistSession\b/,
  /\bbeginWorklistLoad\b/,
  /\bapplyWorklistPage\b/,
  /\bapplyWorklistError\b/,
  /\bselectWorklistView\b/,
  /\bapplyWorklistFilter\b/,
  /\bclearWorklistFilter\b/,
  /\bsetWorklistPageSize\b/,
  /\btoFirstWorklistPage\b/,
  /\btoNextWorklistPage\b/,
  /\btoPreviousWorklistPage\b/,
] as const;

/** The R44 non-goals as SOURCE tokens — assignment, dispatch, notification, scheduling, queueing, retries.
 *  A read-only surface names none of them: it renders presentation, it never acts on a worklist. */
const OPERATIONAL_TOKENS = [
  /\bassign\w*/i,
  /\bdispatch\w*/i,
  /\bnotif\w*/i, // notify / notification
  /\bschedul\w*/i, // schedule / scheduling
  /\benqueue\w*/i,
  /\bretr(?:y|ies)\b/i,
] as const;

/** The fixed display COPY that lives in the pure view-model core — the surface forks none of it; it RENDERS
 *  the view model's own message fields. */
const PRESENTATION_COPY = [
  /No conversations/,
  /This worklist is empty/,
  /match the current filter/,
  /Loading conversations/,
  /Refreshing/,
  /Showing /,
] as const;

/** The six per-facet derivations the pure core OWNS + the composition — the surface names none of them; it
 *  consumes the RUNTIME factory + methods, never the core's derivations. */
const SUB_DERIVATIONS = [
  "deriveWorklistPresentation",
  "deriveWorklistSummary",
  "deriveWorklistPagination",
  "deriveWorklistEmptyState",
  "deriveWorklistLoadingState",
  "deriveWorklistErrorState",
  "deriveWorklistViewModel",
] as const;

/** The view-model TYPES the surface imports but must NEVER re-declare — the core is their sole source. */
const VIEW_MODEL_TYPES = [
  "WorklistViewModel",
  "WorklistRow",
  "WorklistSummaryView",
  "WorklistPaginationView",
  "WorklistEmptyStateView",
  "WorklistLoadingStateView",
  "WorklistErrorStateView",
] as const;

/** Any database client constructor — the surface touches no DB; it reads through the view model. */
const DB_CLIENT = /createAdminClient|createServiceRoleClient|createClient/;

/** Any database query verb — the surface names NONE. */
const QUERY_VERB = /\.(from|select|insert|update|delete|upsert|rpc)\b/;

/** The three organisation spellings the surface must NOT name — org is the API's to resolve. */
const ORG_TOKENS = [/\borg[_-]?id\b/i, /\borganisation\b/i, /\borganization\b/i] as const;

/** The HTTP methods a read-only surface must NOT issue, in a `method:` position of a fetch init. */
const WRITE_METHODS = ["POST", "PUT", "PATCH", "DELETE"] as const;

// =====================================================================
// 0. The surface ships — the operator page + its pure navigation helper.
// =====================================================================

describe("receptionist worklist operator surface — the surface ships", () => {
  it(`ships the page ${SURFACE_PAGE} and the navigation helper ${SURFACE_NAV}`, () => {
    expect(existsSync(resolve(ROOT, SURFACE_PAGE)), SURFACE_PAGE).toBe(true);
    expect(existsSync(resolve(ROOT, SURFACE_NAV)), SURFACE_NAV).toBe(true);
  });

  it("the page is a default-exported async server component gated by the HQ auth", () => {
    const code = codeOf(read(SURFACE_PAGE));
    expect(code).toMatch(/export default async function\b/);
    expect(code, "the page gates on the EXISTING HQ auth").toMatch(/\brequireHqPage\s*\(/);
  });

  it("the page consumes the view model runtime — createWorklistViewModel + a read", () => {
    const code = codeOf(read(SURFACE_PAGE));
    expect(code, "opens a view model").toMatch(/\bcreateWorklistViewModel\s*\(/);
    expect(code, "awaits a read through the runtime").toMatch(/\.refresh\s*\(/);
  });

  it("the navigation helper exports the tabs, param parsers and href builder", () => {
    const code = codeOf(read(SURFACE_NAV));
    expect(code).toMatch(/export const WORKLIST_VIEW_TABS\b/);
    expect(code).toMatch(/export function parseWorklistViewParam\(/);
    expect(code).toMatch(/export function parseOffsetParam\(/);
    expect(code).toMatch(/export function worklistPath\(/);
  });
});

// =====================================================================
// 1. THE SURFACE IS READ-ONLY — it opens a view model, awaits one read, and renders it.
// =====================================================================

describe("receptionist worklist operator surface — the surface is read-only", () => {
  it("issues NO fetch of its own and does not name the client's read — its data path is the view model", () => {
    for (const path of SURFACE_FILES) {
      const code = codeOf(read(path));
      expect(code, `${path} must not fetch directly`).not.toMatch(/\bfetch\s*\(/);
      expect(code, `${path} reads THROUGH the view model, never around it to the client`).not.toMatch(
        /\bfetchOrgWorklist\b/,
      );
    }
  });

  it("performs NO HTTP method itself — transport lives entirely below (no method: literal)", () => {
    for (const path of SURFACE_FILES) {
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
    for (const path of SURFACE_FILES) {
      const code = codeOf(read(path));
      expect(code, `${path} declares no server action`).not.toMatch(/["']use server["']/);
      expect(code, `${path} must not send`).not.toMatch(/\.send\s*\(/);
    }
  });
});

// =====================================================================
// 2. THE SURFACE CONSUMES ONLY THE VIEW MODEL — it reaches around nothing.
// =====================================================================

describe("receptionist worklist operator surface — it consumes only the view model", () => {
  it("the page's ENTIRE import surface is the view-model runtime + core, the HQ gate, next primitives and its helper", () => {
    const imports = new Set(importSpecifiers(codeOf(read(SURFACE_PAGE))));
    expect([...imports].sort()).toEqual(ALLOWED_PAGE_IMPORTS);
  });

  it("the page imports NO session, client, read surface, engine, reader, API contract or DB client", () => {
    const imports = importSpecifiers(codeOf(read(SURFACE_PAGE)));
    for (const forbidden of [
      SESSION_RUNTIME_MODULE,
      SESSION_CORE_MODULE,
      CLIENT_RUNTIME_MODULE,
      CLIENT_CORE_MODULE,
      R40_CORE_MODULE,
      R39_RUNTIME_MODULE,
      R39_CORE_MODULE,
      R38_RUNTIME_MODULE,
      R38_CORE_MODULE,
      R37_READER_MODULE,
      R37_CORE_MODULE,
      SESSION_AUTH_MODULE,
    ]) {
      expect(imports, `the page must not import ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("the navigation helper's ENTIRE import surface is the view-model core (the view TYPE alone)", () => {
    const imports = importSpecifiers(codeOf(read(SURFACE_NAV)));
    expect(imports).toEqual([VM_CORE_MODULE]);
  });

  it("with R44 in the tree, the view-model runtime is imported by EXACTLY the surface page", () => {
    expect(importersOf(VM_RUNTIME_MODULE)).toEqual([SURFACE_PAGE]);
  });

  it("with R44 in the tree, createWorklistViewModel is named by EXACTLY its definition + the surface", () => {
    expect(namersOf(/\bcreateWorklistViewModel\b/)).toEqual([SURFACE_PAGE, VM_RUNTIME].sort());
  });

  it("the surface never names the session factory — it reads through the view model, not around it", () => {
    for (const path of SURFACE_FILES) {
      expect(codeOf(read(path)), `${path} must not open a session`).not.toMatch(/\bcreateWorklistSession\b/);
    }
  });

  it("neither artefact names the worklist API endpoint, a ledger, the Read Model view, a DB client or a query verb", () => {
    const endpointLiteral = new RegExp(`["']${WORKLIST_API_PATH}["']`);
    for (const path of SURFACE_FILES) {
      const code = codeOf(read(path));
      expect(code, `${path} must not name the API endpoint`).not.toMatch(endpointLiteral);
      expect(code, `${path} must not name the Read Model view`).not.toMatch(READ_MODEL_VIEW);
      for (const ledger of LEDGER_RELATIONS) {
        expect(code, `${path} must not name ${ledger}`).not.toMatch(ledger);
      }
      expect(code, `${path} creates no database client`).not.toMatch(DB_CLIENT);
      expect(code, `${path} uses no database query verb`).not.toMatch(QUERY_VERB);
    }
  });
});

// =====================================================================
// 3. THE VIEW MODEL / SESSION / CLIENT / API STAY AUTHORITATIVE — the lower invariants hold with R44 in the tree.
// =====================================================================

describe("receptionist worklist operator surface — the stack below stays authoritative", () => {
  it("the client read is STILL named by exactly the client + session runtimes", () => {
    expect(namersOf(/\bfetchOrgWorklist\b/)).toEqual([CLIENT_RUNTIME, SESSION_RUNTIME].sort());
  });

  it("the read surface is called by exactly the R40 route, the R58 attention queue + the R39 runtime", () => {
    // R58, the attention queue, is R39's authorised second consumer (the "queue" R39's doc anticipates);
    // R44's surface still reads through the client/API, never the read surface directly.
    expect(namersOf(/\bqueryOrgWorklist\b/)).toEqual([ROUTE, R39_RUNTIME, R58_QUEUE_RUNTIME].sort());
  });

  it("the endpoint literal is STILL owned by the client core alone", () => {
    const endpointLiteral = new RegExp(`["']${WORKLIST_API_PATH}["']`);
    expect(namersOf(endpointLiteral)).toEqual([CLIENT_CORE]);
  });

  it("the worklist derivation is STILL owned by exactly the two R38 modules", () => {
    expect(namersOf(/\bderiveWorklists\b/)).toEqual([R38_CORE, R38_RUNTIME].sort());
  });

  it("the Read Model view is STILL queried by exactly the R37 reader", () => {
    expect(namersOf(READ_MODEL_VIEW)).toEqual([R37_READER]);
  });

  it("the session-state type is STILL declared by exactly the R42 session core", () => {
    expect(namersOf(/\btype WorklistSessionState\s*=/)).toEqual([SESSION_CORE]);
  });

  it("the view-model composition is STILL owned by exactly the view-model core + runtime", () => {
    expect(namersOf(/\bderiveWorklistViewModel\b/)).toEqual([VM_CORE, VM_RUNTIME].sort());
  });

  it("the view-model type is STILL declared by exactly the view-model core", () => {
    expect(namersOf(/\btype WorklistViewModel\s*=/)).toEqual([VM_CORE]);
  });

  it("the surface re-derives, re-orders and re-paginates nothing — no worklist logic, no sort, no filter", () => {
    for (const path of SURFACE_FILES) {
      const code = codeOf(read(path));
      for (const token of WORKLIST_LOGIC) {
        expect(code, `${path} must not name ${token} — it renders the view model, it answers no query`).not.toMatch(
          token,
        );
      }
      expect(code, `${path} must not sort entries`).not.toMatch(/\.sort\s*\(/);
      expect(code, `${path} must not filter entries`).not.toMatch(/\.filter\s*\(/);
    }
  });
});

// =====================================================================
// 4. ORGANISATION ISOLATION IS STRUCTURAL — the surface names no organisation.
// =====================================================================

describe("receptionist worklist operator surface — organisation isolation is structural", () => {
  it("neither artefact names an organisation of any kind — the surface cannot select one", () => {
    for (const path of SURFACE_FILES) {
      const code = codeOf(read(path));
      for (const token of ORG_TOKENS) {
        expect(code, `${path} must not name an organisation (${token})`).not.toMatch(token);
      }
    }
  });

  it("the page gates on the HQ auth but does NOT import the org chokepoint — it forwards a session it never inspects", () => {
    const imports = importSpecifiers(codeOf(read(SURFACE_PAGE)));
    expect(imports, "the page uses the HQ page gate").toContain(HQ_AUTH_MODULE);
    expect(imports, "the page must NOT resolve the org itself").not.toContain(SESSION_AUTH_MODULE);
  });
});

// =====================================================================
// 5. NO DUPLICATE PRESENTATION LOGIC — presentation lives in the core; the surface only binds it.
// =====================================================================

describe("receptionist worklist operator surface — it forks no presentation logic", () => {
  it("the surface RE-DECLARES no view-model type — it imports them from the core", () => {
    for (const path of SURFACE_FILES) {
      const code = codeOf(read(path));
      for (const typeName of VIEW_MODEL_TYPES) {
        expect(code, `${path} must not redeclare ${typeName}`).not.toMatch(
          new RegExp(`\\b(?:type|interface)\\s+${typeName}\\b\\s*[={]`),
        );
      }
    }
  });

  it("the surface writes NONE of the view model's display copy — it renders the view model's own fields", () => {
    for (const path of SURFACE_FILES) {
      const code = codeOf(read(path));
      for (const copy of PRESENTATION_COPY) {
        expect(code, `${path} must not write display copy (${copy})`).not.toMatch(copy);
      }
    }
  });

  it("the surface names no per-facet derivation nor the composition — it consumes the runtime, not the core's derivations", () => {
    for (const path of SURFACE_FILES) {
      const code = codeOf(read(path));
      for (const fn of SUB_DERIVATIONS) {
        expect(code, `${path} must not name ${fn}`).not.toMatch(new RegExp(`\\b${fn}\\b`));
      }
    }
  });

  it("the surface drives no session transition — it never touches the state machine", () => {
    for (const path of SURFACE_FILES) {
      const code = codeOf(read(path));
      for (const token of SESSION_TRANSITIONS) {
        expect(code, `${path} must not name ${token}`).not.toMatch(token);
      }
    }
  });

  it("the navigation helper reaches no I/O, no clock and no RNG — its arithmetic is deterministic", () => {
    const code = codeOf(read(SURFACE_NAV));
    expect(code).not.toMatch(/\bfetch\s*\(/);
    expect(code).not.toMatch(/Math\.random|Date\.now|crypto\./);
    // The navigation helper depends on NOTHING but the view-model core's view TYPE.
    const imports = importSpecifiers(code);
    expect(imports).not.toContain("server-only");
    expect(imports).not.toContain(VM_RUNTIME_MODULE);
    expect(imports).not.toContain(SESSION_RUNTIME_MODULE);
    expect(imports).not.toContain(SESSION_AUTH_MODULE);
  });
});

// =====================================================================
// 6. NO MUTATION, NO EXECUTION PATH — neither artefact names any engine writer, runtime, or operational verb.
// =====================================================================

describe("receptionist worklist operator surface — it introduces no execution path", () => {
  it("neither artefact names ANY engine writer, runtime, or operational verb", () => {
    for (const path of SURFACE_FILES) {
      const code = codeOf(read(path));
      for (const token of EXECUTION_TOKENS) {
        expect(code, `${path} must not name ${token} — a read-only surface executes nothing`).not.toMatch(token);
      }
      for (const token of OPERATIONAL_TOKENS) {
        expect(
          code,
          `${path} must not name ${token} — the surface renders presentation, it never acts or retries`,
        ).not.toMatch(token);
      }
    }
  });

  it("ships NO migration that names the operator surface — no view, no table, no column", () => {
    const files = readdirSync(resolve(ROOT, MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql"));
    const byName = files.filter((f) => /operator[_-]?surface|worklist[_-]?surface/i.test(f));
    expect(byName, "no migration file is named for the operator surface").toEqual([]);
    const byBody = files.filter((f) =>
      /operator[_-]?surface|worklist[_-]?surface/i.test(sqlCodeOf(read(`${MIGRATIONS_DIR}/${f}`))),
    );
    expect(byBody, "no migration's executable SQL names the operator surface").toEqual([]);
  });
});
