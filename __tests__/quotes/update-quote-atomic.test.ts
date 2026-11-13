import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * updateQuote — FAULT INJECTION at the Supabase boundary.
 *
 * An edit is ONE atomic database write (`replace_quote_content`, migration
 * 20261325000000). These tests pin the application half of that guarantee:
 *
 *   • the action issues NO direct quote / quote_line_items write — the old
 *     update-header → delete-lines → insert-lines chain is what destroyed a
 *     quote's priced lines when the third statement failed;
 *   • when the write fails, the user is told the truth ("nothing was changed")
 *     and gets their input back — never "Saved.";
 *   • a failed pre-read refuses the write (a read error is not "not found" and
 *     is certainly not licence to write);
 *   • an acceptance that lands while the form is open is reported as such.
 *
 * The atomicity itself (old lines survive a mid-write failure) is proved on
 * real Postgres: __tests__/integration/resilience/quote-content-replace-atomic.test.ts.
 */

type Resp = { data: unknown; error: unknown };
const state = {
  quoteRead: { data: { status: "draft" }, error: null } as Resp,
  rpc: { data: { status: "draft", line_count: 1 }, error: null } as Resp,
  rpcCalls: [] as { fn: string; args: Record<string, unknown> }[],
  writes: [] as { table: string; op: string }[],
};

function chain(table: string): Record<string, unknown> {
  const c: Record<string, unknown> = {};
  for (const m of ["select", "eq", "in", "is", "order", "limit"]) c[m] = () => c;
  c.maybeSingle = async () => (table === "quotes" ? state.quoteRead : { data: { id: "x" }, error: null });
  for (const op of ["insert", "update", "delete", "upsert"]) {
    c[op] = () => {
      state.writes.push({ table, op });
      return c;
    };
  }
  return c;
}

const client = {
  from: (t: string) => chain(t),
  rpc: async (fn: string, args: Record<string, unknown>) => {
    state.rpcCalls.push({ fn, args });
    return state.rpc;
  },
};

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => client) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => client }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((u: string) => {
    throw new Error(`REDIRECT:${u}`);
  }),
}));
vi.mock("@/server/auth/session", () => ({
  requireOrgContext: vi.fn(async () => ({
    ctx: { org: { id: "org-1" }, membership: { org_id: "org-1", role: "owner" }, user: { id: "u-1" } },
    user: { id: "u-1" },
  })),
}));
vi.mock("@/server/auth/capabilities", () => ({ requireCapabilityFor: vi.fn(async () => undefined) }));
vi.mock("@/lib/crm/reference-integrity", () => ({
  verifyQuoteReferences: vi.fn(async () => ({ ok: true })),
}));
vi.mock("@/server/services/automation-dispatcher", () => ({ dispatchAutomation: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/lib/email/send-invoice", () => ({ sendInvoiceEmail: vi.fn(async () => ({ sent: false })) }));

const { updateQuote } = await import("@/app/(app)/quotes/actions");

const QUOTE_ID = "22222222-2222-4222-8222-222222222222";
function form(): FormData {
  const fd = new FormData();
  fd.set("customer_id", "11111111-1111-4111-8111-111111111111");
  fd.set("property_id", "");
  fd.set("lead_id", "");
  fd.set("valid_until", "");
  fd.set("notes", "revised scope");
  fd.set("terms", "");
  fd.set(
    "line_items",
    JSON.stringify([
      { description: "First fix", qty: 2, unit: "ea", unit_price: 100, vat_rate: 20 },
      { description: "Second fix", qty: 1, unit: "ea", unit_price: 50, vat_rate: 20 },
    ]),
  );
  return fd;
}
const prev = { ok: true as const, submittedAt: 0 };

beforeEach(() => {
  state.quoteRead = { data: { status: "draft" }, error: null };
  state.rpc = { data: { status: "draft", line_count: 2 }, error: null };
  state.rpcCalls.length = 0;
  state.writes.length = 0;
});

describe("updateQuote — one atomic write, honest on failure", () => {
  it("saves through replace_quote_content only: header + every line in ONE call, pinned to the active org", async () => {
    const res = await updateQuote(QUOTE_ID, prev as never, form());
    expect(res.ok).toBe(true);

    expect(state.rpcCalls).toHaveLength(1);
    const call = state.rpcCalls[0]!;
    expect(call.fn).toBe("replace_quote_content");
    expect(call.args.p_org_id).toBe("org-1");
    expect(call.args.p_quote_id).toBe(QUOTE_ID);
    expect(call.args.p_header).toMatchObject({ subtotal: 250, vat_total: 50, total: 300, notes: "revised scope" });
    expect(call.args.p_lines).toEqual([
      expect.objectContaining({ description: "First fix", line_total: 200, sort_order: 0 }),
      expect.objectContaining({ description: "Second fix", line_total: 50, sort_order: 1 }),
    ]);

    // The hazard was the hand-rolled chain. No direct write may remain.
    expect(state.writes, "no direct quotes / quote_line_items statement").toEqual([]);
  });

  it("FAULT: the database write fails (timeout) → error, input echoed back, 'nothing was changed' — never 'Saved.'", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    state.rpc = { data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } };

    const res = await updateQuote(QUOTE_ID, prev as never, form());

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/nothing was changed/i);
    // The user's edit is handed back so a retry needs no re-typing.
    expect((res as { values?: { notes?: string; line_items?: unknown[] } }).values?.notes).toBe("revised scope");
    expect((res as { values?: { line_items?: unknown[] } }).values?.line_items).toHaveLength(2);
    // And nothing was attempted piecemeal after the failure.
    expect(state.writes).toEqual([]);
    expect(state.rpcCalls).toHaveLength(1);
    errorSpy.mockRestore();
  });

  it("FAULT: the pre-read fails (connection refused) → refuses, and issues NO write at all", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    state.quoteRead = { data: null, error: { code: "PGRST000", message: "connection refused" } };

    const res = await updateQuote(QUOTE_ID, prev as never, form());

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/couldn't load the quote/i);
    expect(state.rpcCalls).toHaveLength(0);
    expect(state.writes).toEqual([]);
    errorSpy.mockRestore();
  });

  it("a quote not resolvable in the active org is refused before any write", async () => {
    state.quoteRead = { data: null, error: null };
    const res = await updateQuote(QUOTE_ID, prev as never, form());
    expect(res.ok).toBe(false);
    expect(state.rpcCalls).toHaveLength(0);
  });

  it("RACE: the customer accepted while the form was open → told it is accepted, not 'try again'", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // The pre-read still saw 'sent'; the function, under the row lock, saw accepted.
    state.quoteRead = { data: { status: "sent" }, error: null };
    state.rpc = { data: null, error: { code: "23514", message: `quote ${QUOTE_ID} has been accepted; it cannot be edited` } };

    const res = await updateQuote(QUOTE_ID, prev as never, form());

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/has been accepted/i);
    expect(res.error).toMatch(/variation/i);
    errorSpy.mockRestore();
  });
});
