import { afterAll, beforeAll, expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient, userClient } from "../_harness";

/**
 * R5 Phase 3 (slice 5) — job-photos STORAGE read is assignment-aware
 * (migration 20261249000000), proven against the real storage API.
 *
 * The bucket stores `<org_id>/<job_id>/<file>`. A signed URL is a capability, so
 * the SELECT policy on storage.objects is the gate: admins may sign any of the
 * org's photos; a staff member may sign ONLY a photo whose job they are assigned
 * to — even addressing the object path directly (not just via the GET route).
 */

type StorageClient = {
  storage: {
    from: (b: string) => {
      upload: (path: string, body: unknown, opts?: unknown) => Promise<{ data: unknown; error: { message: string } | null }>;
      createSignedUrl: (path: string, expires: number) => Promise<{ data: { signedUrl: string } | null; error: { message: string } | null }>;
      remove: (paths: string[]) => Promise<{ data: unknown; error: { message: string } | null }>;
    };
  };
};
type Row = Record<string, unknown>;
const db = (client: unknown) => client as unknown as { from(t: string): { insert(r: Row): { select(c?: string): { single(): Promise<{ data: Row | null; error: { message: string } | null }> } } } };
const svc = () => db(serviceClient());
const store = (client: unknown) => client as unknown as StorageClient;
const TOKEN = `r5p3ph-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

let orgA = "";
let jobAssigned = "", jobUnassigned = "";
const tok: Record<string, string> = {};
const uid: Record<string, string> = {};
let assignedPath = "", unassignedPath = "";

async function makeUser(suffix: string): Promise<{ id: string; token: string }> {
  const email = `${TOKEN}-${suffix}@example.test`;
  const password = `Pw-${TOKEN}-${suffix}-${Math.random().toString(36).slice(2)}`;
  const created = await serviceClient().auth.admin.createUser({ email, password, email_confirm: true });
  const id = created.data.user?.id ?? "";
  await svc().from("users").insert({ id, email, full_name: `PH ${suffix}` }).select("id").single();
  const signedIn = await anonClient().auth.signInWithPassword({ email, password });
  const token = signedIn.data.session?.access_token ?? "";
  if (!id || !token) throw new Error(`mint failed ${suffix}`);
  return { id, token };
}

describeIntegration("rls · job-photos storage assignment-aware (20261249 · R5 Phase 3 slice 5)", () => {
  beforeAll(async () => {
    const org = await svc().from("organizations").insert({ name: `PH ${TOKEN}`, slug: `${TOKEN}-a` }).select("id").single();
    orgA = String((org.data as { id: string }).id);
    for (const who of ["admin", "assigned", "unassigned"]) {
      const u = await makeUser(who);
      uid[who] = u.id;
      tok[who] = u.token;
    }
    await svc().from("memberships").insert({ org_id: orgA, user_id: uid.admin, role: "owner" }).select("user_id").single();
    await svc().from("memberships").insert({ org_id: orgA, user_id: uid.assigned, role: "staff" }).select("user_id").single();
    await svc().from("memberships").insert({ org_id: orgA, user_id: uid.unassigned, role: "staff" }).select("user_id").single();

    const j1 = await svc().from("jobs").insert({ org_id: orgA, status: "new" }).select("id").single();
    jobAssigned = String((j1.data as { id: string }).id);
    const j2 = await svc().from("jobs").insert({ org_id: orgA, status: "new" }).select("id").single();
    jobUnassigned = String((j2.data as { id: string }).id);
    await svc().from("job_assignments").insert({ org_id: orgA, job_id: jobAssigned, user_id: uid.assigned }).select("id").single();

    assignedPath = `${orgA}/${jobAssigned}/a.jpg`;
    unassignedPath = `${orgA}/${jobUnassigned}/u.jpg`;
    const body = Buffer.from([0xff, 0xd8, 0xff, 0xd9]); // tiny JPEG-ish blob
    for (const p of [assignedPath, unassignedPath]) {
      const up = await store(serviceClient()).storage.from("job-photos").upload(p, body, { contentType: "image/jpeg", upsert: true });
      expect(up.error, `upload ${p}: ${up.error?.message}`).toBeNull();
    }
  });

  afterAll(async () => {
    await store(serviceClient()).storage.from("job-photos").remove([assignedPath, unassignedPath]);
    for (const who of ["admin", "assigned", "unassigned"]) {
      if (uid[who]) await serviceClient().auth.admin.deleteUser(uid[who]!);
    }
  });

  const canSign = async (who: string, path: string): Promise<boolean> => {
    const r = await store(userClient(tok[who] ?? "")).storage.from("job-photos").createSignedUrl(path, 60);
    return !r.error && Boolean(r.data?.signedUrl);
  };

  it("an admin can sign any of the org's job photos", async () => {
    expect(await canSign("admin", assignedPath)).toBe(true);
    expect(await canSign("admin", unassignedPath)).toBe(true);
  });

  it("assigned staff can sign ONLY their assigned job's photo", async () => {
    expect(await canSign("assigned", assignedPath), "assigned job photo is signable").toBe(true);
    expect(await canSign("assigned", unassignedPath), "a non-assigned job's photo must NOT be signable").toBe(false);
  });

  it("unassigned staff cannot sign any job photo; anon cannot either", async () => {
    expect(await canSign("unassigned", assignedPath)).toBe(false);
    expect(await canSign("unassigned", unassignedPath)).toBe(false);
    const anon = await store(anonClient()).storage.from("job-photos").createSignedUrl(assignedPath, 60);
    expect(!anon.error && Boolean(anon.data?.signedUrl), "anon cannot sign").toBe(false);
  });
});
