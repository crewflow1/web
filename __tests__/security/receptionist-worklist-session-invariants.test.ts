import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve, relative, sep } from "node:path";

/**
 * Voice Receptionist AI — conversation worklist SESSION invariants
 * (the AI Receptionist Programme, R42 — CONVERSATION WORKLIST SESSION).
 *
 * R41 shipped the Conversation Worklist Client: the single authorised CONSUMER of the R40 Worklist API — a
 * typed, one-shot, STATELESS read that serialises a request, GETs the API once, and parses a page. R42 is the
 * layer UP: the canonical Conversation Worklist SESSION — the single authorised STATE-MANAGEMENT layer OVER
 * that client. It is TWO artefacts: a PURE STATE CORE (`lib/receptionist/conversation-worklist-session.ts`)
 * that models an immutable read position (view + filter + page window + load status + a monotonic freshness
 * revision) and the total, deterministic transitions that evolve it, and a SERVER RUNTIME
 * (`server/services/receptionist-worklist-session.ts`) — a thin stateful shell that HOLDS the current state,
 * DELEGATES every state change to the pure core, and performs each read THROUGH the R41 client's
 * {@link fetchOrgWorklist}. The cardinal safety property is that the session CONSUMES the client and does
 * nothing else: it reads worklists ONLY through the R41 client (never around it to the R40 endpoint, the R39
 * read surface, the R38 engine, the R37 reader or a ledger), it re-derives / re-orders / re-paginates no
 * worklist (the client — and behind it the API — stays authoritative), it forks no vocabulary and duplicates
 * no session logic, it names no organisation (so organisation isolation is inherited from the API,
 * structurally), and it introduces NO execution path — it assigns nobody, dispatches nothing, notifies no
 * one, schedules nothing, enqueues into nothing and retries nothing. This suite proves that contract as a
 * matter of SOURCE, not discipline — the house bar of the R36→R41 invariant suites:
 *
 *   • THE SESSION IS READ-ONLY — it holds state and reads THROUGH the client; the client owns the transport.
 *     The runtime issues NO `fetch(` of its own and performs NO HTTP method (no `method:` literal at all): its
 *     one outbound call is `fetchOrgWorklist`. Neither artefact `.send(`s. There is provably no path through
 *     which the session mutates anything.
 *   • THE SESSION CONSUMES ONLY THE WORKLIST CLIENT — the runtime's ENTIRE dependency surface is the R41
 *     client runtime, the R41 client core, the R42 pure core and `server-only`; the pure core's ENTIRE surface
 *     is the R41 client core. Neither imports a read surface, engine, reader, session chokepoint, API contract
 *     or database client, and neither names the R40 endpoint. `fetchOrgWorklist` is named in the tree by
 *     exactly its definition (the client runtime) and its ONE caller (the session runtime); with R42 in the
 *     tree the R39 read surface (`queryOrgWorklist`) is STILL called only by the R40 route + the R39 runtime —
 *     the session reads THROUGH the client over HTTP, never around it.
 *   • THE CLIENT + API STAY AUTHORITATIVE — the session validates no filter vocabulary of its own and
 *     re-implements no read-surface operation: it shapes which request to ask for next and holds the page the
 *     client returned. With R42 in the tree the derivation (`deriveWorklists`) is STILL owned by exactly the
 *     two R38 modules and the Read Model view is STILL queried by exactly R37's reader.
 *   • ORGANISATION ISOLATION IS PRESERVED — STRUCTURALLY. Neither artefact names an organisation of any kind:
 *     the state carries none and the runtime forwards a session (headers) it never inspects. The organisation
 *     a read is scoped to is the API's to resolve; the session cannot express a cross-organisation read.
 *   • NO DUPLICATE SESSION LOGIC — the state type and the status union live in the pure core ALONE; the
 *     runtime re-declares neither and writes no status literal, and the core forks none of the client's
 *     request/page vocabulary and re-implements none of the client's request-shaping helpers.
 *   • NO EXECUTION PATH — neither artefact names any engine writer, engine runtime, or operational verb
 *     (assign / dispatch / notify / schedule / enqueue / retry), creates a database client, uses a query
 *     verb, or ships a migration; the runtime's only outbound call is the client read itself.
 *
 * The session's runtime behaviour (the pure core's transitions; the runtime's load lifecycle, refresh-race
 * discard, filtering, pagination and isolation against real data) is pinned by the unit suite
 * (__tests__/receptionist/conversation-worklist-session.test.ts) and against real Postgres in
 * __tests__/integration/receptionist/worklist-session-pipeline.test.ts. This tier is HERMETIC — a filesystem
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

// The R42 artefacts — the pure state core and the server runtime that manages it over the R41 client.
const SESSION_CORE = "lib/receptionist/conversation-worklist-session.ts";
const SESSION_RUNTIME = "server/services/receptionist-worklist-session.ts";
const SESSION_CORE_MODULE = "@/lib/receptionist/conversation-worklist-session";

// The R41 client the session consumes — its pure contract and its server runtime (the sole transport).
const CLIENT_CORE = "lib/receptionist/conversation-worklist-client.ts";
const CLIENT_RUNTIME = "server/services/receptionist-worklist-client.ts";
const CLIENT_CORE_MODULE = "@/lib/receptionist/conversation-worklist-client";
const CLIENT_RUNTIME_MODULE = "@/server/services/receptionist-worklist-client";

// The ONE endpoint the client consumes — the R40 API. The route is the sole caller of the R39 read surface.
const WORKLIST_API_PATH = "/api/receptionist/worklists";
const ROUTE = "app/api/receptionist/worklists/route.ts";

// The R40 API request-contract core — a SIBLING two layers below; the session never imports it.
const R40_CORE_MODULE = "@/lib/receptionist/conversation-worklist-api";

// The R39 read surface the client reads THROUGH the API — the session must never name it.
const R39_RUNTIME = "server/services/receptionist-worklist-read-surface.ts";
const R39_CORE_MODULE = "@/lib/receptionist/conversation-worklist-read-surface";
const R39_RUNTIME_MODULE = "@/server/services/receptionist-worklist-read-surface";

// The R38 Worklist Engine BELOW R39 — the session must never reach it.
const R38_CORE = "lib/receptionist/conversation-coordination-worklist.ts";
const R38_RUNTIME = "server/services/receptionist-coordination-worklist.ts";
const R38_CORE_MODULE = "@/lib/receptionist/conversation-coordination-worklist";
const R38_RUNTIME_MODULE = "@/server/services/receptionist-coordination-worklist";

// The R37 read layer BELOW R38 — the session must never name it.
const R37_READER = "server/services/receptionist-coordination-view.ts";
const R37_READER_MODULE = "@/server/services/receptionist-coordination-view";
const R37_CORE_MODULE = "@/lib/receptionist/conversation-coordination-view";

// The single auth + org chokepoint — the session must NOT import it (the API route owns org resolution; the
// session merely forwards a session it never inspects).
const SESSION_AUTH_MODULE = "@/server/auth/session";

/** The R37 read-model projection — the relation the session must NEVER name. */
const READ_MODEL_VIEW = /\breceptionist_coordination_read_model\b/;

const SOURCE_ROOTS = ["app", "server", "lib"] as const;
const MIGRATIONS_DIR = "supabase/migrations";

/** The coordination ledger and its six sibling ledgers — the seven relations the session must never name. */
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
 *  read-only session must NEVER name. `record_receptionist_conversation_` covers all seven writers. */
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
 *  RE-ANSWER a worklist (the engine's + read surface's jobs). The session shapes a request and holds a
 *  page; it does neither. */
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

/** The R42 non-goals as SOURCE tokens — assignment, dispatch, notification, scheduling, queueing, retries.
 *  A read-only session names none of them: it manages a read position, it never acts on a worklist, and it
 *  never re-drives a failed read. */
const OPERATIONAL_TOKENS = [
  /\bassign\w*/i,
  /\bdispatch\w*/i,
  /\bnotif\w*/i, // notify / notification
  /\bschedul\w*/i, // schedule / scheduling
  /\benqueue\w*/i,
  /\bretr(?:y|ies)\b/i,
] as const;

/** Any database client constructor — the session touches no DB; it reads through the client over HTTP. */
const DB_CLIENT = /createAdminClient|createServiceRoleClient|createClient/;

/** Any database query verb — the session names NONE (it consumes the client, it touches no DB primitive). */
const QUERY_VERB = /\.(from|select|insert|update|delete|upsert|rpc)\b/;

/** The three organisation spellings the session must NOT name — org is the API's to resolve, never the session's. */
const ORG_TOKENS = [/\borg[_-]?id\b/i, /\borganisation\b/i, /\borganization\b/i] as const;

/** The HTTP methods a read-only session must NOT issue, in a `method:` position of a fetch init. */
const WRITE_METHODS = ["POST", "PUT", "PATCH", "DELETE"] as const;

// =====================================================================
// 0. The session ships — pure state core + server runtime.
// =====================================================================

describe("receptionist worklist session — the session ships", () => {
  it(`ships the pure core ${SESSION_CORE} and the runtime ${SESSION_RUNTIME}`, () => {
    expect(existsSync(resolve(ROOT, SESSION_CORE)), SESSION_CORE).toBe(true);
    expect(existsSync(resolve(ROOT, SESSION_RUNTIME)), SESSION_RUNTIME).toBe(true);
  });

  it("the core exports the state type, the status union and the load-lifecycle transitions", () => {
    const code = codeOf(read(SESSION_CORE));
    expect(code).toMatch(/export type WorklistSessionStatus\b/);
    expect(code).toMatch(/export type WorklistSessionState\b/);
    expect(code).toMatch(/export function initWorklistSession\(/);
    expect(code).toMatch(/export function beginWorklistLoad\(/);
    expect(code).toMatch(/export function applyWorklistPage\(/);
    expect(code).toMatch(/export function applyWorklistError\(/);
  });

  it("the runtime exports the session shell (WorklistSession) and its factory (createWorklistSession)", () => {
    const code = codeOf(read(SESSION_RUNTIME));
    expect(code).toMatch(/export class WorklistSession\b/);
    expect(code).toMatch(/export function createWorklistSession\(/);
  });
});

// =====================================================================
// 1. THE SESSION IS READ-ONLY — it holds state and reads THROUGH the client; the client owns the transport.
// =====================================================================

describe("receptionist worklist session — the session is read-only", () => {
  const runtimeCode = codeOf(read(SESSION_RUNTIME));

  it("issues NO fetch of its own — its one outbound call is the client's fetchOrgWorklist", () => {
    expect(runtimeCode, "the runtime must not fetch directly").not.toMatch(/\bfetch\s*\(/);
    expect(runtimeCode, "the runtime reads THROUGH the client").toMatch(/\bfetchOrgWorklist\s*\(/);
  });

  it("performs NO HTTP method itself — transport lives entirely in the client (no method: literal)", () => {
    // The session never builds a request; the client does. So neither artefact carries a `method:` at all —
    // and, a fortiori, no write method.
    for (const path of [SESSION_CORE, SESSION_RUNTIME]) {
      const code = codeOf(read(path));
      expect(code, `${path} performs no HTTP method`).not.toMatch(/method:\s*["']/);
      for (const method of WRITE_METHODS) {
        expect(code, `${path} must not issue a ${method} request`).not.toMatch(
          new RegExp(`method:\\s*["']${method}["']`, "i"),
        );
      }
    }
  });

  it("neither artefact sends — a session holds a read position, it transmits nothing", () => {
    for (const path of [SESSION_CORE, SESSION_RUNTIME]) {
      expect(codeOf(read(path)), `${path} must not send`).not.toMatch(/\.send\s*\(/);
    }
  });
});

// =====================================================================
// 2. THE SESSION CONSUMES ONLY THE WORKLIST CLIENT — it reaches around nothing.
// =====================================================================

describe("receptionist worklist session — it consumes only the Worklist Client", () => {
  it("the runtime's ENTIRE dependency surface is the client runtime + client core + session core (and server-only)", () => {
    const imports = new Set(importSpecifiers(codeOf(read(SESSION_RUNTIME))));
    expect([...imports].sort()).toEqual(
      [CLIENT_RUNTIME_MODULE, CLIENT_CORE_MODULE, SESSION_CORE_MODULE, "server-only"].sort(),
    );
  });

  it("the runtime imports NO read surface, engine, reader, session chokepoint or API-contract module", () => {
    const imports = importSpecifiers(codeOf(read(SESSION_RUNTIME)));
    expect(imports).not.toContain(R40_CORE_MODULE);
    expect(imports).not.toContain(R39_RUNTIME_MODULE);
    expect(imports).not.toContain(R39_CORE_MODULE);
    expect(imports).not.toContain(R38_RUNTIME_MODULE);
    expect(imports).not.toContain(R38_CORE_MODULE);
    expect(imports).not.toContain(R37_READER_MODULE);
    expect(imports).not.toContain(R37_CORE_MODULE);
    expect(imports).not.toContain(SESSION_AUTH_MODULE);
  });

  it("the pure core's ENTIRE dependency surface is the client core — it types the session THROUGH the client", () => {
    const raw = read(SESSION_CORE);
    const imports = new Set(importSpecifiers(codeOf(raw)));
    expect([...imports]).toEqual([CLIENT_CORE_MODULE]);
    // The read-surface vocabulary is re-exported THROUGH the client core (never imported from the read
    // surface, which the session must not name).
    expect(raw).toMatch(
      /export type \{[\s\S]*?\} from ["']@\/lib\/receptionist\/conversation-worklist-client["']/,
    );
    // …and it names none of the lower layers directly.
    expect([...imports]).not.toContain(R39_CORE_MODULE);
    expect([...imports]).not.toContain(R39_RUNTIME_MODULE);
    expect([...imports]).not.toContain(CLIENT_RUNTIME_MODULE);
    expect([...imports]).not.toContain(SESSION_AUTH_MODULE);
  });

  it("reads through the client's ONE function — fetchOrgWorklist is named by exactly its definition + the session", () => {
    // `fetchOrgWorklist` — the R41 client's sole read — is named in executable source by exactly the client
    // runtime (its definition) and the session runtime (its ONE production caller). Nothing else consumes it,
    // and the session consumes NOTHING else: there is one read path, and it goes through the client.
    const owners = walkSources(SOURCE_ROOTS)
      .filter((full) => /\bfetchOrgWorklist\b/.test(codeOf(read(rel(full)))))
      .map(rel)
      .sort();
    expect(owners).toEqual([CLIENT_RUNTIME, SESSION_RUNTIME].sort());
  });

  it("neither session artefact names the worklist API endpoint — that literal stays owned by the client core", () => {
    const endpointLiteral = new RegExp(`["']${WORKLIST_API_PATH}["']`);
    for (const path of [SESSION_CORE, SESSION_RUNTIME]) {
      expect(codeOf(read(path)), `${path} must not name the API endpoint`).not.toMatch(endpointLiteral);
    }
    // Whole-tree: the endpoint STRING LITERAL is STILL owned by the client core alone — the session reads
    // through the client, it does not re-address the API.
    const owners = walkSources(SOURCE_ROOTS)
      .filter((full) => endpointLiteral.test(codeOf(read(rel(full)))))
      .map(rel)
      .sort();
    expect(owners).toEqual([CLIENT_CORE]);
  });

  it("with R42 in the tree, the R39 read surface is STILL called by exactly the R40 route + the R39 runtime", () => {
    // `queryOrgWorklist` — the R39 read surface — must be named in executable source only by the R40 route
    // (its single production caller) and the R39 runtime (its definition). The R42 session must NOT appear:
    // it reads THROUGH the client (which GETs the API), never by calling the read surface. If it did, it
    // would have a read path AROUND the client and the API.
    const callers = walkSources(SOURCE_ROOTS)
      .filter((full) => /\bqueryOrgWorklist\b/.test(codeOf(read(rel(full)))))
      .map(rel)
      .sort();
    expect(callers).toEqual([ROUTE, R39_RUNTIME].sort());
  });

  it("neither artefact names a lower reader, a ledger or the Read Model view — it reads through the client", () => {
    for (const path of [SESSION_CORE, SESSION_RUNTIME]) {
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
// 3. THE CLIENT + API STAY AUTHORITATIVE — the engine + read model invariants hold with R42 in the tree.
// =====================================================================

describe("receptionist worklist session — the client and API stay authoritative", () => {
  it("with R42 in the tree, the worklist derivation is STILL owned by exactly the two R38 modules", () => {
    const derivers = walkSources(SOURCE_ROOTS)
      .filter((full) => /\bderiveWorklists\b/.test(codeOf(read(rel(full)))))
      .map(rel)
      .sort();
    expect(derivers).toEqual([R38_CORE, R38_RUNTIME].sort());
  });

  it("with R42 in the tree, the R37 view is STILL queried by exactly one module (R37's reader)", () => {
    const readers = walkSources(SOURCE_ROOTS)
      .filter((full) => READ_MODEL_VIEW.test(codeOf(read(rel(full)))))
      .map(rel)
      .sort();
    expect(readers).toEqual([R37_READER]);
  });

  it("neither artefact names an engine-derivation primitive or a read-surface operation", () => {
    for (const path of [SESSION_CORE, SESSION_RUNTIME]) {
      const code = codeOf(read(path));
      for (const token of WORKLIST_LOGIC) {
        expect(
          code,
          `${path} must not name ${token} — it shapes a request and holds a page, it answers no query`,
        ).not.toMatch(token);
      }
    }
  });

  it("neither artefact sorts or filters entries — ordering and filtering are the engine's + API's", () => {
    for (const path of [SESSION_CORE, SESSION_RUNTIME]) {
      const code = codeOf(read(path));
      expect(code, `${path} must not sort entries`).not.toMatch(/\.sort\s*\(/);
      expect(code, `${path} must not filter entries`).not.toMatch(/\.filter\s*\(/);
    }
  });
});

// =====================================================================
// 4. ORGANISATION ISOLATION IS STRUCTURAL — neither artefact names an organisation.
// =====================================================================

describe("receptionist worklist session — organisation isolation is structural", () => {
  it("neither artefact names an organisation of any kind — the session cannot select one", () => {
    // The killer structural guarantee: the state carries no org and the runtime serialises none, so the
    // organisation a read is scoped to can ONLY be the API's — resolved from the authenticated session. A
    // caller cannot move this session to another org's worklist; the vocabulary does not exist.
    for (const path of [SESSION_CORE, SESSION_RUNTIME]) {
      const code = codeOf(read(path));
      for (const token of ORG_TOKENS) {
        expect(code, `${path} must not name an organisation (${token})`).not.toMatch(token);
      }
    }
  });

  it("the runtime forwards a session it never inspects — it does not import the session chokepoint", () => {
    // The session forwards the caller's credentials (headers) to the client and lets the API resolve the org;
    // it never resolves, reads or asserts an org itself, so it does not import requireOrgContext.
    expect(importSpecifiers(codeOf(read(SESSION_RUNTIME)))).not.toContain(SESSION_AUTH_MODULE);
  });
});

// =====================================================================
// 5. NO DUPLICATE SESSION LOGIC — the state + status live in the core; the core forks no client vocabulary.
// =====================================================================

describe("receptionist worklist session — it forks no logic", () => {
  it("the state type and the status union are DECLARED in the pure core alone — no forked source of truth", () => {
    const coreCode = codeOf(read(SESSION_CORE));
    expect(coreCode).toMatch(/export type WorklistSessionStatus\s*=/);
    expect(coreCode).toMatch(/export type WorklistSessionState\s*=/);
    // Whole-tree: each is declared in exactly one module — the core.
    const stateOwners = walkSources(SOURCE_ROOTS)
      .filter((full) => /\btype WorklistSessionState\s*=/.test(codeOf(read(rel(full)))))
      .map(rel)
      .sort();
    expect(stateOwners).toEqual([SESSION_CORE]);
    const statusOwners = walkSources(SOURCE_ROOTS)
      .filter((full) => /\btype WorklistSessionStatus\s*=/.test(codeOf(read(rel(full)))))
      .map(rel)
      .sort();
    expect(statusOwners).toEqual([SESSION_CORE]);
  });

  it("the runtime RE-DECLARES neither the state type nor the status union, and writes no status literal", () => {
    const code = codeOf(read(SESSION_RUNTIME));
    expect(code, "the runtime imports the state type, it does not redeclare it").not.toMatch(
      /\btype\s+WorklistSessionState\s*=/,
    );
    expect(code, "the runtime imports the status union, it does not redeclare it").not.toMatch(
      /\btype\s+WorklistSessionStatus\s*=/,
    );
    // The status vocabulary is the core's: the runtime sets status only through the core's transitions, so it
    // writes none of the four status string literals itself.
    for (const literal of ["idle", "loading", "ready", "error"] as const) {
      expect(code, `the runtime must not write the "${literal}" status literal`).not.toMatch(
        new RegExp(`["']${literal}["']`),
      );
    }
  });

  it("the core FORKS none of the client's request/page vocabulary — it re-exports, it redefines nothing", () => {
    const code = codeOf(read(SESSION_CORE));
    expect(code).not.toMatch(/\b(?:type|interface)\s+WorklistClientRequest\b\s*[={]/);
    expect(code).not.toMatch(/\b(?:type|interface)\s+WorklistPage\b\s*[={]/);
    expect(code).not.toMatch(/\b(?:type|interface)\s+WorklistView\b\s*[={]/);
    expect(code).not.toMatch(/\b(?:type|interface)\s+WorklistFilter\b\s*[={]/);
  });

  it("the core RE-IMPLEMENTS none of the client's request-shaping helpers — it imports them", () => {
    const code = codeOf(read(SESSION_CORE));
    for (const helper of [
      "withWorklistView",
      "withWorklistFilter",
      "withWorklistPage",
      "nextWorklistPageRequest",
    ] as const) {
      expect(code, `the core must not define ${helper} — it reuses the client's`).not.toMatch(
        new RegExp(`\\bfunction\\s+${helper}\\b`),
      );
    }
  });

  it("the pure core reaches no I/O, no clock and no RNG — the transitions are deterministic", () => {
    const code = codeOf(read(SESSION_CORE));
    expect(code).not.toMatch(/\bfetch\s*\(/); // the CORE is pure; only the runtime reads (through the client)
    expect(code).not.toMatch(/Math\.random|Date\.now|crypto\./);
    // The pure core depends on no server module, no session chokepoint and no database client.
    const imports = importSpecifiers(code);
    expect(imports).not.toContain("server-only");
    expect(imports).not.toContain(CLIENT_RUNTIME_MODULE);
    expect(imports).not.toContain(SESSION_AUTH_MODULE);
    expect(code).not.toMatch(DB_CLIENT);
    expect(code).not.toMatch(QUERY_VERB);
  });
});

// =====================================================================
// 6. NO EXECUTION PATH — neither artefact names any engine writer, runtime, or operational verb.
// =====================================================================

describe("receptionist worklist session — it introduces no execution path", () => {
  it("neither artefact names ANY engine writer, runtime, or operational verb", () => {
    const artefacts: Array<{ path: string; text: string }> = [
      { path: SESSION_CORE, text: codeOf(read(SESSION_CORE)) },
      { path: SESSION_RUNTIME, text: codeOf(read(SESSION_RUNTIME)) },
    ];
    for (const { path, text } of artefacts) {
      for (const token of EXECUTION_TOKENS) {
        expect(text, `${path} must not name ${token} — a read-only session executes nothing`).not.toMatch(
          token,
        );
      }
      // The R42 non-goals as source: assignment, dispatch, notifications, scheduling, queueing, retries.
      for (const token of OPERATIONAL_TOKENS) {
        expect(
          text,
          `${path} must not name ${token} — the session reads, it never acts or retries`,
        ).not.toMatch(token);
      }
    }
  });

  it("ships NO migration that names a worklist-session relation — no view, no table, no column", () => {
    // R42 is a stateful consumer of the R41 client; it introduces no database object of its own.
    const files = readdirSync(resolve(ROOT, MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql"));
    const byName = files.filter((f) => /worklist[_-]?session/i.test(f));
    expect(byName, "no migration file is named for a worklist-session relation").toEqual([]);
    const byBody = files.filter((f) =>
      /worklist[_-]?session/i.test(sqlCodeOf(read(`${MIGRATIONS_DIR}/${f}`))),
    );
    expect(byBody, "no migration's executable SQL names a worklist-session relation").toEqual([]);
  });
});
