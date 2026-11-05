import { beforeAll, expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient, userClient } from "../_harness";

/**
 * Tenant semantic search — INDEXING LIFECYCLE, against real Postgres.
 *
 * The retrieval + isolation properties live in tenant-search-semantic.test.ts.
 * This file proves the corpus LIFECYCLE that gate 5 asks for, with deterministic
 * unit-basis embedding fixtures (no provider call):
 *   • INDEXING — an inserted doc is retrievable (semantic + keyword).
 *   • UPDATE / DRIFT — changing content trips the drift trigger: embedding_status
 *     → 'pending', embedded_at → null, attempts reset, but the OLD vector is KEPT
 *     so the doc stays searchable until re-embedded (atomic-swap design).
 *   • DELETION — a deleted doc disappears from retrieval.
 *   • POST-UPDATE PERMISSION — raising a doc's visibility to 'management' hides it
 *     from staff immediately (restricted-document access survives an edit).
 *   • CROSS-ORG — an edit never makes a doc visible to another tenant.
 */

const DIM = 1536;
const VERSION = "test-v1";
const vecLiteral = (pos: number) => { const a = new Array<number>(DIM).fill(0); a[pos - 1] = 1; return `[${a.join(",")}]`; };
const vecArray = (pos: number) => { const a = new Array<number>(DIM).fill(0); a[pos - 1] = 1; return a; };

type Row = Record<string, unknown>;
type Res<T = Row> = { data: T | null; error: { message: string; code?: string } | null };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = (c: unknown) => c as unknown as { from(t: string): any };
const svc = () => db(serviceClient());
const rpc = (c: unknown) => c as unknown as { rpc(fn: string, args: Record<string, unknown>): PromiseLike<Res<unknown>> };

const TOKEN = `tsl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
let orgA = "", orgB = "", job = "", lifeDoc = "";
const tok: Record<string, string> = {};
const uid: Record<string, string> = {};

async function makeUser(s: string) {
  const email = `${TOKEN}-${s}@example.test`;
  const password = `Pw-${TOKEN}-${s}-${Math.random().toString(36).slice(2)}`;
  const created = await serviceClient().auth.admin.createUser({ email, password, email_confirm: true });
  expect(created.error, created.error?.message).toBeNull();
  const id = created.data.user?.id ?? "";
  await svc().from("users").insert({ id, email, full_name: `TSL ${s}` });
  const signedIn = await anonClient().auth.signInWithPassword({ email, password });
  expect(signedIn.error, signedIn.error?.message).toBeNull();
  return { id, token: signedIn.data.session?.access_token ?? "" };
}
async function makeOrg(s: string) {
  const r = await svc().from("organizations").insert({ name: `TSL ${s}`, slug: `${TOKEN}-${s}` }).select("id").single();
  expect(r.error, r.error?.message).toBeNull();
  return (r.data as { id: string }).id;
}
async function semantic(who: string, orgId: string, query: string | null, embedPos: number | null) {
  const res = await rpc(userClient(tok[who] ?? "")).rpc("tenant_search_semantic", {
    p_org_id: orgId, p_query: query,
    p_query_embedding: embedPos == null ? null : vecArray(embedPos),
    p_query_version: embedPos == null ? null : VERSION, p_limit: 20,
  });
  expect(res.error, `${who}: ${res.error?.message}`).toBeNull();
  return (res.data as Array<{ source_id: string; visibility: string }>) ?? [];
}
const has = (rows: Array<{ source_id: string }>, id: string) => rows.some((r) => r.source_id === id);
async function docRow(id: string) {
  const r = await svc().from("tenant_search_documents").select("embedding_status, embedded_at, embedding_attempts, visibility, content").eq("id", id).single();
  expect(r.error, r.error?.message).toBeNull();
  return r.data as { embedding_status: string; embedded_at: string | null; embedding_attempts: number; visibility: string; content: string };
}

describeIntegration("rls · tenant_search_documents lifecycle (20261280-282)", () => {
  const srcId = crypto.randomUUID();
  beforeAll(async () => {
    orgA = await makeOrg("a");
    orgB = await makeOrg("b");
    const staff = await makeUser("staff");
    uid.staff = staff.id; tok.staff = staff.token;
    const r = await svc().from("memberships").insert({ org_id: orgA, user_id: staff.id, role: "staff" });
    expect(r.error, r.error?.message).toBeNull();
    const j = await svc().from("jobs").insert({ org_id: orgA, status: "new" }).select("id").single();
    job = (j.data as { id: string }).id;
    await svc().from("job_assignments").insert({ org_id: orgA, job_id: job, user_id: staff.id });

    // Index one member doc on the assigned job, embedded at unit vector e7.
    const ins = await svc().from("tenant_search_documents").insert({
      org_id: orgA, source_table: "jobs", source_id: srcId, job_id: job, visibility: "member",
      content: "replacing the fascia boards and guttering along the rear elevation",
      embedding: vecLiteral(7), embedding_version: VERSION, embedding_dimension: DIM,
      embedded_at: new Date().toISOString(), embedding_status: "embedded",
    }).select("id").single();
    expect(ins.error, ins.error?.message).toBeNull();
    lifeDoc = (ins.data as { id: string }).id;
  });

  it("INDEXING: a freshly-indexed doc is retrievable (semantic + keyword)", async () => {
    expect(has(await semantic("staff", orgA, "anything", 7), srcId), "semantic hit on e7").toBe(true);
    expect(has(await semantic("staff", orgA, "guttering", null), srcId), "keyword hit on content").toBe(true);
  });

  it("UPDATE/DRIFT: changing content re-queues embedding but KEEPS the doc searchable", async () => {
    const before = await docRow(lifeDoc);
    expect(before.embedding_status).toBe("embedded");
    const upd = await svc().from("tenant_search_documents").update({ content: "renewing soffits and downpipes on the side return" }).eq("id", lifeDoc);
    expect(upd.error, upd.error?.message).toBeNull();
    const after = await docRow(lifeDoc);
    // Drift trigger fired: re-queued, attempts reset, embedded_at cleared…
    expect(after.embedding_status).toBe("pending");
    expect(after.embedded_at).toBeNull();
    expect(after.embedding_attempts).toBe(0);
    // …but the OLD vector is KEPT (atomic-swap) so semantic recall still works
    // (a hit on the e7 query vector proves the stored vector survived the edit).
    expect(has(await semantic("staff", orgA, "x", 7), srcId), "old vector still searchable").toBe(true);
    // …and the keyword channel now reflects the NEW content, not the old.
    expect(has(await semantic("staff", orgA, "downpipes", null), srcId), "new content indexed").toBe(true);
    expect(has(await semantic("staff", orgA, "guttering", null), srcId), "old content gone").toBe(false);
  });

  it("POST-UPDATE PERMISSION: raising visibility to 'management' hides it from staff at once", async () => {
    const upd = await svc().from("tenant_search_documents").update({ visibility: "management" }).eq("id", lifeDoc);
    expect(upd.error, upd.error?.message).toBeNull();
    expect(has(await semantic("staff", orgA, "x", 7), srcId), "staff must not see a management doc").toBe(false);
    // restore for the deletion test
    await svc().from("tenant_search_documents").update({ visibility: "member" }).eq("id", lifeDoc);
  });

  it("CROSS-ORG: the doc is never visible to another tenant, even after edits", async () => {
    // orgB has no member here; query as staff against orgB fails closed regardless.
    expect((await semantic("staff", orgB, "x", 7)).length).toBe(0);
  });

  it("DELETION: a deleted doc disappears from retrieval (semantic + keyword)", async () => {
    const del = await svc().from("tenant_search_documents").delete().eq("id", lifeDoc);
    expect(del.error, del.error?.message).toBeNull();
    expect(has(await semantic("staff", orgA, "x", 7), srcId), "deleted doc gone from semantic").toBe(false);
    expect(has(await semantic("staff", orgA, "downpipes", null), srcId), "deleted doc gone from keyword").toBe(false);
  });
});
