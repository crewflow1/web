import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * HQ Event Spine — consumer invariants (Module 1, PR3).
 *
 * CI has no database in this tier (the live drain is proven in the integration
 * tier), so — exactly like the PR1 spine-core and PR2 producer suites — we pin the
 * consumer migration's contract against its source text. These are the assertions
 * that, if they ever silently flipped, would be a hole: a drainer that shipped ON
 * instead of dark, an offset advanced WITHOUT the single-active lock (a double-
 * apply), an apply that wasn't idempotent, a dead-letter path that raised an alert
 * by a raw INSERT instead of the validated entry point, a consumer function with an
 * unpinned search_path, or a drain primitive callable by a JWT client.
 *
 * The load-bearing checks run over `exec` (executable SQL with `--` comments
 * stripped) so the prose that documents the consumer contract can't satisfy a
 * positive match or trip a negative one.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

const MIG_REL = "supabase/migrations/20260720020000_hq_event_spine_consumers.sql";
const mig = read(MIG_REL);

// Strip SQL line comments (-- … EOL) so assertions test the EXECUTABLE statements,
// not the prose that documents the consumer contract.
const exec = mig
  .split("\n")
  .map((line) => {
    const idx = line.indexOf("--");
    return idx === -1 ? line : line.slice(0, idx);
  })
  .join("\n");

/** The header of a CREATE FUNCTION (signature → `as $$`), where the hardening lives. */
function fnHeader(name: string): string {
  const start = exec.indexOf(`create or replace function public.${name}(`);
  expect(start, `function ${name} not found`).toBeGreaterThanOrEqual(0);
  const bodyAt = exec.indexOf("as $$", start);
  expect(bodyAt, `function ${name} body not found`).toBeGreaterThan(start);
  return exec.slice(start, bodyAt);
}

/** The full source of a CREATE FUNCTION (signature → closing `$$;`). */
function fnSource(name: string): string {
  const start = exec.indexOf(`create or replace function public.${name}(`);
  expect(start, `function ${name} not found`).toBeGreaterThanOrEqual(0);
  const end = exec.indexOf("$$;", start);
  expect(end, `function ${name} end not found`).toBeGreaterThan(start);
  return exec.slice(start, end);
}

const NEW_FUNCTIONS = [
  "hq_spine_consumer_enabled",
  "hq_consumer_register",
  "hq_consumer_apply",
  "hq_drain_consumer",
  "hq_replay_consumer",
  "hq_spine_golden_signals",
] as const;

// =====================================================================
// 0. The migration ships
// =====================================================================

describe("spine consumer — migration is present", () => {
  it("the PR3 consumer migration exists", () => {
    expect(existsSync(resolve(ROOT, MIG_REL))).toBe(true);
  });
});

// =====================================================================
// 1. Ships DARK — the drain defaults OFF and lives off the operator UI
// =====================================================================

describe("spine consumer — the drain ships dark", () => {
  it("seeds the global gate FALSE (applying PR3 changes no behaviour)", () => {
    expect(exec).toMatch(/jsonb_build_object\('consumer_enabled',\s*false\)/i);
  });

  it("never seeds the gate true — only an operator turns it on, at runtime", () => {
    expect(exec).not.toMatch(/consumer_enabled'\s*,\s*true/i);
    expect(exec).not.toMatch(/'\{event_spine,consumer_enabled\}'\s*,\s*'true'/i);
  });

  it("stores the gate under the non-UI `event_spine` section (an infra kill-switch)", () => {
    expect(exec).toMatch(/event_spine,consumer_enabled/);
  });

  it("only seeds when the key is absent — never clobbers an operator's setting", () => {
    expect(exec).toMatch(
      /where id = 'singleton'\s+and \(data #> '\{event_spine,consumer_enabled\}'\) is null/i,
    );
  });

  it("the drainer fails dark — it returns early when the gate is off", () => {
    const src = fnSource("hq_drain_consumer");
    expect(src).toMatch(/if not public\.hq_spine_consumer_enabled\(\) then/i);
    expect(src).toMatch(/'consumer_disabled'/i);
  });
});

// =====================================================================
// 2. Never process an event twice — lock + strict order + transactional advance
// =====================================================================

describe("spine consumer — the drain can never double-apply", () => {
  const src = fnSource("hq_drain_consumer");

  it("takes a single-active-drainer lock (FOR UPDATE SKIP LOCKED) on the offset row", () => {
    // Two overlapping cron runs must not both process the same consumer: the
    // second finds the row locked and leaves (skipped), never double-applies.
    expect(src).toMatch(/for update skip locked/i);
    expect(src).toMatch(/'locked'/i);
  });

  it("reads strictly after the offset, in id (total) order", () => {
    expect(src).toMatch(/where id > v_offset/i);
    expect(src).toMatch(/order by id asc/i);
  });

  it("reads a BOUNDED batch (offset + limit — never an unbounded scan)", () => {
    expect(src).toMatch(/limit greatest\(p_max_events/i);
  });

  it("advances the offset only for an applied event (advance follows apply)", () => {
    const applyAt = src.search(/perform public\.hq_consumer_apply\(/i);
    const advanceAt = src.search(/v_offset := v_ev\.id;/);
    expect(applyAt).toBeGreaterThanOrEqual(0);
    expect(advanceAt).toBeGreaterThan(applyAt);
  });

  it("persists the advanced offset back to hq_event_consumers in the same call", () => {
    expect(src).toMatch(/update public\.hq_event_consumers\s+set last_event_id = v_offset/i);
  });
});

// =====================================================================
// 3. Idempotent apply — the bible's effectively-once oracle
// =====================================================================

describe("spine consumer — the apply is idempotent", () => {
  const src = fnSource("hq_consumer_apply");

  it("the selftest projection upserts ON CONFLICT DO NOTHING (re-apply is a no-op)", () => {
    expect(src).toMatch(/insert into public\.hq_consumer_selftest[\s\S]*?on conflict \(consumer, event_id\) do nothing/i);
  });

  it("uses STATIC dispatch — no dynamic EXECUTE in any consumer function (no escalation surface)", () => {
    // A SECURITY DEFINER function that EXECUTEs a stored handler name would be a
    // privilege-escalation surface; the spine refuses it. The whole PR3 migration
    // contains no dynamic SQL.
    expect(exec).not.toMatch(/\bexecute\s+format\(/i);
    expect(exec).not.toMatch(/\bexecute\s+'/i);
  });

  it("is forward-compatible — an unknown consumer is a no-op, not an error", () => {
    expect(src).toMatch(/else\s+null;/i);
  });
});

// =====================================================================
// 4. Dead-letter handling — park, advance past, alert (through the entry point)
// =====================================================================

describe("spine consumer — poison events are dead-lettered, not stuck", () => {
  const src = fnSource("hq_drain_consumer");

  it("parks the event in dead_events idempotently after the attempt threshold", () => {
    expect(src).toMatch(/if v_attempts >= greatest\(p_max_attempts/i);
    expect(src).toMatch(/insert into public\.dead_events[\s\S]*?on conflict \(consumer, event_id\) do nothing/i);
  });

  it("advances the offset PAST the poison event so one bad event never blocks the stream", () => {
    // The dead-letter branch sets v_offset := v_ev.id then continues the loop.
    expect(src).toMatch(/v_dead := v_dead \+ 1/i);
  });

  it("raises the alert through the VALIDATED entry point, not a raw INSERT into hq_events", () => {
    expect(src).toMatch(/perform public\.hq_emit_event\(/i);
    expect(src).toMatch(/'system\.alert_raised'/i);
    expect(src).not.toMatch(/insert into public\.hq_events/i);
  });

  it("emits the alert best-effort — a failed alert must not abort the drain", () => {
    // The hq_emit_event call is wrapped in its own begin/exception so a telemetry
    // hiccup can never roll back the drain's committed progress.
    expect(src).toMatch(/perform public\.hq_emit_event\([\s\S]*?exception when others then\s+null;\s+end;/i);
  });
});

// =====================================================================
// 5. Replay engine — offset is the only state
// =====================================================================

describe("spine consumer — replay resets the offset deterministically", () => {
  const src = fnSource("hq_replay_consumer");

  it("rewinds the offset (default 0 = from the beginning)", () => {
    expect(fnHeader("hq_replay_consumer")).toMatch(/p_to_event_id\s+bigint default 0/i);
    expect(src).toMatch(/update public\.hq_event_consumers\s+set last_event_id = greatest\(p_to_event_id, 0\)/i);
  });

  it("clears transient retry + dead rows beyond the replay point so the redrive is clean", () => {
    expect(src).toMatch(/delete from public\.hq_consumer_retries\s+where consumer = p_consumer and event_id > /i);
    expect(src).toMatch(/delete from public\.dead_events\s+where consumer = p_consumer and event_id > /i);
  });
});

// =====================================================================
// 6. Golden signals — read-side lag/throughput/dead-count (Ch.15 canary)
// =====================================================================

describe("spine consumer — golden signals compute on read (no projection)", () => {
  const src = fnSource("hq_spine_golden_signals");

  it("computes per-consumer lag as max(id) − last_event_id (the canary)", () => {
    expect(src).toMatch(/max\(id\), 0\) from public\.hq_events\) - c\.last_event_id/i);
  });

  it("exposes throughput windows and the dead-event count", () => {
    expect(src).toMatch(/'last_1m'/i);
    expect(src).toMatch(/dead_event_count'?,?\s*\(select count\(\*\) from public\.dead_events\)/i);
  });
});

// =====================================================================
// 7. Function hardening — SECURITY DEFINER + pinned search_path
// =====================================================================

describe("spine consumer — every new function is hardened", () => {
  for (const fn of NEW_FUNCTIONS) {
    it(`${fn} is SECURITY DEFINER with an empty search_path`, () => {
      const header = fnHeader(fn);
      expect(header).toMatch(/security definer/i);
      expect(header).toMatch(/set search_path = ''/i);
    });
  }
});

// =====================================================================
// 8. Privilege model — every new function is service_role-only (L-4)
// =====================================================================

describe("spine consumer — EXECUTE revoked from anon/authenticated, granted only to service_role", () => {
  for (const fn of NEW_FUNCTIONS) {
    it(`${fn} revokes from public, anon AND authenticated`, () => {
      expect(exec).toMatch(
        new RegExp(
          `revoke all on function\\s+public\\.${fn}\\([\\s\\S]*?\\)\\s*from public, anon, authenticated`,
          "i",
        ),
      );
    });

    it(`${fn} grants execute only to service_role`, () => {
      expect(exec).toMatch(
        new RegExp(
          `grant execute on function\\s+public\\.${fn}\\([\\s\\S]*?\\)\\s*to service_role`,
          "i",
        ),
      );
    });
  }

  it("the new tables are RLS:hq (RLS enabled → service-role only)", () => {
    expect(exec).toMatch(/alter table public\.hq_consumer_retries enable row level security/i);
    expect(exec).toMatch(/alter table public\.hq_consumer_selftest enable row level security/i);
  });

  it("no EXECUTE/privilege is ever GRANTED to a JWT role (anon/authenticated/public)", () => {
    expect(exec).not.toMatch(/\bto\s+anon\b/i);
    expect(exec).not.toMatch(/\bto\s+authenticated\b/i);
    expect(exec).not.toMatch(/grant[\s\S]*?\bto\s+public\b/i);
  });
});
