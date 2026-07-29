import { afterAll, beforeAll, expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient, userClient } from "../_harness";

/**
 * AI Quote Writer drafts · isolation, lifecycle, evidence integrity (20261068).
 *
 * `ai_quote_drafts` holds a customer's description of their work and a model's
 * proposal about it, so it is sensitive in the ordinary tenant-isolation way.
 * But the interesting properties here are the ones that make the row EVIDENCE
 * rather than a scratchpad, and every one of them is enforced by a trigger
 * precisely because the service-role client bypasses RLS — a guard living only
 * in TypeScript would be a convention that any future caller could route round:
 *
 *   - what the MODEL said never changes, and is kept separate from what the
 *     HUMAN applied;
 *   - applied and discarded are TERMINAL;
 *   - discard is a STATUS, never a delete, so "a human rejected this" survives;
 *   - a draft cannot be anchored to another tenant's quote or lead;
 *   - and none of it blocks user deletion or org teardown.
 *
 * The last one matters more than it sounds: an immutability guard that refuses
 * the UPDATE Postgres uses to implement `on delete set null` makes personal
 * data undeletable — the failure 20261052 was written to fix.
 */

type Err = { message: string; code?: string } | null;
type Res<T> = { data: T | null; error: Err };
type Row = Record<string, unknown>;

interface Sel extends PromiseLike<Res<Row[]>> {
  eq(column: string, value: unknown): Sel;
}
interface Upd extends PromiseLike<Res<null>> {
  eq(column: string, value: unknown): Upd;
}
interface Del extends PromiseLike<Res<null>> {
  eq(column: string, value: unknown): Del;
}
interface Ins extends PromiseLike<Res<Row[]>> {
  select(columns?: string): { single(): PromiseLike<Res<Row>> };
}
interface Table {
  select(columns?: string): Sel;
  insert(rows: Row | Row[]): Ins;
  update(row: Row): Upd;
  delete(): Del;
}
const db = (client: unknown) => client as unknown as { from(t: string): Table };

const T = `it-aiqd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const HEX = (c: string) => c.repeat(64);

/** A complete, valid draft row. Individual tests override one field at a time. */
function draftRow(orgId: string, quoteId: string, over: Row = {}): Row {
  return {
    org_id: orgId,
    quote_id: quoteId,
    content: { title: "Bathroom refit", line_items: [] },
    provenance: "anthropic",
    model: "test-model",
    prompt_version: "quote_writer:v1",
    prompt_checksum: HEX("a"),
    schema_version: 1,
    context_fields: ["work_description"],
    invocation_hash: HEX("c"),
    ...over,
  };
}

describeIntegration("ai_quote_drafts · isolation + lifecycle (20261068)", () => {
  const svc = () => db(serviceClient());

  let orgA = "";
  let orgB = "";
  let quoteA = "";
  let quoteB = "";
  let memberA = { id: "", token: "" };
  let memberB = { id: "", token: "" };

  async function makeUser(suffix: string): Promise<{ id: string; token: string }> {
    const email = `${T}-${suffix}@example.test`;
    const password = `Pw-${T}-${suffix}-${Math.random().toString(36).slice(2)}`;
    const created = await serviceClient().auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    expect(created.error, created.error?.message).toBeNull();
    const id = created.data.user?.id ?? "";
    const mirrored = await svc()
      .from("users")
      .insert({ id, email, full_name: `Quote Writer ${suffix}` })
      .select("id")
      .single();
    expect(mirrored.error, mirrored.error?.message).toBeNull();
    const signedIn = await anonClient().auth.signInWithPassword({ email, password });
    expect(signedIn.error, signedIn.error?.message).toBeNull();
    const token = signedIn.data.session?.access_token ?? "";
    if (!id || !token) throw new Error(`failed to mint user ${suffix}`);
    return { id, token };
  }

  async function makeOrgWithQuote(label: string): Promise<{ org: string; quote: string }> {
    const o = await svc()
      .from("organizations")
      .insert({ name: `Quote Writer ${label}`, slug: `${T}-${label}` })
      .select("id")
      .single();
    expect(o.error, o.error?.message).toBeNull();
    const org = String(o.data?.id ?? "");

    const c = await svc()
      .from("customers")
      .insert({ org_id: org, name: `Customer ${label}` })
      .select("id")
      .single();
    expect(c.error, c.error?.message).toBeNull();

    const q = await svc()
      .from("quotes")
      .insert({
        org_id: org,
        customer_id: String(c.data?.id ?? ""),
        number: `${T}-${label}-1`,
        status: "draft",
        subtotal: 0,
        vat_total: 0,
        total: 0,
      })
      .select("id")
      .single();
    expect(q.error, q.error?.message).toBeNull();
    return { org, quote: String(q.data?.id ?? "") };
  }

  beforeAll(async () => {
    const a = await makeOrgWithQuote("a");
    const b = await makeOrgWithQuote("b");
    orgA = a.org;
    quoteA = a.quote;
    orgB = b.org;
    quoteB = b.quote;
    if (!orgA || !orgB || !quoteA || !quoteB) throw new Error("failed to create fixtures");

    memberA = await makeUser("member-a");
    memberB = await makeUser("member-b");
    for (const [org, user] of [
      [orgA, memberA.id],
      [orgB, memberB.id],
    ] as const) {
      const m = await svc()
        .from("memberships")
        .insert({ org_id: org, user_id: user, role: "staff" })
        .select("user_id")
        .single();
      expect(m.error, m.error?.message).toBeNull();
    }
  });

  afterAll(async () => {
    if (orgA) await svc().from("organizations").delete().eq("id", orgA);
    if (orgB) await svc().from("organizations").delete().eq("id", orgB);
    for (const u of [memberA.id, memberB.id]) {
      if (u) await serviceClient().auth.admin.deleteUser(u);
    }
  });

  // ── 1. The shape refuses incoherent rows ─────────────────────────────────

  it("refuses a draft with no anchor — an unreachable row nobody can find", async () => {
    const { error } = await svc()
      .from("ai_quote_drafts")
      .insert(draftRow(orgA, quoteA, { quote_id: null, lead_id: null }))
      .select("id")
      .single();
    expect(error?.message ?? "").toMatch(/anchor_check/i);
  });

  it("refuses provenance 'deterministic' — there is no computable fallback", async () => {
    // The asymmetry with every other governed capability, enforced by the DB:
    // a row here can only exist because a model produced it.
    const { error } = await svc()
      .from("ai_quote_drafts")
      .insert(draftRow(orgA, quoteA, { provenance: "deterministic" }))
      .select("id")
      .single();
    expect(error?.message ?? "").toMatch(/provenance_check/i);
  });

  it("refuses a non-hex prompt checksum", async () => {
    const { error } = await svc()
      .from("ai_quote_drafts")
      .insert(draftRow(orgA, quoteA, { prompt_checksum: "not-a-checksum" }))
      .select("id")
      .single();
    expect(error).not.toBeNull();
  });

  it("CROSS-TENANT: a draft cannot be anchored to another org's quote", async () => {
    // RLS checks only the row's own org_id. Without the integrity trigger a
    // member of org A could POST a draft against org B's quote via PostgREST.
    const { error } = await svc()
      .from("ai_quote_drafts")
      .insert(draftRow(orgA, quoteB))
      .select("id")
      .single();
    expect(error?.message ?? "").toMatch(/is not in this org/i);
  });

  // ── 2. Tenant isolation ──────────────────────────────────────────────────

  it("a member reads their OWN org's drafts and not another's", async () => {
    const seeded = await svc()
      .from("ai_quote_drafts")
      .insert([draftRow(orgA, quoteA), draftRow(orgB, quoteB, { prompt_checksum: HEX("b") })]);
    expect(seeded.error, seeded.error?.message).toBeNull();

    const { data, error } = await db(userClient(memberA.token))
      .from("ai_quote_drafts")
      .select("id, org_id");
    expect(error, error?.message).toBeNull();
    expect((data ?? []).length).toBeGreaterThan(0);
    for (const row of data ?? []) expect(String(row.org_id)).toBe(orgA);
  });

  it("anon is denied entirely", async () => {
    const { data, error } = await db(anonClient()).from("ai_quote_drafts").select("*");
    expect(error ? true : (data ?? []).length === 0, "drafts leaked to anon").toBe(true);
  });

  it("a member cannot INSERT into another org", async () => {
    const { error } = await db(userClient(memberA.token))
      .from("ai_quote_drafts")
      .insert(draftRow(orgB, quoteB, { prompt_checksum: HEX("e") }))
      .select("id")
      .single();
    expect(error, "org A planted a draft in org B").not.toBeNull();
  });

  it("a member cannot UPDATE another org's draft", async () => {
    const created = await svc()
      .from("ai_quote_drafts")
      .insert(draftRow(orgB, quoteB, { prompt_checksum: HEX("f") }))
      .select("id")
      .single();
    expect(created.error, created.error?.message).toBeNull();
    const id = String(created.data?.id ?? "");

    await db(userClient(memberA.token))
      .from("ai_quote_drafts")
      .update({ status: "discarded", discarded_at: new Date().toISOString() })
      .eq("id", id);

    const after = await svc().from("ai_quote_drafts").select("status").eq("id", id);
    expect(String((after.data ?? [])[0]?.status)).toBe("draft");
  });

  // ── 3. The row is EVIDENCE ───────────────────────────────────────────────

  it("what the MODEL said is immutable", async () => {
    const created = await svc()
      .from("ai_quote_drafts")
      .insert(draftRow(orgA, quoteA, { prompt_checksum: HEX("1") }))
      .select("id")
      .single();
    const id = String(created.data?.id ?? "");

    const { error } = await svc()
      .from("ai_quote_drafts")
      .update({ content: { title: "Tampered" } })
      .eq("id", id);
    expect(error?.message ?? "").toMatch(/immutable/i);
  });

  it("the provenance and the prompt that produced it are immutable", async () => {
    const created = await svc()
      .from("ai_quote_drafts")
      .insert(draftRow(orgA, quoteA, { prompt_checksum: HEX("2") }))
      .select("id")
      .single();
    const id = String(created.data?.id ?? "");

    for (const patch of [
      { prompt_checksum: HEX("9") },
      { provenance: "openai" },
      { context_fields: ["price_book"] },
      { invocation_hash: HEX("9") },
      { degraded: true },
    ]) {
      const { error } = await svc().from("ai_quote_drafts").update(patch).eq("id", id);
      expect(error?.message ?? "", JSON.stringify(patch)).toMatch(/immutable/i);
    }
  });

  it("applying WITHOUT recording what was applied is refused", async () => {
    const created = await svc()
      .from("ai_quote_drafts")
      .insert(draftRow(orgA, quoteA, { prompt_checksum: HEX("3") }))
      .select("id")
      .single();
    const id = String(created.data?.id ?? "");

    const { error } = await svc()
      .from("ai_quote_drafts")
      .update({ status: "applied", applied_at: new Date().toISOString() })
      .eq("id", id);
    expect(error).not.toBeNull();
  });

  it("a legitimate apply keeps BOTH versions — the model's and the human's", async () => {
    const created = await svc()
      .from("ai_quote_drafts")
      .insert(draftRow(orgA, quoteA, { prompt_checksum: HEX("4") }))
      .select("id")
      .single();
    const id = String(created.data?.id ?? "");

    const applied = await svc()
      .from("ai_quote_drafts")
      .update({
        status: "applied",
        applied_at: new Date().toISOString(),
        applied_by: memberA.id,
        applied_content: { title: "Bathroom refit, edited by a human", line_items: [] },
      })
      .eq("id", id);
    expect(applied.error, applied.error?.message).toBeNull();

    const { data } = await svc()
      .from("ai_quote_drafts")
      .select("status, content, applied_content")
      .eq("id", id);
    const row = (data ?? [])[0]!;
    expect(row.status).toBe("applied");
    // The pair is what answers "how much did the operator have to change?".
    expect((row.content as Row).title).toBe("Bathroom refit");
    expect((row.applied_content as Row).title).toBe("Bathroom refit, edited by a human");
  });

  it("TERMINAL IS TERMINAL — an applied draft cannot be re-applied or discarded", async () => {
    const created = await svc()
      .from("ai_quote_drafts")
      .insert(draftRow(orgA, quoteA, { prompt_checksum: HEX("5") }))
      .select("id")
      .single();
    const id = String(created.data?.id ?? "");
    await svc()
      .from("ai_quote_drafts")
      .update({
        status: "applied",
        applied_at: new Date().toISOString(),
        applied_content: { title: "v1" },
      })
      .eq("id", id);

    // Re-applying would let one generation overwrite a human's later edits.
    const reapply = await svc()
      .from("ai_quote_drafts")
      .update({ applied_content: { title: "v2" } })
      .eq("id", id);
    expect(reapply.error?.message ?? "").toMatch(/terminal|immutable/i);

    const flip = await svc()
      .from("ai_quote_drafts")
      .update({ status: "discarded", discarded_at: new Date().toISOString() })
      .eq("id", id);
    expect(flip.error?.message ?? "").toMatch(/terminal/i);
  });

  it("DISCARD IS A STATUS — the record of a rejected suggestion survives", async () => {
    const created = await svc()
      .from("ai_quote_drafts")
      .insert(draftRow(orgA, quoteA, { prompt_checksum: HEX("6") }))
      .select("id")
      .single();
    const id = String(created.data?.id ?? "");

    const discarded = await svc()
      .from("ai_quote_drafts")
      .update({
        status: "discarded",
        discarded_at: new Date().toISOString(),
        discarded_by: memberA.id,
      })
      .eq("id", id);
    expect(discarded.error, discarded.error?.message).toBeNull();

    const { data } = await svc().from("ai_quote_drafts").select("status, content").eq("id", id);
    expect((data ?? [])[0]?.status).toBe("discarded");
    // "AI proposed this and a human rejected it" is the most useful record this
    // table holds. A delete would destroy exactly that evidence.
    expect(((data ?? [])[0]?.content as Row).title).toBe("Bathroom refit");
  });

  it("a MEMBER cannot delete a draft — there is no DELETE policy at all", async () => {
    const created = await svc()
      .from("ai_quote_drafts")
      .insert(draftRow(orgA, quoteA, { prompt_checksum: HEX("7") }))
      .select("id")
      .single();
    const id = String(created.data?.id ?? "");

    await db(userClient(memberA.token)).from("ai_quote_drafts").delete().eq("id", id);
    const after = await svc().from("ai_quote_drafts").select("id").eq("id", id);
    expect((after.data ?? []).length, "a member deleted a draft").toBe(1);
  });

  // ── 4. …and none of it blocks erasure ────────────────────────────────────

  it("USER DELETION still works, and the draft survives anonymised", async () => {
    const doomed = await makeUser("doomed");
    await svc()
      .from("memberships")
      .insert({ org_id: orgA, user_id: doomed.id, role: "staff" })
      .select("user_id")
      .single();
    const created = await svc()
      .from("ai_quote_drafts")
      .insert(draftRow(orgA, quoteA, { prompt_checksum: HEX("8"), created_by: doomed.id }))
      .select("id")
      .single();
    const id = String(created.data?.id ?? "");

    // An immutability guard that refused this UPDATE would leave personal data
    // undeletable — the failure 20261052 exists to prevent.
    const removed = await serviceClient().auth.admin.deleteUser(doomed.id);
    expect(removed.error, removed.error?.message).toBeNull();
    await svc().from("users").delete().eq("id", doomed.id);

    const { data } = await svc()
      .from("ai_quote_drafts")
      .select("created_by, content")
      .eq("id", id);
    const row = (data ?? [])[0];
    expect(row, "the draft must survive its author's deletion").toBeTruthy();
    expect(row!.created_by).toBeNull();
    expect((row!.content as Row).title).toBe("Bathroom refit");
  });

  it("ORG TEARDOWN cascades — no guard blocks GDPR erasure", async () => {
    const temp = await makeOrgWithQuote("teardown");
    const created = await svc()
      .from("ai_quote_drafts")
      .insert(draftRow(temp.org, temp.quote, { prompt_checksum: HEX("0") }))
      .select("id")
      .single();
    expect(created.error, created.error?.message).toBeNull();

    const torn = await svc().from("organizations").delete().eq("id", temp.org);
    expect(torn.error, torn.error?.message).toBeNull();

    const { data } = await svc()
      .from("ai_quote_drafts")
      .select("id")
      .eq("id", String(created.data?.id ?? ""));
    expect((data ?? []).length).toBe(0);
  });
});
