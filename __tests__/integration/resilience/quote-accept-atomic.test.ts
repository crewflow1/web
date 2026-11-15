import { afterAll, beforeAll, expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient, userClient } from "../_harness";
import { acceptQuoteByToken } from "@/app/(app)/quotes/actions";

/**
 * QUOTE ACCEPTANCE — the job + invoice an accepted quote implies are created
 * ATOMICALLY and EXACTLY ONCE (migration 20261324000000,
 * `ensure_accepted_quote_artifacts`). Real Postgres, real concurrency.
 *
 * What this file proves, and what each case looked like BEFORE the fix (the
 * artifacts were a chain of separate PostgREST statements: insert job → update
 * quote.job_id → read invoice → allocate number → insert invoice):
 *
 *   1. DUPLICATE JOB. Two simultaneous re-accepts of an accepted quote that has
 *      no job yet each read `job_id IS NULL` and each inserted a job — two jobs
 *      for one agreement (the invoice was protected by its unique index; the job
 *      had nothing). Reachable by a double-tap on the public accept button
 *      landing inside the first accept's own window.
 *   2. INVOICE-NUMBER RACE → INVOICE-LESS ACCEPTED QUOTE. `next_invoice_number`
 *      is max()+1 with no lock, so two DIFFERENT quotes of one org accepted at
 *      the same moment are handed the SAME number; the loser's insert hits
 *      invoices_org_number_key and was only logged — the customer saw "accepted"
 *      and the business got no invoice.
 *   3. HALF-WRITTEN ACCEPT. When the invoice step failed, the job (and its
 *      backlink) had already been committed: an accepted quote with a job and no
 *      invoice. Now the step is one transaction — all of it or none of it — and
 *      a later accept heals it.
 */

type Res<T> = { data: T | null; error: { message: string; code?: string } | null };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = (c: unknown) => c as unknown as { from(t: string): any };
const rpc = (c: unknown) =>
  c as unknown as { rpc(fn: string, args: Record<string, unknown>): PromiseLike<Res<unknown>> };
const svc = () => db(serviceClient());
const TOKEN = `resilience-qacc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

let orgId = "";
let poisonOrgId = "";
let otherOrgId = "";
let customerId = "";
let poisonCustomerId = "";
const userIds: string[] = [];

async function makeOrg(suffix: string): Promise<string> {
  const r = await svc()
    .from("organizations")
    .insert({ name: `Resilience QAcc ${suffix} ${TOKEN}`, slug: `${TOKEN}-${suffix}` })
    .select("id")
    .single();
  expect(r.error, r.error?.message).toBeNull();
  return r.data.id as string;
}

async function makeCustomer(org: string): Promise<string> {
  const r = await svc().from("customers").insert({ org_id: org, name: "Resilience Customer" }).select("id").single();
  expect(r.error, r.error?.message).toBeNull();
  return r.data.id as string;
}

let seq = 0;
async function makeQuote(
  org: string,
  customer: string,
  status: "sent" | "accepted",
  opts: { lines?: boolean } = {},
): Promise<{ id: string; token: string }> {
  seq += 1;
  const token = `tok_${TOKEN}_${seq}`;
  // Insert as 'sent' first so line items can be attached (they freeze once
  // accepted_at is stamped), then flip to accepted WITHOUT a job/invoice — the
  // exact shape a partial first accept leaves behind.
  const q = await svc()
    .from("quotes")
    .insert({
      org_id: org,
      customer_id: customer,
      number: `Q-${TOKEN}-${seq}`,
      status: "sent",
      subtotal: 1000,
      vat_total: 200,
      public_token: token,
    })
    .select("id")
    .single();
  expect(q.error, q.error?.message).toBeNull();
  const id = q.data.id as string;
  if (opts.lines) {
    const li = await svc().from("quote_line_items").insert([
      { quote_id: id, org_id: org, description: "First fix", qty: 1, unit: "ea", unit_price: 600, vat_rate: 20, line_total: 600, sort_order: 0 },
      { quote_id: id, org_id: org, description: "Second fix", qty: 2, unit: "ea", unit_price: 200, vat_rate: 20, line_total: 400, sort_order: 1 },
    ]);
    expect(li.error, li.error?.message).toBeNull();
  }
  if (status === "accepted") {
    const u = await svc()
      .from("quotes")
      .update({ status: "accepted", accepted_at: new Date().toISOString() })
      .eq("id", id);
    expect(u.error, u.error?.message).toBeNull();
  }
  return { id, token };
}

async function jobsFor(org: string): Promise<{ id: string }[]> {
  const r = (await svc().from("jobs").select("id").eq("org_id", org)) as Res<{ id: string }[]>;
  expect(r.error, r.error?.message).toBeNull();
  return r.data ?? [];
}

async function invoicesForQuote(quoteId: string): Promise<
  { id: string; number: string; amount: number; vat_total: number; job_id: string | null; status: string; due_date: string | null; customer_id: string | null }[]
> {
  const r = await svc()
    .from("invoices")
    .select("id, number, amount, vat_total, job_id, status, due_date, customer_id")
    .eq("quote_id", quoteId);
  expect(r.error, r.error?.message).toBeNull();
  return r.data ?? [];
}

async function makeUser(suffix: string): Promise<{ id: string; token: string }> {
  const email = `${TOKEN}-${suffix}@example.test`;
  const password = `Pw-${TOKEN}-${suffix}-${Math.random().toString(36).slice(2)}`;
  const created = await serviceClient().auth.admin.createUser({ email, password, email_confirm: true });
  expect(created.error, created.error?.message).toBeNull();
  const id = created.data.user?.id ?? "";
  userIds.push(id);
  const mirrored = await svc().from("users").insert({ id, email, full_name: `Resilience ${suffix}` }).select("id").single();
  expect(mirrored.error, mirrored.error?.message).toBeNull();
  const signedIn = await anonClient().auth.signInWithPassword({ email, password });
  expect(signedIn.error, signedIn.error?.message).toBeNull();
  return { id, token: signedIn.data.session?.access_token ?? "" };
}

beforeAll(async () => {
  orgId = await makeOrg("main");
  poisonOrgId = await makeOrg("poison");
  otherOrgId = await makeOrg("other");
  customerId = await makeCustomer(orgId);
  poisonCustomerId = await makeCustomer(poisonOrgId);
});

afterAll(async () => {
  for (const org of [orgId, poisonOrgId, otherOrgId]) {
    if (!org) continue;
    await svc().from("invoices").delete().eq("org_id", org);
    await svc().from("organizations").delete().eq("id", org);
  }
  for (const id of userIds) {
    await svc().from("users").delete().eq("id", id);
    await serviceClient().auth.admin.deleteUser(id);
  }
});

describeIntegration("quote acceptance · job + invoice are atomic and exactly-once", () => {
  it("first accept: ONE job + ONE draft invoice mirroring the quote, linked both ways, lines snapshotted", async () => {
    const q = await makeQuote(orgId, customerId, "sent", { lines: true });
    const before = (await jobsFor(orgId)).length;

    const res = await acceptQuoteByToken(q.token, "Resilience Signer", null);
    expect(res.ok, JSON.stringify(res)).toBe(true);

    const inv = await invoicesForQuote(q.id);
    expect(inv).toHaveLength(1);
    expect(Number(inv[0]!.amount)).toBe(1000);
    expect(Number(inv[0]!.vat_total)).toBe(200);
    expect(inv[0]!.status).toBe("draft");
    // Denormalised customer anchor (Issue #349): stamped from the quote.
    expect(inv[0]!.customer_id).toBe(customerId);
    expect(inv[0]!.number).toMatch(/^INV-\d+$/);
    // net-14 default: a concrete calendar date, never blank.
    expect(inv[0]!.due_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    const quote = await svc().from("quotes").select("job_id, status").eq("id", q.id).single();
    expect(quote.data.status).toBe("accepted");
    expect(quote.data.job_id, "quote carries the job backlink").toBeTruthy();
    expect(inv[0]!.job_id, "invoice is linked to the SAME job").toBe(quote.data.job_id);
    expect((await jobsFor(orgId)).length - before, "exactly one job created").toBe(1);

    const lines = await svc().from("invoice_line_items").select("description").eq("invoice_id", inv[0]!.id);
    expect((lines.data ?? []).length, "invoice line snapshot copied from the quote").toBe(2);
  });

  it("two SIMULTANEOUS re-accepts of a job-less accepted quote create EXACTLY ONE job and ONE invoice", async () => {
    const q = await makeQuote(orgId, customerId, "accepted");
    const before = (await jobsFor(orgId)).length;

    const results = await Promise.all([
      acceptQuoteByToken(q.token, "Concurrent A", null),
      acceptQuoteByToken(q.token, "Concurrent B", null),
      acceptQuoteByToken(q.token, "Concurrent C", null),
    ]);
    for (const r of results) expect(r.ok, JSON.stringify(r)).toBe(true);

    expect((await jobsFor(orgId)).length - before, "no duplicate job from a concurrent re-accept").toBe(1);
    const inv = await invoicesForQuote(q.id);
    expect(inv).toHaveLength(1);
    const quote = await svc().from("quotes").select("job_id").eq("id", q.id).single();
    expect(inv[0]!.job_id).toBe(quote.data.job_id);
  });

  it("DIFFERENT quotes of one org accepted at the same moment ALL get an invoice (no number-race loser)", async () => {
    const quotes = await Promise.all(
      Array.from({ length: 5 }, () => makeQuote(orgId, customerId, "sent")),
    );
    const results = await Promise.all(
      quotes.map((q, i) => acceptQuoteByToken(q.token, `Racer ${i}`, null)),
    );
    for (const r of results) expect(r.ok, JSON.stringify(r)).toBe(true);

    const numbers: string[] = [];
    for (const q of quotes) {
      const inv = await invoicesForQuote(q.id);
      expect(inv, `quote ${q.id} must not be left accepted-but-invoice-less`).toHaveLength(1);
      numbers.push(inv[0]!.number);
    }
    expect(new Set(numbers).size, "every invoice has its own number").toBe(quotes.length);
  });

  it("a failing invoice step leaves NO half-written job — and the next accept heals it", async () => {
    // FAULT INJECTION, scoped to a throwaway org: an invoice whose numeric suffix
    // overflows the allocator's int cast makes next_invoice_number raise for THIS
    // org only. The job insert that precedes it must roll back with it.
    const poison = await svc()
      .from("invoices")
      .insert({ org_id: poisonOrgId, number: "INV-99999999999", amount: 1, vat_total: 0, status: "draft" })
      .select("id")
      .single();
    expect(poison.error, poison.error?.message).toBeNull();

    const q = await makeQuote(poisonOrgId, poisonCustomerId, "sent");
    const res = await acceptQuoteByToken(q.token, "Poisoned", null);
    // Acceptance itself is recorded (the customer's decision is never lost)…
    expect(res.ok, JSON.stringify(res)).toBe(true);
    const afterFail = await svc().from("quotes").select("status, job_id").eq("id", q.id).single();
    expect(afterFail.data.status).toBe("accepted");
    // …but the artifacts are all-or-nothing: no invoice ⇒ no orphan job either.
    expect(await invoicesForQuote(q.id)).toHaveLength(0);
    expect(afterFail.data.job_id, "no dangling job backlink").toBeNull();
    expect(await jobsFor(poisonOrgId), "no orphan job from the failed step").toHaveLength(0);

    // Clear the fault; a re-accept (customer reload / owner retry) HEALS: one job, one invoice.
    await svc().from("invoices").delete().eq("id", poison.data.id);
    const again = await acceptQuoteByToken(q.token, "Poisoned", null);
    expect(again.ok).toBe(true);
    expect(await jobsFor(poisonOrgId)).toHaveLength(1);
    const inv = await invoicesForQuote(q.id);
    expect(inv).toHaveLength(1);
    const healed = await svc().from("quotes").select("job_id").eq("id", q.id).single();
    expect(inv[0]!.job_id).toBe(healed.data.job_id);
  });

  it("the RPC is tenant-fenced: refuses a non-accepted quote, a wrong org, a non-member and anon", async () => {
    const sent = await makeQuote(orgId, customerId, "sent");
    const notAccepted = await rpc(serviceClient()).rpc("ensure_accepted_quote_artifacts", {
      p_org_id: orgId,
      p_quote_id: sent.id,
    });
    expect(notAccepted.error, "a quote that is not accepted must not be invoiced").not.toBeNull();
    expect(await invoicesForQuote(sent.id)).toHaveLength(0);

    const accepted = await makeQuote(orgId, customerId, "accepted");
    // Right quote, WRONG org pin → not found (never re-homed into another tenant).
    const wrongOrg = await rpc(serviceClient()).rpc("ensure_accepted_quote_artifacts", {
      p_org_id: otherOrgId,
      p_quote_id: accepted.id,
    });
    expect(wrongOrg.error).not.toBeNull();

    // A signed-in user who is NOT a member of the org.
    const outsider = await makeUser("outsider");
    const denied = await rpc(userClient(outsider.token)).rpc("ensure_accepted_quote_artifacts", {
      p_org_id: orgId,
      p_quote_id: accepted.id,
    });
    expect(denied.error?.code).toBe("42501");

    const anon = await rpc(anonClient()).rpc("ensure_accepted_quote_artifacts", {
      p_org_id: orgId,
      p_quote_id: accepted.id,
    });
    expect(anon.error).not.toBeNull();
    expect(await invoicesForQuote(accepted.id), "no refused caller created anything").toHaveLength(0);

    // An ADMIN member of the org, through the user-JWT (RLS) client — the owner path.
    const admin = await makeUser("admin");
    const mem = await svc().from("memberships").insert({ org_id: orgId, user_id: admin.id, role: "admin" });
    expect(mem.error, mem.error?.message).toBeNull();
    const ok = await rpc(userClient(admin.token)).rpc("ensure_accepted_quote_artifacts", {
      p_org_id: orgId,
      p_quote_id: accepted.id,
    });
    expect(ok.error, ok.error?.message).toBeNull();
    expect((ok.data as { created_invoice?: boolean }).created_invoice).toBe(true);
    expect(await invoicesForQuote(accepted.id)).toHaveLength(1);

    // Idempotent: a second call reuses, creates nothing.
    const replay = await rpc(userClient(admin.token)).rpc("ensure_accepted_quote_artifacts", {
      p_org_id: orgId,
      p_quote_id: accepted.id,
    });
    expect(replay.error, replay.error?.message).toBeNull();
    expect((replay.data as { created_invoice?: boolean; created_job?: boolean }).created_invoice).toBe(false);
    expect((replay.data as { created_job?: boolean }).created_job).toBe(false);
    expect(await invoicesForQuote(accepted.id)).toHaveLength(1);
  });
});
