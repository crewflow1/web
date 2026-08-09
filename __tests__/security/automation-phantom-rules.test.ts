import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import { AUTOMATION_RULES } from "@/lib/automation/rules";

/**
 * Phantom automation rules — the anti-regression drift guard (C29).
 *
 * THE CLASS OF BUG: a rule ships `enabled: true` in the built-in catalogue
 * (lib/automation/rules.ts) and the Settings → Automations page advertises it as
 * live ("Each rule runs its actions when its trigger event happens"), but NO code
 * ever calls `dispatchAutomation({ type: "<that verb>" })` from a real event — so
 * the rule can only ever fire from a manually-attached cron, never from the
 * transition it claims to watch. Four verbs were in exactly this state:
 * job.completed, import.completed, demo.booked, onboarding.completed.
 *
 * THE FIX (per verb, the honest split):
 *   - job.completed        → WIRED at the jobs status→completed transition.
 *   - import.completed     → WIRED at the import commit (status→committed).
 *   - onboarding.completed → WIRED at markCompleted (setup hits 100%).
 *   - demo.booked          → HONEST-DISABLED (enabled:false): a demo is booked
 *     into `demo_requests`, a global HQ table with NO tenant org_id at booking
 *     time, and the automation OS is fundamentally org-scoped — there is no
 *     owning org to attribute the event to, so it cannot fire honestly.
 *
 * THE GUARD: mirrors the outbound-webhooks drift guard
 * (__tests__/security/outbound-webhooks.test.ts §5, "every exposable verb has a
 * REAL producer"). A source sweep builds the set of verbs that actually have a
 * literal `dispatchAutomation({ type: "<verb>" })` producer, then asserts every
 * rule shipped `enabled:true` is backed by one. If anyone re-enables a
 * producer-less rule — or adds an enabled rule for a new verb without wiring its
 * producer — this fails CI, so the phantom class can never regress.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

/** Strip block + line comments so a doc-comment example (e.g. the dispatcher's
 *  own `dispatchAutomation({type:"quote.accepted"...})` docstring) is never
 *  mistaken for a real producer call. */
const codeOf = (ts: string) =>
  ts.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

/** Recursively collect .ts/.tsx source files under a directory. */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (name === "node_modules" || name === "__tests__") continue;
      out.push(...walk(full));
    } else if (/\.tsx?$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * The source-of-truth producer set: every verb dispatched via a LITERAL
 * `dispatchAutomation({ ... type: "<verb>" ... })` somewhere in the app/lib/server
 * tree. The schedule drain (server/services/automation-schedules.ts) dispatches
 * `type: rule.trigger` — a DYNAMIC value, deliberately not a literal — so it is
 * NOT counted as a producer: the drain is the manual-cron path, not the real
 * event that a rule claims to watch. That exclusion is the whole point.
 */
function collectProducedVerbs(): Set<string> {
  const produced = new Set<string>();
  for (const { verb } of collectProducerSites()) produced.add(verb);
  return produced;
}

/**
 * The richer sweep: every LITERAL `dispatchAutomation({ type, ..., source_table })`
 * site, as a {verb, source_table} pair. Used by the wrong-transition-alias guard
 * below — it is not enough that a verb is produced SOMEWHERE (the C29 guard); it
 * must be produced from the source_table that matches the verb's semantic entity.
 * A lead firing `support.ticket.created` (source_table:"leads") passed the plain
 * verb sweep but is a mis-wired alias, and this catches it.
 */
function collectProducerSites(): Array<{ verb: string; source_table: string | null }> {
  const sites: Array<{ verb: string; source_table: string | null }> = [];
  const files = ["app", "lib", "server"].flatMap((d) => walk(resolve(ROOT, d)));
  for (const file of files) {
    const src = codeOf(readFileSync(file, "utf8"));
    let idx = src.indexOf("dispatchAutomation(");
    while (idx !== -1) {
      // Look at the window immediately after the call opens; every producer in
      // this codebase puts `type:` as the first field of the event object.
      const window = src.slice(idx, idx + 300);
      const m = /dispatchAutomation\(\s*\{\s*type:\s*"([a-z][a-z.]*)"/.exec(window);
      if (m) {
        const st = /source_table:\s*"([a-z_]+)"/.exec(window);
        sites.push({ verb: m[1]!, source_table: st ? st[1]! : null });
      }
      idx = src.indexOf("dispatchAutomation(", idx + 1);
    }
  }
  return sites;
}

/** verb → the set of source_tables it is literally dispatched with. */
function collectProducedVerbSources(): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const { verb, source_table } of collectProducerSites()) {
    if (!source_table) continue;
    if (!map.has(verb)) map.set(verb, new Set());
    map.get(verb)!.add(source_table);
  }
  return map;
}

/**
 * The semantic entity each enabled trigger verb MUST be dispatched from. This is
 * the honest producer→consumer contract: the "Support ticket opened" rule may
 * only be advertised as live if a REAL support ticket (source_table
 * "support_tickets") fires it — not a lead, not a quote. Add a row here when a
 * new enabled rule lands; a verb absent from this map is not checked (opt-in /
 * disabled verbs like payment.recorded intentionally have multiple sources).
 */
const EXPECTED_SOURCE_TABLE: Record<string, string> = {
  "quote.accepted": "quotes",
  "invoice.overdue": "invoices",
  "job.completed": "jobs",
  "import.completed": "imports",
  "onboarding.completed": "organizations",
  "support.ticket.created": "support_tickets",
};

// ===========================================================================
// 1. The core drift guard
// ===========================================================================

describe("automation catalogue — no enabled-but-producer-less rule (phantom guard)", () => {
  const produced = collectProducedVerbs();

  it("sees the known-good producers (a broken sweep can't pass by finding nothing)", () => {
    // Sanity floor: the sweep must find the established literal producers.
    for (const verb of [
      "quote.accepted",
      "payment.recorded",
      "invoice.overdue",
      "support.ticket.created",
    ]) {
      expect(produced.has(verb), `${verb} producer not found by the sweep`).toBe(true);
    }
    expect(produced.size).toBeGreaterThanOrEqual(4);
  });

  it("every rule shipped enabled:true has a REAL dispatchAutomation producer", () => {
    const enabled = AUTOMATION_RULES.filter((r) => r.enabled);
    expect(enabled.length).toBeGreaterThan(0);
    for (const rule of enabled) {
      expect(
        produced.has(rule.trigger),
        `Rule "${rule.id}" ships enabled:true on trigger "${rule.trigger}" but NO code ` +
          `dispatches it — this is a phantom rule. Either wire a dispatchAutomation ` +
          `producer at the real transition, or ship it enabled:false (see the ` +
          `demo_booked_notify_hq annotation in lib/automation/rules.ts).`,
      ).toBe(true);
    }
  });

  it("every enabled rule's verb is produced from the source_table that MATCHES its entity (no wrong-transition alias)", () => {
    // The C30 class: a rule ships enabled:true and its verb IS produced somewhere
    // (so the plain phantom guard is green), but from the WRONG entity — e.g. a
    // lead dispatching `support.ticket.created` (source_table "leads"). The
    // "Support ticket opened" rule then fires on lead creation and never on a
    // real ticket. This asserts producer↔consumer honesty by source_table.
    const bySource = collectProducedVerbSources();
    for (const rule of AUTOMATION_RULES.filter((r) => r.enabled)) {
      const expected = EXPECTED_SOURCE_TABLE[rule.trigger];
      if (!expected) continue; // not an entity-pinned verb; covered by other guards
      const sources = bySource.get(rule.trigger) ?? new Set<string>();
      expect(
        sources.has(expected),
        `Rule "${rule.id}" (enabled) triggers on "${rule.trigger}", which must be ` +
          `dispatched with source_table "${expected}" (its real entity) but the only ` +
          `producer source_table(s) found are [${[...sources].join(", ") || "none"}]. ` +
          `A verb produced from the wrong entity is a mis-wired alias: the rule fires ` +
          `on the wrong transition and never on the one it advertises. Wire a ` +
          `dispatchAutomation producer at the real transition with the correct ` +
          `source_table (see app/(app)/support/actions.ts createSupportTicket).`,
      ).toBe(true);
    }
  });

  it("the four originally-phantom verbs are each resolved (wired OR disabled), never advertised-but-silent", () => {
    const PHANTOMS = [
      "job.completed",
      "import.completed",
      "demo.booked",
      "onboarding.completed",
    ] as const;
    for (const verb of PHANTOMS) {
      const enabledRulesForVerb = AUTOMATION_RULES.filter(
        (r) => r.trigger === verb && r.enabled,
      );
      // A verb may be advertised (enabled) ONLY if it now has a real producer.
      if (enabledRulesForVerb.length > 0) {
        expect(
          produced.has(verb),
          `${verb} has an enabled rule but no producer`,
        ).toBe(true);
      }
    }
  });
});

// ===========================================================================
// 2. The C29 split, pinned explicitly (documents intent + guards each site)
// ===========================================================================

describe("C29 wiring — the three verbs that gained a real producer", () => {
  const sites: Array<{
    verb: string;
    ruleId: string;
    path: string;
    source_table: string;
    org: string;
  }> = [
    {
      verb: "job.completed",
      ruleId: "job_completed_suggest_invoice",
      path: "app/(app)/jobs/actions.ts",
      source_table: '"jobs"',
      org: "ctx.org.id",
    },
    {
      verb: "import.completed",
      ruleId: "import_completed_notify",
      path: "app/(app)/imports/actions.ts",
      source_table: '"imports"',
      org: "ctx.org.id",
    },
    {
      verb: "onboarding.completed",
      ruleId: "onboarding_completed_notify",
      path: "app/(app)/onboarding/setup/actions.ts",
      source_table: '"organizations"',
      org: "ctx.org.id",
    },
  ];

  for (const site of sites) {
    describe(`${site.verb} @ ${site.path}`, () => {
      const src = read(site.path);

      it("imports and calls dispatchAutomation", () => {
        expect(src).toMatch(
          /import \{ dispatchAutomation \} from "@\/server\/services\/automation-dispatcher"/,
        );
        expect(src).toMatch(/dispatchAutomation\(\{/);
      });

      it(`dispatches type "${site.verb}"`, () => {
        expect(src).toMatch(new RegExp(`type: "${site.verb.replace(/\./g, "\\.")}"`));
      });

      it("is org-pinned (org_id passed, never blended)", () => {
        expect(src).toMatch(new RegExp(`org_id: ${site.org.replace(/\./g, "\\.")}`));
      });

      it("uses the expected source_table", () => {
        expect(src).toMatch(
          new RegExp(`source_table: ${site.source_table.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
        );
      });

      it("is best-effort — a dispatch failure never derails the flow", () => {
        expect(src).toMatch(/dispatchAutomation\([\s\S]*?\}\)\.catch\(\(e\) =>/);
      });

      it("the rule it activates exists, targets the verb, and ships enabled:true", () => {
        const rule = AUTOMATION_RULES.find((r) => r.id === site.ruleId);
        expect(rule, `${site.ruleId} must exist`).toBeTruthy();
        expect(rule?.trigger).toBe(site.verb);
        expect(rule?.enabled).toBe(true);
      });
    });
  }
});

describe("C29 honest-disable — demo.booked stays off until a real producer exists", () => {
  it("demo_booked_notify_hq ships enabled:false (producer-less on the org-scoped engine)", () => {
    const rule = AUTOMATION_RULES.find((r) => r.id === "demo_booked_notify_hq");
    expect(rule, "demo_booked_notify_hq must exist").toBeTruthy();
    expect(rule?.trigger).toBe("demo.booked");
    // The load-bearing assertion: re-enabling this without wiring a producer will
    // ALSO trip the core guard above, but pin it here so the intent is explicit.
    expect(rule?.enabled).toBe(false);
  });

  it("no code dispatches demo.booked (confirming the honest-disable, not an oversight)", () => {
    const produced = collectProducedVerbs();
    expect(produced.has("demo.booked")).toBe(false);
  });
});

// ===========================================================================
// 3. Producer coverage across ALL write paths — the shape-class guard (C56)
// ===========================================================================

/**
 * Slice a source file into its top-level exported function bodies, keyed by
 * function name. The plain verb sweep (§1) proves a verb is produced SOMEWHERE;
 * this lets the all-paths guard prove a producer fires INSIDE a specific action
 * (e.g. acceptQuoteByToken) and not merely somewhere in a file that ALSO holds
 * acceptQuoteAsOwner.
 */
function exportedFunctionBodies(src: string): Map<string, string> {
  const bodies = new Map<string, string>();
  const re = /export\s+(?:async\s+)?function\s+([A-Za-z0-9_]+)\s*\(/g;
  const starts: Array<{ name: string; idx: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) starts.push({ name: m[1]!, idx: m.index });
  for (let i = 0; i < starts.length; i++) {
    const from = starts[i]!.idx;
    const to = i + 1 < starts.length ? starts[i + 1]!.idx : src.length;
    bodies.set(starts[i]!.name, src.slice(from, to));
  }
  return bodies;
}

/**
 * THE C56 CLASS (generalises C55): a status-transition / creation automation verb
 * whose producer exists on only SOME of the write paths that reach its triggering
 * state. Three real instances, all customer-facing and all silently dead before
 * this fix:
 *
 *   - quote.accepted        → wired on the OPERATOR paths (acceptQuoteAsOwner,
 *     signatures.recordSignature) but MISSING from the PRIMARY customer path
 *     acceptQuoteByToken (reached from the emailed /q/[token] portal link). A
 *     customer accepting via the portal notified the owner NEVER.
 *   - support.ticket.created → wired only on operator createSupportTicket; MISSING
 *     from the two portal ticket-creators sendPortalMessage (portal message) and
 *     requestProfileUpdate (portal profile-update request).
 *
 * The C55 guard was ITSELF incomplete: it only checked operator create-vs-update
 * for job.completed and EXPLICITLY excluded quote.accepted ("only reached by … the
 * portal accept") and support.ticket.created ("symmetric by definition") — the
 * exact two verbs that were broken on the portal. This rewrite drops those false
 * premises.
 *
 * THE GUARD SHAPE — for each enabled entity-pinned verb we declare its TRIGGERING
 * WRITE as a source-shape detector (a status literal written to the entity, OR an
 * INSERT of the entity), NOT a specific helper call. That is what makes it
 * resilient to the raw-admin bypass: acceptQuoteByToken writes the signature via a
 * raw `admin.from("signatures").insert()` rather than recordSignature, but it is
 * detected on its `status:"accepted"` write to quotes, so the bypass cannot hide
 * it. Two assertions per verb:
 *
 *   (a) PER-FUNCTION COVERAGE — across the enumerated write-path modules (operator
 *       actions + token/public-portal actions + service-role helpers), EVERY
 *       exported function whose body performs the triggering write MUST dispatch
 *       the verb, unless it is allowlisted with a documented reason.
 *   (b) TREE-WIDE CONTAINMENT (the recurrence backstop) — a scan of the whole
 *       app/lib/server tree must find NO file performing the triggering write that
 *       is not in the enumerated module set. A brand-new file introducing the
 *       write (the next portal/token bypass) therefore fails CI with a message
 *       telling the author to enumerate it here, so this residual class cannot
 *       recur even though static enumeration of "all write paths" is imperfect.
 *
 * LIMITATION (documented, per the mandate): detection is source-shape heuristic,
 * not a type-checked dataflow. `setsStatusLiteral` keys on a `status:"<x>"` object
 * property scoped to a `from("<table>")` reference in the same function. The
 * VARIABLE-status shape (`status: result.data.status` gated on
 * `=== "completed"`) — which the jobs producers use and which made the old
 * literal-only job.completed detector VACUOUS — is now handled by
 * `setsJobStatusCompleted`; but a status transition written by a still-unusual
 * shape (a SECURITY DEFINER RPC that flips the status server-side) would not be
 * seen. That is why (b) exists: it pins the FILE SET, so any new write-path file
 * is forced through (a). The enumerated `files` list is the authority — add a row
 * when a new write path for one of these entities lands. Detectors must be kept
 * NON-VACUOUS: a detector that matches zero real producers protects nothing (the
 * exact latent gap this guard was rewritten to close), so §3.5 below pins each
 * known producer directly.
 */

/** True when `body` writes `status:"<status>"` as an object property AND
 *  references `from("<table>")` — i.e. it sets that entity to that status.
 *  Distinguishes a WRITE (`status: "accepted"`) from a COMPARISON
 *  (`existing?.status === "accepted"`), and from a same-named status on an
 *  unrelated table (service helpers that `return { status: "accepted" }` never
 *  reference `from("quotes")`, so they are not matched). */
function setsStatusLiteral(body: string, table: string, status: string): boolean {
  const hasStatusWrite = new RegExp(`status:\\s*"${status}"`).test(body);
  const touchesTable = new RegExp(`from\\(\\s*"${table}"`).test(body);
  return hasStatusWrite && touchesTable;
}

/** True when `body` performs an INSERT whose target table is `<table>`. For each
 *  `.insert(` we resolve the NEAREST preceding `from("<x>")` — so a function that
 *  reads `from("support_tickets").select()` and then `from("support_messages")
 *  .insert()` (a reply) is NOT counted as inserting a ticket. Handles the inline
 *  `from(...) as unknown as {…}).insert(` type-cast shape both portal creators use,
 *  because the cast contains no intervening `from(`. */
function insertsIntoTable(body: string, table: string): boolean {
  const insertRe = /\.insert\(/g;
  let m: RegExpExecArray | null;
  while ((m = insertRe.exec(body))) {
    const before = body.slice(0, m.index);
    const lastFrom = before.lastIndexOf("from(");
    if (lastFrom === -1) continue;
    const fm = /from\(\s*"([a-z_]+)"/.exec(before.slice(lastFrom, lastFrom + 80));
    if (fm && fm[1] === table) return true;
  }
  return false;
}

/** True when `body` sets `<table>`'s status column to a VARIABLE (not a string
 *  literal) via an insert/update — the shape the jobs producers use. For each
 *  `.insert(`/`.update(` we resolve the NEAREST preceding `from("<x>")` (same
 *  discipline as insertsIntoTable), require it to be `<table>`, then require a
 *  `status: <identifier>` object property (e.g. `status: result.data.status`) in
 *  the write object that follows. A comparison (`status === "…"`) has no colon
 *  and is never matched; a literal (`status:"…"`) is handled by the caller's own
 *  literal branch, not here. */
function writesVarStatusToTable(body: string, table: string): boolean {
  const opRe = /\.(?:insert|update)\(/g;
  let m: RegExpExecArray | null;
  while ((m = opRe.exec(body))) {
    const before = body.slice(0, m.index);
    const lastFrom = before.lastIndexOf("from(");
    if (lastFrom === -1) continue;
    const fm = /from\(\s*"([a-z_]+)"/.exec(before.slice(lastFrom, lastFrom + 80));
    if (!fm || fm[1] !== table) continue;
    const after = body.slice(m.index, m.index + 800);
    if (/status:\s*[A-Za-z_$][\w$.]*/.test(after)) return true;
  }
  return false;
}

/**
 * True when `body` transitions a jobs row to "completed".
 *
 * THE C56-vacuity fix. The original job.completed detector was
 * `setsStatusLiteral(body,"jobs","completed")`, which requires the literal regex
 * `status:"completed"` in the body. But BOTH real producers write the status via
 * a VALIDATED VARIABLE, never a literal:
 *
 *   createJob  → `.from("jobs").insert({ … status: result.data.status … })`
 *                dispatched inside `if (result.data.status === "completed")`
 *   updateJob  → `.from("jobs").update({ … status: result.data.status … })`
 *                dispatched inside `if (result.data.status === "completed")`
 *
 * So `status:"completed"` appeared NOWHERE and the detector matched ZERO
 * functions — making both C56 assertions (a) per-function coverage and (b)
 * tree-wide containment silently vacuous for the flagship producer-coverage
 * verb. Live behaviour was correct (both paths dispatch), so this was a latent
 * guard-integrity gap, not a live defect — but the guard protected nothing.
 *
 * This detector keys on the WRITE INTENT instead: a `from("jobs")` reference,
 * plus EITHER a future-proof literal `status:"completed"` write OR the real
 * producer shape — a validated-variable status write into jobs
 * (writesVarStatusToTable) gated on `status === "completed"`. It matches exactly
 * createJob + updateJob and no read/aggregate (e.g. lib/reports/aggregates.ts
 * `jobsPerWeek`, which only `.select`s and compares `j.status === "completed"`
 * with no status-column write, is correctly NOT matched).
 *
 * IMPORT/COMMIT-PATH EXCLUSION (deliberate): the CSV import commit
 * (app/(app)/imports/actions.ts) can write a jobs row with an arbitrary status —
 * including "completed" — via the non-exported `insertOne` helper
 * (`.from("jobs").insert({ … status: (mapped.status as string) ?? "new" … })`).
 * It is a BULK MIGRATION path and fires ONE `import.completed` for the session,
 * NOT a per-row `job.completed` (mirroring the schedule-drain exclusion). It is
 * excluded here three ways: it is not an exported function (so the per-function
 * sweep never sees it), it carries no `status === "completed"` gate, and its
 * status value `(mapped.status …)` begins with `(` so `status:\s*[A-Za-z_$]`
 * does not match it. If a future refactor ever surfaces it as a matched write
 * path, add it to the job.completed `allow` map with this exclusion reason —
 * do NOT wire a per-row dispatch onto the import path.
 */
function setsJobStatusCompleted(body: string): boolean {
  if (!/from\(\s*"jobs"/.test(body)) return false;
  if (/status:\s*"completed"/.test(body)) return true; // future-proof literal write
  const completedGate = /status\s*===\s*["']completed["']/.test(body);
  return completedGate && writesVarStatusToTable(body, "jobs");
}

type WritePathClass = {
  verb: string;
  /** Human description of the triggering write, for failure messages. */
  write: string;
  /** Source-shape detector run on each function body AND on whole files. */
  detect: (body: string) => boolean;
  /**
   * Every module that holds a write path for this entity — operator actions,
   * token/public-portal actions (app/q, app/customer-portal) and service-role
   * helpers. This is the enumerated authority; the tree-wide backstop refuses any
   * write-performing file NOT listed here.
   */
  files: string[];
  /** Functions that perform the write but legitimately DON'T dispatch, each with a
   *  specific documented reason (e.g. a genuinely internal-only path). */
  allow: Record<string, string>;
};

const WRITE_PATH_CLASSES: WritePathClass[] = [
  {
    verb: "quote.accepted",
    write: 'a quotes row written to status:"accepted"',
    detect: (b) => setsStatusLiteral(b, "quotes", "accepted"),
    files: [
      // operator: acceptQuoteAsOwner + the token/public-portal helper
      // acceptQuoteByToken (which also holds the raw admin signature-insert
      // bypass — detected on its status write, not the helper it skips).
      "app/(app)/quotes/actions.ts",
      // service-role e-sign path (recordSignature) — a producer, though it does
      // not itself write the quote status, so it is scanned here for completeness.
      "server/services/signatures.ts",
    ],
    allow: {},
  },
  {
    verb: "support.ticket.created",
    write: "an INSERT into support_tickets",
    detect: (b) => insertsIntoTable(b, "support_tickets"),
    files: [
      // operator create path.
      "app/(app)/support/actions.ts",
      // portal ticket creators — the two that were silently missing the producer.
      "app/customer-portal/_message-action.ts",
      "app/customer-portal/_preferences-action.ts",
    ],
    allow: {},
  },
  {
    verb: "job.completed",
    // The producers write the status via a VALIDATED VARIABLE
    // (`status: result.data.status`) gated on `=== "completed"`, never a literal
    // `status:"completed"` — see setsJobStatusCompleted for why the old
    // literal-only detector was vacuous here.
    write: 'a jobs row transitioned to "completed" (validated-variable status write, gated)',
    detect: setsJobStatusCompleted,
    files: [
      // operator create + update (the original C55 both-path site). The CSV
      // import commit path (app/(app)/imports/actions.ts) ALSO writes jobs.status
      // but is a bulk-migration path deliberately excluded — it fires one
      // import.completed per session, not per-row job.completed. It is not caught
      // by the detector (non-exported insertOne, no completed-gate, `status: (…`);
      // see setsJobStatusCompleted's IMPORT/COMMIT-PATH EXCLUSION note.
      "app/(app)/jobs/actions.ts",
    ],
    allow: {},
  },
];

/**
 * Whole-tree scan: files under app/lib/server that hold a FUNCTION whose body
 * performs `detect`. Granularity matches assertion (a) — per exported-function
 * body, not per whole file — so a file where `status:"completed"` lives in a
 * completeJobDocument() writing `job_documents` while a DIFFERENT function merely
 * reads `from("jobs")` is NOT falsely flagged as a jobs-completion write path.
 */
function filesPerformingWrite(detect: (b: string) => boolean): string[] {
  const files = ["app", "lib", "server"].flatMap((d) => walk(resolve(ROOT, d)));
  const hits: string[] = [];
  for (const file of files) {
    const bodies = exportedFunctionBodies(codeOf(readFileSync(file, "utf8")));
    for (const body of bodies.values()) {
      if (detect(body)) {
        hits.push(file.slice(ROOT.length + 1));
        break;
      }
    }
  }
  return hits;
}

describe("producer coverage — EVERY write path that reaches a verb's trigger dispatches it (C56 shape-class guard)", () => {
  for (const cls of WRITE_PATH_CLASSES) {
    const verbLiteral = new RegExp(`type:\\s*"${cls.verb.replace(/\./g, "\\.")}"`);

    describe(`${cls.verb} — ${cls.write}`, () => {
      it("(a) every enumerated write path dispatches the verb (or is allowlisted)", () => {
        const offenders: string[] = [];
        for (const file of cls.files) {
          const bodies = exportedFunctionBodies(codeOf(read(file)));
          for (const [fn, body] of bodies) {
            if (!cls.detect(body)) continue; // not a triggering write path
            if (cls.allow[fn]) continue; // documented internal-only exemption
            if (!verbLiteral.test(body)) {
              offenders.push(`${fn} @ ${file}`);
            }
          }
        }
        expect(
          offenders.length,
          `These write paths perform ${cls.write} but never dispatch ` +
            `"${cls.verb}", so the enabled rule watching that trigger is silently ` +
            `dead on them:\n  ${offenders.join("\n  ")}\n` +
            `Add a best-effort, correlation-id-idempotent dispatchAutomation(` +
            `{ type: "${cls.verb}", … }) on each (mirror the operator path), or ` +
            `allowlist it in WRITE_PATH_CLASSES with a documented reason.`,
        ).toBe(0);
      });

      it("(b) no write path exists OUTSIDE the enumerated module set (recurrence backstop)", () => {
        const known = new Set(cls.files);
        const stray = filesPerformingWrite(cls.detect).filter((f) => !known.has(f));
        expect(
          stray.length,
          `These files perform ${cls.write} but are NOT enumerated in ` +
            `WRITE_PATH_CLASSES["${cls.verb}"].files, so assertion (a) never ` +
            `checked whether they dispatch "${cls.verb}" — the exact way the ` +
            `portal bypass recurred:\n  ${stray.join("\n  ")}\n` +
            `Add each to the files list so its per-function dispatch coverage is ` +
            `enforced.`,
        ).toBe(0);
      });
    });
  }
});

// ===========================================================================
// 3.5 Direct per-function producer pins — non-vacuous by construction (C57)
// ===========================================================================

/**
 * THE C57 CLASS (guard-integrity): a shape-class detector (§3) can silently go
 * VACUOUS — match ZERO real producers — if the code writes a shape the detector
 * doesn't recognise. That happened to job.completed: the producers write
 * `status: result.data.status` (a validated VARIABLE) while the detector required
 * a literal `status:"completed"`, so `cls.detect` matched nothing, `offenders`
 * was always 0, `filesPerformingWrite` returned nothing, and BOTH §3 assertions
 * passed green while protecting nothing. Deleting createJob's dispatch (the exact
 * C55 regression) still left CI green.
 *
 * This block is the backstop against that failure mode. For each KNOWN producer
 * we assert TWO things DIRECTLY, without going through the heuristic gate:
 *
 *   1. the function body literally dispatches `type: "<verb>"` — so deleting ANY
 *      known producer's dispatch fails CI immediately (red-if-regressed), even
 *      when a file-level `toMatch` would still find another producer's literal;
 *   2. the class detector RECOGNISES this producer's body — so if a future edit
 *      changes the write shape out from under the detector (re-introducing the
 *      vacuity), THIS fails, forcing the detector to be fixed rather than the
 *      guard quietly falling asleep.
 *
 * Enumerate every producer here when one lands. This is the authority that keeps
 * §3 honest.
 */
type ProducerSite = { verb: string; file: string; fn: string };
const PRODUCER_SITES: ProducerSite[] = [
  // job.completed — the two originally-vacuous producers (variable status write).
  { verb: "job.completed", file: "app/(app)/jobs/actions.ts", fn: "createJob" },
  { verb: "job.completed", file: "app/(app)/jobs/actions.ts", fn: "updateJob" },
  // quote.accepted — operator + primary customer-portal token path.
  { verb: "quote.accepted", file: "app/(app)/quotes/actions.ts", fn: "acceptQuoteAsOwner" },
  { verb: "quote.accepted", file: "app/(app)/quotes/actions.ts", fn: "acceptQuoteByToken" },
  // support.ticket.created — operator create + both portal ticket-creators.
  { verb: "support.ticket.created", file: "app/(app)/support/actions.ts", fn: "createSupportTicket" },
  { verb: "support.ticket.created", file: "app/customer-portal/_message-action.ts", fn: "sendPortalMessage" },
  { verb: "support.ticket.created", file: "app/customer-portal/_preferences-action.ts", fn: "requestProfileUpdate" },
];

describe("producer coverage — direct per-function producer pins (C57 non-vacuity backstop)", () => {
  for (const site of PRODUCER_SITES) {
    const cls = WRITE_PATH_CLASSES.find((c) => c.verb === site.verb);
    const verbLiteral = new RegExp(`type:\\s*"${site.verb.replace(/\./g, "\\.")}"`);

    describe(`${site.verb} @ ${site.fn}`, () => {
      const bodies = exportedFunctionBodies(codeOf(read(site.file)));
      const body = bodies.get(site.fn);

      it("the producer function exists", () => {
        expect(
          body,
          `${site.fn} not found in ${site.file} — a known ${site.verb} producer ` +
            `was renamed or removed. Update PRODUCER_SITES (and any dispatch).`,
        ).toBeTruthy();
      });

      it(`dispatches type "${site.verb}" (red if this producer's dispatch is deleted)`, () => {
        expect(
          verbLiteral.test(body ?? ""),
          `${site.fn} @ ${site.file} no longer dispatches "${site.verb}". This is a ` +
            `known producer — deleting its dispatchAutomation call silently kills the ` +
            `enabled rule on this path. Restore the best-effort, correlation-id-` +
            `idempotent dispatchAutomation({ type: "${site.verb}", … }).`,
        ).toBe(true);
      });

      it("is recognised by its class detector (guards against the detector going vacuous)", () => {
        expect(cls, `no WRITE_PATH_CLASSES entry for ${site.verb}`).toBeTruthy();
        expect(
          cls!.detect(body ?? ""),
          `The ${site.verb} detector does NOT recognise known producer ${site.fn} — ` +
            `the detector has gone vacuous for this shape (the C56 job.completed ` +
            `latent gap). Fix the detector to match the real write shape; do NOT ` +
            `weaken this assertion.`,
        ).toBe(true);
      });
    });
  }
});
