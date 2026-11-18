import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * PUT /api/schedule/[id] — moving a job's start past its end date violates the
 * jobs_span_forward check. That is invalid input (422 with guidance), never a 500.
 */
const updateResult = vi.hoisted(() => ({ value: { error: null as unknown, count: 1 as number | null } }));

vi.mock("@/server/auth/session", () => ({
  requireOrgContext: vi.fn(async () => ({ ctx: { org: { id: "org-1" } } })),
}));
vi.mock("@/lib/crm/reference-integrity", () => ({ verifyAssigneeInOrg: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/server/services/calendar-connections", () => ({
  bestEffortPushJob: vi.fn(async () => undefined),
  bestEffortDeleteJobEvent: vi.fn(async () => undefined),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    from: () => ({
      update: () => ({ eq: () => ({ eq: async () => updateResult.value }) }),
    }),
  })),
}));

import { PUT } from "@/app/api/schedule/[id]/route";

const call = (body: unknown) =>
  PUT(
    new Request("http://localhost/api/schedule/job-1", { method: "PUT", body: JSON.stringify(body) }) as never,
    { params: Promise.resolve({ id: "job-1" }) },
  );

describe("PUT /api/schedule/[id] — span validation", () => {
  beforeEach(() => {
    updateResult.value = { error: null, count: 1 };
  });

  it("answers 422 with guidance when the new start is after the job's end date", async () => {
    updateResult.value = {
      error: { code: "23514", message: 'new row for relation "jobs" violates check constraint "jobs_span_forward"' },
      count: null,
    };
    const res = await call({ scheduled_date: "2030-01-10" });
    expect(res.status).toBe(422);
    expect(JSON.stringify(await res.json())).toMatch(/end date/i);
  });

  it("still answers 500 for any other database failure", async () => {
    updateResult.value = { error: { code: "XX000", message: "boom" }, count: null };
    const res = await call({ scheduled_date: "2030-01-10" });
    expect(res.status).toBe(500);
  });

  it("succeeds for a valid move", async () => {
    const res = await call({ scheduled_date: "2030-01-10" });
    expect(res.status).toBe(200);
  });
});
