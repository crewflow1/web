import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { describeIntegration, serviceClient, userClient, anonClient } from "../_harness";

/**
 * A.5 — audit-log immutability (append-only DB enforcement) · 20261214000000.
 *
 * activity_log (per-tenant feed) and admin_activity_log (HQ super-admin trail)
 * were tenant-safe via RLS-with-no-write-policy, but service_role (RLS-bypassing)
 * could still UPDATE/DELETE recorded rows and rewrite history. The migration adds
 * BEFORE UPDATE/DELETE triggers that RAISE for EVERY role incl. service_role,
 * with only the proven sanctioned paths carved out:
 *   - activity_log:       PII scrub (GDPR anonymise) may change identity columns
 *                         but NOT the event facts; DELETE only via org-cascade
 *                         teardown or the sanctioned retention purge.
 *   - admin_activity_log: only actor_id→null (user erasure) may UPDATE; DELETE is
 *                         refused outright.
 *
 * Everything runs on the RLS-bypassing service client, because the whole point is
 * that even that client is now refused.
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
const rpc = (client: unknown) =>
  client as unknown as { rpc(fn: string, args?: Record<string, unknown>): PromiseLike<Res<unknown>> };

const T = `it-auditimm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const uuid = () =>
  "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });

/**
 * TRUNCATE cannot be issued through PostgREST/supabase-js, so the TRUNCATE-guard
 * cases run raw SQL via psql inside the Supabase local container — the same route
 * trigger-firing-order.test.ts uses for catalogue access. Returns the combined
 * stdout+stderr and whether psql exited non-zero (a raised trigger → error).
 * Returns null when the container is not reachable (local convenience); callers
 * fail loudly in CI, matching describeIntegration's contract.
 */
const PROJECT_ID =
  /^\s*project_id\s*=\s*"([^"]+)"/m.exec(
    readFileSync(resolve(process.cwd(), "supabase/config.toml"), "utf8"),
  )?.[1] ?? "crewflow";
const CONTAINER = `supabase_db_${PROJECT_ID}`;

function runSql(sql: string): { failed: boolean; output: string } | null {
  try {
    const out = execFileSync(
      "docker",
      ["exec", "-i", CONTAINER, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-tAq", "-c", sql],
      { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
    );
    return { failed: false, output: out };
  } catch (e) {
    const err = e as { status?: number; stderr?: string; stdout?: string; message?: string };
    return { failed: true, output: `${err.stdout ?? ""}${err.stderr ?? ""}${err.message ?? ""}` };
  }
}

/** True only when psql inside the container answers a trivial query. */
function dbReachable(): boolean {
  const r = runSql("select 1;");
  return !!r && !r.failed && r.output.trim() === "1";
}

describeIntegration("A.5 audit-log immutability (20261214000000)", () => {
  const svc = () => db(serviceClient());

  let orgA = "";
  let member = { id: "", token: "" };

  async function makeUser(suffix: string): Promise<{ id: string; token: string }> {
    const email = `${T}-${suffix}@example.test`;
    const password = `Pw-${T}-${suffix}-${Math.random().toString(36).slice(2)}`;
    const created = await serviceClient().auth.admin.createUser({ email, password, email_confirm: true });
    expect(created.error, created.error?.message).toBeNull();
    const id = created.data.user?.id ?? "";
    const mirrored = await svc().from("users").insert({ id, email, full_name: `Audit ${suffix}` }).select("id").single();
    expect(mirrored.error, mirrored.error?.message).toBeNull();
    const signedIn = await anonClient().auth.signInWithPassword({ email, password });
    expect(signedIn.error, signedIn.error?.message).toBeNull();
    const token = signedIn.data.session?.access_token ?? "";
    if (!id || !token) throw new Error(`failed to mint user ${suffix}`);
    return { id, token };
  }

  async function insertActivity(orgId: string, over: Row = {}): Promise<string> {
    const r = await svc()
      .from("activity_log")
      .insert({
        org_id: orgId,
        actor_id: null,
        actor_name: "System",
        action: "job.created",
        target_table: "jobs",
        target_id: uuid(),
        metadata: { k: "v" },
        ...over,
      })
      .select("id")
      .single();
    expect(r.error, r.error?.message).toBeNull();
    return String(r.data?.id ?? "");
  }

  beforeAll(async () => {
    const org = await svc().from("organizations").insert({ name: `Audit ${T}`, slug: `${T}-a` }).select("id").single();
    expect(org.error, org.error?.message).toBeNull();
    orgA = String(org.data?.id ?? "");
    if (!orgA) throw new Error("failed to create probe org");
    member = await makeUser("member");
    const m = await svc().from("memberships").insert({ org_id: orgA, user_id: member.id, role: "admin" }).select("user_id").single();
    expect(m.error, m.error?.message).toBeNull();
  });

  afterAll(async () => {
    // Deleting the org exercises the cascade DELETE path (org gone → allowed).
    if (orgA) await svc().from("organizations").delete().eq("id", orgA);
    if (member.id) await serviceClient().auth.admin.deleteUser(member.id).catch(() => undefined);
  });

  // ── activity_log ────────────────────────────────────────────────────────────

  it("INSERT still works (append is the whole point)", async () => {
    const id = await insertActivity(orgA);
    expect(id).toMatch(/[0-9a-f-]{36}/);
  });

  it("service_role CANNOT UPDATE an event-fact column (append-only)", async () => {
    const id = await insertActivity(orgA);
    for (const patch of [
      { action: "job.deleted" },
      { target_table: "invoices" },
      { target_id: uuid() },
      { org_id: uuid() },
    ] as Row[]) {
      const { error } = await svc().from("activity_log").update(patch).eq("id", id);
      expect(error, `patch ${JSON.stringify(patch)} was NOT refused`).not.toBeNull();
      expect(error?.message ?? "").toMatch(/append-only/i);
    }
  });

  it("the EXACT gdpr_erase_org PII scrub is still ALLOWED (facts intact)", async () => {
    // Drive the REAL production writer, not a hand-rolled update, so the guard is
    // proven against exactly what gdpr_erase_org issues (actor_name → '[erased]',
    // metadata → 'null'::jsonb). A throwaway org keeps it isolated.
    const slug = `${T}-gdpr`;
    const org = await svc().from("organizations").insert({ name: `GDPR ${T}`, slug }).select("id").single();
    expect(org.error, org.error?.message).toBeNull();
    const gorg = String(org.data?.id ?? "");
    const id = await insertActivity(gorg, { actor_id: uuid(), actor_name: "Jane Doe", metadata: { pii: "x" } });

    const erase = await rpc(serviceClient()).rpc("gdpr_erase_org", {
      p_org_id: gorg,
      p_confirm: slug,
      p_anonymise: ["activity_log"],
      p_hard_delete: [],
      p_retain: [],
    });
    expect(erase.error, `gdpr scrub was blocked by the append-only guard: ${erase.error?.message}`).toBeNull();

    const after = await svc().from("activity_log").select("actor_name, action, metadata").eq("id", id);
    expect((after.data ?? [])[0]?.actor_name).toBe("[erased]");
    expect((after.data ?? [])[0]?.metadata).toBeNull(); // jsonb 'null' deserialises to null
    expect((after.data ?? [])[0]?.action).toBe("job.created"); // event fact preserved

    await svc().from("organizations").delete().eq("id", gorg);
  });

  it("service_role CANNOT repoint actor_id to a different non-null value", async () => {
    const id = await insertActivity(orgA, { actor_id: uuid() });
    const { error } = await svc().from("activity_log").update({ actor_id: uuid() }).eq("id", id);
    expect(error, "actor_id was repointed to a different user").not.toBeNull();
    expect(error?.message ?? "").toMatch(/append-only/i);
  });

  it("service_role CANNOT rewrite metadata to arbitrary (non-scrub) content", async () => {
    const id = await insertActivity(orgA, { metadata: { k: "v" } });
    const { error } = await svc().from("activity_log").update({ metadata: { forged: "context" } }).eq("id", id);
    expect(error, "metadata was rewritten with arbitrary content").not.toBeNull();
    expect(error?.message ?? "").toMatch(/append-only/i);
  });

  it("service_role CANNOT DELETE a LIVE org's audit row (append-only)", async () => {
    const id = await insertActivity(orgA);
    const { error } = await svc().from("activity_log").delete().eq("id", id);
    expect(error, "a live-org audit row was deleted").not.toBeNull();
    expect(error?.message ?? "").toMatch(/append-only/i);
  });

  it("a tenant (authenticated) cannot UPDATE or DELETE the feed (RLS + trigger)", async () => {
    const id = await insertActivity(orgA);
    await db(userClient(member.token)).from("activity_log").update({ action: "x" }).eq("id", id);
    await db(userClient(member.token)).from("activity_log").delete().eq("id", id);
    const still = await svc().from("activity_log").select("id, action").eq("id", id);
    expect((still.data ?? []).length, "tenant mutated the audit row").toBe(1);
    expect((still.data ?? [])[0]?.action).toBe("job.created");
  });

  it("the sanctioned retention purge CAN delete aged rows (marker path)", async () => {
    const oldId = await insertActivity(orgA, { created_at: "2000-01-01T00:00:00Z" });
    const freshId = await insertActivity(orgA);
    const purged = await rpc(serviceClient()).rpc("purge_activity_log", { p_retention: "1 day" });
    expect(purged.error, purged.error?.message).toBeNull();
    const oldGone = await svc().from("activity_log").select("id").eq("id", oldId);
    const freshKept = await svc().from("activity_log").select("id").eq("id", freshId);
    expect((oldGone.data ?? []).length, "aged row survived the purge").toBe(0);
    expect((freshKept.data ?? []).length, "fresh row was wrongly purged").toBe(1);
  });

  it("org-cascade teardown deletes the feed (org gone → allowed)", async () => {
    const doomed = await svc().from("organizations").insert({ name: `Doomed ${T}`, slug: `${T}-doomed` }).select("id").single();
    expect(doomed.error, doomed.error?.message).toBeNull();
    const doomedOrg = String(doomed.data?.id ?? "");
    await insertActivity(doomedOrg);
    const del = await svc().from("organizations").delete().eq("id", doomedOrg);
    expect(del.error, "org teardown was blocked by the append-only DELETE guard").toBeNull();
    const rows = await svc().from("activity_log").select("id").eq("org_id", doomedOrg);
    expect((rows.data ?? []).length).toBe(0);
  });

  // ── admin_activity_log ───────────────────────────────────────────────────────

  async function insertAdmin(actorId: string | null, over: Row = {}): Promise<string> {
    const r = await svc()
      .from("admin_activity_log")
      .insert({
        actor_id: actorId,
        actor_email: "ceo@example.test",
        action: "org.status_changed",
        target_table: "organizations",
        target_id: uuid(),
        metadata: { from: "a", to: "b" },
        ...over,
      })
      .select("id")
      .single();
    expect(r.error, r.error?.message).toBeNull();
    return String(r.data?.id ?? "");
  }

  it("admin_activity_log INSERT works", async () => {
    const id = await insertAdmin(null);
    expect(id).toMatch(/[0-9a-f-]{36}/);
  });

  it("admin_activity_log: service_role CANNOT edit a non-erasure field", async () => {
    const id = await insertAdmin(null);
    const { error } = await svc().from("admin_activity_log").update({ action: "tampered" }).eq("id", id);
    expect(error, "an admin audit row was edited").not.toBeNull();
    expect(error?.message ?? "").toMatch(/append-only/i);
  });

  it("admin_activity_log: actor_id→null erasure is permitted; →different is refused", async () => {
    const leaver = await makeUser("leaver");
    const id = await insertAdmin(leaver.id);
    // repoint to a different actor → refused
    const repoint = await svc().from("admin_activity_log").update({ actor_id: member.id }).eq("id", id);
    expect(repoint.error, "actor_id was repointed").not.toBeNull();
    expect(repoint.error?.message ?? "").toMatch(/append-only/i);
    // null it directly → allowed
    const nulled = await svc().from("admin_activity_log").update({ actor_id: null }).eq("id", id);
    expect(nulled.error, nulled.error?.message).toBeNull();
    await serviceClient().auth.admin.deleteUser(leaver.id).catch(() => undefined);
  });

  it("admin_activity_log: a user hard-delete nulls actor_id via on-delete-set-null (allowed)", async () => {
    const leaver = await makeUser("leaver2");
    const id = await insertAdmin(leaver.id);
    await svc().from("memberships").delete().eq("user_id", leaver.id);
    const removed = await svc().from("users").delete().eq("id", leaver.id);
    expect(removed.error, "the set-null cascade was blocked by the append-only guard").toBeNull();
    const after = await svc().from("admin_activity_log").select("actor_id").eq("id", id);
    expect((after.data ?? [])[0]?.actor_id).toBeNull();
    await serviceClient().auth.admin.deleteUser(leaver.id).catch(() => undefined);
  });

  it("admin_activity_log: DELETE is refused even for service_role", async () => {
    const id = await insertAdmin(null);
    const { error } = await svc().from("admin_activity_log").delete().eq("id", id);
    expect(error, "an admin audit row was deleted").not.toBeNull();
    expect(error?.message ?? "").toMatch(/append-only/i);
  });

  // ── TRUNCATE guard (raw SQL; PostgREST cannot issue TRUNCATE) ────────────────

  it("TRUNCATE is refused on BOTH tables even for service_role", () => {
    if (!dbReachable()) {
      if (process.env.CI) {
        throw new Error(
          `Could not reach Postgres in container "${CONTAINER}" to test the TRUNCATE guard. ` +
            "This guards an append-only audit trail and must not be skipped in CI. " +
            "Did `supabase start` run before this suite?",
        );
      }
      console.warn(`[audit-truncate] container ${CONTAINER} not reachable — skipping`);
      return;
    }
    for (const tbl of ["activity_log", "admin_activity_log"]) {
      const res = runSql(`set role service_role; truncate public.${tbl};`);
      expect(res, `no psql result for ${tbl}`).not.toBeNull();
      expect(res!.failed, `TRUNCATE public.${tbl} was NOT refused`).toBe(true);
      expect(res!.output, `TRUNCATE public.${tbl} failed for the wrong reason`).toMatch(/append-only/i);
    }
  });
});
