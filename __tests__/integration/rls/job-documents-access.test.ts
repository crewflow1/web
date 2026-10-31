import { beforeAll, expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient, userClient } from "../_harness";

/**
 * R5 Phase 3 (slice 4) — job_documents + job_document_versions assignment-aware
 * SELECT (migration 20261248000000), against real Postgres with real JWTs.
 *
 *   • owner/admin: every document in the org (staff + private);
 *   • staff: a 'staff'-visibility document ONLY for a job they are ASSIGNED to;
 *   • staff: NO private documents (the drop box stays admin-read-only);
 *   • a staff member of another org / anon: nothing.
 *
 * It also pins the DOWNLOAD capability: getJobDocumentDownloadUrl reads the
 * version row via the tenant client under RLS and only signs if that read
 * returns a row. So the version-SELECT visibility proven here IS the signed-URL
 * gate — a staff member can be minted a URL only for an assigned job's staff doc.
 */

type Row = Record<string, unknown>;
type Res<T = Row> = { data: T | null; error: { message: string } | null };
interface Sel extends PromiseLike<Res<Row[]>> {
  eq(c: string, v: unknown): Sel;
  in(c: string, v: unknown[]): Sel;
}
interface Ins extends PromiseLike<Res<null>> {
  select(c?: string): { single(): PromiseLike<Res<Row>> };
}
interface Table {
  select(c?: string): Sel;
  insert(rows: Row | Row[]): Ins;
}
const db = (client: unknown) => client as unknown as { from(t: string): Table };
const svc = () => db(serviceClient());
const TOKEN = `r5p3d-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

let orgA = "", orgB = "";
let jobAssigned = "", jobUnassigned = "", jobB = "";
const tok: Record<string, string> = {};
const uid: Record<string, string> = {};
const uc = (who: string) => userClient(tok[who] ?? "");
const U = (who: string): string => uid[who] ?? "";
// doc ids keyed by a label
const doc: Record<string, string> = {};
const ver: Record<string, string> = {};

async function makeUser(suffix: string): Promise<{ id: string; token: string }> {
  const email = `${TOKEN}-${suffix}@example.test`;
  const password = `Pw-${TOKEN}-${suffix}-${Math.random().toString(36).slice(2)}`;
  const created = await serviceClient().auth.admin.createUser({ email, password, email_confirm: true });
  expect(created.error, created.error?.message).toBeNull();
  const id = created.data.user?.id ?? "";
  await svc().from("users").insert({ id, email, full_name: `R5P3D ${suffix}` });
  const signedIn = await anonClient().auth.signInWithPassword({ email, password });
  const token = signedIn.data.session?.access_token ?? "";
  if (!id || !token) throw new Error(`mint failed ${suffix}`);
  return { id, token };
}
async function makeOrg(suffix: string): Promise<string> {
  const r = await svc().from("organizations").insert({ name: `R5P3D ${suffix}`, slug: `${TOKEN}-${suffix}` }).select("id").single();
  expect(r.error, r.error?.message).toBeNull();
  return String((r.data as { id: string }).id);
}
async function member(org: string, userId: string, role: string) {
  expect((await svc().from("memberships").insert({ org_id: org, user_id: userId, role })).error).toBeNull();
}
async function makeJob(org: string, assignedTo: string | null): Promise<string> {
  const r = await svc().from("jobs").insert({ org_id: org, status: "new", assigned_to: assignedTo }).select("id").single();
  expect(r.error, r.error?.message).toBeNull();
  return String((r.data as { id: string }).id);
}
async function makeDoc(label: string, org: string, job: string, visibility: "staff" | "private") {
  const d = await svc()
    .from("job_documents")
    .insert({ org_id: org, job_id: job, visibility, title: `Doc ${label}` })
    .select("id")
    .single();
  expect(d.error, `${label}: ${d.error?.message}`).toBeNull();
  const docId = String((d.data as { id: string }).id);
  doc[label] = docId;
  const bucket = visibility === "private" ? "job-docs-private" : "job-docs";
  const v = await svc()
    .from("job_document_versions")
    .insert({
      document_id: docId,
      version_no: 1,
      storage_bucket: bucket,
      storage_path: `${org}/${job}/${label}.pdf`,
      filename: `${label}.pdf`,
      mime_type: "application/pdf",
      size_bytes: 100,
    })
    .select("id")
    .single();
  expect(v.error, `${label} version: ${v.error?.message}`).toBeNull();
  ver[label] = String((v.data as { id: string }).id);
}

const seenIn = async (who: string, table: string, col: string, ids: string[]): Promise<Set<string>> => {
  const res = await db(uc(who)).from(table).select(col === "id" ? "id" : `id`).in("id", ids);
  expect(res.error, `${who}/${table}: ${res.error?.message}`).toBeNull();
  return new Set((res.data ?? []).map((r) => String(r.id)));
};

describeIntegration("rls · job_documents assignment-aware (20261248 · R5 Phase 3 slice 4)", () => {
  beforeAll(async () => {
    orgA = await makeOrg("A");
    orgB = await makeOrg("B");
    for (const who of ["owner", "admin", "assigned", "unassigned", "otherOrg"]) {
      const u = await makeUser(who);
      uid[who] = u.id;
      tok[who] = u.token;
    }
    await member(orgA, U("owner"), "owner");
    await member(orgA, U("admin"), "admin");
    await member(orgA, U("assigned"), "staff");
    await member(orgA, U("unassigned"), "staff");
    await member(orgB, U("otherOrg"), "owner");

    jobAssigned = await makeJob(orgA, null);
    jobUnassigned = await makeJob(orgA, null);
    jobB = await makeJob(orgB, null);
    expect((await svc().from("job_assignments").insert({ org_id: orgA, job_id: jobAssigned, user_id: U("assigned") })).error).toBeNull();

    await makeDoc("staffA", orgA, jobAssigned, "staff"); // assigned job, staff area
    await makeDoc("privA", orgA, jobAssigned, "private"); // assigned job, private area
    await makeDoc("staffU", orgA, jobUnassigned, "staff"); // unassigned job, staff area
    await makeDoc("staffB", orgB, jobB, "staff"); // other org
  });

  const allDocs = () => [doc.staffA!, doc.privA!, doc.staffU!, doc.staffB!];
  const allVers = () => [ver.staffA!, ver.privA!, ver.staffU!, ver.staffB!];

  it("owner/admin see every org-A document (staff + private), never org B", async () => {
    for (const who of ["owner", "admin"]) {
      const seen = await seenIn(who, "job_documents", "id", allDocs());
      expect(seen.has(doc.staffA!) && seen.has(doc.privA!) && seen.has(doc.staffU!), `${who} sees all org-A docs`).toBe(true);
      expect(seen.has(doc.staffB!), `${who} must not see org B`).toBe(false);
    }
  });

  it("assigned staff see ONLY the assigned job's STAFF doc (not private, not unassigned)", async () => {
    const seen = await seenIn("assigned", "job_documents", "id", allDocs());
    expect([...seen], "exactly the assigned job's staff doc").toEqual([doc.staffA!]);
  });

  it("unassigned staff and other-org / anon see no org-A documents", async () => {
    const orgADocs = [doc.staffA!, doc.privA!, doc.staffU!];
    expect((await seenIn("unassigned", "job_documents", "id", orgADocs)).size, "unassigned staff see nothing").toBe(0);
    // otherOrg legitimately sees its OWN org-B doc, but none of org A's.
    const otherSeesOrgA = await seenIn("otherOrg", "job_documents", "id", orgADocs);
    expect(otherSeesOrgA.size, "cross-tenant: org B owner sees no org-A doc").toBe(0);
    const anon = await db(anonClient()).from("job_documents").select("id").in("id", allDocs());
    expect(anon.data ?? [], "anon sees nothing").toHaveLength(0);
  });

  it("versions mirror parent visibility — and this IS the signed-URL download gate", async () => {
    // owner sees all versions; assigned sees only the assigned staff doc's
    // version; unassigned none. getJobDocumentDownloadUrl signs only what this
    // tenant read returns, so a staff member can be minted a URL for staffA only.
    const owner = await seenIn("owner", "job_document_versions", "id", allVers());
    expect(owner.has(ver.staffA!) && owner.has(ver.privA!) && owner.has(ver.staffU!)).toBe(true);

    const assigned = await seenIn("assigned", "job_document_versions", "id", allVers());
    expect([...assigned], "download gate: only the assigned job's staff version is visible/signable").toEqual([ver.staffA!]);

    expect((await seenIn("unassigned", "job_document_versions", "id", allVers())).size).toBe(0);
  });
});
