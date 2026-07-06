import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve, relative, sep } from "node:path";

/**
 * Voice Receptionist AI — conversation worklist VIEW MODEL invariants
 * (the AI Receptionist Programme, R43 — CONVERSATION WORKLIST VIEW MODEL).
 *
 * R42 shipped the Conversation Worklist Session: the single authorised STATE-MANAGEMENT layer over the R41
 * client — an immutable read position (view + filter + page window + load status + a monotonic freshness
 * revision) and the transitions that evolve it. What a consumer holds is therefore RAW STATE: a status enum,
 * a nullable page of already-derived entries, an error string. R43 is the layer UP: the canonical Conversation
 * Worklist VIEW MODEL — the single authorised PRESENTATION MODEL over that session. It is TWO artefacts: a PURE
 * PRESENTATION CORE (`lib/receptionist/conversation-worklist-view-model.ts`) that declares the presentation-ready
 * {@link WorklistViewModel} and the total, deterministic derivations that project it from a
 * {@link WorklistSessionState}, and a SERVER RUNTIME (`server/services/receptionist-worklist-view-model.ts`) — a
 * thin shell that HOLDS a live R42 session, DELEGATES every navigation to it, and PROJECTS the session's current
 * state through the pure core into a view model. The cardinal safety property is that the view model CONSUMES the
 * session and does nothing else: it reads worklists ONLY through the R42 session (never around it to the R41
 * client, the R40 endpoint, the R39 read surface, the R38 engine, the R37 reader or a ledger), it re-derives /
 * re-orders / re-paginates no worklist (the session — and behind it the client and the API — stays authoritative),
 * it forks no vocabulary and duplicates no presentation logic, it names no organisation (so organisation isolation
 * is inherited from the API, structurally), and it introduces NO execution path — it assigns nobody, dispatches
 * nothing, notifies no one, schedules nothing, enqueues into nothing and retries nothing. This suite proves that
 * contract as a matter of SOURCE, not discipline — the house bar of the R36→R42 invariant suites:
 *
 *   • THE VIEW MODEL IS READ-ONLY — it holds a session and projects it; the session owns the read, the client
 *     owns the transport. The runtime issues NO `fetch(` of its own and does not even name the client's
 *     `fetchOrgWorklist`: its one data path is the R42 session it drives via `createWorklistSession`, projected
 *     through `deriveWorklistViewModel`. Neither artefact performs an HTTP method (no `method:` literal) or
 *     `.send(`s. There is provably no path through which the view model mutates anything.
 *   • THE VIEW MODEL CONSUMES ONLY THE WORKLIST SESSION — the runtime's ENTIRE dependency surface is the R42
 *     session runtime, the R43 pure core and `server-only`; the pure core's ENTIRE surface is the R42 session
 *     core. Neither imports the client, a read surface, engine, reader, session chokepoint, API contract or
 *     database client, and neither names the R40 endpoint. With R43 in the tree `fetchOrgWorklist` is STILL named
 *     by exactly the client runtime + the session runtime (the view model reads THROUGH the session, never around
 *     it to the client), and the R39 read surface (`queryOrgWorklist`) is STILL called only by the R40 route +
 *     the R39 runtime.
 *   • THE SESSION + CLIENT + API STAY AUTHORITATIVE — the view model shapes no request vocabulary and
 *     re-implements no read-surface operation: it LABELS the entries the session holds and REUSES the session's
 *     own pagination selectors. With R43 in the tree the derivation (`deriveWorklists`) is STILL owned by exactly
 *     the two R38 modules, the Read Model view is STILL queried by exactly R37's reader, and the session-state
 *     type is STILL declared by exactly the R42 session core.
 *   • ORGANISATION ISOLATION IS PRESERVED — STRUCTURALLY. Neither artefact names an organisation of any kind:
 *     the view model is projected from a session state that carries none, and the runtime forwards a session
 *     (headers) it never inspects. The organisation a view model presents is the API's to resolve; the view model
 *     cannot express a cross-organisation read.
 *   • NO DUPLICATE PRESENTATION LOGIC — the view model type and every derivation live in the pure core ALONE;
 *     the runtime re-declares no view type and writes no display copy, and the core forks none of the session's
 *     state / status / request vocabulary and names none of the session's transitions.
 *   • NO EXECUTION PATH — neither artefact names any engine writer, engine runtime, or operational verb
 *     (assign / dispatch / notify / schedule / enqueue / retry), creates a database client, uses a query verb, or
 *     ships a migration; the runtime's only data path is the session read it projects.
 *
 * The view model's runtime behaviour (the pure core's derivations; the runtime's projection over the live
 * session, refresh, filtering, pagination and isolation against real data) is pinned by the unit suite
 * (__tests__/receptionist/conversation-worklist-view-model.test.ts) and against real Postgres in
 * __tests__/integration/receptionist/worklist-view-model-pipeline.test.ts. This tier is HERMETIC — a filesystem
 * scan over comment-stripped source — so the prose documenting the contract can neither satisfy a positive
 * match nor trip a negative.
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

// The R43 artefacts — the pure presentation core and the server runtime that projects it over the R42 session.
const VM_CORE = "lib/receptionist/conversation-worklist-view-model.ts";
const VM_RUNTIME = "server/services/receptionist-worklist-view-model.ts";
const VM_CORE_MODULE = "@/lib/receptionist/conversation-worklist-view-model";

// The R42 session the view model consumes — its pure state core and its server runtime (the sole read path).
const SESSION_CORE = "lib/receptionist/conversation-worklist-session.ts";
const SESSION_RUNTIME = "server/services/receptionist-worklist-session.ts";
const SESSION_CORE_MODULE = "@/lib/receptionist/conversation-worklist-session";
const SESSION_RUNTIME_MODULE = "@/server/services/receptionist-worklist-session";

// The R41 client the session consumes — its pure contract and its server runtime (the sole transport). The view
// model must reach neither: it reads THROUGH the session.
const CLIENT_CORE = "lib/receptionist/conversation-worklist-client.ts";
const CLIENT_RUNTIME = "server/services/receptionist-worklist-client.ts";
const CLIENT_CORE_MODULE = "@/lib/receptionist/conversation-worklist-client";
const CLIENT_RUNTIME_MODULE = "@/server/services/receptionist-worklist-client";

// The ONE endpoint the client consumes — the R40 API. The route is the sole caller of the R39 read surface.
const WORKLIST_API_PATH = "/api/receptionist/worklists";
const ROUTE = "app/api/receptionist/worklists/route.ts";

// The R40 API request-contract core — a SIBLING three layers below; the view model never imports it.
const R40_CORE_MODULE = "@/lib/receptionist/conversation-worklist-api";

// The R39 read surface the client reads THROUGH the API — the view model must never name it.
const R39_RUNTIME = "server/services/receptionist-worklist-read-surface.ts";
const R39_CORE_MODULE = "@/lib/receptionist/conversation-worklist-read-surface";
const R39_RUNTIME_MODULE = "@/server/services/receptionist-worklist-read-surface";

// The R38 Worklist Engine BELOW R39 — the view model must never reach it.
const R38_CORE = "lib/receptionist/conversation-coordination-worklist.ts";
const R38_RUNTIME = "server/services/receptionist-coordination-worklist.ts";
const R38_CORE_MODULE = "@/lib/receptionist/conversation-coordination-worklist";
const R38_RUNTIME_MODULE = "@/server/services/receptionist-coordination-worklist";

// The R37 read layer BELOW R38 — the view model must never name it.
const R37_READER = "server/services/receptionist-coordination-view.ts";
const R37_READER_MODULE = "@/server/services/receptionist-coordination-view";
const R37_CORE_MODULE = "@/lib/receptionist/conversation-coordination-view";

// The single auth + org chokepoint — the view model must NOT import it (the API route owns org resolution; the
// session merely forwards a session it never inspects, and the view model holds even less).
const SESSION_AUTH_MODULE = "@/server/auth/session";

/** The R37 read-model projection — the relation the view model must NEVER name. */
const READ_MODEL_VIEW = /\breceptionist_coordination_read_model\b/;

const SOURCE_ROOTS = ["app", "server", "lib"] as const;
const MIGRATIONS_DIR = "supabase/migrations";

/** The coordination ledger and its six sibling ledgers — the seven relations the view model must never name. */
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
 *  read-only view model must NEVER name. `record_receptionist_conversation_` covers all seven writers. */
const EXECUTION_TOKENS = [
  /record_receptionist_conversation_/i, // every ledger's write RPC (coordination + six siblings)
  /\bresolveConversationCoordination\b/, // the R36 fold — re-deriving the decision
  /\bcoordinateConversationLifecycle\b/, // the R36 runtime writer
  /\borchestrateConversationLifecycle\b/, // the R35 runtime writer
  /\bgovernConversationLifecycle\b/, // the R34 runtime writer
  /\bresolveConversationCompletion\b/, // the R33 runtime writer
  /\brecoverVerifiedFulfilment\b/, // the R32 runtime writer
  /\bverifyApprovedFulfilment\b/, // the R31 runtime writer
  /\bfulfilApprovedBooking\b/, // the R30 runtime writer
] as const;

/** The R38 worklist-DERIVATION primitives + the R39 read operations — naming any would RE-DERIVE or
 *  RE-ANSWER a worklist (the engine's + read surface's jobs). The view model LABELS the page the session holds;
 *  it does neither. */
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

/** The R42 session TRANSITIONS — naming any would re-drive the session's state machine (the session's job).
 *  The view model's runtime drives the session through its METHODS (refresh / setView / setFilter / …), never
 *  its transitions; the core REUSES the session's two pagination SELECTORS but names none of the transitions. */
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

/** The R43 non-goals as SOURCE tokens — assignment, dispatch, notification, scheduling, queueing, retries.
 *  A read-only view model names none of them: it derives presentation, it never acts on a worklist, and it
 *  never re-drives a read. */
const OPERATIONAL_TOKENS = [
  /\bassign\w*/i,
  /\bdispatch\w*/i,
  /\bnotif\w*/i, // notify / notification
  /\bschedul\w*/i, // schedule / scheduling
  /\benqueue\w*/i,
  /\bretr(?:y|ies)\b/i,
] as const;

/** The fixed display COPY that lives in the pure core — the runtime forks none of it. */
const PRESENTATION_COPY = [
  /No conversations/,
  /This worklist is empty/,
  /match the current filter/,
  /Loading conversations/,
  /Refreshing/,
  /Showing /,
] as const;

/** The six per-facet derivations the pure core OWNS — each named in the tree by exactly the core. */
const SUB_DERIVATIONS = [
  "deriveWorklistPresentation",
  "deriveWorklistSummary",
  "deriveWorklistPagination",
  "deriveWorklistEmptyState",
  "deriveWorklistLoadingState",
  "deriveWorklistErrorState",
] as const;

/** Any database client constructor — the view model touches no DB; it reads through the session. */
const DB_CLIENT = /createAdminClient|createServiceRoleClient|createClient/;

/** Any database query verb — the view model names NONE (it consumes the session, it touches no DB primitive). */
const QUERY_VERB = /\.(from|select|insert|update|delete|upsert|rpc)\b/;

/** The three organisation spellings the view model must NOT name — org is the API's to resolve, never the view model's. */
const ORG_TOKENS = [/\borg[_-]?id\b/i, /\borganisation\b/i, /\borganization\b/i] as const;

/** The HTTP methods a read-only view model must NOT issue, in a `method:` position of a fetch init. */
const WRITE_METHODS = ["POST", "PUT", "PATCH", "DELETE"] as const;

// =====================================================================
// 0. The view model ships — pure presentation core + server runtime.
// =====================================================================

describe("receptionist worklist view model — the view model ships", () => {
  it(`ships the pure core ${VM_CORE} and the runtime ${VM_RUNTIME}`, () => {
    expect(existsSync(resolve(ROOT, VM_CORE)), VM_CORE).toBe(true);
    expect(existsSync(resolve(ROOT, VM_RUNTIME)), VM_RUNTIME).toBe(true);
  });

  it("the core exports the view-model type and all seven presentation derivations", () => {
    const code = codeOf(read(VM_CORE));
    expect(code).toMatch(/export type WorklistViewModel\b/);
    expect(code).toMatch(/export function deriveWorklistPresentation\(/);
    expect(code).toMatch(/export function deriveWorklistSummary\(/);
    expect(code).toMatch(/export function deriveWorklistPagination\(/);
    expect(code).toMatch(/export function deriveWorklistEmptyState\(/);
    expect(code).toMatch(/export function deriveWorklistLoadingState\(/);
    expect(code).toMatch(/export function deriveWorklistErrorState\(/);
    expect(code).toMatch(/export function deriveWorklistViewModel\(/);
  });

  it("the runtime exports the view-model shell (WorklistViewModelRuntime) and its factory (createWorklistViewModel)", () => {
    const code = codeOf(read(VM_RUNTIME));
    expect(code).toMatch(/export class WorklistViewModelRuntime\b/);
    expect(code).toMatch(/export function createWorklistViewModel\(/);
  });
});

// =====================================================================
// 1. THE VIEW MODEL IS READ-ONLY — it holds a session and projects it; the session owns the read.
// =====================================================================

describe("receptionist worklist view model — the view model is read-only", () => {
  const runtimeCode = codeOf(read(VM_RUNTIME));

  it("issues NO fetch of its own and does not even name the client's read — its data path is the session", () => {
    expect(runtimeCode, "the runtime must not fetch directly").not.toMatch(/\bfetch\s*\(/);
    expect(
      runtimeCode,
      "the runtime reads THROUGH the session, never around it to the client's fetchOrgWorklist",
    ).not.toMatch(/\bfetchOrgWorklist\b/);
    expect(runtimeCode, "the runtime drives an R42 session").toMatch(/\bcreateWorklistSession\s*\(/);
    expect(runtimeCode, "the runtime projects through the pure core").toMatch(
      /\bderiveWorklistViewModel\s*\(/,
    );
  });

  it("performs NO HTTP method itself — transport lives entirely below (no method: literal)", () => {
    // The view model builds no request and drives no transport; the session (through the client) does. So
    // neither artefact carries a `method:` at all — and, a fortiori, no write method.
    for (const path of [VM_CORE, VM_RUNTIME]) {
      const code = codeOf(read(path));
      expect(code, `${path} performs no HTTP method`).not.toMatch(/method:\s*["']/);
      for (const method of WRITE_METHODS) {
        expect(code, `${path} must not issue a ${method} request`).not.toMatch(
          new RegExp(`method:\\s*["']${method}["']`, "i"),
        );
      }
    }
  });

  it("neither artefact sends — a view model derives presentation, it transmits nothing", () => {
    for (const path of [VM_CORE, VM_RUNTIME]) {
      expect(codeOf(read(path)), `${path} must not send`).not.toMatch(/\.send\s*\(/);
    }
  });
});

// =====================================================================
// 2. THE VIEW MODEL CONSUMES ONLY THE WORKLIST SESSION — it reaches around nothing.
// =====================================================================

describe("receptionist worklist view model — it consumes only the Worklist Session", () => {
  it("the runtime's ENTIRE dependency surface is the session runtime + the pure core (and server-only)", () => {
    const imports = new Set(importSpecifiers(codeOf(read(VM_RUNTIME))));
    expect([...imports].sort()).toEqual([SESSION_RUNTIME_MODULE, VM_CORE_MODULE, "server-only"].sort());
  });

  it("the runtime imports NO client, read surface, engine, reader, session chokepoint or API-contract module", () => {
    const imports = importSpecifiers(codeOf(read(VM_RUNTIME)));
    // It reads THROUGH the session runtime — never around it to the client, the session CORE, or lower.
    expect(imports).not.toContain(CLIENT_RUNTIME_MODULE);
    expect(imports).not.toContain(CLIENT_CORE_MODULE);
    expect(imports).not.toContain(SESSION_CORE_MODULE);
    expect(imports).not.toContain(R40_CORE_MODULE);
    expect(imports).not.toContain(R39_RUNTIME_MODULE);
    expect(imports).not.toContain(R39_CORE_MODULE);
    expect(imports).not.toContain(R38_RUNTIME_MODULE);
    expect(imports).not.toContain(R38_CORE_MODULE);
    expect(imports).not.toContain(R37_READER_MODULE);
    expect(imports).not.toContain(R37_CORE_MODULE);
    expect(imports).not.toContain(SESSION_AUTH_MODULE);
  });

  it("the pure core's ENTIRE dependency surface is the session core — it projects the session THROUGH it", () => {
    const raw = read(VM_CORE);
    const imports = new Set(importSpecifiers(codeOf(raw)));
    expect([...imports]).toEqual([SESSION_CORE_MODULE]);
    // The session / worklist vocabulary is re-exported THROUGH the session core (never imported from the
    // client, the read surface or the engine, none of which the view model names).
    expect(raw).toMatch(
      /export type \{[\s\S]*?\} from ["']@\/lib\/receptionist\/conversation-worklist-session["']/,
    );
    // …and it names none of the lower layers directly.
    expect([...imports]).not.toContain(SESSION_RUNTIME_MODULE);
    expect([...imports]).not.toContain(CLIENT_CORE_MODULE);
    expect([...imports]).not.toContain(CLIENT_RUNTIME_MODULE);
    expect([...imports]).not.toContain("server-only");
    expect([...imports]).not.toContain(SESSION_AUTH_MODULE);
  });

  it("with R43 in the tree, the client's read is STILL named by exactly its definition + the R42 session", () => {
    // `fetchOrgWorklist` — the R41 client's sole read — is named in executable source by exactly the client
    // runtime (its definition) and the session runtime (its ONE production caller). The R43 view model must NOT
    // appear: it reads THROUGH the session, never around it to the client. If it did, it would have a read path
    // that skips the session's state machine.
    const owners = walkSources(SOURCE_ROOTS)
      .filter((full) => /\bfetchOrgWorklist\b/.test(codeOf(read(rel(full)))))
      .map(rel)
      .sort();
    expect(owners).toEqual([CLIENT_RUNTIME, SESSION_RUNTIME].sort());
  });

  it("neither view-model artefact names the worklist API endpoint — that literal stays owned by the client core", () => {
    const endpointLiteral = new RegExp(`["']${WORKLIST_API_PATH}["']`);
    for (const path of [VM_CORE, VM_RUNTIME]) {
      expect(codeOf(read(path)), `${path} must not name the API endpoint`).not.toMatch(endpointLiteral);
    }
    // Whole-tree: the endpoint STRING LITERAL is STILL owned by the client core alone — the view model reads
    // through the session (through the client), it does not re-address the API.
    const owners = walkSources(SOURCE_ROOTS)
      .filter((full) => endpointLiteral.test(codeOf(read(rel(full)))))
      .map(rel)
      .sort();
    expect(owners).toEqual([CLIENT_CORE]);
  });

  it("with R43 in the tree, the R39 read surface is STILL called by exactly the R40 route + the R39 runtime", () => {
    // `queryOrgWorklist` — the R39 read surface — must be named in executable source only by the R40 route
    // (its single production caller) and the R39 runtime (its definition). The R43 view model must NOT appear:
    // it reads THROUGH the session (which reads through the client, which GETs the API), never by calling the
    // read surface.
    const callers = walkSources(SOURCE_ROOTS)
      .filter((full) => /\bqueryOrgWorklist\b/.test(codeOf(read(rel(full)))))
      .map(rel)
      .sort();
    expect(callers).toEqual([ROUTE, R39_RUNTIME].sort());
  });

  it("neither artefact names a lower reader, a ledger or the Read Model view — it reads through the session", () => {
    for (const path of [VM_CORE, VM_RUNTIME]) {
      const code = codeOf(read(path));
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
// 3. THE SESSION + CLIENT + API STAY AUTHORITATIVE — the lower invariants hold with R43 in the tree.
// =====================================================================

describe("receptionist worklist view model — the session, client and API stay authoritative", () => {
  it("with R43 in the tree, the worklist derivation is STILL owned by exactly the two R38 modules", () => {
    const derivers = walkSources(SOURCE_ROOTS)
      .filter((full) => /\bderiveWorklists\b/.test(codeOf(read(rel(full)))))
      .map(rel)
      .sort();
    expect(derivers).toEqual([R38_CORE, R38_RUNTIME].sort());
  });

  it("with R43 in the tree, the R37 view is STILL queried by exactly one module (R37's reader)", () => {
    const readers = walkSources(SOURCE_ROOTS)
      .filter((full) => READ_MODEL_VIEW.test(codeOf(read(rel(full)))))
      .map(rel)
      .sort();
    expect(readers).toEqual([R37_READER]);
  });

  it("with R43 in the tree, the session-state type is STILL declared by exactly the R42 session core", () => {
    const owners = walkSources(SOURCE_ROOTS)
      .filter((full) => /\btype WorklistSessionState\s*=/.test(codeOf(read(rel(full)))))
      .map(rel)
      .sort();
    expect(owners).toEqual([SESSION_CORE]);
  });

  it("neither artefact names an engine-derivation primitive or a read-surface operation", () => {
    for (const path of [VM_CORE, VM_RUNTIME]) {
      const code = codeOf(read(path));
      for (const token of WORKLIST_LOGIC) {
        expect(
          code,
          `${path} must not name ${token} — it labels the page the session holds, it answers no query`,
        ).not.toMatch(token);
      }
    }
  });

  it("the core REUSES the session's pagination selectors — it re-derives paging itself nowhere", () => {
    // The one place the view model expresses "can I page?" delegates to the session's own selectors, so the
    // session stays authoritative on paging; the view model echoes the verdict, it does not compute it.
    const core = codeOf(read(VM_CORE));
    expect(core, "the core reuses hasNextWorklistPage").toMatch(/\bhasNextWorklistPage\s*\(/);
    expect(core, "the core reuses hasPreviousWorklistPage").toMatch(/\bhasPreviousWorklistPage\s*\(/);
  });

  it("neither artefact sorts or filters entries — ordering and filtering are the engine's + API's", () => {
    for (const path of [VM_CORE, VM_RUNTIME]) {
      const code = codeOf(read(path));
      expect(code, `${path} must not sort entries`).not.toMatch(/\.sort\s*\(/);
      expect(code, `${path} must not filter entries`).not.toMatch(/\.filter\s*\(/);
    }
  });
});

// =====================================================================
// 4. ORGANISATION ISOLATION IS STRUCTURAL — neither artefact names an organisation.
// =====================================================================

describe("receptionist worklist view model — organisation isolation is structural", () => {
  it("neither artefact names an organisation of any kind — the view model cannot select one", () => {
    // The killer structural guarantee: the view model is projected from a session state that carries no org,
    // and it adds none. The organisation a view model presents can ONLY be the API's — resolved from the
    // authenticated session, far below. A caller cannot move this view model to another org's worklist; the
    // vocabulary does not exist.
    for (const path of [VM_CORE, VM_RUNTIME]) {
      const code = codeOf(read(path));
      for (const token of ORG_TOKENS) {
        expect(code, `${path} must not name an organisation (${token})`).not.toMatch(token);
      }
    }
  });

  it("the runtime forwards a session it never inspects — it does not import the session chokepoint", () => {
    // The runtime forwards the caller's options (headers) to the session and lets the API resolve the org; it
    // never resolves, reads or asserts an org itself, so it does not import requireOrgContext.
    expect(importSpecifiers(codeOf(read(VM_RUNTIME)))).not.toContain(SESSION_AUTH_MODULE);
  });
});

// =====================================================================
// 5. NO DUPLICATE PRESENTATION LOGIC — the view model + derivations live in the core; the core forks nothing.
// =====================================================================

describe("receptionist worklist view model — it forks no logic", () => {
  it("the view-model type is DECLARED in the pure core alone — no forked source of truth", () => {
    const owners = walkSources(SOURCE_ROOTS)
      .filter((full) => /\btype WorklistViewModel\s*=/.test(codeOf(read(rel(full)))))
      .map(rel)
      .sort();
    expect(owners).toEqual([VM_CORE]);
  });

  it("every per-facet derivation is named in the tree by exactly the core; the composition by core + runtime", () => {
    // Each of the six facet derivations exists once — in the core. Nothing re-implements presentation.
    for (const fn of SUB_DERIVATIONS) {
      const owners = walkSources(SOURCE_ROOTS)
        .filter((full) => new RegExp(`\\b${fn}\\b`).test(codeOf(read(rel(full)))))
        .map(rel)
        .sort();
      expect(owners, `${fn} is owned by exactly the core`).toEqual([VM_CORE]);
    }
    // The top-level composition is DEFINED in the core and CALLED by exactly the runtime — one entry point,
    // one consumer.
    const composers = walkSources(SOURCE_ROOTS)
      .filter((full) => /\bderiveWorklistViewModel\b/.test(codeOf(read(rel(full)))))
      .map(rel)
      .sort();
    expect(composers).toEqual([VM_CORE, VM_RUNTIME].sort());
  });

  it("the runtime RE-DECLARES no view type and writes no display copy — the core owns presentation", () => {
    const code = codeOf(read(VM_RUNTIME));
    expect(code, "the runtime imports the view-model type, it does not redeclare it").not.toMatch(
      /\btype\s+WorklistViewModel\s*=/,
    );
    expect(code, "the runtime declares no row type").not.toMatch(/\btype\s+WorklistRow\s*=/);
    expect(code, "the runtime declares no summary type").not.toMatch(/\btype\s+WorklistSummaryView\s*=/);
    // The display copy is the core's: the runtime renders none of it.
    for (const copy of PRESENTATION_COPY) {
      expect(code, `the runtime must not write display copy (${copy})`).not.toMatch(copy);
    }
  });

  it("the core FORKS none of the session's state / status / request vocabulary — it re-exports, redefines nothing", () => {
    const code = codeOf(read(VM_CORE));
    expect(code).not.toMatch(/\b(?:type|interface)\s+WorklistSessionState\b\s*[={]/);
    expect(code).not.toMatch(/\b(?:type|interface)\s+WorklistSessionStatus\b\s*[={]/);
    expect(code).not.toMatch(/\b(?:type|interface)\s+WorklistView\b\s*[={]/);
    expect(code).not.toMatch(/\b(?:type|interface)\s+WorklistFilter\b\s*[={]/);
    expect(code).not.toMatch(/\b(?:type|interface)\s+WorklistPage\b\s*[={]/);
  });

  it("neither artefact names a session TRANSITION — the runtime drives METHODS, the core reuses SELECTORS", () => {
    for (const path of [VM_CORE, VM_RUNTIME]) {
      const code = codeOf(read(path));
      for (const token of SESSION_TRANSITIONS) {
        expect(
          code,
          `${path} must not name ${token} — the session owns its state machine`,
        ).not.toMatch(token);
      }
    }
  });

  it("the pure core reaches no I/O, no clock and no RNG — the derivations are deterministic", () => {
    const code = codeOf(read(VM_CORE));
    expect(code).not.toMatch(/\bfetch\s*\(/); // the CORE is pure; only the runtime drives (through the session)
    expect(code).not.toMatch(/Math\.random|Date\.now|crypto\./);
    // The pure core depends on no server module, no session runtime, no session chokepoint and no DB client.
    const imports = importSpecifiers(code);
    expect(imports).not.toContain("server-only");
    expect(imports).not.toContain(SESSION_RUNTIME_MODULE);
    expect(imports).not.toContain(CLIENT_RUNTIME_MODULE);
    expect(imports).not.toContain(SESSION_AUTH_MODULE);
    expect(code).not.toMatch(DB_CLIENT);
    expect(code).not.toMatch(QUERY_VERB);
  });
});

// =====================================================================
// 6. NO EXECUTION PATH — neither artefact names any engine writer, runtime, or operational verb.
// =====================================================================

describe("receptionist worklist view model — it introduces no execution path", () => {
  it("neither artefact names ANY engine writer, runtime, or operational verb", () => {
    const artefacts: Array<{ path: string; text: string }> = [
      { path: VM_CORE, text: codeOf(read(VM_CORE)) },
      { path: VM_RUNTIME, text: codeOf(read(VM_RUNTIME)) },
    ];
    for (const { path, text } of artefacts) {
      for (const token of EXECUTION_TOKENS) {
        expect(text, `${path} must not name ${token} — a read-only view model executes nothing`).not.toMatch(
          token,
        );
      }
      // The R43 non-goals as source: assignment, dispatch, notifications, scheduling, queueing, retries.
      for (const token of OPERATIONAL_TOKENS) {
        expect(
          text,
          `${path} must not name ${token} — the view model derives presentation, it never acts or retries`,
        ).not.toMatch(token);
      }
    }
  });

  it("ships NO migration that names a worklist view model — no view, no table, no column", () => {
    // R43 is a pure presentation projection of the R42 session; it introduces no database object of its own.
    const files = readdirSync(resolve(ROOT, MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql"));
    const byName = files.filter((f) => /view[_-]?model/i.test(f));
    expect(byName, "no migration file is named for a view model").toEqual([]);
    const byBody = files.filter((f) => /view[_-]?model/i.test(sqlCodeOf(read(`${MIGRATIONS_DIR}/${f}`))));
    expect(byBody, "no migration's executable SQL names a view model").toEqual([]);
  });
});
