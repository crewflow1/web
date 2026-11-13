import { afterAll, beforeAll, expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient, userClient } from "../_harness";

/**
 * QUOTE EDIT — header + line items are replaced ATOMICALLY (migration
 * 20261325000000, `replace_quote_content`). Real Postgres.
 *
 * BEFORE: updateQuote ran three independent statements —
 *
 *     UPDATE quotes (new totals) → DELETE quote_line_items → INSERT quote_line_items
 *
 * — so a failure of the INSERT (a dropped connection, a statement timeout, a
 * constraint, or the freeze trigger firing because the customer accepted in the
 * gap) left a quote whose stored totals describe line items that NO LONGER
 * EXIST. The priced scope was destroyed and only an error banner in a browser
 * tab held the replacement. The first case below reproduces that sequence
 * statement-for-statement against the real schema so the hazard is on record;
 * the rest prove the function cannot produce it.
 */

type Res<T> = { data: T | null; error: { message: string; code?: string } | null };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = (c: unknown) => c as unknown as { from(t: string): any };
const rpc = (c: unknown) =>
  c as unknown as { rpc(fn: string, args: Record<string, unknown>): PromiseLike<Res<unknown>> };
const svc = () => db(serviceClient());
const TOKEN = `resilience-qedit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

let orgId = "";
let otherOrgId = "";
let customerId = "";
let adminToken = "";
const userIds: string[] = [];
let seq = 0;

const ORIGINAL_LINES = [
  { description: "Strip out", qty: 1, unit: "ea", unit_price: 300, vat_rate: 20, line_total: 300, sort_order: 0 },
  { description: "First fix", qty: 1, unit: "ea", unit_price: 700, vat_rate: 20, line_total: 700, sort_order: 1 },
];
const NEW_LINES = [
  { description: "Strip out (revised)", qty: 1, unit: "ea", unit_price: 350, vat_rate: 20, line_total: 350, sort_order: 0 },
  { description: "First fix", qty: 1, unit: "ea", unit_price: 700, vat_rate: 20, line_total: 700, sort_order: 1 },
  { description: "Second fix", qty: 1, unit: "ea", unit_price: 450, vat_rate: 20, line_total: 450, sort_order: 2 },
];
const NEW_HEADER = (customer: string) => ({
  customer_id: customer,
  property_id: null,
  lead_id: null,
  subtotal: 1500,
  vat_total: 300,
  total: 1800,
  notes: "revised",
  terms: null,
  valid_until: null,
});

async function makeQuote(status: string): Promise<string> {
  seq += 1;
  const q = await svc()
    .from("quotes")
    .insert({
      org_id: orgId,
      customer_id: customerId,
      number: `Q-${TOKEN}-${seq}`,
      status,
      subtotal: 1000,
      vat_total: 200,
      total: 1200,
      public_token: `tok_${TOKEN}_${seq}`,
    })
    .select("id")
    .single();
  expect(q.error, q.error?.message).toBeNull();
  const id = q.data.id as string;
  const li = await svc()
    .from("quote_line_items")
    .insert(ORIGINAL_LINES.map((l) => ({ ...l, quote_id: id, org_id: orgId })));
  expect(li.error, li.error?.message).toBeNull();
  return id;
}

async function state(id: string) {
  const q = await svc().from("quotes").select("status, subtotal, total, notes, approved_by").eq("id", id).single();
  const l = await svc().from("quote_line_items").select("description, line_total").eq("quote_id", id).order("sort_order");
  expect(q.error, q.error?.message).toBeNull();
  expect(l.error, l.error?.message).toBeNull();
  return {
    status: q.data.status as string,
    subtotal: Number(q.data.subtotal),
    notes: q.data.notes as string | null,
    lines: (l.data ?? []) as { description: string; line_total: number }[],
  };
}

beforeAll(async () => {
  const mk = async (suffix: string) => {
    const r = await svc()
      .from("organizations")
      .insert({ name: `Resilience QEdit ${suffix} ${TOKEN}`, slug: `${TOKEN}-${suffix}` })
      .select("id")
      .single();
    expect(r.error, r.error?.message).toBeNull();
    return r.data.id as string;
  };
  orgId = await mk("main");
  otherOrgId = await mk("other");
  const c = await svc().from("customers").insert({ org_id: orgId, name: "Resilience Customer" }).select("id").single();
  expect(c.error, c.error?.message).toBeNull();
  customerId = c.data.id as string;

  const email = `${TOKEN}-admin@example.test`;
  const password = `Pw-${TOKEN}-${Math.random().toString(36).slice(2)}`;
  const created = await serviceClient().auth.admin.createUser({ email, password, email_confirm: true });
  expect(created.error, created.error?.message).toBeNull();
  const uid = created.data.user?.id ?? "";
  userIds.push(uid);
  expect((await svc().from("users").insert({ id: uid, email, full_name: "Resilience Admin" })).error).toBeNull();
  expect((await svc().from("memberships").insert({ org_id: orgId, user_id: uid, role: "admin" })).error).toBeNull();
  const signedIn = await anonClient().auth.signInWithPassword({ email, password });
  expect(signedIn.error, signedIn.error?.message).toBeNull();
  adminToken = signedIn.data.session?.access_token ?? "";
});

afterAll(async () => {
  for (const org of [orgId, otherOrgId]) if (org) await svc().from("organizations").delete().eq("id", org);
  for (const id of userIds) {
    await svc().from("users").delete().eq("id", id);
    await serviceClient().auth.admin.deleteUser(id);
  }
});

describeIntegration("quote edit · header + line items replaced atomically", () => {
  it("HAZARD ON RECORD: the old three-statement sequence destroys the priced lines when the insert fails", async () => {
    const id = await makeQuote("draft");
    // 1. header update (new totals) — commits.
    expect((await svc().from("quotes").update({ subtotal: 1500, vat_total: 300, total: 1800 }).eq("id", id)).error).toBeNull();
    // 2. delete the old lines — commits.
    expect((await svc().from("quote_line_items").delete().eq("quote_id", id).eq("org_id", orgId)).error).toBeNull();
    // 3. the re-insert FAILS (fault: one line cannot be stored).
    const bad = await svc()
      .from("quote_line_items")
      .insert([
        { ...NEW_LINES[0], quote_id: id, org_id: orgId },
        { ...NEW_LINES[1], quote_id: id, org_id: orgId, description: null },
      ]);
    expect(bad.error, "the fault is real").not.toBeNull();

    const after = await state(id);
    // The durable result: totals for scope that is gone. This is the state the
    // function below makes unreachable.
    expect(after.subtotal).toBe(1500);
    expect(after.lines).toHaveLength(0);
  });

  it("replaces header + lines in one transaction (admin, user-JWT client)", async () => {
    const id = await makeQuote("draft");
    const res = await rpc(userClient(adminToken)).rpc("replace_quote_content", {
      p_org_id: orgId,
      p_quote_id: id,
      p_header: NEW_HEADER(customerId),
      p_lines: NEW_LINES,
    });
    expect(res.error, res.error?.message).toBeNull();
    const after = await state(id);
    expect(after.subtotal).toBe(1500);
    expect(after.notes).toBe("revised");
    expect(after.lines.map((l) => l.description)).toEqual(["Strip out (revised)", "First fix", "Second fix"]);
    expect(after.status).toBe("draft");
  });

  it("FAULT: a line that cannot be stored rolls back EVERYTHING — old totals AND old lines survive", async () => {
    const id = await makeQuote("draft");
    const res = await rpc(userClient(adminToken)).rpc("replace_quote_content", {
      p_org_id: orgId,
      p_quote_id: id,
      p_header: NEW_HEADER(customerId),
      // second line has no description → NOT NULL violation mid-insert,
      // AFTER the header update and the delete have run inside the function.
      p_lines: [NEW_LINES[0], { ...NEW_LINES[1], description: null }],
    });
    expect(res.error, "the write must be refused").not.toBeNull();

    const after = await state(id);
    expect(after.subtotal, "header untouched").toBe(1000);
    expect(after.notes).toBeNull();
    expect(after.lines.map((l) => l.description), "the priced scope is intact").toEqual(["Strip out", "First fix"]);
  });

  it("an edit to an approved/sent quote reverts it to pending_approval in the SAME transaction", async () => {
    const id = await makeQuote("sent");
    const res = await rpc(userClient(adminToken)).rpc("replace_quote_content", {
      p_org_id: orgId,
      p_quote_id: id,
      p_header: NEW_HEADER(customerId),
      p_lines: NEW_LINES,
    });
    expect(res.error, res.error?.message).toBeNull();
    expect((res.data as { status?: string }).status).toBe("pending_approval");
    expect((await state(id)).status).toBe("pending_approval");
  });

  it("an ACCEPTED quote is frozen: refused before anything is touched (no line can be deleted)", async () => {
    const id = await makeQuote("sent");
    expect(
      (await svc().from("quotes").update({ status: "accepted", accepted_at: new Date().toISOString() }).eq("id", id)).error,
    ).toBeNull();
    const res = await rpc(userClient(adminToken)).rpc("replace_quote_content", {
      p_org_id: orgId,
      p_quote_id: id,
      p_header: NEW_HEADER(customerId),
      p_lines: NEW_LINES,
    });
    expect(res.error).not.toBeNull();
    const after = await state(id);
    expect(after.subtotal).toBe(1000);
    // The old sequence's DELETE was not covered by the freeze trigger (it guards
    // INSERT/UPDATE only), so an edit racing an acceptance could strip the lines
    // of an accepted quote. Here they are provably still present.
    expect(after.lines).toHaveLength(2);
  });

  it("concurrent edit vs acceptance: the quote ends CONSISTENT — never accepted with missing lines", async () => {
    for (let i = 0; i < 4; i++) {
      const id = await makeQuote("sent");
      const [edit] = await Promise.all([
        rpc(userClient(adminToken)).rpc("replace_quote_content", {
          p_org_id: orgId,
          p_quote_id: id,
          p_header: NEW_HEADER(customerId),
          p_lines: NEW_LINES,
        }),
        svc().from("quotes").update({ status: "accepted", accepted_at: new Date().toISOString() }).eq("id", id),
      ]);
      const after = await state(id);
      if (edit.error) {
        // Acceptance won: the edit was refused whole → original scope intact.
        expect(after.subtotal).toBe(1000);
        expect(after.lines).toHaveLength(2);
      } else {
        // The edit won: the new scope is complete (3 lines for the new totals).
        expect(after.subtotal).toBe(1500);
        expect(after.lines).toHaveLength(3);
      }
    }
  });

  it("tenant fence: wrong org pin, a non-member and anon are refused and change nothing", async () => {
    const id = await makeQuote("draft");
    const args = { p_quote_id: id, p_header: NEW_HEADER(customerId), p_lines: NEW_LINES };
    // Right quote, WRONG active org (admin is not a member of otherOrg).
    const wrongOrg = await rpc(userClient(adminToken)).rpc("replace_quote_content", { p_org_id: otherOrgId, ...args });
    expect(wrongOrg.error?.code).toBe("42501");
    const anon = await rpc(anonClient()).rpc("replace_quote_content", { p_org_id: orgId, ...args });
    expect(anon.error).not.toBeNull();
    const after = await state(id);
    expect(after.subtotal).toBe(1000);
    expect(after.lines).toHaveLength(2);
  });
});
