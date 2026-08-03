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
