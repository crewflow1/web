/**
 * Shared SYNTHETIC fixtures for the account & data deletion suites.
 *
 * Everything here is fabricated and local: every person and company is built
 * from a per-run random tag, and three distinctive MARKER strings (a name, an
 * email stem and a phone number) are written into the identity and data rows so
 * that an erasure can be verified by a catalogue-wide marker search
 * (`privacy_residue_scan`) rather than by checking the tables we expect.
 */
import { expect } from "vitest";
import { anonClient, serviceClient } from "../_harness";
import type {
  DeletionAdminClient,
  StripeSubscriptionsApi,
} from "@/server/services/privacy-deletion";

type Res<T = Record<string, unknown>> = { data: T | null; error: { message: string; code?: string } | null };
interface Sel<T = Record<string, unknown>> extends PromiseLike<Res<T[]>> {
  eq(c: string, v: unknown): Sel<T>;
  in(c: string, v: unknown[]): Sel<T>;
  order(c: string, o?: { ascending?: boolean }): Sel<T>;
  limit(n: number): Sel<T>;
  select(c: string): Sel<T>;
  single(): PromiseLike<Res<T>>;
  maybeSingle(): PromiseLike<Res<T>>;
}
export type LooseDb = {
  from(t: string): {
    select<T = Record<string, unknown>>(c: string, o?: { count?: "exact"; head?: boolean }): Sel<T>;
    insert(r: Record<string, unknown> | Record<string, unknown>[]): Sel;
    update(r: Record<string, unknown>): Sel;
    delete(): Sel;
  };
  rpc(fn: string, args?: Record<string, unknown>): PromiseLike<Res<unknown>>;
};

export const db = (): LooseDb => serviceClient() as unknown as LooseDb;
export const asLoose = (c: unknown): LooseDb => c as LooseDb;
export const admin = (): DeletionAdminClient => serviceClient() as unknown as DeletionAdminClient;

export type Markers = { tag: string; name: string; email: string; phone: string };

/** Fresh, collision-proof markers. Every one is ≥ 6 chars (the scan refuses less). */
export function newMarkers(prefix: string): Markers {
  const tag = `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const digits = String(Math.floor(Math.random() * 1e6)).padStart(6, "0");
  return {
    tag,
    name: `Zqdel${tag}`,
    email: `zqdel${tag}@deletion-ws.invalid`,
    phone: `+44770090${digits}`.slice(0, 13),
  };
}

export type TestUser = { id: string; email: string; password: string };

/** A real auth user + mirrored public.users profile carrying the markers. */
export async function mkUser(m: Markers, label: string): Promise<TestUser> {
  const email = `${label}.${m.email}`;
  const password = `Pw-${m.tag}-${label}-9!x`;
  const created = await serviceClient().auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: `${m.name} ${label}` },
  });
  expect(created.error, created.error?.message).toBeNull();
  const id = created.data.user?.id ?? "";
  const mirrored = await db()
    .from("users")
    .insert({ id, email, full_name: `${m.name} ${label}`, phone: m.phone });
  expect(mirrored.error, mirrored.error?.message).toBeNull();
  return { id, email, password };
}

export async function signIn(u: TestUser): Promise<string> {
  const s = await anonClient().auth.signInWithPassword({ email: u.email, password: u.password });
  expect(s.error, s.error?.message).toBeNull();
  return s.data.session?.access_token ?? "";
}

export type TestOrg = { id: string; name: string; slug: string };

export async function mkOrg(
  m: Markers,
  label: string,
  members: Array<{ user: TestUser; role: "owner" | "admin" | "staff" }>,
): Promise<TestOrg> {
  const name = `${m.name} ${label} Ltd`;
  const slug = `del-${m.tag}-${label}`.toLowerCase();
  const org = await db()
    .from("organizations")
    .insert({
      name,
      slug,
      phone: m.phone,
      billing_email: `billing.${m.email}`,
      address: { line1: `${m.name} Street` },
      status: "active",
    })
    .select("id")
    .single();
  expect(org.error, org.error?.message).toBeNull();
  const id = String(org.data?.id ?? "");
  for (const mem of members) {
    const r = await db().from("memberships").insert({ org_id: id, user_id: mem.user.id, role: mem.role });
    expect(r.error, r.error?.message).toBeNull();
  }
  return { id, name, slug };
}

async function ins(table: string, row: Record<string, unknown>): Promise<string> {
  const r = await db().from(table).insert(row).select("*").single();
  expect(r.error, `${table}: ${r.error?.message}`).toBeNull();
  return String((r.data as { id?: string } | null)?.id ?? "");
}

/** A 1×1 PNG — accepted by every tenant bucket's mime allowlist. */
const PNG = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="),
  (c) => c.charCodeAt(0),
);

export const SEEDED_BUCKETS = ["job-photos", "signatures", "tenant-attachments", "form-imports"] as const;

export async function uploadOrgObjects(orgId: string, m: Markers): Promise<string[]> {
  const paths: string[] = [];
  for (const bucket of SEEDED_BUCKETS) {
    const path = `${orgId}/nested/deep/${m.name}-${bucket}.png`;
    const up = await serviceClient().storage.from(bucket).upload(path, PNG, {
      contentType: "image/png",
      upsert: true,
    });
    expect(up.error, `${bucket}: ${up.error?.message}`).toBeNull();
    paths.push(`${bucket}:${path}`);
  }
  return paths;
}

export async function countOrgObjects(orgId: string): Promise<number> {
  // storage.objects is not exposed through PostgREST; list every bucket instead.
  let n = 0;
  const walk = async (bucket: string, prefix: string): Promise<void> => {
    const { data, error } = await serviceClient().storage.from(bucket).list(prefix, { limit: 1000 });
    if (error) return;
    for (const item of data ?? []) {
      if (item.id === null) await walk(bucket, `${prefix}/${item.name}`);
      else n += 1;
    }
  };
  const { data: buckets } = await db().rpc("_privacy_introspect_buckets");
  for (const b of (buckets as Array<{ bucket: string }> | null) ?? []) await walk(b.bucket, orgId);
  return n;
}

export type OrgSeed = {
  customer: string;
  job: string;
  payrollRun: string;
  conversation: string;
};

/**
 * Tenant business data for `org`, with the markers in the fields a real company
 * would put personal data in: a customer, a job, an inbound lead, a conversation
 * with a message, an append-only comm event (the row that used to make an org
 * undeletable), CrewFlow-side billing rows and provider-webhook logs.
 */
export async function seedOrgBusinessData(org: TestOrg, m: Markers): Promise<OrgSeed> {
  const customer = await ins("customers", {
    org_id: org.id,
    name: `${m.name} Customer`,
    email: `customer.${m.email}`,
    phone: m.phone,
  });
  const job = await ins("jobs", { org_id: org.id, customer_id: customer, status: "new" });
  await ins("leads", {
    org_id: org.id,
    source: "manual",
    contact_name: `${m.name} Lead`,
    contact_email: `lead.${m.email}`,
    contact_phone: m.phone,
  });
  const conversation = await ins("conversations", { org_id: org.id, channel: "email" });
  await ins("messages", {
    org_id: org.id,
    conversation_id: conversation,
    direction: "inbound",
    body: `Hello from ${m.name} — call me on ${m.phone}`,
  });
  await ins("comm_events", {
    org_id: org.id,
    provider_event_id: `evt-${m.tag}-${org.slug}`,
    event_type: "delivered",
    recipient: `customer.${m.email}`,
  });
  await ins("billing_invoices", {
    org_id: org.id,
    kind: "subscription",
    status: "paid",
    amount_gbp: 99,
    currency: "GBP",
    stripe_invoice_id: `in_${m.tag.replace(/[^A-Za-z0-9]/g, "")}0001`,
    notes: `Agreed with ${m.name} by phone`,
  });
  await ins("billing_events", {
    org_id: org.id,
    event_id: `evt_${m.tag}_${org.slug}`,
    event_type: "invoice.paid",
    payload: { customer_email: `billing.${m.email}`, customer_name: m.name },
  });
  const payrollRun = await ins("payroll_runs", {
    org_id: org.id,
    cycle: "monthly",
    period_start: "2026-10-01",
    period_end: "2026-10-31",
  });
  return { customer, job, payrollRun, conversation };
}

/**
 * The personal footprint of ONE member in ONE org, one row per data class of
 * lib/gdpr/user-erasure.json. `withPayroll` adds a statutory payroll line (which
 * also decides whether the NI number is retained).
 */
export async function seedMemberFootprint(
  org: TestOrg,
  seed: OrgSeed,
  user: TestUser,
  m: Markers,
  opts: { withPayroll: boolean },
): Promise<void> {
  // DELETE class
  await ins("notifications", {
    org_id: org.id,
    user_id: user.id,
    type: "info",
    title: `Shift change for ${m.name}`,
    body: `Text ${m.phone}`,
  });
  await ins("notification_preferences", { org_id: org.id, user_id: user.id, category: "system" });
  await ins("push_subscriptions", {
    org_id: org.id,
    user_id: user.id,
    endpoint: `https://push.invalid/${m.name}/${user.id}`,
    p256dh: "p256dh-key",
    auth: "auth-key",
  });
  await ins("job_assignments", { org_id: org.id, job_id: seed.job, user_id: user.id });
  await ins("rota_entries", {
    org_id: org.id,
    user_id: user.id,
    starts_at: "2026-12-01T08:00:00Z",
    ends_at: "2026-12-01T16:00:00Z",
    notes: `${m.name} on early shift`,
  });
  // SCRUB class
  await ins("time_entries", {
    org_id: org.id,
    user_id: user.id,
    job_id: seed.job,
    started_at: "2026-10-05T08:00:00Z",
    ended_at: "2026-10-05T16:00:00Z",
    gps_lat: 54.5973,
    gps_lng: -5.9301,
    note: `${m.name} left early for a hospital appointment`,
  });
  await ins("leave_requests", {
    org_id: org.id,
    user_id: user.id,
    type: "sick",
    starts_at: "2026-10-12",
    ends_at: "2026-10-13",
    reason: `${m.name} — back injury`,
  });
  // CONDITIONAL class (NI number) — format-constrained, so it cannot carry a marker.
  const ni = await db().from("staff_secrets").insert({ org_id: org.id, user_id: user.id, ni_number: "AB123456C" });
  expect(ni.error, ni.error?.message).toBeNull();
  // RETAIN class
  if (opts.withPayroll) {
    await ins("payroll_lines", { org_id: org.id, payroll_run_id: seed.payrollRun, user_id: user.id });
  }
  // PSEUDONYMISE class — a business record the person authored.
  await ins("internal_notes", {
    org_id: org.id,
    author_user_id: user.id,
    author_email: "office@company.invalid",
    body: "Customer prefers morning visits.",
  });
  // User-keyed, no org: pay rate + a THIRD PARTY's contact details.
  const comp = await db()
    .from("staff_compensation")
    .insert({ user_id: user.id, hourly_pay: 18.5, emergency_contact: { name: `${m.name} next of kin`, phone: m.phone } });
  expect(comp.error, comp.error?.message).toBeNull();
}

export async function residue(m: Markers): Promise<Array<{ location: string; marker: string; hits: number }>> {
  const r = await db().rpc("privacy_residue_scan", { p_markers: [m.name, m.email, m.phone] });
  expect(r.error, r.error?.message).toBeNull();
  return (r.data as Array<{ location: string; marker: string; hits: number }> | null) ?? [];
}

export async function countRows(table: string, filters: Record<string, unknown>): Promise<number> {
  let q = db().from(table).select("*", { count: "exact", head: true });
  for (const [k, v] of Object.entries(filters)) q = q.eq(k, v);
  const r = (await q) as unknown as { count: number | null; error: { message: string } | null };
  expect(r.error, `${table}: ${r.error?.message}`).toBeNull();
  return r.count ?? 0;
}

/**
 * Every row of every org-scoped table for `orgId`, plus its storage listing —
 * a canonical JSON snapshot. Two snapshots being string-equal is the
 * "byte-for-byte unaffected" assertion for a bystander tenant.
 */
export async function snapshotOrg(orgId: string, userIds: string[]): Promise<string> {
  const t = await db().rpc("_introspect_org_scoped_tables");
  expect(t.error, t.error?.message).toBeNull();
  const tables = ((t.data as Array<string | { table_name?: string; relname?: string }> | null) ?? [])
    .map((x) => (typeof x === "string" ? x : (x.table_name ?? x.relname ?? "")))
    .filter(Boolean)
    .sort();
  expect(tables.length).toBeGreaterThan(100);
  const out: Record<string, unknown> = {};
  for (const table of tables) {
    const r = await db().from(table).select("*").eq("org_id", orgId).limit(1000);
    expect(r.error, `${table}: ${r.error?.message}`).toBeNull();
    const rows = ((r.data as Array<Record<string, unknown>> | null) ?? [])
      .map((row) => JSON.stringify(row, Object.keys(row).sort()))
      .sort();
    if (rows.length > 0) out[table] = rows;
  }
  const org = await db().from("organizations").select("*").eq("id", orgId);
  out.__organizations = org.data;
  const users = await db().from("users").select("*").in("id", userIds).order("id");
  out.__users = users.data;
  const comp = await db().from("staff_compensation").select("*").in("user_id", userIds).order("user_id");
  out.__staff_compensation = comp.data;
  out.__storage_objects = await countOrgObjects(orgId);
  for (const id of userIds) {
    const u = await serviceClient().auth.admin.getUserById(id);
    out[`__auth_${id}`] = u.data.user
      ? { email: u.data.user.email, meta: u.data.user.user_metadata, deleted: (u.data.user as { deleted_at?: string }).deleted_at ?? null }
      : null;
  }
  return JSON.stringify(out);
}

export type StripeMock = StripeSubscriptionsApi & { calls: string[] };

/** A recording Stripe stand-in (SIMULATED — no network, no real Stripe). */
export function stripeMock(
  opts: { status?: string; failCancel?: boolean; missing?: boolean } = {},
): StripeMock {
  const calls: string[] = [];
  return {
    calls,
    subscriptions: {
      retrieve: async (id: string) => {
        calls.push(`retrieve:${id}`);
        if (opts.missing) throw Object.assign(new Error("No such subscription"), { code: "resource_missing" });
        return { status: opts.status ?? "active" };
      },
      cancel: async (id: string, _params, o) => {
        calls.push(`cancel:${id}:${o?.idempotencyKey ?? ""}`);
        if (opts.failCancel) throw Object.assign(new Error("stripe is down"), { code: "api_error" });
        return { status: "canceled" };
      },
    },
  };
}

/** End a company deletion's cooling-off now (a synthetic request only). */
export async function makeDue(requestId: string): Promise<void> {
  const r = await db()
    .from("privacy_deletion_requests")
    .update({ scheduled_for: new Date(Date.now() - 5_000).toISOString() })
    .eq("id", requestId);
  expect(r.error, r.error?.message).toBeNull();
}

export async function ledger(requestId: string): Promise<Record<string, unknown>> {
  const r = await db().from("privacy_deletion_requests").select("*").eq("id", requestId).single();
  expect(r.error, r.error?.message).toBeNull();
  return r.data as Record<string, unknown>;
}

/** Best-effort teardown of anything a test left behind (already-deleted is fine). */
export async function cleanup(orgIds: string[], userIds: string[]): Promise<void> {
  const svc = serviceClient();
  for (const orgId of orgIds) {
    for (const bucket of SEEDED_BUCKETS) {
      const walk = async (prefix: string): Promise<string[]> => {
        const { data } = await svc.storage.from(bucket).list(prefix, { limit: 1000 });
        const acc: string[] = [];
        for (const item of data ?? []) {
          if (item.id === null) acc.push(...(await walk(`${prefix}/${item.name}`)));
          else acc.push(`${prefix}/${item.name}`);
        }
        return acc;
      };
      const paths = await walk(orgId);
      if (paths.length) await svc.storage.from(bucket).remove(paths);
    }
    await db().from("billing_events").delete().eq("org_id", orgId);
    await db().from("organizations").delete().eq("id", orgId);
  }
  for (const id of userIds) {
    await db().from("staff_compensation").delete().eq("user_id", id);
    await svc.auth.admin.deleteUser(id);
  }
}
