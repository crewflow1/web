import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve, relative, sep } from "node:path";

/**
 * Voice Receptionist AI — conversation worklist READ SURFACE invariants
 * (the AI Receptionist Programme, R39 — CONVERSATION WORKLIST READ SURFACE).
 *
 * R38 shipped the Conversation Coordination WORKLIST ENGINE: a pure core
 * (`lib/receptionist/conversation-coordination-worklist.ts`) that DERIVES prioritised, read-only
 * worklists from the coordinations the R37 Read Model records, and an org-scoped runtime
 * (`server/services/receptionist-coordination-worklist.ts`) that joins the R37 reader to it. R39 is the
 * next layer UP: a pure core (`lib/receptionist/conversation-worklist-read-surface.ts`) that QUERIES a
 * derived worklist set — SELECTS one worklist, FILTERS it, and returns a BOUNDED, stably-ordered PAGE —
 * and a server runtime (`server/services/receptionist-worklist-read-surface.ts`) that joins the R38 engine
 * reader to it: the SINGLE authorised query surface a future operational capability reads a worklist page
 * from. The cardinal safety property is that it is a QUERY, NOT BEHAVIOUR: it adds no relation, it reads
 * worklists ONLY through the R38 engine (never a ledger, never the view, never a re-derivation), it
 * RE-DERIVES no worklist (the Worklist Engine stays authoritative), the Coordination Read Model stays the
 * single query surface over recorded coordinations, and it introduces NO execution path — it assigns
 * nobody, dispatches nothing, notifies no one, schedules nothing and retries nothing. This suite proves
 * that contract as a matter of SOURCE, not discipline — the house bar of the R9/R11/R36/R37/R38 invariant
 * suites:
 *
 *   • ADDS NO RELATION — the Read Surface ships NO migration: no view, no table, no column. It reads
 *     entirely from the in-memory R38 {@link WorklistSet}, so the Read Model stays the single query
 *     surface and there is provably no second worklist-reconstruction path in the database.
 *   • THE WORKLIST ENGINE STAYS AUTHORITATIVE — the runtime reads worklists ONLY through the R38 engine
 *     reader; it never reaches around R38 to the R37 reader, never names the projection view or a ledger,
 *     and with R39 in the tree the worklist derivation (`deriveWorklists`) is STILL owned by exactly the
 *     two R38 modules, and the Read Model view is STILL queried by exactly one module (R37's reader).
 *   • THE READ SURFACE IS READ-ONLY — the runtime is server-only, imports the R38 reader + the R39 core
 *     and nothing else, creates no database client, names no ledger, uses NO query verb at all
 *     (.select/.insert/.update/.delete/.upsert/.rpc/.from), calls no vendor and names no engine writer.
 *   • ORGANISATION ISOLATION IS PRESERVED — every exported seam takes an `org_id` and forwards it straight
 *     to the R38 reader (whose read is org-scoped through R37's mandatory org filter); isolation is not
 *     re-implemented, it is inherited.
 *   • NO DUPLICATE WORKLIST LOGIC — the pure core reuses the R38 worklist vocabulary as TYPES only and the
 *     R36 mode type only, REUSES the R38 canonical order (orderWorklistEntries) rather than re-implementing
 *     it, names NONE of the R38 derivation primitives (deriveWorklists / toWorklistEntry / belongsToWorklist
 *     / deriveCoordinationPriority / worklistCategoriesOf / compareWorklistEntries), and reaches no I/O, no
 *     clock and no RNG: it QUERIES the derived worklists, it never re-derives them — so the same set and the
 *     same query always yield the same page (deterministic by construction).
 *   • ONE CANONICAL ORDER — every page is returned in the R38 canonical order, REUSED verbatim via
 *     orderWorklistEntries; the surface defines no comparator, and neither artefact rolls its own sort.
 *   • NO EXECUTION PATH — neither the runtime nor the pure core names ANY engine write primitive, runtime,
 *     or operational verb (assign / dispatch / notify / schedule / enqueue / retry); there is provably no
 *     way to assign, dispatch, notify, schedule or execute work through the Read Surface.
 *
 * The surface's runtime behaviour (verbatim view selection with the engine authoritative; filtering by
 * each dimension; offset/limit pagination with total/has_more; stable order read-twice; the four required
 * worklists; org isolation; conversation scoping; the concluded-is-non-actionable absence) is pinned by
 * the unit suite (__tests__/receptionist/conversation-worklist-read-surface.test.ts) and against real
 * Postgres in __tests__/integration/receptionist/worklist-read-surface-pipeline.test.ts. This tier is
 * HERMETIC — a filesystem scan over comment-stripped source — so the prose documenting the contract can
 * neither satisfy a positive match nor trip a negative.
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

// The R39 artefacts — the pure query core and the server runtime that joins the R38 engine to it.
const CORE = "lib/receptionist/conversation-worklist-read-surface.ts";
const RUNTIME = "server/services/receptionist-worklist-read-surface.ts";

// The R38 Worklist Engine R39 reads THROUGH — never around. The runtime consumes the R38 runtime reader;
// the pure core consumes the R38 pure core (the WorklistSet type + the canonical order value).
const R38_RUNTIME = "server/services/receptionist-coordination-worklist.ts";
const R38_CORE = "lib/receptionist/conversation-coordination-worklist.ts";
const R38_RUNTIME_MODULE = "@/server/services/receptionist-coordination-worklist";
const R38_CORE_MODULE = "@/lib/receptionist/conversation-coordination-worklist";

// The R37 read layer BELOW R38 — R39 must never reach around R38 to it (that would be a second read path).
const R37_READER = "server/services/receptionist-coordination-view.ts";
const R37_READER_MODULE = "@/server/services/receptionist-coordination-view";
const R37_CORE_MODULE = "@/lib/receptionist/conversation-coordination-view";

// The R36 resolver — R39's core imports its MODE type ONLY (erased at runtime); nothing imports its runtime.
const R36_CORE_MODULE = "@/lib/receptionist/conversation-coordination";
const R36_RUNTIME_MODULE = "@/server/services/receptionist-coordination";

/** The R37 read-model projection — the relation R39 must NEVER name (it reads through the R38 engine). */
const READ_MODEL_VIEW = /\breceptionist_coordination_read_model\b/;

const SOURCE_ROOTS = ["app", "server", "lib"] as const;
const MIGRATIONS_DIR = "supabase/migrations";

/** The coordination ledger and its six sibling ledgers — the seven relations R39 must never name. */
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
 *  read surface must NEVER name. `record_receptionist_conversation_` covers all seven ledger writers. */
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
 *  job). `orderWorklistEntries` is deliberately ABSENT: reusing the canonical order is the ONE legitimate
 *  value dependency (see §5, §6) — the surface QUERIES the derived worklists, it re-derives none. */
const WORKLIST_DERIVATION = [
  /\bderiveWorklists\b/,
  /\bderiveCoordinationPriority\b/,
  /\bbelongsToWorklist\b/,
  /\bworklistCategoriesOf\b/,
  /\btoWorklistEntry\b/,
  /\bcompareWorklistEntries\b/,
] as const;

/** The R39 non-goals as SOURCE tokens — assignment, dispatch, notification, scheduling, queueing, retries.
 *  A read surface names none of them: it reads worklists, it never acts on one. */
const OPERATIONAL_TOKENS = [
  /\bassign\w*/i,
  /\bdispatch\w*/i,
  /\bnotif\w*/i, // notify / notification
  /\bschedul\w*/i, // schedule / scheduling
  /\benqueue\w*/i,
  /\bretr(?:y|ies)\b/i,
] as const;

/** Any database client constructor — the pure core and the runtime must create none (the runtime reads
 *  through the R38 engine reader; the core touches no DB at all). */
const DB_CLIENT = /createAdminClient|createServiceRoleClient|createClient/;

/** Any database query verb — R39 names NONE (a query surface over a read model over a read model touches
 *  no DB primitive). */
const QUERY_VERB = /\.(from|select|insert|update|delete|upsert|rpc)\b/;

// =====================================================================
// 0. The read surface ships — pure query core + server runtime.
// =====================================================================

describe("receptionist worklist read surface — the read surface ships", () => {
  it(`ships the runtime ${RUNTIME} and its pure core ${CORE}`, () => {
    expect(existsSync(resolve(ROOT, RUNTIME)), RUNTIME).toBe(true);
    expect(existsSync(resolve(ROOT, CORE)), CORE).toBe(true);
  });

  it("the runtime exports the two org-scoped query seams (org-wide + per-conversation)", () => {
    const code = codeOf(read(RUNTIME));
    expect(code).toMatch(/export async function queryOrgWorklist\(/);
    expect(code).toMatch(/export async function queryConversationWorklist\(/);
  });

  it("the pure core exports the query vocabulary and the four query operations", () => {
    const code = codeOf(read(CORE));
    expect(code).toMatch(/export const WORKLIST_VIEWS\b/);
    expect(code).toMatch(/export function readWorklistView\(/);
    expect(code).toMatch(/export function matchesWorklistFilter\(/);
    expect(code).toMatch(/export function filterWorklistEntries\(/);
    expect(code).toMatch(/export function paginateWorklistEntries\(/);
    expect(code).toMatch(/export function queryWorklist\(/);
  });
});

// =====================================================================
// 1. ADDS NO RELATION — the read surface ships no migration; it reads the in-memory R38 set alone.
// =====================================================================

describe("receptionist worklist read surface — it adds no relation", () => {
  it("ships NO migration that names a read-surface relation — no view, no table, no column", () => {
    // The Read Surface QUERIES the in-memory {@link WorklistSet} the R38 engine derived; it introduces no
    // database object of its own. So no migration — in FILENAME or in executable SQL — names a read
    // surface. If one did, R39 would have forked a second query surface over the coordinations.
    const files = readdirSync(resolve(ROOT, MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql"));
    const byName = files.filter((f) => /read[_-]?surface/i.test(f));
    expect(byName, "no migration file is named for a read-surface relation").toEqual([]);
    const byBody = files.filter((f) => /read[_-]?surface/i.test(sqlCodeOf(read(`${MIGRATIONS_DIR}/${f}`))));
    expect(byBody, "no migration's executable SQL names a read-surface relation").toEqual([]);
  });
});

// =====================================================================
// 2. THE WORKLIST ENGINE STAYS AUTHORITATIVE — R39 reads worklists only through the R38 engine.
// =====================================================================

describe("receptionist worklist read surface — the Worklist Engine stays authoritative", () => {
  it("the runtime reads worklists ONLY through the R38 engine reader — never around it", () => {
    const runtimeCode = codeOf(read(RUNTIME));
    const imports = importSpecifiers(runtimeCode);
    // R39 goes through the R38 engine runtime's functions…
    expect(imports).toContain(R38_RUNTIME_MODULE);
    // …and never reaches around R38 down to the R37 reader (which would be a second read path below it).
    expect(imports).not.toContain(R37_READER_MODULE);
    expect(imports).not.toContain(R37_CORE_MODULE);
  });

  it("the pure core's only worklist input is the R38 engine core — it names no lower read layer", () => {
    const coreCode = codeOf(read(CORE));
    const imports = importSpecifiers(coreCode);
    // The core consumes the R38 pure core (the WorklistSet type + the canonical order)…
    expect(imports).toContain(R38_CORE_MODULE);
    // …and never the R37 reader/core or the R38 runtime — it QUERIES what it is given, it fetches nothing.
    expect(imports).not.toContain(R37_READER_MODULE);
    expect(imports).not.toContain(R37_CORE_MODULE);
    expect(imports).not.toContain(R38_RUNTIME_MODULE);
  });

  it("names NONE of the seven coordination ledgers and never names the Read Model view", () => {
    const runtimeCode = codeOf(read(RUNTIME));
    const coreCode = codeOf(read(CORE));
    expect(runtimeCode).not.toMatch(READ_MODEL_VIEW);
    expect(coreCode).not.toMatch(READ_MODEL_VIEW);
    for (const ledger of LEDGER_RELATIONS) {
      expect(runtimeCode, `the runtime must not name ${ledger}`).not.toMatch(ledger);
      expect(coreCode, `the pure core must not name ${ledger}`).not.toMatch(ledger);
    }
  });

  it("with R39 in the tree, the worklist derivation is STILL owned by exactly the two R38 modules", () => {
    // `deriveWorklists` — the sole worklist-derivation entry point — must be named by ONLY the R38 core
    // (its definition) and the R38 runtime (its single caller). R39 must NOT appear: it reads the derived
    // set through the R38 runtime, it derives nothing. If it did, there would be a second derivation path.
    const derivers = walkSources(SOURCE_ROOTS)
      .filter((full) => /\bderiveWorklists\b/.test(codeOf(read(rel(full)))))
      .map(rel)
      .sort();
    expect(derivers).toEqual([R38_CORE, R38_RUNTIME]);
  });

  it("with R39 in the tree, the R37 view is STILL queried by exactly one module (R37's invariant holds)", () => {
    const readers = walkSources(SOURCE_ROOTS)
      .filter((full) => READ_MODEL_VIEW.test(codeOf(read(rel(full)))))
      .map(rel)
      .sort();
    // Neither R38 nor R39 may appear here — both read through the R37 reader, not the view. The Read Model
    // stays the SINGLE query surface over recorded coordinations, three layers up as it was at R37.
    expect(readers).toEqual([R37_READER]);
  });
});

// =====================================================================
// 3. THE READ SURFACE IS READ-ONLY — pure read through R38, no client, no query verb, no outbound.
// =====================================================================

describe("receptionist worklist read surface — the runtime is read-only", () => {
  const code = codeOf(read(RUNTIME));

  it("is a server-only module that reads through the R38 reader and queries through the pure core", () => {
    const imports = importSpecifiers(code);
    expect(imports).toContain("server-only");
    expect(imports).toContain(R38_RUNTIME_MODULE); // reads derived worklists through R38
    expect(imports).toContain("@/lib/receptionist/conversation-worklist-read-surface"); // queries, purely
  });

  it("imports no engine, no policy, no comms — it reads and queries, it does not coordinate", () => {
    const imports = importSpecifiers(code);
    expect(imports).not.toContain(R36_RUNTIME_MODULE); // the R36 runtime
    expect(imports).not.toContain(R36_CORE_MODULE); // the R36 resolver core
    expect(imports).not.toContain("@/lib/receptionist/policy");
    expect(imports).not.toContain("@/lib/comms");
  });

  it("creates NO database client — its only data source is the R38 reader", () => {
    expect(code).not.toMatch(DB_CLIENT);
    expect(importSpecifiers(code)).not.toContain("@/lib/supabase/admin");
  });

  it("uses NO database query verb — a query surface over a read model touches no DB primitive", () => {
    expect(code).not.toMatch(QUERY_VERB);
  });

  it("names no engine writer and calls no vendor — no door to an engine or a provider", () => {
    for (const token of EXECUTION_TOKENS) {
      expect(code, `the runtime must not name ${token}`).not.toMatch(token);
    }
    expect(code).not.toMatch(/\bfetch\s*\(/);
    expect(code).not.toMatch(/\.send\s*\(/);
  });
});

// =====================================================================
// 4. ORGANISATION ISOLATION IS PRESERVED — every seam takes and forwards org_id to the R38 reader.
// =====================================================================

describe("receptionist worklist read surface — organisation isolation is preserved", () => {
  const code = codeOf(read(RUNTIME));

  it("every query seam is org-scoped — each takes an org_id (one per exported seam)", () => {
    const orgInputs = code.match(/org_id:\s*string/g) ?? [];
    expect(orgInputs.length).toBeGreaterThanOrEqual(2);
  });

  it("forwards org_id straight to the R38 reader — isolation is inherited, not re-implemented", () => {
    // The org reader passes the caller's org_id into `getCoordinationWorklists`; the conversation reader
    // passes org_id AND conversation_id into `getCoordinationWorklistsForConversation`. Every read is
    // therefore scoped by the R38 → R37 query's own mandatory org filter — R39 re-implements no isolation.
    expect(code).toMatch(/getCoordinationWorklists\(\s*\{\s*org_id:\s*input\.org_id/);
    expect(code).toMatch(/getCoordinationWorklistsForConversation\(\s*\{\s*org_id:\s*input\.org_id/);
    expect(code).toMatch(/conversation_id:\s*input\.conversation_id/);
  });
});

// =====================================================================
// 5. NO DUPLICATE WORKLIST LOGIC — the pure core re-derives nothing (and is deterministic).
// =====================================================================

describe("receptionist worklist read surface — the pure core re-derives no worklist", () => {
  const raw = read(CORE);
  const code = codeOf(raw);

  it("reuses the R38 worklist vocabulary as TYPES only — it forks no vocabulary of its own", () => {
    // The derived worklist's own vocabulary (entry, set, category, priority) is imported type-only (erased
    // at runtime), so the core carries no runtime dependency on the derivation — it SHAPES what R38 derived.
    expect(code).toMatch(/\btype WorklistEntry\b/);
    expect(code).toMatch(/\btype WorklistSet\b/);
    expect(code).toMatch(/\btype WorklistCategory\b/);
    expect(code).toMatch(/\btype CoordinationPriority\b/);
    expect(importSpecifiers(code)).toContain(R38_CORE_MODULE);
  });

  it("imports the R36 conversation MODE as a TYPE only — the filter reads it, it recomputes nothing", () => {
    expect(raw).toMatch(
      /import type \{\s*CoordinationMode\s*\}\s*from\s*["']@\/lib\/receptionist\/conversation-coordination["']/,
    );
  });

  it("REUSES the R38 canonical order rather than re-implementing it", () => {
    // The single legitimate VALUE import from R38: the canonical worklist order. It is the ONLY worklist
    // function the surface imports — the derivation primitives (§ next assertion) are all absent.
    expect(code).toMatch(/\borderWorklistEntries\b/);
  });

  it("names NONE of the R38 worklist-derivation primitives — it QUERIES, it never re-derives", () => {
    for (const token of WORKLIST_DERIVATION) {
      expect(code, `the pure core must not name ${token}`).not.toMatch(token);
    }
  });

  it("depends on no server module and no database client — the core is a pure query transform", () => {
    // The pure core consumes the R38 pure core (the set type + the order); it never reaches the R38 runtime
    // or any DB — WHICH org's worklists are read is the runtime's job, through R38 → R37.
    expect(importSpecifiers(code)).not.toContain(R38_RUNTIME_MODULE);
    expect(importSpecifiers(code)).not.toContain(R37_READER_MODULE);
    expect(code).not.toMatch(DB_CLIENT);
    expect(code).not.toMatch(QUERY_VERB);
  });

  it("names no resolver and no runtime writer — the derived worklist is re-shaped, never recomputed", () => {
    for (const token of EXECUTION_TOKENS) {
      expect(code, `the pure core must not name ${token}`).not.toMatch(token);
    }
  });

  it("reaches no I/O, no clock and no RNG — pages are deterministic by construction", () => {
    // No clock and no RNG ⇒ the same set and the same query always yield the same page, in the same order.
    // Determinism is a property of the SOURCE, not merely of a passing test run.
    expect(code).not.toMatch(/\bfetch\s*\(/);
    expect(code).not.toMatch(/Math\.random|Date\.now|crypto\./);
  });
});

// =====================================================================
// 6. ONE CANONICAL ORDER — the surface reuses R38's order and defines none of its own.
// =====================================================================

describe("receptionist worklist read surface — the worklist order is reused, never redefined", () => {
  const coreCode = codeOf(read(CORE));
  const runtimeCode = codeOf(read(RUNTIME));

  it("the query pipeline re-asserts the R38 canonical order by REUSING orderWorklistEntries", () => {
    // queryWorklist selects → filters → orders (reused) → pages. The order step delegates to the one
    // canonical function; the surface implements no comparator of its own.
    expect(coreCode).toMatch(/orderWorklistEntries\(\s*filtered\s*\)/);
    expect(coreCode).not.toMatch(/\bcompareWorklistEntries\b/);
  });

  it("neither artefact rolls its own sort — all ordering lives in the R38 canonical order", () => {
    expect(coreCode).not.toMatch(/\.sort\s*\(/);
    expect(runtimeCode).not.toMatch(/\.sort\s*\(/);
  });
});

// =====================================================================
// 7. NO EXECUTION PATH — neither artefact names any engine writer, runtime, or operational verb.
// =====================================================================

describe("receptionist worklist read surface — it introduces no execution path", () => {
  it("neither the runtime nor the pure core names ANY engine writer, runtime, or operational verb", () => {
    const artefacts: Array<{ path: string; text: string }> = [
      { path: RUNTIME, text: codeOf(read(RUNTIME)) },
      { path: CORE, text: codeOf(read(CORE)) },
    ];
    for (const { path, text } of artefacts) {
      for (const token of EXECUTION_TOKENS) {
        expect(text, `${path} must not name ${token} — a read surface executes nothing`).not.toMatch(token);
      }
      // The R39 non-goals as source: assignment, dispatch, notifications, scheduling, queueing, retries.
      for (const token of OPERATIONAL_TOKENS) {
        expect(text, `${path} must not name ${token} — a read surface reads, it never acts`).not.toMatch(
          token,
        );
      }
      // It queries worklists; it opens no outbound path to assign, dispatch, notify or schedule.
      expect(text, `${path} must not reach a provider`).not.toMatch(/\bfetch\s*\(/);
      expect(text, `${path} must not send`).not.toMatch(/\.send\s*\(/);
    }
  });
});
