import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { ACTOR_TYPES, SEVERITIES } from "@/lib/events/registry";

/**
 * HQ Event Spine — security invariants (Module 1, PR1).
 *
 * CI has no database here (the live behaviour is proven in the integration tier),
 * so — exactly like the activity-log-retention and phase7 suites — we pin the
 * migration's SECURITY contract against its source text. These are the assertions
 * that, if they ever silently flipped, would be a hole: a partition readable by
 * anon, an emit callable by a JWT client, an editable "append-only" log, a
 * function with an unpinned search_path.
 *
 * The load-bearing checks run over `exec` (executable SQL with `--` comments
 * stripped) so the documentation that NAMES anon/authenticated, etc., can't
 * satisfy a positive match or trip a negative one.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

const MIG_REL = "supabase/migrations/20260720000000_hq_event_spine_core.sql";
const mig = read(MIG_REL);

// Strip SQL line comments (-- … EOL) so assertions test the EXECUTABLE statements,
// not the prose that documents the security model.
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

// =====================================================================
// 0. The migration ships
// =====================================================================

describe("spine — migration is present", () => {
  it("the PR1 core migration exists", () => {
    expect(existsSync(resolve(ROOT, MIG_REL))).toBe(true);
  });
});

// =====================================================================
// 1. Storage shape — total order + partitioning + envelope CHECKs
// =====================================================================

describe("spine — hq_events storage contract", () => {
  it("is RANGE-partitioned by ts with a monotonic bigint identity id", () => {
    expect(exec).toMatch(/create table if not exists public\.hq_events/i);
    expect(exec).toMatch(/partition by range \(ts\)/i);
    expect(exec).toMatch(/id\s+bigint generated always as identity/i);
  });

  it("the primary key includes the partition key — (id, ts) is THE total order", () => {
    expect(exec).toMatch(/primary key \(id, ts\)/i);
  });

  it("correlation_id is a NOT NULL uuid (every event is traceable)", () => {
    expect(exec).toMatch(/correlation_id\s+uuid\s+not null/i);
  });

  it("the actor_type CHECK mirrors the TS registry exactly", () => {
    expect(exec).toMatch(/actor_type\s+text\s+not null\s+check \(actor_type in \(/i);
    for (const a of ACTOR_TYPES) expect(exec).toMatch(new RegExp(`'${a}'`));
  });

  it("the severity CHECK mirrors the TS registry exactly", () => {
    expect(exec).toMatch(/severity\s+text\s+not null\s+default 'info' check \(severity in \(/i);
    for (const s of SEVERITIES) expect(exec).toMatch(new RegExp(`'${s}'`));
  });
});

// =====================================================================
// 2. RLS:hq — every base table is service-role only (RLS on, zero policies)
// =====================================================================

describe("spine — RLS:hq on every base table", () => {
  for (const table of ["hq_events", "hq_event_consumers", "dead_events"]) {
    it(`${table} enables row level security`, () => {
      expect(exec).toMatch(
        new RegExp(`alter table public\\.${table} enable row level security`, "i"),
      );
    });
  }

  it("declares NO policies anywhere — service_role (BYPASSRLS) is the only reader", () => {
    expect(exec).not.toMatch(/create policy/i);
  });
});

// =====================================================================
// 3. Partition-level RLS — the PostgREST pitfall (parent RLS isn't inherited)
// =====================================================================

describe("spine — partitions are individually RLS-protected", () => {
  it("the partition creator enables RLS on each partition it makes", () => {
    expect(exec).toMatch(
      /execute format\(\s*'alter table public\.%I enable row level security'/i,
    );
  });

  it("the DEFAULT catch-all partition exists and has RLS enabled", () => {
    expect(exec).toMatch(/partition of public\.hq_events default/i);
    expect(exec).toMatch(/alter table public\.hq_events_default enable row level security/i);
  });

  it("pre-creates a runway (current month + 6 ahead) via the creator function", () => {
    expect(exec).toMatch(/for i in 0\.\.6 loop/i);
    expect(exec).toMatch(/public\.hq_create_events_partition\(now\(\) \+ make_interval\(months => i\)\)/i);
  });
});

// =====================================================================
// 4. Append-only — UPDATE/DELETE rejected even under service_role
// =====================================================================

describe("spine — append-only guard", () => {
  it("BEFORE UPDATE and BEFORE DELETE triggers call the block function", () => {
    expect(exec).toMatch(
      /before update on public\.hq_events\s+for each row execute function public\.hq_events_block_mutation/i,
    );
    expect(exec).toMatch(
      /before delete on public\.hq_events\s+for each row execute function public\.hq_events_block_mutation/i,
    );
  });

  it("the guard RAISES (restrict_violation) rather than silently allowing", () => {
    const header = exec.indexOf("function public.hq_events_block_mutation()");
    expect(header).toBeGreaterThanOrEqual(0);
    expect(exec).toMatch(/raise exception 'hq_events is append-only/i);
    expect(exec).toMatch(/errcode = 'restrict_violation'/i);
  });
});

// =====================================================================
// 5. Function hardening — SECURITY DEFINER + pinned search_path
// =====================================================================

describe("spine — SECURITY DEFINER functions are hardened", () => {
  for (const fn of ["hq_emit_event", "hq_create_events_partition"]) {
    it(`${fn} is SECURITY DEFINER with an empty search_path`, () => {
      const header = fnHeader(fn);
      expect(header).toMatch(/security definer/i);
      expect(header).toMatch(/set search_path = ''/i);
    });
  }
});

// =====================================================================
// 6. Privilege model — emit + partition creation are service_role-only
// =====================================================================

describe("spine — EXECUTE is revoked from anon/authenticated and granted only to service_role", () => {
  for (const fn of ["hq_emit_event", "hq_create_events_partition"]) {
    it(`${fn} revokes from public, anon AND authenticated`, () => {
      // Revoking from PUBLIC alone is NOT enough: Supabase's default privileges
      // grant EXECUTE on new public functions directly to anon/authenticated, so
      // a JWT client could otherwise call it. (Proven by the integration tier.)
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
    // The functions are the only API surface without RLS, so the grant IS the
    // gate. service_role is the sole grantee; anon/authenticated/public appear
    // only in the REVOKE.
    expect(exec).not.toMatch(/\bto\s+anon\b/i);
    expect(exec).not.toMatch(/\bto\s+authenticated\b/i);
    expect(exec).not.toMatch(/grant[\s\S]*?\bto\s+public\b/i);
  });
});
