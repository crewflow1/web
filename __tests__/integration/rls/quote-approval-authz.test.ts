import { afterAll, beforeAll, expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient, userClient } from "../_harness";

/**
 * QUOTE APPROVAL AUTHZ against real Postgres (migration 20261090000000).
 *
 * The owner/admin approval gate on quotes was enforced ONLY in the server
 * action (`requireQuoteApprover`). RLS on `quotes` is member-level
 * (`org_id in (select current_org_ids())`), so a STAFF-role JWT could skip the
 * UI and drive a quote to 'approved'/'sent' or stamp approval provenance
 * straight through PostgREST. This file proves the SAME gate now holds at the
 * DATABASE with a BEFORE UPDATE trigger, without breaking one legitimate flow.
 *
 * The proofs, one per case (numbered to match the ship-gate):
 *   1  staff self-approve (→ 'approved')            → REJECTED, status unchanged
 *   2  staff stamps approved_by = self              → REJECTED, provenance unchanged
 *   3  staff draft → sent (gate bypass)             → REJECTED
 *   4  admin approves (status + approved_by/_at)    → SUCCEEDS
 *   5  staff sends an already-APPROVED quote        → SUCCEEDS (legit)
 *   6  staff edit-reverts an approved quote to null → SUCCEEDS (legit)
 *   7  staff submits a draft for approval           → SUCCEEDS (legit)
 *   8  staff edits a plain draft field              → SUCCEEDS (legit)
 *   9  customer-accept via SERVICE ROLE (exempt)    → SUCCEEDS (legit)
 *
 * MUTATION PROOF. Cases 1–3 are the security arms; cases 4–9 protect the
 * legitimate flows. A reviewer can confirm the trigger is load-bearing by
 * dropping it and re-running:
 *
 *     drop trigger enforce_quote_approval_authz on public.quotes;
 *
 * With the trigger gone, cases 1, 2 and 3 flip GREEN (the staff writes now
 * succeed) — i.e. the assertions in this file are the only thing standing
 * between a staff JWT and a self-approved/un-approved-but-sent quote. Cases
 * 4–9 stay green either way (they are the flows the trigger must NOT touch), so
 * the drop isolates exactly what the trigger is responsible for. The drop is
 * described, not automated, so the committed suite always runs with the real
 * schema.
 */

type Res<T> = { data: T | null; error: { message: string; code?: string } | null };
type Row = Record<string, unknown>;
interface Sel extends PromiseLike<Res<Row[]>> {
  select(columns?: string): Sel;
  eq(column: string, value: unknown): Sel;
  maybeSingle(): PromiseLike<Res<Row>>;
}
interface Ins extends PromiseLike<Res<Row[]>> {
  select(columns?: string): { single(): PromiseLike<Res<Row>> };
}
interface Upd extends PromiseLike<Res<null>> {
  eq(column: string, value: unknown): Upd;
}
interface Table {
  select(columns?: string): Sel;
  insert(rows: Row | Row[]): Ins;
  update(patch: Row): Upd;
  delete(): Upd;
}
const db = (client: unknown) => client as unknown as { from(t: string): Table };

const TOKEN = `it-qauthz-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describeIntegration("quote approval authz · DB-layer owner/admin gate", () => {
  let orgA = "";
  let customerA = "";
  let adminId = "";
  let adminToken = "";
  let staffId = "";
  let staffToken = "";
  let quoteSeq = 0;

  const svc = () => db(serviceClient());

  async function makeUser(suffix: string): Promise<{ id: string; token: string }> {
    const email = `${TOKEN}-${suffix}@example.test`;
    const password = `Pw-${TOKEN}-${suffix}-${Math.random().toString(36).slice(2)}`;
    const created = await serviceClient().auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    expect(created.error, created.error?.message).toBeNull();
    const id = created.data.user?.id ?? "";
    const mirrored = await svc()
      .from("users")
      .insert({ id, email, full_name: `QAuthz ${suffix}` })
      .select("id")
      .single();
    expect(mirrored.error, mirrored.error?.message).toBeNull();
    const signedIn = await anonClient().auth.signInWithPassword({ email, password });
    expect(signedIn.error, signedIn.error?.message).toBeNull();
    const token = signedIn.data.session?.access_token ?? "";
    if (!id || !token) throw new Error(`failed to mint user ${suffix}`);
    return { id, token };
  }

  /** Seed a quote via service_role (bypasses the trigger — it's exempt). */
  async function seedQuote(overrides: Row = {}): Promise<string> {
    quoteSeq += 1;
    const r = await svc()
      .from("quotes")
      .insert({
        org_id: orgA,
        customer_id: customerA,
        number: `${TOKEN}-Q${quoteSeq}`,
        status: "draft",
        ...overrides,
      })
      .select("id")
      .single();
    expect(r.error, r.error?.message).toBeNull();
    return String(r.data?.id ?? "");
  }

  async function statusOf(id: string): Promise<string> {
    const r = await svc().from("quotes").select("status").eq("id", id).maybeSingle();
    expect(r.error, r.error?.message).toBeNull();
    return String(r.data?.status ?? "");
  }

  beforeAll(async () => {
    const org = await svc()
      .from("organizations")
      .insert({ name: "QAuthz Probe", slug: `${TOKEN}-a` })
      .select("id")
      .single();
    expect(org.error, org.error?.message).toBeNull();
    orgA = String(org.data?.id ?? "");

    const cust = await svc()
      .from("customers")
      .insert({ org_id: orgA, name: "QAuthz Customer" })
      .select("id")
      .single();
    expect(cust.error, cust.error?.message).toBeNull();
    customerA = String(cust.data?.id ?? "");

    const admin = await makeUser("admin");
    adminId = admin.id;
    adminToken = admin.token;
    const staff = await makeUser("staff");
    staffId = staff.id;
    staffToken = staff.token;

    // Admin of org A (is_org_admin → true), plain staff of org A (member: passes
    // RLS UPDATE, so the trigger — not RLS — is what refuses the manager acts).
    const am = await svc()
      .from("memberships")
      .insert({ org_id: orgA, user_id: adminId, role: "admin" })
      .select("user_id")
      .single();
    expect(am.error, am.error?.message).toBeNull();
    const sm = await svc()
      .from("memberships")
      .insert({ org_id: orgA, user_id: staffId, role: "staff" })
      .select("user_id")
      .single();
    expect(sm.error, sm.error?.message).toBeNull();
  });

  afterAll(async () => {
    if (orgA) {
      const del = await svc().from("organizations").delete().eq("id", orgA);
      expect(del.error, `org teardown failed: ${JSON.stringify(del.error)}`).toBeNull();
    }
    for (const id of [adminId, staffId]) {
      if (id) await serviceClient().auth.admin.deleteUser(id);
    }
  });

  // ── security arms (the trigger's whole reason to exist) ────────────────────

  it("1 · staff self-approving a draft is REJECTED, and the status is unchanged", async () => {
    const id = await seedQuote();
    const res = await db(userClient(staffToken))
      .from("quotes")
      .update({ status: "approved" })
      .eq("id", id);
    expect(res.error, "a staff member must not be able to approve a quote").not.toBeNull();
    expect(res.error?.message ?? "").toMatch(/owner or admin/i);
    expect(await statusOf(id), "the rejected update must roll back").toBe("draft");
  });

  it("2 · staff stamping approved_by = self is REJECTED, and provenance is unchanged", async () => {
    const id = await seedQuote();
    const res = await db(userClient(staffToken))
      .from("quotes")
      .update({ approved_by: staffId })
      .eq("id", id);
    expect(res.error, "a staff member must not be able to stamp approval").not.toBeNull();
    expect(res.error?.message ?? "").toMatch(/owner or admin/i);
    const after = await svc().from("quotes").select("approved_by").eq("id", id).maybeSingle();
    expect(after.data?.approved_by ?? null, "approved_by must stay null").toBeNull();
  });

  it("3 · staff sending a DRAFT (draft → sent, gate bypass) is REJECTED", async () => {
    const id = await seedQuote();
    const res = await db(userClient(staffToken))
      .from("quotes")
      .update({ status: "sent" })
      .eq("id", id);
    expect(res.error, "an un-approved quote must not be sendable").not.toBeNull();
    expect(res.error?.message ?? "").toMatch(/approved before it can be sent/i);
    expect(await statusOf(id)).toBe("draft");
  });

  // ── legitimate flows the trigger must NOT break (fail here ⇒ DO NOT SHIP) ──

  it("4 · an admin approving (status + approved_by + approved_at) SUCCEEDS", async () => {
    const id = await seedQuote({ status: "pending_approval" });
    const res = await db(userClient(adminToken))
      .from("quotes")
      .update({
        status: "approved",
        approved_by: adminId,
        approved_at: new Date().toISOString(),
      })
      .eq("id", id);
    expect(res.error, JSON.stringify(res.error)).toBeNull();
    expect(await statusOf(id)).toBe("approved");
  });

  it("5 · staff SENDING an already-approved quote (approved → sent) SUCCEEDS", async () => {
    const id = await seedQuote({ status: "approved", approved_by: adminId });
    const res = await db(userClient(staffToken))
      .from("quotes")
      .update({ status: "sent" })
      .eq("id", id);
    expect(res.error, JSON.stringify(res.error)).toBeNull();
    expect(await statusOf(id)).toBe("sent");
  });

  it("6 · staff edit-reverting an approved quote (→ pending, approved_by → null) SUCCEEDS", async () => {
    const id = await seedQuote({
      status: "approved",
      approved_by: adminId,
      approved_at: new Date().toISOString(),
    });
    const res = await db(userClient(staffToken))
      .from("quotes")
      .update({ status: "pending_approval", approved_by: null, approved_at: null })
      .eq("id", id);
    expect(res.error, JSON.stringify(res.error)).toBeNull();
    expect(await statusOf(id)).toBe("pending_approval");
    const after = await svc().from("quotes").select("approved_by").eq("id", id).maybeSingle();
    expect(after.data?.approved_by ?? null).toBeNull();
  });

  it("7 · staff submitting a draft for approval (draft → pending_approval) SUCCEEDS", async () => {
    const id = await seedQuote();
    const res = await db(userClient(staffToken))
      .from("quotes")
      .update({ status: "pending_approval" })
      .eq("id", id);
    expect(res.error, JSON.stringify(res.error)).toBeNull();
    expect(await statusOf(id)).toBe("pending_approval");
  });

  it("8 · staff editing a plain draft field (notes) leaving status draft SUCCEEDS", async () => {
    const id = await seedQuote();
    const res = await db(userClient(staffToken))
      .from("quotes")
      .update({ notes: "revised scope note" })
      .eq("id", id);
    expect(res.error, JSON.stringify(res.error)).toBeNull();
    const after = await svc().from("quotes").select("status, notes").eq("id", id).maybeSingle();
    expect(String(after.data?.status)).toBe("draft");
    expect(String(after.data?.notes)).toBe("revised scope note");
  });

  it("9 · customer-accept via SERVICE ROLE (sent → accepted) SUCCEEDS — service_role is exempt", async () => {
    const id = await seedQuote({ status: "sent", approved_by: adminId });
    const res = await svc()
      .from("quotes")
      .update({ status: "accepted", accepted_at: new Date().toISOString() })
      .eq("id", id);
    expect(res.error, JSON.stringify(res.error)).toBeNull();
    expect(await statusOf(id)).toBe("accepted");
  });

  // ── INSERT arm: the gate must hold on creation too, not only on UPDATE.
  // A BEFORE UPDATE-only trigger let a staff JWT skip the gate by CREATING a
  // quote already at 'approved'/'sent'. These prove the INSERT path is closed.
  // The staff INSERT must satisfy the member-insert RLS policy (org_id), which
  // it does — staff is a member of orgA — so the REFUSAL is the trigger, not RLS.

  it("10 · staff INSERTing a quote already 'approved' (self-approval on create) is REJECTED", async () => {
    const res = await db(userClient(staffToken))
      .from("quotes")
      .insert({
        org_id: orgA,
        customer_id: customerA,
        number: `${TOKEN}-INS-APPROVED`,
        status: "approved",
        approved_by: staffId,
      })
      .select("id")
      .single();
    expect(res.error, "staff must not create an already-approved quote").not.toBeNull();
    expect(res.error?.message ?? "").toMatch(/owner or admin/i);
  });

  it("11 · staff INSERTing a quote already 'sent' (un-approved → customer) is REJECTED", async () => {
    const res = await db(userClient(staffToken))
      .from("quotes")
      .insert({
        org_id: orgA,
        customer_id: customerA,
        number: `${TOKEN}-INS-SENT`,
        status: "sent",
      })
      .select("id")
      .single();
    expect(res.error, "staff must not create an already-sent quote").not.toBeNull();
    expect(res.error?.message ?? "").toMatch(/approved before it can be sent/i);
  });

  it("12 · staff INSERTing a draft that stamps approved_by is REJECTED", async () => {
    const res = await db(userClient(staffToken))
      .from("quotes")
      .insert({
        org_id: orgA,
        customer_id: customerA,
        number: `${TOKEN}-INS-STAMP`,
        status: "draft",
        approved_by: staffId,
      })
      .select("id")
      .single();
    expect(res.error, "staff must not stamp approval provenance on create").not.toBeNull();
    expect(res.error?.message ?? "").toMatch(/owner or admin/i);
  });

  it("13 · staff INSERTing a plain DRAFT (the real createQuote path) SUCCEEDS", async () => {
    const res = await db(userClient(staffToken))
      .from("quotes")
      .insert({
        org_id: orgA,
        customer_id: customerA,
        number: `${TOKEN}-INS-DRAFT`,
        status: "draft",
      })
      .select("id")
      .single();
    expect(res.error, JSON.stringify(res.error)).toBeNull();
    expect(String(res.data?.id ?? "")).not.toBe("");
  });
});
