import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * HQ Event Spine — historical-backfill invariants (Module 1, PR4).
 *
 * CI has no database in this tier (the live replay is proven in the integration
 * tier), so — exactly like the PR1/PR2/PR3 suites — we pin the backfill migration's
 * contract against its source text. These are the assertions that, if they ever
 * silently flipped, would be a hole: a backfill that shipped ON instead of dark, an
 * emit that wrote ts = now() instead of the original created_at (collapsing all
 * history into today's partition), an emit that DROPPED the (source, source_id)
 * idempotency guard (a re-run would duplicate the whole spine), a cursor advanced
 * WITHOUT the single-active lock, a walk that wasn't deterministically ordered or
 * bounded by a ceiling, dynamic SQL on a SECURITY DEFINER function, or a backfill
 * primitive callable by a JWT client.
 *
 * The load-bearing checks run over `exec` (executable SQL with `--` comments
 * stripped) so the prose that documents the contract can't satisfy a positive match
 * or trip a negative one.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

const MIG_REL = "supabase/migrations/20260720030000_hq_event_spine_backfill.sql";
const mig = read(MIG_REL);

// Strip SQL line comments (-- … EOL) so assertions test the EXECUTABLE statements.
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
  "hq_spine_backfill_enabled",
  "hq_backfill_register",
  "hq_backfill_emit",
  "hq_backfill_drain",
  "hq_backfill_reset",
  "hq_backfill_status",
] as const;

// =====================================================================
// 0. The migration ships
// =====================================================================

describe("spine backfill — migration is present", () => {
  it("the PR4 backfill migration exists", () => {
    expect(existsSync(resolve(ROOT, MIG_REL))).toBe(true);
  });
});

// =====================================================================
// 1. Ships DARK — the backfill defaults OFF and lives off the operator UI
// =====================================================================

describe("spine backfill — the replay ships dark", () => {
  it("seeds the global gate FALSE (applying PR4 changes no behaviour)", () => {
    expect(exec).toMatch(/jsonb_build_object\('backfill_enabled',\s*false\)/i);
  });

  it("never seeds the gate true — only an operator turns it on, at runtime", () => {
    expect(exec).not.toMatch(/backfill_enabled'\s*,\s*true/i);
    expect(exec).not.toMatch(/'\{event_spine,backfill_enabled\}'\s*,\s*'true'/i);
  });

  it("stores the gate under the non-UI `event_spine` section (an infra kill-switch)", () => {
    expect(exec).toMatch(/event_spine,backfill_enabled/);
  });

  it("only seeds when the key is absent — never clobbers an operator's setting", () => {
    expect(exec).toMatch(
      /where id = 'singleton'\s+and \(data #> '\{event_spine,backfill_enabled\}'\) is null/i,
    );
  });

  it("the drainer fails dark — it returns early when the gate is off", () => {
    const src = fnSource("hq_backfill_drain");
    expect(src).toMatch(/if not public\.hq_spine_backfill_enabled\(\) then/i);
    expect(src).toMatch(/'backfill_disabled'/i);
  });
});

// =====================================================================
// 2. No duplicate events — the (source, source_id) guard against the append-only spine
// =====================================================================

describe("spine backfill — a re-run can never duplicate an event", () => {
  const src = fnSource("hq_backfill_emit");

  it("carries the (backfill_source, backfill_source_id) idempotency key IN the event payload", () => {
    expect(src).toMatch(
      /jsonb_build_object\('backfill_source',\s*p_source,\s*'backfill_source_id',\s*p_source_id::text\)/i,
    );
  });

  it("NAMESPACES the key — never merges a bare `source` that would clobber a domain field", () => {
    // quote.accepted's curated payload carries its OWN `source` (the acceptance
    // channel); jsonb `||` lets the right operand win, so a bare {source: p_source}
    // merged on top would overwrite it. The emit must use the backfill_* names only.
    expect(src).not.toMatch(/jsonb_build_object\('source',\s*p_source/i);
    expect(src).not.toMatch(/payload ->> 'source' = p_source/i);
  });

  it("inserts ONLY where NOT EXISTS a prior event with that key (the replay backstop)", () => {
    expect(src).toMatch(
      /where not exists \(\s*select 1\s+from public\.hq_events\s+where payload ->> 'backfill_source' = p_source\s+and payload ->> 'backfill_source_id' = p_source_id::text/i,
    );
  });

  it("reports whether a row was actually inserted (false = already present, a no-op)", () => {
    expect(src).toMatch(/get diagnostics v_inserted = row_count/i);
    expect(src).toMatch(/return v_inserted > 0/i);
  });

  it("there is a lookup index on the backfill key so the guard is a point probe", () => {
    expect(exec).toMatch(
      /create index if not exists hq_events_backfill_source_idx\s+on public\.hq_events \(\(payload ->> 'backfill_source'\), \(payload ->> 'backfill_source_id'\)\)/i,
    );
  });
});

// =====================================================================
// 3. Original ts — historical events land in their own partition/order
// =====================================================================

describe("spine backfill — events carry their ORIGINAL ts (not now())", () => {
  const src = fnSource("hq_backfill_emit");

  it("inserts ts from the caller's created_at, never defaulting to now()", () => {
    // The INSERT lists ts first and selects p_created_at into it.
    expect(src).toMatch(/insert into public\.hq_events \(\s*ts,/i);
    expect(src).toMatch(/select\s+p_created_at,/i);
  });

  it("uses a DETERMINISTIC correlation_id (md5(source:source_id) → uuid), stable on replay", () => {
    expect(src).toMatch(/md5\(p_source \|\| ':' \|\| p_source_id::text\)::uuid/i);
  });

  it("the backfill writes hq_events DIRECTLY — never through hq_emit_event (which has no ts param)", () => {
    expect(exec).not.toMatch(/hq_emit_event/i);
  });
});

// =====================================================================
// 4. Deterministic + bounded + single-active — never process a source row twice
// =====================================================================

describe("spine backfill — the walk is deterministic, bounded and single-active", () => {
  const src = fnSource("hq_backfill_drain");

  it("takes a single-active-backfiller lock (FOR UPDATE SKIP LOCKED) on the source row", () => {
    expect(src).toMatch(/for update skip locked/i);
    expect(src).toMatch(/'locked'/i);
  });

  it("walks in strict (created_at, id) order — a stable total order", () => {
    expect(src).toMatch(/order by created_at asc, id asc/i);
  });

  it("reads strictly after the cursor and at/under the ceiling (bounded to history)", () => {
    expect(src).toMatch(/where \(created_at, id\) > \(v_cur_at, v_cur_id\)/i);
    expect(src).toMatch(/and \(created_at, id\) <= \(v_ceil_at, v_ceil_id\)/i);
  });

  it("reads a BOUNDED batch (limit greatest(p_max_rows, 1))", () => {
    expect(src).toMatch(/v_limit\s+integer\s*:=\s*greatest\(p_max_rows, 1\)/i);
    expect(src).toMatch(/limit v_limit/i);
  });

  it("advances the cursor and persists it transactionally (crash rolls back both)", () => {
    expect(src).toMatch(/v_cur_at := v_rec\.created_at; v_cur_id := v_rec\.id;/i);
    expect(src).toMatch(/update public\.hq_backfill_state\s+set cursor_created_at = v_cur_at/i);
  });

  it("captures the ceiling ONCE on the first run (status idle → running)", () => {
    expect(src).toMatch(/if v_status = 'idle' then/i);
    expect(src).toMatch(/ceiling_created_at = v_ceil_at, ceiling_id = v_ceil_id/i);
  });
});

// =====================================================================
// 5. Restartable — reset rewinds the cursor, the guard keeps it duplicate-free
// =====================================================================

describe("spine backfill — reset rewinds for a clean redrive", () => {
  const src = fnSource("hq_backfill_reset");

  it("rewinds the cursor to the sentinels and returns the source to idle", () => {
    expect(src).toMatch(/cursor_created_at\s*=\s*'-infinity'/i);
    expect(src).toMatch(/cursor_id\s*=\s*'00000000-0000-0000-0000-000000000000'/i);
    expect(src).toMatch(/status\s*=\s*'idle'/i);
  });

  it("locks the row so a reset cannot race a live drain", () => {
    expect(src).toMatch(/for update/i);
  });
});

// =====================================================================
// 6. The mappings are grounded in the REAL producer vocabulary
// =====================================================================

describe("spine backfill — activity_log MIRRORS PR2's six curated verbs", () => {
  const src = fnSource("hq_backfill_drain");

  it("maps exactly the PR2 forward verbs (forward/backfill parity)", () => {
    for (const verb of [
      "customer.created",
      "customer.updated",
      "job.created",
      "job.completed",
      "quote.sent",
      "quote.accepted",
    ]) {
      expect(src).toContain(`'${verb}'`);
    }
  });

  it("derives job.completed only from a status change TO completed (PR2's rule)", () => {
    expect(src).toMatch(/v_rec\.action = 'job\.status_changed'\s+and v_rec\.metadata ->> 'to' = 'completed' then 'job\.completed'/i);
  });

  it("preserves quote.accepted's acceptance `source` channel (the field namespacing protects)", () => {
    // PR2 parity: the curated quote.accepted payload keeps its own `source` from the
    // legacy metadata — only reachable because the idempotency key is backfill_*.
    expect(src).toMatch(/when 'quote\.accepted'[\s\S]*?'source', v_rec\.metadata -> 'source'/i);
  });
});

describe("spine backfill — admin_activity_log projects ONLY the canonical billing trio", () => {
  const src = fnSource("hq_backfill_drain");

  it("maps the three unambiguous Stripe-driven signals", () => {
    expect(src).toMatch(/v_rec\.action = 'stripe\.invoice_paid'\s+then 'invoice\.paid'/i);
    expect(src).toMatch(/v_rec\.action = 'stripe\.invoice_failed'\s+then 'invoice\.payment_failed'/i);
    expect(src).toMatch(/v_rec\.action = 'stripe\.subscription_deleted' then 'org\.churned'/i);
  });

  it("does NOT project the operator-audit noise (impersonation / milestone / tenant_attachment)", () => {
    expect(exec).not.toMatch(/'impersonation/i);
    expect(exec).not.toMatch(/'milestone/i);
    expect(exec).not.toMatch(/'tenant_attachment/i);
  });

  it("does NOT project hq_memory.* (the memory verb is owned by the hq_memory_events adapter)", () => {
    // Avoids the cross-source duplicate: the same logical memory event is logged in
    // BOTH admin_activity_log (hq_memory.created) and hq_memory_events (created).
    expect(exec).not.toMatch(/'hq_memory\./i);
  });
});

describe("spine backfill — hq_memory_events maps created + the superseded transition", () => {
  const src = fnSource("hq_backfill_drain");

  it("created → memory.asserted", () => {
    expect(src).toMatch(/v_rec\.event_type = 'created' then 'memory\.asserted'/i);
  });

  it("status_changed to 'superseded' → memory.superseded", () => {
    expect(src).toMatch(/v_rec\.event_type = 'status_changed'\s+and v_rec\.detail ->> 'to' = 'superseded' then 'memory\.superseded'/i);
  });
});

// =====================================================================
// 7. No dynamic SQL — static dispatch only (no SECURITY DEFINER escalation surface)
// =====================================================================

describe("spine backfill — no dynamic SQL anywhere", () => {
  it("uses static per-source reads, never EXECUTE format / EXECUTE '…'", () => {
    expect(exec).not.toMatch(/\bexecute\s+format\(/i);
    expect(exec).not.toMatch(/\bexecute\s+'/i);
  });
});

// =====================================================================
// 8. Function hardening — SECURITY DEFINER + pinned search_path
// =====================================================================

describe("spine backfill — every new function is hardened", () => {
  for (const fn of NEW_FUNCTIONS) {
    it(`${fn} is SECURITY DEFINER with an empty search_path`, () => {
      const header = fnHeader(fn);
      expect(header).toMatch(/security definer/i);
      expect(header).toMatch(/set search_path = ''/i);
    });
  }
});

// =====================================================================
// 9. Privilege model — every new function is service_role-only (L-4)
// =====================================================================

describe("spine backfill — EXECUTE revoked from anon/authenticated, granted only to service_role", () => {
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

  it("the new state table is RLS:hq (RLS enabled → service-role only)", () => {
    expect(exec).toMatch(/alter table public\.hq_backfill_state enable row level security/i);
  });

  it("no EXECUTE/privilege is ever GRANTED to a JWT role (anon/authenticated/public)", () => {
    expect(exec).not.toMatch(/\bto\s+anon\b/i);
    expect(exec).not.toMatch(/\bto\s+authenticated\b/i);
    expect(exec).not.toMatch(/grant[\s\S]*?\bto\s+public\b/i);
  });
});
