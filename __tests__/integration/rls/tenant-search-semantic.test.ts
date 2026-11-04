import { beforeAll, expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient, userClient } from "../_harness";

/**
 * Tenant Semantic Search — the permissioned retrieval RPC against real Postgres
 * (migrations 20261280–20261282), through real signed-in user JWTs.
 *
 * Proves the four behaviours the feature lives or dies on:
 *   • SEMANTIC recall finds a NON-EXACT (non-lexical) match — the query term
 *     appears in NONE of the member docs' content, yet the nearest vector is
 *     returned (deterministic unit-basis vectors stand in for a provider).
 *   • CROSS-TENANT isolation fails closed — an orgA member querying orgB gets [].
 *   • STAFF + VISIBILITY gate fails closed — staff never see an unassigned job's
 *     doc nor a management (admin-only) doc; an admin sees the whole org.
 *   • DARK → KEYWORD degradation — with no query embedding the RPC answers on the
 *     lexical channel, still under the same staff/visibility boundary.
 *   • The embedding column is never returned.
 */

const VERSION = "det:test:d1536:v1";
const DIM = 1536;

/** A unit-basis embedding vector as the pgvector text literal "[0,...,1,...,0]". */
function vecLiteral(pos: number): string {
  const a = new Array<number>(DIM).fill(0);
  a[pos - 1] = 1;
  return `[${a.join(",")}]`;
}
/** The same basis vector as a float8[] (what the RPC takes for the query). */
function vecArray(pos: number): number[] {
  const a = new Array<number>(DIM).fill(0);
  a[pos - 1] = 1;
  return a;
}

type Row = Record<string, unknown>;
type Res<T = Row> = { data: T | null; error: { message: string; code?: string } | null };
interface Sel extends PromiseLike<Res<Row[]>> {
  eq(column: string, value: unknown): Sel;
}
interface Ins extends PromiseLike<Res<null>> {
  select(columns?: string): { single(): PromiseLike<Res<Row>> };
}
interface Table {
  select(columns?: string): Sel;
  insert(rows: Row | Row[]): Ins;
}
const db = (client: unknown) => client as unknown as { from(t: string): Table };
const svc = () => db(serviceClient());

type RpcClient = {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<Res<unknown>>;
};
const rpc = (client: unknown) => client as unknown as RpcClient;

const TOKEN = `tss-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

let orgA = "";
let orgB = "";
let job1 = ""; // orgA, assigned to staff
let job2 = ""; // orgA, unassigned
let srcDecoy = "";
let srcCust = "";
let srcOrgB = "";

const tok: Record<string, string> = {};
const uid: Record<string, string> = {};

async function makeUser(suffix: string): Promise<{ id: string; token: string }> {
  const email = `${TOKEN}-${suffix}@example.test`;
  const password = `Pw-${TOKEN}-${suffix}-${Math.random().toString(36).slice(2)}`;
  const created = await serviceClient().auth.admin.createUser({ email, password, email_confirm: true });
  expect(created.error, created.error?.message).toBeNull();
  const id = created.data.user?.id ?? "";
  const mirrored = await svc().from("users").insert({ id, email, full_name: `TSS ${suffix}` }).select("id").single();
  expect(mirrored.error, mirrored.error?.message).toBeNull();
  const signedIn = await anonClient().auth.signInWithPassword({ email, password });
  expect(signedIn.error, signedIn.error?.message).toBeNull();
  const token = signedIn.data.session?.access_token ?? "";
  if (!id || !token) throw new Error(`failed to mint user ${suffix}`);
  return { id, token };
}

async function makeOrg(suffix: string): Promise<string> {
  const r = await svc().from("organizations").insert({ name: `TSS ${suffix}`, slug: `${TOKEN}-${suffix}` }).select("id").single();
  expect(r.error, r.error?.message).toBeNull();
  return (r.data as { id: string }).id;
}
async function member(org: string, userId: string, role: string): Promise<void> {
  const r = await svc().from("memberships").insert({ org_id: org, user_id: userId, role });
  expect(r.error, r.error?.message).toBeNull();
}
async function makeJob(org: string): Promise<string> {
  const r = await svc().from("jobs").insert({ org_id: org, status: "new" }).select("id").single();
  expect(r.error, r.error?.message).toBeNull();
  return (r.data as { id: string }).id;
}

async function insertDoc(d: {
  org: string;
  sourceTable: string;
  sourceId: string;
  jobId: string | null;
  visibility: string;
  content: string;
  pos: number;
}): Promise<void> {
  const r = await svc().from("tenant_search_documents").insert({
    org_id: d.org,
    source_table: d.sourceTable,
    source_id: d.sourceId,
    job_id: d.jobId,
    visibility: d.visibility,
    content: d.content,
    embedding: vecLiteral(d.pos),
    embedding_version: VERSION,
    embedding_dimension: DIM,
    embedded_at: new Date().toISOString(),
    embedding_status: "embedded",
  });
  expect(r.error, r.error?.message).toBeNull();
}

async function semantic(
  who: string | null,
  orgId: string,
  query: string | null,
  embedPos: number | null,
): Promise<Array<{ source_id: string; source_table: string; visibility: string; cos_sim: number | null }>> {
  const client = who ? userClient(tok[who] ?? "") : anonClient();
  const res = await rpc(client).rpc("tenant_search_semantic", {
    p_org_id: orgId,
    p_query: query,
    p_query_embedding: embedPos == null ? null : vecArray(embedPos),
    p_query_version: embedPos == null ? null : VERSION,
    p_limit: 20,
  });
  expect(res.error, `${who ?? "anon"}: ${res.error?.message}`).toBeNull();
  return (res.data as Array<{ source_id: string; source_table: string; visibility: string; cos_sim: number | null }>) ?? [];
}

describeIntegration("rls · tenant_search_semantic (20261280-282)", () => {
  beforeAll(async () => {
    orgA = await makeOrg("orgA");
    orgB = await makeOrg("orgB");
    for (const who of ["staff", "admin", "otherOrg"]) {
      const u = await makeUser(who);
      uid[who] = u.id;
      tok[who] = u.token;
    }
    await member(orgA, uid.staff!, "staff");
    await member(orgA, uid.admin!, "admin");
    await member(orgB, uid.otherOrg!, "staff");

    job1 = await makeJob(orgA);
    job2 = await makeJob(orgA);
    const ja = await svc().from("job_assignments").insert({ org_id: orgA, job_id: job1, user_id: uid.staff! });
    expect(ja.error, ja.error?.message).toBeNull();

    srcDecoy = crypto.randomUUID();
    srcCust = crypto.randomUUID();
    srcOrgB = crypto.randomUUID();

    // Member doc on the ASSIGNED job — the semantic target (vec e5). Its content
    // does NOT contain the word "leak" → a hit proves semantic, not keyword.
    await insertDoc({ org: orgA, sourceTable: "jobs", sourceId: job1, jobId: job1, visibility: "member",
      content: "water escaping from the hot water cylinder in the airing cupboard", pos: 5 });
    // Decoy member doc on the same assigned job (vec e10, cosine 0 vs e5).
    await insertDoc({ org: orgA, sourceTable: "jobs", sourceId: srcDecoy, jobId: job1, visibility: "member",
      content: "replace kitchen worktop laminate edging", pos: 10 });
    // Member doc on an UNASSIGNED job (vec e5) — staff must NOT see; admin must.
    await insertDoc({ org: orgA, sourceTable: "jobs", sourceId: job2, jobId: job2, visibility: "member",
      content: "water leak under bath on the second job", pos: 5 });
    // MANAGEMENT doc (vec e5) — staff must NOT see; admin must.
    await insertDoc({ org: orgA, sourceTable: "customers", sourceId: srcCust, jobId: null, visibility: "management",
      content: "customer water utilities ltd account", pos: 5 });
    // orgB doc (vec e5) — nobody in orgA may see.
    await insertDoc({ org: orgB, sourceTable: "jobs", sourceId: srcOrgB, jobId: null, visibility: "member",
      content: "orgB water tank overflow", pos: 5 });
  });

  it("STAFF: semantic recall finds the NON-EXACT match on the assigned job", async () => {
    const rows = await semantic("staff", orgA, "leak", 5);
    const ids = new Set(rows.map((r) => r.source_id));
    // The nearest (cos 1.0) permitted vector is the assigned-job member doc,
    // whose content never contains "leak" — pure semantic recall.
    expect(ids.has(job1)).toBe(true);
    const target = rows.find((r) => r.source_id === job1);
    expect(target?.cos_sim).toBeGreaterThan(0.99);
    // Fails closed on everything the staff member may not read:
    expect(ids.has(job2), "unassigned-job doc").toBe(false);
    expect(ids.has(srcCust), "management doc").toBe(false);
    expect(ids.has(srcOrgB), "cross-tenant doc").toBe(false);
  });

  it("STAFF: cross-tenant query (orgB) fails closed → []", async () => {
    const rows = await semantic("staff", orgB, "leak", 5);
    expect(rows).toHaveLength(0);
  });

  it("ADMIN: sees member docs on BOTH jobs AND the management doc", async () => {
    const rows = await semantic("admin", orgA, "leak", 5);
    const ids = new Set(rows.map((r) => r.source_id));
    expect(ids.has(job1)).toBe(true);
    expect(ids.has(job2)).toBe(true);
    expect(ids.has(srcCust)).toBe(true);
    // ...but still never another tenant's data.
    expect(ids.has(srcOrgB)).toBe(false);
  });

  it("DARK → KEYWORD: no embedding, lexical term on the assigned doc is found", async () => {
    const rows = await semantic("staff", orgA, "cylinder", null);
    expect(rows.map((r) => r.source_id)).toContain(job1);
  });

  it("DARK → KEYWORD: a lexical term only in the UNASSIGNED doc stays hidden from staff", async () => {
    const rows = await semantic("staff", orgA, "bath", null);
    expect(rows.map((r) => r.source_id)).not.toContain(job2);
    expect(rows).toHaveLength(0);
  });

  it("the embedding column is never present in a returned row", async () => {
    const res = await rpc(userClient(tok.staff ?? "")).rpc("tenant_search_semantic", {
      p_org_id: orgA, p_query: "leak", p_query_embedding: vecArray(5), p_query_version: VERSION, p_limit: 20,
    });
    const rows = (res.data as Array<Record<string, unknown>>) ?? [];
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(Object.keys(r)).not.toContain("embedding");
  });

  it("ANON: EXECUTE is revoked → the call is denied outright (fail closed, defence in depth)", async () => {
    const res = await rpc(anonClient()).rpc("tenant_search_semantic", {
      p_org_id: orgA, p_query: "leak", p_query_embedding: vecArray(5), p_query_version: VERSION, p_limit: 20,
    });
    // anon has no EXECUTE grant (revoked in 20261282), so PostgREST returns a
    // 42501 permission-denied — a stronger fail-closed than an empty result.
    expect(res.error?.code).toBe("42501");
    expect(res.data ?? null).toBeNull();
  });
});
