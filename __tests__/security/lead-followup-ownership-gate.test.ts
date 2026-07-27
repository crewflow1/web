import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * P2 audit M-2 — lead_followup_state lead-ownership gate.
 *
 * acknowledgeLead records owner action on a lead via markLeadActed, which
 * UPSERTs lead_followup_state on the SERVICE-ROLE admin client (RLS
 * BYPASSED) and stamps the row with the CALLER'S OWN org_id. The
 * lead_followup_state RLS is org-scoped only (`org_id in current_org_ids()`,
 * migration 20260623000000), so it can never reject a foreign lead_id — the
 * malicious input is the lead_id, not the org_id. Before the fix a member
 * who knew another org's lead id could acknowledge it: the cron joins state
 * by lead_id and skips firing once `acted_at` is set, so the attacker would
 * silently suppress that org's 72h/7d follow-up reminders (and corrupt /
 * re-attribute its state row).
 *
 * The fix verifies the lead belongs to ctx.org.id on the RLS-scoped tenant
 * client BEFORE any admin-client write. redirect() throws (as in Next), so
 * each path ends in a captured redirect URL.
 */

const redirectMock = vi.fn((url: string) => {
  throw new Error(`REDIRECT:${url}`);
});
vi.mock("next/navigation", () => ({
  redirect: (url: string) => redirectMock(url),
}));

const revalidatePathMock = vi.fn();
vi.mock("next/cache", () => ({
  revalidatePath: (p: string) => revalidatePathMock(p),
}));

const requireOrgContextMock = vi.fn();
vi.mock("@/server/auth/session", () => ({
  requireOrgContext: () => requireOrgContextMock(),
}));

const createClientMock = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createClient: () => createClientMock(),
}));

// markLeadActed is dynamically imported inside the action — mock the whole
// module so the admin-client write is observable (and never really runs).
const markLeadActedSpy = vi.fn(async (_input: unknown) => undefined);
vi.mock("@/server/services/lead-followups", () => ({
  markLeadActed: (input: unknown) => markLeadActedSpy(input),
}));

import { acknowledgeLead } from "@/app/(app)/leads/actions";

const ORG = "11111111-1111-1111-1111-111111111111";
const USER = "99999999-9999-9999-9999-999999999999";
const LEAD = "33333333-3333-3333-3333-333333333333";
const FOREIGN_LEAD = "44444444-4444-4444-4444-444444444444";

// Records the leads UPDATE payload (archive vs. last_activity bump).
const updateSpy = vi.fn();

function tenantClientReturning(lead: { id: string } | null) {
  const builder: Record<string, unknown> = {
    select: () => builder,
    update: (row: unknown) => {
      updateSpy(row);
      return builder;
    },
    eq: () => builder,
    maybeSingle: async () => ({ data: lead }),
    then: (
      resolve: (v: { error: null }) => unknown,
      reject?: (e: unknown) => unknown,
    ) => Promise.resolve({ error: null }).then(resolve, reject),
  };
  return { from: () => builder };
}

function ctx() {
  return { ctx: { org: { id: ORG } }, user: { id: USER, email: "u@test" } };
}

function form(kind: string): FormData {
  const fd = new FormData();
  fd.set("kind", kind);
  return fd;
}

async function runAck(id: string, kind: string): Promise<string> {
  try {
    await acknowledgeLead(id, form(kind));
  } catch {
    /* redirect() throws by design */
  }
  const call = redirectMock.mock.calls.at(-1);
  return call ? String(call[0]) : "";
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("M-2 — acknowledgeLead enforces lead ownership", () => {
  it("foreign / nonexistent lead → not_found, no admin write, no lead update", async () => {
    requireOrgContextMock.mockResolvedValue(ctx());
    createClientMock.mockResolvedValue(tenantClientReturning(null));

    const url = await runAck(FOREIGN_LEAD, "call");

    expect(url).toContain("error=not_found");
    // Bailed before the service-role lead_followup_state write.
    expect(markLeadActedSpy).not.toHaveBeenCalled();
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("own-org lead (call) → stamps followup state for THIS org + bumps activity", async () => {
    requireOrgContextMock.mockResolvedValue(ctx());
    createClientMock.mockResolvedValue(tenantClientReturning({ id: LEAD }));

    const url = await runAck(LEAD, "call");

    expect(url).toContain("saved=acknowledged");
    expect(markLeadActedSpy).toHaveBeenCalledTimes(1);
    expect(markLeadActedSpy.mock.calls[0]?.[0]).toMatchObject({
      lead_id: LEAD,
      org_id: ORG,
      kind: "call",
      acted_by_user_id: USER,
    });
    // Non-archive path just bumps last_activity_at (no status change).
    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(updateSpy.mock.calls[0]?.[0]).not.toHaveProperty("status");
  });

  it("own-org lead (archive) → archives the lead row", async () => {
    requireOrgContextMock.mockResolvedValue(ctx());
    createClientMock.mockResolvedValue(tenantClientReturning({ id: LEAD }));

    const url = await runAck(LEAD, "archive");

    expect(url).toContain("saved=acknowledged");
    expect(markLeadActedSpy).toHaveBeenCalledTimes(1);
    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(updateSpy.mock.calls[0]?.[0]).toMatchObject({ status: "archived" });
  });

  it("invalid kind → bad_kind before any read or admin write", async () => {
    requireOrgContextMock.mockResolvedValue(ctx());
    createClientMock.mockResolvedValue(tenantClientReturning({ id: LEAD }));

    const url = await runAck(LEAD, "nope");

    expect(url).toContain("error=bad_kind");
    expect(markLeadActedSpy).not.toHaveBeenCalled();
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("invalid id → bad_id, no admin write", async () => {
    requireOrgContextMock.mockResolvedValue(ctx());
    createClientMock.mockResolvedValue(tenantClientReturning({ id: LEAD }));

    const url = await runAck("not-a-uuid", "call");

    expect(url).toContain("error=bad_id");
    expect(markLeadActedSpy).not.toHaveBeenCalled();
  });
});

// =====================================================================
// Source contract — the ownership gate must stay before the admin write
// =====================================================================

const ROOT = resolve(__dirname, "..", "..");
const actionSrc = readFileSync(
  resolve(ROOT, "app/(app)/leads/actions.ts"),
  "utf8",
);
const pageSrc = readFileSync(
  resolve(ROOT, "app/(app)/leads/[id]/page.tsx"),
  "utf8",
);

const start = actionSrc.indexOf("export async function acknowledgeLead");
const end = actionSrc.indexOf(
  "export async function regenerateLeadSummary",
  start,
);
const ackFn = actionSrc.slice(start, end === -1 ? undefined : end);

describe("M-2 contract — ownership gate pinned in source", () => {
  it("org-scopes the ownership read (id + org_id + maybeSingle)", () => {
    expect(ackFn).toMatch(/\.eq\("id", id\)/);
    expect(ackFn).toMatch(/\.eq\("org_id", ctx\.org\.id\)/);
    expect(ackFn).toMatch(/\.maybeSingle\(\)/);
  });

  it("reads on the RLS-scoped tenant client before the admin-client write", () => {
    const readIdx = ackFn.indexOf(".maybeSingle(");
    const writeIdx = ackFn.indexOf("markLeadActed(");
    expect(readIdx).toBeGreaterThanOrEqual(0);
    expect(writeIdx).toBeGreaterThanOrEqual(0);
    // Ownership read happens first; the service-role write only after.
    expect(readIdx).toBeLessThan(writeIdx);
    expect(ackFn).toMatch(/const supabase = await createClient\(\)/);
  });

  it("fails closed when the lead isn't in this org", () => {
    expect(ackFn).toMatch(/if \(!lead\) redirect\(`\/leads\/\$\{id\}\?error=not_found`\)/);
  });

  it("page renders a message for the not_found failure mode", () => {
    expect(pageSrc).toMatch(/not_found:/);
  });
});
