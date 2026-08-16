import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { VERB_GROUPS, isVerb } from "@/lib/events/registry";

/**
 * HQ Event Spine — ACTIVATION invariants (Module 1 reveal; Master-Plan R3).
 *
 * The three PR migrations (producers/consumers/backfill) each ship DARK behind a
 * flag seeded FALSE, and their own invariant suites PIN that darkness against
 * their source text. This suite pins the DELIBERATE reveal — the activation
 * migration that flips those three flags ON — and, just as importantly, pins what
 * the reveal must NOT do: it must not become a second writer, weaken the
 * append-only guard, invent a verb, add an unhardened function, or open a JWT
 * grant. Activation is a data flip + a re-affirmed consumer registration, nothing
 * more.
 *
 * Like the sibling spine suites, the load-bearing checks run over `exec`
 * (executable SQL with `--` comments stripped) so the migration's prose can't
 * satisfy a positive match or trip a negative one.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

const MIG_REL = "supabase/migrations/20261159000000_hq_spine_activation.sql";
const mig = read(MIG_REL);

// Strip SQL line comments (-- … EOL) so assertions test the EXECUTABLE statements,
// not the prose that documents the reveal.
const exec = mig
  .split("\n")
  .map((line) => {
    const idx = line.indexOf("--");
    return idx === -1 ? line : line.slice(0, idx);
  })
  .join("\n");

// =====================================================================
// 0. The migration ships
// =====================================================================

describe("spine activation — migration is present", () => {
  it("the activation migration exists at the mandated prefix", () => {
    expect(existsSync(resolve(ROOT, MIG_REL))).toBe(true);
  });
});

// =====================================================================
// 1. It flips all three infra kill-switches ON — the reveal
// =====================================================================

describe("spine activation — every gate is turned ON", () => {
  it("sets dual_write_enabled true (real HQ actions begin emitting)", () => {
    expect(exec).toMatch(/'dual_write_enabled',\s*true/i);
  });

  it("sets backfill_enabled true (history replays into the spine)", () => {
    expect(exec).toMatch(/'backfill_enabled',\s*true/i);
  });

  it("sets consumer_enabled true (the drain fills the timeline projection)", () => {
    expect(exec).toMatch(/'consumer_enabled',\s*true/i);
  });

  it("never re-seeds any gate FALSE — activation only turns things on", () => {
    expect(exec).not.toMatch(/_enabled',\s*false/i);
  });

  it("writes under the non-UI `event_spine` section (still an infra switch)", () => {
    expect(exec).toMatch(/'event_spine'/);
    // The values are merged into the existing event_spine sub-object, preserving
    // any other keys (the coalesce/`||` merge), not overwriting the section.
    expect(exec).toMatch(/coalesce\(data -> 'event_spine'/i);
  });

  it("targets the hq_settings singleton (the guaranteed-present row)", () => {
    expect(exec).toMatch(/update public\.hq_settings/i);
    expect(exec).toMatch(/where id = 'singleton'/i);
  });
});

// =====================================================================
// 2. It re-affirms the timeline consumer registration, idempotently
// =====================================================================

describe("spine activation — the timeline consumer is registered at offset 0", () => {
  it("re-affirms registration through the idempotent register RPC", () => {
    // hq_consumer_register is ON CONFLICT (consumer) DO NOTHING, so this NEVER
    // rewinds an already-advanced live consumer — it only creates the row if absent.
    expect(exec).toMatch(/select public\.hq_consumer_register\('timeline',\s*0\)/i);
  });
});

// =====================================================================
// 3. It is NOT a second writer / guard-weakener — the append-only spine is safe
// =====================================================================

describe("spine activation — introduces no new write path and weakens no guard", () => {
  it("defines NO new function (no fresh SECURITY DEFINER grant surface)", () => {
    expect(exec).not.toMatch(/create (or replace )?function/i);
  });

  it("creates NO table and touches NO table DDL", () => {
    expect(exec).not.toMatch(/create table/i);
    expect(exec).not.toMatch(/alter table/i);
  });

  it("never writes hq_events directly — emission stays behind hq_emit_event", () => {
    expect(exec).not.toMatch(/insert into public\.hq_events/i);
  });

  it("never mutates the append-only log (no update/delete/truncate on hq_events)", () => {
    expect(exec).not.toMatch(/update public\.hq_events/i);
    expect(exec).not.toMatch(/delete from public\.hq_events/i);
    expect(exec).not.toMatch(/truncate[\s\S]*hq_events/i);
  });

  it("drops no trigger — the block-mutation guard is untouched", () => {
    expect(exec).not.toMatch(/drop trigger/i);
  });

  it("contains no dynamic SQL (no escalation surface)", () => {
    expect(exec).not.toMatch(/\bexecute\s+format\(/i);
    expect(exec).not.toMatch(/\bexecute\s+'/i);
  });

  it("grants nothing to a JWT role (anon / authenticated / public)", () => {
    expect(exec).not.toMatch(/\bto\s+anon\b/i);
    expect(exec).not.toMatch(/\bto\s+authenticated\b/i);
    expect(exec).not.toMatch(/grant[\s\S]*?\bto\s+public\b/i);
  });
});

// =====================================================================
// 4. It invents NO verbs — the dual-write subset is the frozen registry's own
// =====================================================================

describe("spine activation — no verb is invented; the curated subset is registered", () => {
  it("the activation migration declares no verb literals of its own", () => {
    // It only flips flags + registers a consumer; it must not carry any producer
    // mapping or verb strings (those live in the frozen producer migration).
    expect(exec).not.toMatch(/hq_emit_event\(/i);
    expect(exec).not.toMatch(/hq_emit_from_activity/i);
  });

  it("every curated OPERATIONS verb the producer dual-writes is in the frozen registry", () => {
    // The producer (20260720010000) maps exactly this curated six. Activation turns
    // that mapping ON; proving each verb is registered proves activation cannot make
    // the spine emit an unregistered verb.
    const CURATED = [
      "customer.created",
      "customer.updated",
      "job.created",
      "job.completed",
      "quote.sent",
      "quote.accepted",
    ] as const;
    for (const verb of CURATED) {
      expect(isVerb(verb), `${verb} must be a registered verb`).toBe(true);
      expect(
        (VERB_GROUPS.operations as readonly string[]).includes(verb),
        `${verb} must be in the OPERATIONS group`,
      ).toBe(true);
    }
  });

  it("the producer migration still maps ONLY to registered verbs (no drift under activation)", () => {
    // Cross-check the actual mapper text: every `then '<verb>'` target it produces
    // must be a registered verb. This fails loudly if a future edit to the producer
    // introduces a verb the registry does not know while the spine is live.
    const producer = read(
      "supabase/migrations/20260720010000_hq_event_spine_producers.sql",
    );
    const pexec = producer
      .split("\n")
      .map((line) => {
        const idx = line.indexOf("--");
        return idx === -1 ? line : line.slice(0, idx);
      })
      .join("\n");
    // Grab the verb assignment block: `v_verb := case … end;`
    const caseStart = pexec.indexOf("v_verb := case");
    expect(caseStart).toBeGreaterThanOrEqual(0);
    const caseEnd = pexec.indexOf("end;", caseStart);
    const block = pexec.slice(caseStart, caseEnd);
    const targets = [...block.matchAll(/then\s+'([a-z_]+\.[a-z_]+)'/gi)].map((m) => m[1]);
    expect(targets.length).toBeGreaterThan(0);
    for (const verb of targets) {
      expect(isVerb(verb), `producer target ${verb} must be registered`).toBe(true);
    }
  });
});
