import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * P2 audit H-1 — lead-summary cross-tenant isolation (behavioural).
 *
 * summariseLead() reads `leads` + `tenant_attachments` via the SERVICE-ROLE
 * admin client, which BYPASSES RLS. Before the fix it filtered only by lead
 * id, so any authenticated member could pass another tenant's lead id and
 * trigger a read of that lead + linked customer PII — which was then sent to
 * the LLM. The fix threads the caller's org id into BOTH queries.
 *
 * These tests mock the admin client so the org_id filter is *honoured* the
 * same way Postgres would (a row comes back only when id AND org_id match),
 * then assert the security-critical behaviours.
 */

// --- module mocks (hoisted above imports by vitest) ---
const createAdminClientMock = vi.fn();
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => createAdminClientMock(),
}));

/**
 * The AI gate. It used to be `isAiConfigured()` — "a vendor key is present" —
 * which meant a credential on a deploy sent this TENANT-FACING summary to a model
 * with no £100/org/month ceiling and no ledger row. It is now
 * `isGovernorActivated()`: the cost tier must be BOUND in the build too. The mock
 * keeps its old name here so every assertion below still reads as "AI on / AI
 * off", which is exactly what the flag still means to this test.
 */
const isAiConfiguredMock = vi.fn();
vi.mock("@/lib/ai/governor", async (importOriginal) => {
  // Keep the real governor seam — `invokeWithGovernor`'s dark pass-through is
  // what lets the provider leg run under this mock, and mocking it away would
  // make the test prove less than it does now.
  const actual = await importOriginal<typeof import("@/lib/ai/governor")>();
  return { ...actual, isGovernorActivated: () => isAiConfiguredMock() };
});

// If summariseLead ever reaches the LLM, this spy records it. The whole point
// of the foreign-org test is that it stays UNCALLED (no cross-tenant PII out).
const anthropicCreateSpy = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create: anthropicCreateSpy };
  },
}));

import { summariseLead } from "@/server/services/lead-summary";

const ORG = "11111111-1111-1111-1111-111111111111";
const OTHER_ORG = "22222222-2222-2222-2222-222222222222";
const LEAD = "33333333-3333-3333-3333-333333333333";

type Capture = { table: string; eqs: Record<string, unknown> };

/**
 * Fake admin client that enforces the same id+org_id scoping Postgres would:
 * the `leads` read returns the seed row only when BOTH lead id and org id
 * match; the `tenant_attachments` count returns the seed count only when
 * org id + target id match. Records every query's .eq() filters so the test
 * can assert org scoping was applied.
 */
function makeAdmin(seed: {
  id: string;
  org_id: string;
  row: Record<string, unknown>;
  count: number;
}) {
  const captures: Capture[] = [];
  const from = (table: string) => {
    const eqs: Record<string, unknown> = {};
    const builder = {
      select: () => builder,
      eq: (k: string, v: unknown) => {
        eqs[k] = v;
        return builder;
      },
      maybeSingle: async () => {
        captures.push({ table, eqs });
        const match = eqs.id === seed.id && eqs.org_id === seed.org_id;
        return { data: match ? seed.row : null, error: null };
      },
      // tenant_attachments count is awaited directly (no .maybeSingle()),
      // so the builder is thenable.
      then: (
        resolve: (v: { count: number; error: null }) => unknown,
        reject?: (e: unknown) => unknown,
      ) => {
        captures.push({ table, eqs });
        const match = eqs.org_id === seed.org_id && eqs.target_id === seed.id;
        return Promise.resolve({
          count: match ? seed.count : 0,
          error: null,
        }).then(resolve, reject);
      },
    };
    return builder;
  };
  return { client: { from }, captures };
}

const seedRow = {
  id: LEAD,
  org_id: ORG,
  source: "web",
  status: "new",
  service: "boiler repair",
  urgency: "high",
  postcode: "SW1A 1AA",
  estimated_value: null,
  ai_summary: null,
  created_at: "2026-06-01T00:00:00Z",
  last_activity_at: "2026-06-01T00:00:00Z",
  customer: { name: "Acme Ltd", email: "ops@acme.test" },
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("H-1 — summariseLead is org-scoped (service-role / RLS-bypass path)", () => {
  it("summarises an in-org lead (deterministic path)", async () => {
    isAiConfiguredMock.mockReturnValue(false);
    const { client } = makeAdmin({ id: LEAD, org_id: ORG, row: seedRow, count: 2 });
    createAdminClientMock.mockReturnValue(client);

    const result = await summariseLead(LEAD, ORG);

    expect(result).not.toBeNull();
    expect(result?.generated_by).toBe("deterministic");
    expect(result?.summary).toContain("SW1A 1AA");
    expect(result?.summary).toContain("Acme Ltd");
    expect(result?.summary).toContain("2 photos");
    expect(anthropicCreateSpy).not.toHaveBeenCalled();
  });

  it("summarises an in-org lead via the LLM when AI is configured", async () => {
    isAiConfiguredMock.mockReturnValue(true);
    anthropicCreateSpy.mockResolvedValue({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            summary: "Urgent boiler job in SW1A.",
            suggested_action: "call",
          }),
        },
      ],
    });
    const { client } = makeAdmin({ id: LEAD, org_id: ORG, row: seedRow, count: 0 });
    createAdminClientMock.mockReturnValue(client);

    const result = await summariseLead(LEAD, ORG);

    expect(anthropicCreateSpy).toHaveBeenCalledTimes(1);
    expect(result?.generated_by).toBe("anthropic");
    expect(result?.summary).toBe("Urgent boiler job in SW1A.");
    expect(result?.suggested_action).toBe("call");
  });

  it("returns null for a lead in ANOTHER org — and NEVER calls the LLM", async () => {
    // AI is configured, so if the org filter were missing the code WOULD
    // call Anthropic with the foreign lead's PII. It must not.
    isAiConfiguredMock.mockReturnValue(true);
    const { client } = makeAdmin({ id: LEAD, org_id: ORG, row: seedRow, count: 5 });
    createAdminClientMock.mockReturnValue(client);

    const result = await summariseLead(LEAD, OTHER_ORG);

    expect(result).toBeNull();
    expect(anthropicCreateSpy).not.toHaveBeenCalled();
  });

  it("filters BOTH the lead read and the photo-count by org_id", async () => {
    isAiConfiguredMock.mockReturnValue(false);
    const admin = makeAdmin({ id: LEAD, org_id: ORG, row: seedRow, count: 3 });
    createAdminClientMock.mockReturnValue(admin.client);

    await summariseLead(LEAD, ORG);

    const leadQ = admin.captures.find((c) => c.table === "leads");
    expect(leadQ).toBeDefined();
    expect(leadQ?.eqs.id).toBe(LEAD);
    expect(leadQ?.eqs.org_id).toBe(ORG);

    const attQ = admin.captures.find((c) => c.table === "tenant_attachments");
    expect(attQ).toBeDefined();
    expect(attQ?.eqs.target_id).toBe(LEAD);
    expect(attQ?.eqs.org_id).toBe(ORG);
  });
});
