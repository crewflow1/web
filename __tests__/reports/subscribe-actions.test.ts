import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * REPORT SUBSCRIPTION LIFECYCLE — create/delete gating + validation.
 *
 * The admin gate here is a courtesy sentence; the RLS on report_subscriptions is
 * the real boundary (proven by the migration pins + the integration RLS tier).
 * These tests pin the SERVER-ACTION contract: a non-admin is refused before any
 * write, malformed input never reaches the DB, and a valid create passes the
 * parsed/normalised recipients + the caller's org to the insert helper.
 */

const { requireOrgContextMock, insertMock, deleteMock, createClientMock } = vi.hoisted(() => ({
  requireOrgContextMock: vi.fn(),
  insertMock: vi.fn(),
  deleteMock: vi.fn(),
  createClientMock: vi.fn(),
}));

vi.mock("@/server/auth/session", () => ({ requireOrgContext: requireOrgContextMock }));
vi.mock("@/lib/supabase/server", () => ({ createClient: createClientMock }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/reports/subscriptions", () => ({
  insertReportSubscription: insertMock,
  deleteReportSubscription: deleteMock,
}));

const { createReportSubscription, deleteReportSubscription } = await import(
  "@/app/(app)/reports/subscribe/actions"
);

function fd(entries: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.set(k, v);
  return f;
}

beforeEach(() => {
  requireOrgContextMock.mockReset();
  insertMock.mockReset();
  deleteMock.mockReset();
  createClientMock.mockReset();
  createClientMock.mockResolvedValue({});
  insertMock.mockResolvedValue({ error: null });
  deleteMock.mockResolvedValue({ error: null });
  requireOrgContextMock.mockResolvedValue({
    ctx: { org: { id: "org-1" }, membership: { role: "owner" } },
    user: { id: "user-1" },
  });
});

describe("createReportSubscription", () => {
  it("refuses a non-admin before any write", async () => {
    requireOrgContextMock.mockResolvedValue({
      ctx: { org: { id: "org-1" }, membership: { role: "staff" } },
      user: { id: "user-1" },
    });
    const res = await createReportSubscription(null, fd({
      report_key: "profit",
      format: "pdf",
      cadence: "weekly",
      recipients: "a@b.com",
    }));
    expect(res.ok).toBe(false);
    expect(insertMock).not.toHaveBeenCalled();
  });

  it("rejects an unknown report key", async () => {
    const res = await createReportSubscription(null, fd({
      report_key: "nope",
      format: "pdf",
      cadence: "weekly",
      recipients: "a@b.com",
    }));
    expect(res.ok).toBe(false);
    expect(insertMock).not.toHaveBeenCalled();
  });

  it("rejects an empty recipient list and an invalid address", async () => {
    const empty = await createReportSubscription(null, fd({
      report_key: "profit", format: "pdf", cadence: "weekly", recipients: "   ",
    }));
    expect(empty.ok).toBe(false);

    const bad = await createReportSubscription(null, fd({
      report_key: "profit", format: "pdf", cadence: "weekly", recipients: "not-an-email",
    }));
    expect(bad.ok).toBe(false);
    expect(insertMock).not.toHaveBeenCalled();
  });

  it("inserts with the caller's org and normalised, deduped recipients", async () => {
    const res = await createReportSubscription(null, fd({
      report_key: "profit",
      format: "csv",
      cadence: "monthly",
      recipients: "Boss@Co.com, boss@co.com\nfinance@co.com",
    }));
    expect(res.ok).toBe(true);
    expect(insertMock).toHaveBeenCalledTimes(1);
    const [, row] = insertMock.mock.calls[0]!;
    expect(row.org_id).toBe("org-1");
    expect(row.report_key).toBe("profit");
    expect(row.format).toBe("csv");
    expect(row.cadence).toBe("monthly");
    expect(row.created_by).toBe("user-1");
    // lowercased + deduped
    expect(row.recipients).toEqual(["boss@co.com", "finance@co.com"]);
  });
});

describe("deleteReportSubscription", () => {
  it("refuses a non-admin", async () => {
    requireOrgContextMock.mockResolvedValue({
      ctx: { org: { id: "org-1" }, membership: { role: "staff" } },
      user: { id: "user-1" },
    });
    const res = await deleteReportSubscription(null, fd({ id: "sub-1" }));
    expect(res.ok).toBe(false);
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it("deletes org-scoped by id for an admin", async () => {
    const res = await deleteReportSubscription(null, fd({ id: "sub-1" }));
    expect(res.ok).toBe(true);
    expect(deleteMock).toHaveBeenCalledWith(expect.anything(), "org-1", "sub-1");
  });
});
