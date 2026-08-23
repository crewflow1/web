import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve, relative, sep } from "node:path";

/**
 * Voice Receptionist AI — conversation worklist API invariants
 * (the AI Receptionist Programme, R40 — CONVERSATION WORKLIST API).
 *
 * R39 shipped the Conversation Worklist READ SURFACE: a pure core
 * (`lib/receptionist/conversation-worklist-read-surface.ts`) that QUERIES the worklists the R38 engine
 * derives, and a server runtime (`server/services/receptionist-worklist-read-surface.ts`) that joins the
 * R38 engine reader to it — the SINGLE authorised query surface a capability reads a worklist page from.
 * R40 is the layer UP: the canonical Conversation Worklist API — the single authorised APPLICATION
 * INTERFACE for querying Conversation Worklists over HTTP. It is TWO artefacts: a PURE REQUEST CONTRACT
 * (`lib/receptionist/conversation-worklist-api.ts`) that translates an untrusted query string into a
 * validated {@link WorklistQuery}, and a ROUTE HANDLER (`app/api/receptionist/worklists/route.ts`) that
 * authenticates the caller, resolves the organisation from the SESSION, parses the query, and reads a
 * bounded page THROUGH the R39 read surface. The cardinal safety property is that it is an INTERFACE, NOT
 * BEHAVIOUR: it exposes GET only, it reads worklists ONLY through the R39 read surface (never around it to
 * R38, R37 or a ledger), it re-derives no worklist (the Worklist Engine stays authoritative), it forks no
 * vocabulary, the organisation can only come from the authenticated session (the request contract parses
 * none), and it introduces NO execution path — it assigns nobody, dispatches nothing, notifies no one,
 * schedules nothing and retries nothing. This suite proves that contract as a matter of SOURCE, not
 * discipline — the house bar of the R36/R37/R38/R39 invariant suites:
 *
 *   • THE API IS READ-ONLY — the route exports GET and GET alone: no POST / PUT / PATCH / DELETE / HEAD /
 *     OPTIONS. There is provably no HTTP verb through which the API mutates anything.
 *   • THE WORKLIST READ SURFACE STAYS AUTHORITATIVE — the route reads worklists ONLY through the R39
 *     runtime (`queryOrgWorklist`); it never reaches around R39 to the R38 reader, the R37 reader, the
 *     projection view or a ledger, and with R40 in the tree the R38 reader (`getCoordinationWorklists`) is
 *     STILL named by exactly the R38 + R39 runtimes — R40 reads through R39, it is the sole production
 *     caller of `queryOrgWorklist`.
 *   • THE WORKLIST ENGINE STAYS AUTHORITATIVE — with R40 in the tree the worklist derivation
 *     (`deriveWorklists`) is STILL owned by exactly the two R38 modules, and the Read Model view is STILL
 *     queried by exactly one module (R37's reader). R40 derives nothing and reads no relation.
 *   • ORGANISATION ISOLATION IS PRESERVED — STRUCTURALLY. The request contract parses NO organisation of
 *     any kind (it has no `org_id` vocabulary), so the route can only ever scope the read by the org it
 *     resolved from the authenticated session (`ctx.org.id`), never a client value. Isolation is a
 *     property of the CONTRACT, not a runtime check that could be forgotten.
 *   • NO DUPLICATE WORKLIST LOGIC — the request contract REUSES the R38/R39 vocabulary (views, priorities,
 *     categories) by IMPORT rather than re-declaring it, names NONE of the R38 derivation primitives, runs
 *     no sort, and executes no query — it PARSES a query, it never answers one.
 *   • NO EXECUTION PATH — neither the route nor the contract names ANY engine write primitive, engine
 *     runtime, or operational verb (assign / dispatch / notify / schedule / enqueue / retry), creates a
 *     database client, uses a query verb, reaches a provider, or ships a migration; there is provably no
 *     way to assign, dispatch, notify, schedule or execute work through the API.
 *
 * The API's runtime behaviour (the pure request contract's defaults / bounds / rejections; the route's
 * 200 / 400 / 500 mapping; org-from-session, never from the request; the four required worklists,
 * filtering, pagination and stable ordering over HTTP; org isolation against real data) is pinned by the
 * unit suite (__tests__/receptionist/conversation-worklist-api.test.ts) and against real Postgres in
 * __tests__/integration/receptionist/worklist-api-pipeline.test.ts. This tier is HERMETIC — a filesystem
 * scan over comment-stripped source — so the prose documenting the contract can neither satisfy a positive
 * match nor trip a negative.
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
        if (!full.endsWith("/lib/supabase/types.ts")) out.push(full);
      }
    }
  };
  for (const r of roots) visit(resolve(ROOT, r));
  return out;
}

/** A repo-relative, POSIX-style path for stable assertions across platforms. */
const rel = (full: string) => relative(ROOT, full).split(sep).join("/");

// The R40 artefacts — the pure request contract and the HTTP route handler that joins it to R39.
const CORE = "lib/receptionist/conversation-worklist-api.ts";
const ROUTE = "app/api/receptionist/worklists/route.ts";

// The R39 read surface R40 reads THROUGH — never around. The route consumes the R39 runtime reader; the
// request contract consumes the R39 pure core's vocabulary (WORKLIST_VIEWS + the query types).
const R39_RUNTIME = "server/services/receptionist-worklist-read-surface.ts";
// R58 — the Conversation Attention Queue: R39's authorised SECOND consumer of the worklist read surface
// (the "queue" R39's own doc-comment anticipates). It reads `prioritised` worklist pages through R39 and
// groups them by ownership; it never names the R38 reader, so it is not a read path around R39.
const R58_QUEUE_RUNTIME = "server/services/receptionist-attention-queue.ts";
const R39_RUNTIME_MODULE = "@/server/services/receptionist-worklist-read-surface";
const R39_CORE_MODULE = "@/lib/receptionist/conversation-worklist-read-surface";

// The R38 Worklist Engine BELOW R39 — R40 must never reach around R39 to it. The contract imports the R38
// core's vocabulary (priorities + categories) as values/types; nothing in R40 imports the R38 runtime.
const R38_CORE = "lib/receptionist/conversation-coordination-worklist.ts";
const R38_RUNTIME = "server/services/receptionist-coordination-worklist.ts";
const R38_CORE_MODULE = "@/lib/receptionist/conversation-coordination-worklist";
const R38_RUNTIME_MODULE = "@/server/services/receptionist-coordination-worklist";

// The R37 read layer BELOW R38 — R40 must never name it (that would be a read path around R39 and R38).
const R37_READER = "server/services/receptionist-coordination-view.ts";
const R37_READER_MODULE = "@/server/services/receptionist-coordination-view";
const R37_CORE_MODULE = "@/lib/receptionist/conversation-coordination-view";

// The R36 resolver — R40's contract imports its MODE type ONLY (erased at runtime); nothing imports its
// runtime.
const R36_CORE_MODULE = "@/lib/receptionist/conversation-coordination";
const R36_RUNTIME_MODULE = "@/server/services/receptionist-coordination";

// The single auth + org chokepoint the route MUST go through — the org can come from nowhere else.
const SESSION_MODULE = "@/server/auth/session";

/** The R37 read-model projection — the relation R40 must NEVER name (it reads through the R39 surface). */
const READ_MODEL_VIEW = /\breceptionist_coordination_read_model\b/;

const SOURCE_ROOTS = ["app", "server", "lib"] as const;
const MIGRATIONS_DIR = "supabase/migrations";

/** The coordination ledger and its six sibling ledgers — the seven relations R40 must never name. */
const LEDGER_RELATIONS = [
  /\breceptionist_conversation_coordinations\b/i,
  /\breceptionist_conversation_orchestrations\b/i,
  /\breceptionist_conversation_lifecycles\b/i,
  /\breceptionist_conversation_resolutions\b/i,
  /\breceptionist_conversation_recoveries\b/i,
  /\breceptionist_conversation_verifications\b/i,
  /\breceptionist_conversation_fulfilments\b/i,
] as const;

/** Every engine write primitive + runtime writer + the coordination resolver — the execution path an
 *  application interface must NEVER name. `record_receptionist_conversation_` covers all seven writers. */
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

/** The R38 worklist-DERIVATION primitives — naming any of these would RE-DERIVE a worklist (R38's sole
 *  job). `orderWorklistEntries` is also absent: R40 neither derives nor orders — R39 orders, R40 parses. */
const WORKLIST_DERIVATION = [
  /\bderiveWorklists\b/,
  /\bderiveCoordinationPriority\b/,
  /\bbelongsToWorklist\b/,
  /\bworklistCategoriesOf\b/,
  /\btoWorklistEntry\b/,
  /\bcompareWorklistEntries\b/,
  /\borderWorklistEntries\b/,
] as const;

/** The R40 non-goals as SOURCE tokens — assignment, dispatch, notification, scheduling, queueing, retries.
 *  An application interface names none of them: it reads worklists, it never acts on one. */
const OPERATIONAL_TOKENS = [
  /\bassign\w*/i,
  /\bdispatch\w*/i,
  /\bnotif\w*/i, // notify / notification
  /\bschedul\w*/i, // schedule / scheduling
  /\benqueue\w*/i,
  /\bretr(?:y|ies)\b/i,
] as const;

/** Any database client constructor — the route reads through the R39 runtime, the contract touches no DB. */
const DB_CLIENT = /createAdminClient|createServiceRoleClient|createClient/;

/** Any database query verb — R40 names NONE (an HTTP interface over a read surface touches no DB primitive). */
const QUERY_VERB = /\.(from|select|insert|update|delete|upsert|rpc)\b/;

/** The HTTP write verbs a read-only API must NOT export — as `function` or `const` handlers. */
const WRITE_VERBS = ["POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;

// =====================================================================
// 0. The API ships — pure request contract + HTTP route handler.
// =====================================================================

describe("receptionist worklist API — the API ships", () => {
  it(`ships the route ${ROUTE} and its pure request contract ${CORE}`, () => {
    expect(existsSync(resolve(ROOT, ROUTE)), ROUTE).toBe(true);
    expect(existsSync(resolve(ROOT, CORE)), CORE).toBe(true);
  });

  it("the route exports a GET handler", () => {
    const code = codeOf(read(ROUTE));
    expect(code).toMatch(/export\s+(async\s+)?function\s+GET\b/);
  });

  it("the request contract exports the parser and its typed error", () => {
    const code = codeOf(read(CORE));
    expect(code).toMatch(/export function parseWorklistQuery\(/);
    expect(code).toMatch(/export class WorklistQueryError\b/);
  });
});

// =====================================================================
// 1. THE API IS READ-ONLY — the route exposes GET and GET alone.
// =====================================================================

describe("receptionist worklist API — the API is read-only", () => {
  const code = codeOf(read(ROUTE));

  it("exports GET", () => {
    expect(code).toMatch(/export\s+(async\s+)?function\s+GET\b/);
  });

  it("exports NO write verb and no HEAD/OPTIONS — there is no mutating door", () => {
    for (const verb of WRITE_VERBS) {
      expect(code, `must not export a ${verb} handler function`).not.toMatch(
        new RegExp(`export\\s+(async\\s+)?function\\s+${verb}\\b`),
      );
      expect(code, `must not export a ${verb} handler const`).not.toMatch(
        new RegExp(`export\\s+const\\s+${verb}\\b`),
      );
    }
  });
});

// =====================================================================
// 2. THE READ SURFACE & ENGINE STAY AUTHORITATIVE — R40 reads worklists only through the R39 surface.
// =====================================================================

describe("receptionist worklist API — the read surface stays authoritative", () => {
  it("the route reads worklists ONLY through the R39 runtime — never around it", () => {
    const imports = importSpecifiers(codeOf(read(ROUTE)));
    // R40 goes through the R39 read-surface runtime…
    expect(imports).toContain(R39_RUNTIME_MODULE);
    // …and never reaches around R39 to the R38 engine, the R37 reader, or their cores.
    expect(imports).not.toContain(R38_RUNTIME_MODULE);
    expect(imports).not.toContain(R38_CORE_MODULE);
    expect(imports).not.toContain(R37_READER_MODULE);
    expect(imports).not.toContain(R37_CORE_MODULE);
    expect(imports).not.toContain(R36_RUNTIME_MODULE);
  });

  it("the route calls the R39 read surface (queryOrgWorklist) and no lower reader", () => {
    const code = codeOf(read(ROUTE));
    expect(code).toMatch(/queryOrgWorklist\s*\(/);
    expect(code).not.toMatch(/getCoordinationWorklists/); // the R38 reader — never called directly
  });

  it("names NONE of the seven coordination ledgers and never names the Read Model view", () => {
    const routeCode = codeOf(read(ROUTE));
    const coreCode = codeOf(read(CORE));
    expect(routeCode).not.toMatch(READ_MODEL_VIEW);
    expect(coreCode).not.toMatch(READ_MODEL_VIEW);
    for (const ledger of LEDGER_RELATIONS) {
      expect(routeCode, `the route must not name ${ledger}`).not.toMatch(ledger);
      expect(coreCode, `the request contract must not name ${ledger}`).not.toMatch(ledger);
    }
  });

  it("the route uses NO database query verb and creates no client — it reads through R39 alone", () => {
    const code = codeOf(read(ROUTE));
    expect(code).not.toMatch(QUERY_VERB);
    expect(code).not.toMatch(DB_CLIENT);
  });

  it("with R40 in the tree, the R38 reader is STILL named by exactly the R38 + R39 runtimes", () => {
    // `getCoordinationWorklists` — the R38 engine reader — must be named only by the R38 runtime (its
    // definition) and the R39 runtime (its single caller). R40 must NOT appear: it reads the derived page
    // through R39's `queryOrgWorklist`, never the R38 reader. If it did, R40 would have a read path AROUND
    // the R39 read surface.
    const owners = walkSources(SOURCE_ROOTS)
      .filter((full) => /getCoordinationWorklists/.test(codeOf(read(rel(full)))))
      .map(rel)
      .sort();
    expect(owners).toEqual([R38_RUNTIME, R39_RUNTIME].sort());
  });

  it("the R39 read surface (queryOrgWorklist) is called by exactly the R40 route, the R58 attention queue + the R39 runtime", () => {
    // In executable source, `queryOrgWorklist` is named by the R39 runtime (its definition), the R40 route
    // (its HTTP caller) and the R58 attention queue (R39's designed queue consumer — R39's own doc names "a
    // queue" as its intended reader). R40 STILL reads THROUGH R39 (it is in the set); no surface reaches
    // around R39 to the R38 reader — the getCoordinationWorklists pin stays exactly R38 + R39.
    const owners = walkSources(SOURCE_ROOTS)
      .filter((full) => /\bqueryOrgWorklist\b/.test(codeOf(read(rel(full)))))
      .map(rel)
      .sort();
    expect(owners).toEqual([ROUTE, R39_RUNTIME, R58_QUEUE_RUNTIME].sort());
  });
});

describe("receptionist worklist API — the Worklist Engine stays authoritative", () => {
  it("with R40 in the tree, the worklist derivation is STILL owned by exactly the two R38 modules", () => {
    const derivers = walkSources(SOURCE_ROOTS)
      .filter((full) => /\bderiveWorklists\b/.test(codeOf(read(rel(full)))))
      .map(rel)
      .sort();
    expect(derivers).toEqual([R38_CORE, R38_RUNTIME].sort());
  });

  it("with R40 in the tree, the R37 view is STILL queried by exactly one module (R37's invariant holds)", () => {
    const readers = walkSources(SOURCE_ROOTS)
      .filter((full) => READ_MODEL_VIEW.test(codeOf(read(rel(full)))))
      .map(rel)
      .sort();
    expect(readers).toEqual([R37_READER]);
  });
});

// =====================================================================
// 3. ORGANISATION ISOLATION IS STRUCTURAL — the org can only come from the authenticated session.
// =====================================================================

describe("receptionist worklist API — organisation isolation is structural", () => {
  it("the route authenticates through the single session chokepoint (requireOrgContext)", () => {
    const code = codeOf(read(ROUTE));
    expect(importSpecifiers(code)).toContain(SESSION_MODULE);
    expect(code).toMatch(/requireOrgContext\s*\(/);
  });

  it("the route scopes the read by the SESSION org (ctx.org.id) — every org_id comes from the session", () => {
    const code = codeOf(read(ROUTE));
    expect(code).toMatch(/org_id:\s*ctx\.org\.id/);
    // There is exactly ONE source for the scoped org: the session context. No org_id the handler sets is
    // read from anywhere else.
    const orgAssignments = code.match(/org_id:\s*[^,}\s]+/g) ?? [];
    expect(orgAssignments.length).toBeGreaterThanOrEqual(1);
    for (const assignment of orgAssignments) {
      expect(assignment, "every org_id must be sourced from ctx.org.id").toMatch(
        /org_id:\s*ctx\.org\.id/,
      );
    }
  });

  it("the route never reads an organisation from the request query string", () => {
    const code = codeOf(read(ROUTE));
    expect(code).not.toMatch(/searchParams\.get\(\s*["']org[_-]?id["']/i);
    expect(code).not.toMatch(/params\.get\(\s*["']org[_-]?id["']/i);
  });

  it("the request contract parses NO organisation — the vocabulary to name one does not exist", () => {
    // The killer structural guarantee: because the parsed query carries no org, the route can ONLY ever
    // scope by the session's org. A caller cannot ask this API for another org's worklist — the request
    // contract has no `org_id` to express it.
    const code = codeOf(read(CORE));
    expect(code).not.toMatch(/\borg[_-]?id\b/i);
    expect(code).not.toMatch(/\borganisation\b/i);
    expect(code).not.toMatch(/\borganization\b/i);
  });
});

// =====================================================================
// 4. NO DUPLICATE WORKLIST LOGIC — the request contract reuses the vocabulary and answers no query.
// =====================================================================

describe("receptionist worklist API — the request contract forks no logic", () => {
  const raw = read(CORE);
  const code = codeOf(raw);

  it("reuses the R38/R39 vocabulary by IMPORT — it re-declares no view/priority/category tuple", () => {
    const imports = importSpecifiers(code);
    // Views come from the R39 core; priorities + categories from the R38 core.
    expect(imports).toContain(R39_CORE_MODULE);
    expect(imports).toContain(R38_CORE_MODULE);
    // It uses the vocabulary…
    expect(code).toMatch(/\bWORKLIST_VIEWS\b/);
    expect(code).toMatch(/\bCOORDINATION_PRIORITIES\b/);
    expect(code).toMatch(/\bWORKLIST_CATEGORIES\b/);
    // …but declares NONE of it (no forked second source of truth).
    expect(code).not.toMatch(/\bconst\s+WORKLIST_VIEWS\s*=/);
    expect(code).not.toMatch(/\bconst\s+COORDINATION_PRIORITIES\s*=/);
    expect(code).not.toMatch(/\bconst\s+WORKLIST_CATEGORIES\s*=/);
  });

  it("imports the R36 conversation MODE as a TYPE only — modes are passed through, not recomputed", () => {
    expect(raw).toMatch(
      /import type \{\s*CoordinationMode\s*\}\s*from\s*["']@\/lib\/receptionist\/conversation-coordination["']/,
    );
    expect(importSpecifiers(code)).toContain(R36_CORE_MODULE);
  });

  it("names NONE of the R38 worklist-derivation primitives and rolls no sort — it PARSES, never derives", () => {
    for (const token of WORKLIST_DERIVATION) {
      expect(code, `the request contract must not name ${token}`).not.toMatch(token);
    }
    expect(code).not.toMatch(/\.sort\s*\(/);
  });

  it("executes no query — it produces a WorklistQuery, it never answers one", () => {
    // The contract builds a query object; it never calls the R39 query operations (which need a
    // WorklistSet it does not have). It PARSES a request — reading and answering are the route's + R39's job.
    expect(code).not.toMatch(/\bqueryWorklist\b/);
    expect(code).not.toMatch(/\bqueryOrgWorklist\b/);
    expect(code).not.toMatch(/\breadWorklistView\b/);
    expect(code).not.toMatch(/\bfilterWorklistEntries\b/);
    expect(code).not.toMatch(/\bpaginateWorklistEntries\b/);
  });

  it("depends on no server module and no database client — the contract is a pure parse transform", () => {
    const imports = importSpecifiers(code);
    expect(imports).not.toContain(R39_RUNTIME_MODULE);
    expect(imports).not.toContain(R38_RUNTIME_MODULE);
    expect(imports).not.toContain(R37_READER_MODULE);
    expect(imports).not.toContain(SESSION_MODULE);
    expect(imports).not.toContain("server-only");
    expect(code).not.toMatch(DB_CLIENT);
    expect(code).not.toMatch(QUERY_VERB);
  });

  it("reaches no I/O, no clock and no RNG — parsing is deterministic by construction", () => {
    expect(code).not.toMatch(/\bfetch\s*\(/);
    expect(code).not.toMatch(/Math\.random|Date\.now|crypto\./);
  });
});

// =====================================================================
// 5. NO EXECUTION PATH — neither artefact names any engine writer, runtime, or operational verb.
// =====================================================================

describe("receptionist worklist API — it introduces no execution path", () => {
  it("neither the route nor the request contract names ANY engine writer, runtime, or operational verb", () => {
    const artefacts: Array<{ path: string; text: string }> = [
      { path: ROUTE, text: codeOf(read(ROUTE)) },
      { path: CORE, text: codeOf(read(CORE)) },
    ];
    for (const { path, text } of artefacts) {
      for (const token of EXECUTION_TOKENS) {
        expect(text, `${path} must not name ${token} — an application interface executes nothing`).not.toMatch(
          token,
        );
      }
      // The R40 non-goals as source: assignment, dispatch, notifications, scheduling, queueing, retries.
      for (const token of OPERATIONAL_TOKENS) {
        expect(text, `${path} must not name ${token} — the API reads, it never acts`).not.toMatch(token);
      }
      // It reads worklists; it opens no outbound path to assign, dispatch, notify or schedule.
      expect(text, `${path} must not reach a provider`).not.toMatch(/\bfetch\s*\(/);
      expect(text, `${path} must not send`).not.toMatch(/\.send\s*\(/);
    }
  });

  it("ships NO migration that names a worklist-api relation — no view, no table, no column", () => {
    // R40 is an HTTP interface over the R39 read surface; it introduces no database object of its own.
    const files = readdirSync(resolve(ROOT, MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql"));
    const byName = files.filter((f) => /worklist[_-]?api/i.test(f));
    expect(byName, "no migration file is named for a worklist-api relation").toEqual([]);
    const byBody = files.filter((f) =>
      /worklist[_-]?api/i.test(sqlCodeOf(read(`${MIGRATIONS_DIR}/${f}`))),
    );
    expect(byBody, "no migration's executable SQL names a worklist-api relation").toEqual([]);
  });
});
