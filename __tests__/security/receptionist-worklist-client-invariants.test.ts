import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve, relative, sep } from "node:path";

/**
 * Voice Receptionist AI — conversation worklist CLIENT invariants
 * (the AI Receptionist Programme, R41 — CONVERSATION WORKLIST CLIENT).
 *
 * R40 shipped the Conversation Worklist API: a pure request contract
 * (`lib/receptionist/conversation-worklist-api.ts`) + an HTTP route handler
 * (`app/api/receptionist/worklists/route.ts`) — the single authorised APPLICATION INTERFACE for querying
 * Conversation Worklists, scoped to the caller's organisation resolved from the SESSION. R41 is the layer
 * UP: the canonical Conversation Worklist CLIENT — the single authorised CONSUMER of that API. It is TWO
 * artefacts: a PURE CONTRACT (`lib/receptionist/conversation-worklist-client.ts`) that serialises a typed
 * request into the API's query and parses the API's response envelope into a typed page, and a SERVER
 * RUNTIME (`server/services/receptionist-worklist-client.ts`) that performs the ONE HTTP GET against the
 * API. The cardinal safety property is that it CONSUMES the API and does nothing else: it reads worklists
 * ONLY by GETting the R40 endpoint (never around it to the R39 read surface, the R38 engine, the R37 reader
 * or a ledger), it re-derives / re-orders / re-paginates no worklist (the API stays authoritative), it
 * forks no vocabulary, it names no organisation (so organisation isolation is inherited from the API,
 * structurally), and it introduces NO execution path — it assigns nobody, dispatches nothing, notifies no
 * one, schedules nothing and retries nothing. This suite proves that contract as a matter of SOURCE, not
 * discipline — the house bar of the R36→R40 invariant suites:
 *
 *   • THE CLIENT IS READ-ONLY — the runtime GETs, and GET alone: no POST / PUT / PATCH / DELETE method, no
 *     `.send(`, no operational verb. There is provably no path through which the client mutates anything.
 *   • THE CLIENT CONSUMES ONLY THE WORKLIST API — the runtime's ENTIRE dependency surface is the pure
 *     client contract (and `server-only`); it imports no read surface, engine, reader, session or database
 *     client, and it fetches ONLY the one endpoint {@link WORKLIST_API_PATH}. With R41 in the tree the R39
 *     read surface (`queryOrgWorklist`) is STILL called by exactly the R40 route + the R39 runtime — the
 *     client reads THROUGH the API over HTTP, never around it.
 *   • THE API STAYS AUTHORITATIVE — the client validates no filter vocabulary of its own and re-implements
 *     no read-surface operation: it forwards the typed values the caller chose and returns the page the API
 *     computed. With R41 in the tree the worklist derivation (`deriveWorklists`) is STILL owned by exactly
 *     the two R38 modules and the Read Model view is STILL queried by exactly R37's reader.
 *   • ORGANISATION ISOLATION IS PRESERVED — STRUCTURALLY. Neither artefact names an organisation of any
 *     kind: the request carries none and the runtime serialises none. The organisation a read is scoped to
 *     is the API's to resolve from the session; the client cannot express a cross-organisation read.
 *   • NO DUPLICATE WORKLIST LOGIC — the client REUSES the R39 vocabulary by TYPE import rather than
 *     re-declaring it, names NONE of the R38 derivation primitives or R39 read operations, runs no sort and
 *     filters no entries — it SHAPES a request and READS a response, it never answers a query.
 *   • NO EXECUTION PATH — neither artefact names any engine writer, engine runtime, or operational verb
 *     (assign / dispatch / notify / schedule / enqueue / retry), creates a database client, uses a query
 *     verb, or ships a migration; the runtime's only outbound call is the read of the API itself.
 *
 * The client's runtime behaviour (the pure contract's serialisation / parsing / helpers; the runtime's
 * success / 400 / 500 / transport mapping; org-from-session over HTTP; filtering, pagination and isolation
 * against real data) is pinned by the unit suite (__tests__/receptionist/conversation-worklist-client.test.ts)
 * and against real Postgres in __tests__/integration/receptionist/worklist-client-pipeline.test.ts. This
 * tier is HERMETIC — a filesystem scan over comment-stripped source — so the prose documenting the contract
 * can neither satisfy a positive match nor trip a negative.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

/** Strip block + line comments so only executable TS source is matched. */
function codeOf(ts: string): string {
  return ts
    .replace(/\/\*[\s\S]*?\*\//g, "") // block comments
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1"); // line comments (keep `://` in URLs)
}

/** Strip block + `--` line comments so only executable SQL is matched (prose can't match). */
function sqlCodeOf(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, "") // block comments (defensive)
    .replace(/--[^\n]*/g, ""); // line comments
}

/** Every module specifier the source imports — `from "x"` and bare `import "x"`. */
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

// The R41 artefacts — the pure client contract and the server runtime that consumes the API through it.
const CLIENT_CORE = "lib/receptionist/conversation-worklist-client.ts";
const CLIENT_RUNTIME = "server/services/receptionist-worklist-client.ts";
const CLIENT_CORE_MODULE = "@/lib/receptionist/conversation-worklist-client";

// The ONE endpoint the client consumes — the R40 API. The route is the sole caller of the R39 read surface.
const WORKLIST_API_PATH = "/api/receptionist/worklists";
const ROUTE = "app/api/receptionist/worklists/route.ts";

// The R40 API request-contract core — a SIBLING of the client, never a dependency of it (the client goes
// over HTTP; it does not import the parser).
const R40_CORE_MODULE = "@/lib/receptionist/conversation-worklist-api";

// The R39 read surface the client reads THROUGH the API — never around. Its RUNTIME is what the API route
// calls; the client core reuses the R39 pure core's query TYPES (erased) and imports nothing else.
const R39_RUNTIME = "server/services/receptionist-worklist-read-surface.ts";
// R58 — the Conversation Attention Queue: R39's authorised SECOND consumer of the worklist read surface
// (the "queue" R39's own doc-comment anticipates). It reads `prioritised` worklist pages through R39 and
// groups them by ownership; it never names the R38 reader, so it is not a read path around R39.
const R58_QUEUE_RUNTIME = "server/services/receptionist-attention-queue.ts";
const R39_CORE_MODULE = "@/lib/receptionist/conversation-worklist-read-surface";
const R39_RUNTIME_MODULE = "@/server/services/receptionist-worklist-read-surface";

// The R38 Worklist Engine BELOW R39 — the client must never reach it.
const R38_CORE = "lib/receptionist/conversation-coordination-worklist.ts";
const R38_RUNTIME = "server/services/receptionist-coordination-worklist.ts";
const R38_CORE_MODULE = "@/lib/receptionist/conversation-coordination-worklist";
const R38_RUNTIME_MODULE = "@/server/services/receptionist-coordination-worklist";

// The R37 read layer BELOW R38 — the client must never name it.
const R37_READER = "server/services/receptionist-coordination-view.ts";
const R37_READER_MODULE = "@/server/services/receptionist-coordination-view";
const R37_CORE_MODULE = "@/lib/receptionist/conversation-coordination-view";

// The single auth + org chokepoint — the client must NOT import it (the API route owns org resolution; the
// client merely forwards a session it never inspects).
const SESSION_MODULE = "@/server/auth/session";

/** The R37 read-model projection — the relation the client must NEVER name. */
const READ_MODEL_VIEW = /\breceptionist_coordination_read_model\b/;

const SOURCE_ROOTS = ["app", "server", "lib"] as const;
const MIGRATIONS_DIR = "supabase/migrations";

/** The coordination ledger and its six sibling ledgers — the seven relations the client must never name. */
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
 *  read-only client must NEVER name. `record_receptionist_conversation_` covers all seven writers. */
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
 *  RE-ANSWER a worklist (the engine's + read surface's jobs). The client shapes a request and reads a
 *  response; it does neither. */
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

/** The R41 non-goals as SOURCE tokens — assignment, dispatch, notification, scheduling, queueing, retries.
 *  A read-only client names none of them: it reads a worklist page, it never acts on one, and it never
 *  re-drives a failed read. */
const OPERATIONAL_TOKENS = [
  /\bassign\w*/i,
  /\bdispatch\w*/i,
  /\bnotif\w*/i, // notify / notification
  /\bschedul\w*/i, // schedule / scheduling
  /\benqueue\w*/i,
  /\bretr(?:y|ies)\b/i,
] as const;

/** Any database client constructor — the client touches no DB; it reads the API over HTTP. */
const DB_CLIENT = /createAdminClient|createServiceRoleClient|createClient/;

/** Any database query verb — the client names NONE (it consumes an HTTP API, it touches no DB primitive). */
const QUERY_VERB = /\.(from|select|insert|update|delete|upsert|rpc)\b/;

/** The three organisation spellings the client must NOT name — org is the API's to resolve, never the client's. */
const ORG_TOKENS = [/\borg[_-]?id\b/i, /\borganisation\b/i, /\borganization\b/i] as const;

/** The HTTP methods a read-only client must NOT issue, in a `method:` position of a fetch init. */
const WRITE_METHODS = ["POST", "PUT", "PATCH", "DELETE"] as const;

// =====================================================================
// 0. The client ships — pure contract + server runtime.
// =====================================================================

describe("receptionist worklist client — the client ships", () => {
  it(`ships the pure contract ${CLIENT_CORE} and the runtime ${CLIENT_RUNTIME}`, () => {
    expect(existsSync(resolve(ROOT, CLIENT_CORE)), CLIENT_CORE).toBe(true);
    expect(existsSync(resolve(ROOT, CLIENT_RUNTIME)), CLIENT_RUNTIME).toBe(true);
  });

  it("the contract exports the serialiser, the response parser and the typed error", () => {
    const code = codeOf(read(CLIENT_CORE));
    expect(code).toMatch(/export function worklistRequestToSearchParams\(/);
    expect(code).toMatch(/export function parseWorklistApiResponse\(/);
    expect(code).toMatch(/export class WorklistClientError\b/);
    expect(code).toMatch(/export const WORKLIST_API_PATH\b/);
  });

  it("the runtime exports the API consumer (fetchOrgWorklist)", () => {
    const code = codeOf(read(CLIENT_RUNTIME));
    expect(code).toMatch(/export\s+(async\s+)?function\s+fetchOrgWorklist\b/);
  });
});

// =====================================================================
// 1. THE CLIENT IS READ-ONLY — the runtime GETs and GET alone.
// =====================================================================

describe("receptionist worklist client — the client is read-only", () => {
  const runtimeCode = codeOf(read(CLIENT_RUNTIME));

  it("issues a GET", () => {
    expect(runtimeCode).toMatch(/method:\s*["']GET["']/);
  });

  it("issues NO write method — there is no mutating request", () => {
    for (const method of WRITE_METHODS) {
      expect(runtimeCode, `must not issue a ${method} request`).not.toMatch(
        new RegExp(`method:\\s*["']${method}["']`, "i"),
      );
    }
  });

  it("neither artefact sends — a client reads a page, it transmits nothing", () => {
    for (const path of [CLIENT_CORE, CLIENT_RUNTIME]) {
      expect(codeOf(read(path)), `${path} must not send`).not.toMatch(/\.send\s*\(/);
    }
  });
});

// =====================================================================
// 2. THE CLIENT CONSUMES ONLY THE WORKLIST API — it reaches around nothing.
// =====================================================================

describe("receptionist worklist client — it consumes only the Worklist API", () => {
  it("the runtime's ENTIRE dependency surface is the pure client contract (and server-only)", () => {
    const imports = new Set(importSpecifiers(codeOf(read(CLIENT_RUNTIME))));
    expect([...imports].sort()).toEqual([CLIENT_CORE_MODULE, "server-only"].sort());
  });

  it("the runtime imports NO read surface, engine, reader, session or API-contract module", () => {
    const imports = importSpecifiers(codeOf(read(CLIENT_RUNTIME)));
    expect(imports).not.toContain(R39_RUNTIME_MODULE);
    expect(imports).not.toContain(R39_CORE_MODULE);
    expect(imports).not.toContain(R38_RUNTIME_MODULE);
    expect(imports).not.toContain(R38_CORE_MODULE);
    expect(imports).not.toContain(R37_READER_MODULE);
    expect(imports).not.toContain(R37_CORE_MODULE);
    expect(imports).not.toContain(SESSION_MODULE);
    expect(imports).not.toContain(R40_CORE_MODULE);
  });

  it("the runtime fetches ONLY the one endpoint (via WORKLIST_API_PATH) — no other origin or /api/ path", () => {
    const code = codeOf(read(CLIENT_RUNTIME));
    // It DOES fetch — that is how it consumes the API…
    expect(code).toMatch(/\bfetch\b/);
    expect(code).toMatch(/\bWORKLIST_API_PATH\b/);
    // …and it targets ONLY the worklist API: no hardcoded origin, no other /api/ path literal.
    expect(code).not.toMatch(/["']https?:\/\//);
    expect(code).not.toMatch(/\/api\//);
  });

  it("names the worklist API endpoint in exactly one place — the client core", () => {
    const coreCode = codeOf(read(CLIENT_CORE));
    const endpointLiteral = new RegExp(`["']${WORKLIST_API_PATH}["']`);
    expect(coreCode).toMatch(new RegExp(`WORKLIST_API_PATH\\s*=\\s*${endpointLiteral.source}`));
    // Whole-tree: the endpoint STRING LITERAL is owned by the client core alone (every other mention is
    // prose — a comment referencing the route — stripped by codeOf).
    const owners = walkSources(SOURCE_ROOTS)
      .filter((full) => endpointLiteral.test(codeOf(read(rel(full)))))
      .map(rel)
      .sort();
    expect(owners).toEqual([CLIENT_CORE]);
  });

  it("with R58 in the tree, the R39 read surface is called by exactly the R40 route, the R58 attention queue + the R39 runtime", () => {
    // `queryOrgWorklist` — the R39 read surface — is named in executable source by the R40 route (its HTTP
    // caller), the R58 attention queue (R39's designed queue consumer) and the R39 runtime (its definition).
    // The R41 client must STILL NOT appear: it reads THROUGH the API over HTTP, never by calling the read
    // surface. If it did, it would have a read path AROUND the API.
    const callers = walkSources(SOURCE_ROOTS)
      .filter((full) => /\bqueryOrgWorklist\b/.test(codeOf(read(rel(full)))))
      .map(rel)
      .sort();
    expect(callers).toEqual([ROUTE, R39_RUNTIME, R58_QUEUE_RUNTIME].sort());
  });

  it("neither artefact names a lower reader, a ledger or the Read Model view — it reads through the API", () => {
    for (const path of [CLIENT_CORE, CLIENT_RUNTIME]) {
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
// 3. THE API STAYS AUTHORITATIVE — the engine + read model invariants hold with R41 in the tree.
// =====================================================================

describe("receptionist worklist client — the API stays authoritative", () => {
  it("with R41 in the tree, the worklist derivation is STILL owned by exactly the two R38 modules", () => {
    const derivers = walkSources(SOURCE_ROOTS)
      .filter((full) => /\bderiveWorklists\b/.test(codeOf(read(rel(full)))))
      .map(rel)
      .sort();
    expect(derivers).toEqual([R38_CORE, R38_RUNTIME].sort());
  });

  it("with R41 in the tree, the R37 view is STILL queried by exactly one module (R37's reader)", () => {
    const readers = walkSources(SOURCE_ROOTS)
      .filter((full) => READ_MODEL_VIEW.test(codeOf(read(rel(full)))))
      .map(rel)
      .sort();
    expect(readers).toEqual([R37_READER]);
  });
});

// =====================================================================
// 4. ORGANISATION ISOLATION IS STRUCTURAL — neither artefact names an organisation.
// =====================================================================

describe("receptionist worklist client — organisation isolation is structural", () => {
  it("neither artefact names an organisation of any kind — the client cannot select one", () => {
    // The killer structural guarantee: the request carries no org and the runtime serialises none, so the
    // organisation a read is scoped to can ONLY be the API's — resolved from the authenticated session. A
    // caller cannot ask this client for another org's worklist; the vocabulary does not exist.
    for (const path of [CLIENT_CORE, CLIENT_RUNTIME]) {
      const code = codeOf(read(path));
      for (const token of ORG_TOKENS) {
        expect(code, `${path} must not name an organisation (${token})`).not.toMatch(token);
      }
    }
  });

  it("the runtime forwards a session it never inspects — it does not import the session chokepoint", () => {
    // The client forwards the caller's credentials (headers) and lets the API resolve the org; it never
    // resolves, reads or asserts an org itself, so it does not import requireOrgContext.
    expect(importSpecifiers(codeOf(read(CLIENT_RUNTIME)))).not.toContain(SESSION_MODULE);
  });
});

// =====================================================================
// 5. NO DUPLICATE WORKLIST LOGIC — the client reuses the vocabulary and answers no query.
// =====================================================================

describe("receptionist worklist client — it forks no logic", () => {
  it("the core REUSES the R39 vocabulary by TYPE import — it imports nothing else", () => {
    const raw = read(CLIENT_CORE);
    const imports = new Set(importSpecifiers(codeOf(raw)));
    // The contract's ONLY dependency is the R39 read-surface pure core — for its query/page TYPES.
    expect([...imports]).toEqual([R39_CORE_MODULE]);
    // …imported (and re-exported) as TYPES only — erased at runtime, no data path.
    expect(raw).toMatch(
      /import type \{[\s\S]*?\} from ["']@\/lib\/receptionist\/conversation-worklist-read-surface["']/,
    );
  });

  it("the core re-declares no worklist vocabulary tuple of its own — no forked source of truth", () => {
    const code = codeOf(read(CLIENT_CORE));
    expect(code).not.toMatch(/\bconst\s+WORKLIST_VIEWS\s*=/);
    expect(code).not.toMatch(/\bconst\s+COORDINATION_PRIORITIES\s*=/);
    expect(code).not.toMatch(/\bconst\s+WORKLIST_CATEGORIES\s*=/);
  });

  it("neither artefact names an engine-derivation primitive or a read-surface operation", () => {
    for (const path of [CLIENT_CORE, CLIENT_RUNTIME]) {
      const code = codeOf(read(path));
      for (const token of WORKLIST_LOGIC) {
        expect(code, `${path} must not name ${token} — it shapes a request, it answers no query`).not.toMatch(
          token,
        );
      }
    }
  });

  it("neither artefact sorts or filters entries — ordering and filtering are the engine's + API's", () => {
    for (const path of [CLIENT_CORE, CLIENT_RUNTIME]) {
      const code = codeOf(read(path));
      expect(code, `${path} must not sort entries`).not.toMatch(/\.sort\s*\(/);
      expect(code, `${path} must not filter entries`).not.toMatch(/\.filter\s*\(/);
    }
  });

  it("the pure core reaches no I/O, no clock and no RNG — serialisation and parsing are deterministic", () => {
    const code = codeOf(read(CLIENT_CORE));
    expect(code).not.toMatch(/\bfetch\s*\(/); // the CORE is pure; only the runtime fetches
    expect(code).not.toMatch(/Math\.random|Date\.now|crypto\./);
    // The pure contract depends on no server module, no session and no database client.
    const imports = importSpecifiers(code);
    expect(imports).not.toContain("server-only");
    expect(imports).not.toContain(R39_RUNTIME_MODULE);
    expect(imports).not.toContain(SESSION_MODULE);
    expect(code).not.toMatch(DB_CLIENT);
    expect(code).not.toMatch(QUERY_VERB);
  });
});

// =====================================================================
// 6. NO EXECUTION PATH — neither artefact names any engine writer, runtime, or operational verb.
// =====================================================================

describe("receptionist worklist client — it introduces no execution path", () => {
  it("neither artefact names ANY engine writer, runtime, or operational verb", () => {
    const artefacts: Array<{ path: string; text: string }> = [
      { path: CLIENT_CORE, text: codeOf(read(CLIENT_CORE)) },
      { path: CLIENT_RUNTIME, text: codeOf(read(CLIENT_RUNTIME)) },
    ];
    for (const { path, text } of artefacts) {
      for (const token of EXECUTION_TOKENS) {
        expect(text, `${path} must not name ${token} — a read-only client executes nothing`).not.toMatch(
          token,
        );
      }
      // The R41 non-goals as source: assignment, dispatch, notifications, scheduling, queueing, retries.
      for (const token of OPERATIONAL_TOKENS) {
        expect(text, `${path} must not name ${token} — the client reads, it never acts or retries`).not.toMatch(
          token,
        );
      }
    }
  });

  it("ships NO migration that names a worklist-client relation — no view, no table, no column", () => {
    // R41 is an HTTP consumer of the R40 API; it introduces no database object of its own.
    const files = readdirSync(resolve(ROOT, MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql"));
    const byName = files.filter((f) => /worklist[_-]?client/i.test(f));
    expect(byName, "no migration file is named for a worklist-client relation").toEqual([]);
    const byBody = files.filter((f) =>
      /worklist[_-]?client/i.test(sqlCodeOf(read(`${MIGRATIONS_DIR}/${f}`))),
    );
    expect(byBody, "no migration's executable SQL names a worklist-client relation").toEqual([]);
  });
});
