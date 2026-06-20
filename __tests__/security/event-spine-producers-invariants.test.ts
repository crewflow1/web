import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { VERB_GROUPS, isVerb } from "@/lib/events/registry";

/**
 * HQ Event Spine — producer invariants (Module 1, PR2).
 *
 * CI has no database in this tier (the live dual-write is proven in the
 * integration tier), so — exactly like the PR1 spine-core suite — we pin the
 * producer migration's contract against its source text. These are the
 * assertions that, if they ever silently flipped, would be a hole: a dual-write
 * that shipped ON instead of dark, a producer that bypassed the validated entry
 * point, a mapping that emitted an UNregistered verb, a generalisation that
 * dropped the original activity_log write, or a flag-read callable by a JWT
 * client.
 *
 * The load-bearing checks run over `exec` (executable SQL with `--` comments
 * stripped) so the prose that documents the mapping can't satisfy a positive
 * match or trip a negative one.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

const MIG_REL = "supabase/migrations/20260720010000_hq_event_spine_producers.sql";
const mig = read(MIG_REL);

// Strip SQL line comments (-- … EOL) so assertions test the EXECUTABLE statements,
// not the prose that documents the producer contract.
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

// =====================================================================
// 0. The migration ships
// =====================================================================

describe("spine producers — migration is present", () => {
  it("the PR2 producers migration exists", () => {
    expect(existsSync(resolve(ROOT, MIG_REL))).toBe(true);
  });
});

// =====================================================================
// 1. Ships DARK — the dual-write defaults OFF and lives off the operator UI
// =====================================================================

describe("spine producers — the dual-write ships dark", () => {
  it("seeds the flag FALSE (applying PR2 changes no behaviour)", () => {
    expect(exec).toMatch(/jsonb_build_object\('dual_write_enabled',\s*false\)/i);
  });

  it("never seeds the flag true — only an operator turns it on, at runtime", () => {
    expect(exec).not.toMatch(/dual_write_enabled'\s*,\s*true/i);
    expect(exec).not.toMatch(/'\{event_spine,dual_write_enabled\}'\s*,\s*'true'/i);
  });

  it("stores the flag under a non-UI `event_spine` section (not the operator feature_flags)", () => {
    // The settings TS SECTION_IDS list does not include `event_spine`, so the
    // operator settings page never renders it — this is an infra kill-switch.
    expect(exec).toMatch(/event_spine,dual_write_enabled/);
  });

  it("only seeds when the key is absent — never clobbers an operator's setting", () => {
    expect(exec).toMatch(
      /where id = 'singleton'\s+and \(data #> '\{event_spine,dual_write_enabled\}'\) is null/i,
    );
  });
});

// =====================================================================
// 2. _record_activity is GENERALISED, not replaced — backwards compatible
// =====================================================================

describe("spine producers — _record_activity is generalised in place", () => {
  const src = fnSource("_record_activity");

  it("still performs the original activity_log insert (unchanged path)", () => {
    expect(src).toMatch(/insert into public\.activity_log/i);
  });

  it("now also drives the spine via a single trailing dual-write call", () => {
    expect(src).toMatch(/perform public\.hq_emit_from_activity\(/i);
  });
});

// =====================================================================
// 3. The producer path goes THROUGH the single validated entry point
// =====================================================================

describe("spine producers — emit through hq_emit_event (one write primitive)", () => {
  const src = fnSource("hq_emit_from_activity");

  it("the dual-write is flag-gated — a no-op while the spine is dark", () => {
    expect(src).toMatch(/if not public\.hq_spine_dual_write_enabled\(\) then/i);
    expect(src).toMatch(/return;/i);
  });

  it("emits via the PR1 validated entry point, not a raw INSERT into hq_events", () => {
    expect(src).toMatch(/perform public\.hq_emit_event\(/i);
    expect(src).not.toMatch(/insert into public\.hq_events/i);
  });

  it("threads correlation through the Ch.04 GUC coalesce (or a fresh trace)", () => {
    expect(src).toMatch(
      /coalesce\(\s*nullif\(current_setting\('hq\.correlation_id', true\), ''\)::uuid,\s*gen_random_uuid\(\)\s*\)/i,
    );
  });

  it("never projects tenant PII into the event payload (no name/email/phone/signer)", () => {
    // The spine is a lean event log, not a second copy of tenant PII. The curated
    // payload whitelists only status/identifier/amount hints; personal data stays
    // in activity_log and must never be referenced as a payload key (Ch.04).
    expect(src).not.toMatch(/->\s*'(name|email|phone|signer)'/i);
  });
});

// =====================================================================
// 4. The curated map emits ONLY registered OPERATIONS verbs (SQL ↔ TS pin)
// =====================================================================

describe("spine producers — the activity→verb map is pinned to the registry", () => {
  const src = fnSource("hq_emit_from_activity");
  const produced = Array.from(src.matchAll(/then\s+'([a-z_]+\.[a-z_]+)'/gi))
    .map((m) => m[1])
    .filter((v): v is string => typeof v === "string")
    .sort();
  const uniqueProduced = Array.from(new Set(produced));

  it("maps a non-empty set of verbs", () => {
    expect(uniqueProduced.length).toBeGreaterThan(0);
  });

  it("every produced verb is a REGISTERED verb (won't emit an unknown name)", () => {
    for (const v of uniqueProduced) expect(isVerb(v), `${v} is not a registered verb`).toBe(true);
  });

  it("every produced verb belongs to the OPERATIONS group (mirrored from activity_log)", () => {
    const ops = new Set<string>(VERB_GROUPS.operations);
    for (const v of uniqueProduced) expect(ops.has(v), `${v} is not an operations verb`).toBe(true);
  });

  it("produces exactly the curated subset — a tripwire on adding/removing a producer", () => {
    expect(uniqueProduced).toEqual(
      [
        "customer.created",
        "customer.updated",
        "job.completed",
        "job.created",
        "quote.accepted",
        "quote.sent",
      ].sort(),
    );
  });

  it("does NOT invent a source for the forward-only verbs (job.scheduled / job.cancelled)", () => {
    // These verbs exist in the registry but have no activity_log source today
    // (jobs.status has no 'scheduled'/'cancelled'). PR2 must not fabricate one.
    expect(uniqueProduced).not.toContain("job.scheduled");
    expect(uniqueProduced).not.toContain("job.cancelled");
  });
});

// =====================================================================
// 5. Function hardening — SECURITY DEFINER + pinned search_path
// =====================================================================

describe("spine producers — new functions are hardened", () => {
  for (const fn of ["hq_emit_from_activity", "hq_spine_dual_write_enabled"]) {
    it(`${fn} is SECURITY DEFINER with an empty search_path`, () => {
      const header = fnHeader(fn);
      expect(header).toMatch(/security definer/i);
      expect(header).toMatch(/set search_path = ''/i);
    });
  }
});

// =====================================================================
// 6. Privilege model — both new functions are service_role-only (L-4)
// =====================================================================

describe("spine producers — EXECUTE revoked from anon/authenticated, granted only to service_role", () => {
  for (const fn of ["hq_emit_from_activity", "hq_spine_dual_write_enabled"]) {
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

  it("no EXECUTE/privilege is ever GRANTED to a JWT role (anon/authenticated/public)", () => {
    expect(exec).not.toMatch(/\bto\s+anon\b/i);
    expect(exec).not.toMatch(/\bto\s+authenticated\b/i);
    expect(exec).not.toMatch(/grant[\s\S]*?\bto\s+public\b/i);
  });
});
