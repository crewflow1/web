import { describe, expect, it } from "vitest";
import {
  planRotaPersistence,
  type ExistingRotaEntry,
  type PersistableAssignment,
} from "@/lib/schedule/persist";

/**
 * Rota persistence planner (lib/schedule/persist.ts) — the pure decision that
 * sits between the solver's proposal and the atomic insert. Every case is a
 * plain in/out call; it owns no I/O, so the behaviour asserted here is exactly
 * what the approve action writes.
 *
 * The three guarantees under test: idempotency (an identical shift is never
 * re-inserted), never-overwrite (a clash with a live shift is dropped, not
 * written over), and all-or-nothing hygiene (a malformed interval that would
 * abort the batch insert is filtered out with a reason).
 */

const USER_A = "11111111-1111-1111-1111-111111111111";
const USER_B = "22222222-2222-2222-2222-222222222222";
const JOB_1 = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const JOB_2 = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

function assign(over: Partial<PersistableAssignment> = {}): PersistableAssignment {
  return {
    userId: over.userId ?? USER_A,
    jobId: over.jobId ?? JOB_1,
    startIso: over.startIso ?? "2026-03-04T08:00:00Z",
    endIso: over.endIso ?? "2026-03-04T17:00:00Z",
    notes: over.notes,
  };
}

function existing(over: Partial<ExistingRotaEntry> = {}): ExistingRotaEntry {
  return {
    user_id: over.user_id ?? USER_A,
    job_id: over.job_id ?? JOB_1,
    starts_at: over.starts_at ?? "2026-03-04T08:00:00Z",
    ends_at: over.ends_at ?? "2026-03-04T17:00:00Z",
  };
}

describe("planRotaPersistence", () => {
  it("inserts a clean assignment that has no existing counterpart", () => {
    const plan = planRotaPersistence([assign()], []);
    expect(plan.toInsert).toHaveLength(1);
    expect(plan.alreadySaved).toHaveLength(0);
    expect(plan.conflicts).toHaveLength(0);
  });

  it("is IDEMPOTENT: an identical existing shift is skipped, not re-inserted", () => {
    // Same person, job, start and end — this is the re-approve case.
    const plan = planRotaPersistence([assign()], [existing()]);
    expect(plan.toInsert).toHaveLength(0);
    expect(plan.alreadySaved).toHaveLength(1);
    expect(plan.conflicts).toHaveLength(0);
  });

  it("treats a +00:00 offset from Postgres as equal to a Z instant", () => {
    const plan = planRotaPersistence(
      [assign({ startIso: "2026-03-04T08:00:00Z", endIso: "2026-03-04T17:00:00Z" })],
      [existing({ starts_at: "2026-03-04T08:00:00+00:00", ends_at: "2026-03-04T17:00:00+00:00" })],
    );
    expect(plan.alreadySaved).toHaveLength(1);
    expect(plan.toInsert).toHaveLength(0);
  });

  it("NEVER OVERWRITES: an assignment overlapping a confirmed shift is a dropped conflict", () => {
    // A manager confirmed 09:00–12:00 by hand; the plan proposes 08:00–17:00.
    const plan = planRotaPersistence(
      [assign({ startIso: "2026-03-04T08:00:00Z", endIso: "2026-03-04T17:00:00Z" })],
      [existing({ job_id: null, starts_at: "2026-03-04T09:00:00Z", ends_at: "2026-03-04T12:00:00Z" })],
    );
    expect(plan.toInsert).toHaveLength(0);
    expect(plan.conflicts).toHaveLength(1);
    expect(plan.conflicts[0]?.reason).toMatch(/already on the rota/i);
  });

  it("treats a touching edge as a handover, not a clash", () => {
    // Existing 06:00–08:00, proposal starts exactly at 08:00 — no overlap.
    const plan = planRotaPersistence(
      [assign({ startIso: "2026-03-04T08:00:00Z", endIso: "2026-03-04T17:00:00Z" })],
      [existing({ job_id: null, starts_at: "2026-03-04T06:00:00Z", ends_at: "2026-03-04T08:00:00Z" })],
    );
    expect(plan.toInsert).toHaveLength(1);
    expect(plan.conflicts).toHaveLength(0);
  });

  it("does not confuse two different people's shifts", () => {
    // User B has a shift at the same time; user A's proposal is unaffected.
    const plan = planRotaPersistence(
      [assign({ userId: USER_A })],
      [existing({ user_id: USER_B, starts_at: "2026-03-04T08:00:00Z", ends_at: "2026-03-04T17:00:00Z" })],
    );
    expect(plan.toInsert).toHaveLength(1);
    expect(plan.conflicts).toHaveLength(0);
  });

  it("de-duplicates WITHIN the batch: two overlapping proposals for one person cannot both insert", () => {
    const plan = planRotaPersistence(
      [
        assign({ jobId: JOB_1, startIso: "2026-03-04T08:00:00Z", endIso: "2026-03-04T12:00:00Z" }),
        assign({ jobId: JOB_2, startIso: "2026-03-04T10:00:00Z", endIso: "2026-03-04T15:00:00Z" }),
      ],
      [],
    );
    expect(plan.toInsert).toHaveLength(1);
    expect(plan.conflicts).toHaveLength(1);
    expect(plan.conflicts[0]?.reason).toMatch(/this plan/i);
  });

  it("allows the same person two NON-overlapping shifts in one batch", () => {
    const plan = planRotaPersistence(
      [
        assign({ jobId: JOB_1, startIso: "2026-03-04T08:00:00Z", endIso: "2026-03-04T10:00:00Z" }),
        assign({ jobId: JOB_2, startIso: "2026-03-04T11:00:00Z", endIso: "2026-03-04T13:00:00Z" }),
      ],
      [],
    );
    expect(plan.toInsert).toHaveLength(2);
    expect(plan.conflicts).toHaveLength(0);
  });

  it("filters a malformed/zero-length interval so it cannot abort the atomic insert", () => {
    const plan = planRotaPersistence(
      [
        assign({ startIso: "2026-03-04T17:00:00Z", endIso: "2026-03-04T17:00:00Z" }), // zero length
        assign({ userId: USER_B }), // good
      ],
      [],
    );
    expect(plan.toInsert).toHaveLength(1);
    expect(plan.toInsert[0]?.userId).toBe(USER_B);
    expect(plan.conflicts).toHaveLength(1);
    expect(plan.conflicts[0]?.reason).toMatch(/invalid/i);
  });

  it("preserves input order in toInsert (deterministic output)", () => {
    const plan = planRotaPersistence(
      [
        assign({ userId: USER_A, jobId: JOB_1, startIso: "2026-03-04T08:00:00Z", endIso: "2026-03-04T10:00:00Z" }),
        assign({ userId: USER_B, jobId: JOB_2, startIso: "2026-03-05T08:00:00Z", endIso: "2026-03-05T10:00:00Z" }),
      ],
      [],
    );
    expect(plan.toInsert.map((a) => a.userId)).toEqual([USER_A, USER_B]);
  });
});
