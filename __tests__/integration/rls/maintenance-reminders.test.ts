import { afterAll, beforeAll, expect, it, vi } from "vitest";
import {
  anonClient,
  describeIntegration,
  serviceClient,
  userClient,
} from "../_harness";
import { drainDueReminders } from "@/server/services/maintenance-reminders";
import { sendEmail } from "@/lib/email/send";

// The email seam is mocked so the LIVE-path double-send proof below can run
// against real Postgres WITHOUT a real Resend key and without sending anything.
// The dark-path assertions never reach this seam.
vi.mock("@/lib/email/send", () => ({
  sendEmail: vi.fn(async () => ({ sent: true as const, id: "mock-msg-id" })),
}));

/**
 * MAINTENANCE REMINDERS (20261092) — against real Postgres.
 *
 * Four properties, the shape the expense-budgets isolation proof shipped in:
 *
 *   1. RLS. A member of the org may READ the reminder log; an outsider sees
 *      nothing; a member may not write it (admins/service-role only).
 *   2. IDEMPOTENCY. The dedupe unique key (org, warranty, kind, due_date)
 *      REFUSES a second row for the same occurrence — a duplicate is
 *      structurally unrepresentable.
 *   3. DARK DRAIN. With the feature flag OFF (the default), `drainDueReminders`
 *      records due reminders as `skipped_dark` and reports `live:false` —
 *      computed, logged, but not sent.
 *   4. DRAIN IDEMPOTENCY. A second drain over the same window creates nothing.
 *
 * The "nothing is SENT on the dark path" security assertion (the sender is never
 * invoked) lives in __tests__/security/maintenance-reminders.test.ts, where the
 * email seam can be spied without a real Resend key.
 */

type Res<T> = { data: T | null; error: { message: string } | null };
type Row = Record<string, unknown>;
interface Sel extends PromiseLike<Res<Row[]>> {
  eq(column: string, value: unknown): Sel;
  maybeSingle(): PromiseLike<Res<Row>>;
}
interface Ins extends PromiseLike<Res<Row[]>> {
  select(columns?: string): Ins;
  single(): PromiseLike<Res<Row>>;
}
interface Upd extends PromiseLike<Res<Row[]> & { count: number | null }> {
  eq(column: string, value: unknown): Upd;
}
interface Del extends PromiseLike<Res<null> & { count: number | null }> {
  eq(column: string, value: unknown): Del;
}
interface Table {
  select(columns?: string, opts?: Record<string, unknown>): Sel;
  insert(rows: Row | Row[]): Ins;
  update(row: Row, opts?: Record<string, unknown>): Upd;
  delete(opts?: Record<string, unknown>): Del;
}
const db = (client: unknown) => client as unknown as { from(t: string): Table };

const TOKEN = `it-mr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describeIntegration("maintenance reminders · RLS + idempotency + dark drain", () => {
  let orgA = "";
  let orgB = "";
  let jobA = "";
  let warrantyA = "";

  let memberId = "";
  let memberToken = "";
  let outsiderToken = "";

  async function mintUser(label: string): Promise<{ id: string; token: string }> {
    const email = `${TOKEN}-${label}@example.test`;
    const password = `Pw-${TOKEN}-${Math.random().toString(36).slice(2)}`;
    const created = await serviceClient().auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    expect(created.error, created.error?.message).toBeNull();
    const id = created.data.user?.id ?? "";
    const mirrored = await db(serviceClient())
      .from("users")
      .insert({ id, email, full_name: `Maint reminders ${label}` })
      .select("id")
      .single();
    expect(mirrored.error, mirrored.error?.message).toBeNull();
    const signedIn = await anonClient().auth.signInWithPassword({ email, password });
    expect(signedIn.error, signedIn.error?.message).toBeNull();
    return { id, token: signedIn.data.session?.access_token ?? "" };
  }

  beforeAll(async () => {
    const svc = db(serviceClient());

    const a = await svc
      .from("organizations")
      .insert({ name: "Maint Reminders A", slug: `${TOKEN}-a` })
      .select("id")
      .single();
    const b = await svc
      .from("organizations")
      .insert({ name: "Maint Reminders B", slug: `${TOKEN}-b` })
      .select("id")
      .single();
    orgA = String(a.data?.id ?? "");
    orgB = String(b.data?.id ?? "");
    if (!orgA || !orgB) throw new Error("failed to create probe orgs");

    // A job with an ISSUED completion certificate dated 2025-01-01, and an
    // active PUBLISHED warranty: 12 months, serviced monthly. First service is
    // 2025-02-01, so a drain with today=2025-01-20 finds exactly that one inside
    // the 30-day lead window.
    const job = await svc
      .from("jobs")
      .insert({ org_id: orgA })
      .select("id")
      .single();
    jobA = String(job.data?.id ?? "");
    expect(jobA).not.toBe("");

    const cert = await svc.from("completion_certificates").insert({
      org_id: orgA,
      job_id: jobA,
      certificate_number: `${TOKEN}-cert`,
      completion_date: "2025-01-01",
      status: "issued",
    });
    expect(cert.error, cert.error?.message).toBeNull();

    const warranty = await svc
      .from("job_warranties")
      .insert({
        org_id: orgA,
        job_id: jobA,
        title: "Boiler workmanship",
        cover: "Twelve months on the installation.",
        period_months: 12,
        service_interval_months: 1,
        portal_published_at: new Date().toISOString(),
      })
      .select("id")
      .single();
    expect(warranty.error, warranty.error?.message).toBeNull();
    warrantyA = String(warranty.data?.id ?? "");
    expect(warrantyA).not.toBe("");

    const member = await mintUser("member");
    memberId = member.id;
    memberToken = member.token;
    const mm = await svc
      .from("memberships")
      .insert({ org_id: orgA, user_id: memberId, role: "staff" });
    expect(mm.error, mm.error?.message).toBeNull();

    const outsider = await mintUser("outsider");
    outsiderToken = outsider.token;
    if (!memberToken || !outsiderToken) throw new Error("failed to mint tokens");
  });

  afterAll(async () => {
    const svc = db(serviceClient());
    if (orgA) await svc.from("organizations").delete().eq("id", orgA);
    if (orgB) await svc.from("organizations").delete().eq("id", orgB);
  });

  // ── 3 + 4. Dark drain, then idempotency ─────────────────────────────────────

  it("DARK DRAIN: records due reminders as skipped_dark and reports live:false", async () => {
    const res = await drainDueReminders(orgA, { today: "2025-01-20" });
    expect(res.ok).toBe(true);
    expect(res.live).toBe(false);
    expect(res.sent).toBe(0);
    expect(res.created).toBeGreaterThanOrEqual(1);
    expect(res.skippedDark).toBeGreaterThanOrEqual(1);

    // Every logged row is skipped_dark with no send evidence.
    const rows = await db(serviceClient())
      .from("maintenance_reminder_log")
      .select("status, sent_at, provider_message_id, channel")
      .eq("org_id", orgA);
    expect(rows.error, rows.error?.message).toBeNull();
    expect((rows.data ?? []).length).toBeGreaterThanOrEqual(1);
    for (const r of rows.data ?? []) {
      expect(r.status).toBe("skipped_dark");
      expect(r.sent_at).toBeNull();
      expect(r.provider_message_id).toBeNull();
      expect(r.channel).toBe("email");
    }
  });

  it("DRAIN IDEMPOTENCY: a second drain over the same window creates nothing", async () => {
    const again = await drainDueReminders(orgA, { today: "2025-01-20" });
    expect(again.ok).toBe(true);
    expect(again.created).toBe(0);
    expect(again.sent).toBe(0);
  });

  // ── 2. Unique-key idempotency refuses a duplicate ──────────────────────────

  it("the dedupe UNIQUE key refuses a second row for the same occurrence", async () => {
    const dup = await db(serviceClient())
      .from("maintenance_reminder_log")
      .insert({
        org_id: orgA,
        warranty_id: warrantyA,
        job_id: jobA,
        kind: "service",
        due_date: "2025-02-01",
        scheduled_for: "2025-01-02",
        channel: "email",
        status: "pending",
      })
      .select("id");
    // A row for (orgA, warrantyA, service, 2025-02-01) already exists from the
    // drain — this duplicate must be refused by the unique constraint.
    expect(dup.error, "duplicate reminder must be refused by the unique key").not.toBeNull();
  });

  // ── 1. RLS ─────────────────────────────────────────────────────────────────

  it("a MEMBER may read the org's reminder log", async () => {
    const res = await db(userClient(memberToken))
      .from("maintenance_reminder_log")
      .select("id")
      .eq("org_id", orgA);
    expect(res.error, res.error?.message).toBeNull();
    expect((res.data ?? []).length).toBeGreaterThanOrEqual(1);
  });

  it("an OUTSIDER sees no reminder rows at all (RLS)", async () => {
    const res = await db(userClient(outsiderToken))
      .from("maintenance_reminder_log")
      .select("id")
      .eq("org_id", orgA);
    expect(res.error, res.error?.message).toBeNull();
    expect(res.data ?? []).toHaveLength(0);
  });

  it("a MEMBER may NOT write the reminder log (admins/service-role only)", async () => {
    const ins = await db(userClient(memberToken))
      .from("maintenance_reminder_log")
      .insert({
        org_id: orgA,
        warranty_id: warrantyA,
        job_id: jobA,
        kind: "expiry",
        due_date: "2026-01-01",
        scheduled_for: "2025-12-02",
        channel: "email",
        status: "pending",
      })
      .select("id");
    expect(ins.error, "member insert must be refused by RLS").not.toBeNull();
  });
});

/**
 * ATOMIC CLAIM — the once-only-send proof (P2-a / P2-b), against real Postgres.
 *
 * The live send path claims each reminder pending → 'sending' … RETURNING under
 * a per-org `pg_advisory_xact_lock` (claim_due_maintenance_reminders) and sends
 * ONLY the rows it won. This proves the double-send gaps a future flag-flip would
 * otherwise expose are closed:
 *
 *   1. TWO overlapping drains send the reminder at most once (concurrent-drain).
 *   2. A subsequent drain does not re-send an already-sent reminder.
 *   3. A row stranded in 'sending' (a drain that won the claim but never marked
 *      it — the mark-failure case) is NOT re-claimed and NOT re-sent.
 *
 * The feature is DARK in production; here the flag + a present RESEND key are set
 * ONLY for this block (restored after) to exercise the otherwise-unreachable live
 * path. The email seam itself is mocked, so nothing is actually sent.
 */
describeIntegration("maintenance reminders · atomic claim prevents double-send", () => {
  const sendMock = vi.mocked(sendEmail);
  const svc = () => db(serviceClient());
  const FLAG = "NEXT_PUBLIC_FEATURE_MAINTENANCE_REMINDERS";

  let org = "";
  let job = "";
  let warranty = "";
  let prevFlag: string | undefined;
  let prevResend: string | undefined;

  beforeAll(async () => {
    // Live-path env: flag ON + a present RESEND key ⇒ maintenanceRemindersSending()
    // is true. The email seam is mocked, so no real message leaves the building.
    prevFlag = process.env[FLAG];
    prevResend = process.env.RESEND_API_KEY;
    process.env[FLAG] = "true";
    process.env.RESEND_API_KEY = "re_test_key_for_readiness_only";

    const o = await svc()
      .from("organizations")
      .insert({ name: "Maint Reminders Claim", slug: `${TOKEN}-claim` })
      .select("id")
      .single();
    org = String(o.data?.id ?? "");
    if (!org) throw new Error("failed to create claim probe org");

    const cust = await svc()
      .from("customers")
      .insert({ org_id: org, name: "Claim Customer", email: "claim-customer@example.test" })
      .select("id")
      .single();
    const custId = String(cust.data?.id ?? "");
    expect(custId).not.toBe("");

    const j = await svc()
      .from("jobs")
      .insert({ org_id: org, customer_id: custId })
      .select("id")
      .single();
    job = String(j.data?.id ?? "");
    expect(job).not.toBe("");

    const cert = await svc().from("completion_certificates").insert({
      org_id: org,
      job_id: job,
      certificate_number: `${TOKEN}-claim-cert`,
      completion_date: "2025-01-01",
      status: "issued",
    });
    expect(cert.error, cert.error?.message).toBeNull();

    const w = await svc()
      .from("job_warranties")
      .insert({
        org_id: org,
        job_id: job,
        title: "Claim boiler",
        cover: "Twelve months on the installation.",
        period_months: 12,
        service_interval_months: 1,
        portal_published_at: new Date().toISOString(),
      })
      .select("id")
      .single();
    warranty = String(w.data?.id ?? "");
    expect(warranty).not.toBe("");
  });

  afterAll(async () => {
    if (org) await svc().from("organizations").delete().eq("id", org);
    if (prevFlag === undefined) delete process.env[FLAG];
    else process.env[FLAG] = prevFlag;
    if (prevResend === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = prevResend;
  });

  it("TWO concurrent drains send the reminder AT MOST ONCE", async () => {
    sendMock.mockClear();
    // First service occurrence is 2025-02-01; today=2025-01-20 is inside the 30d
    // lead window. Two overlapping drains race the same due reminder.
    const [a, b] = await Promise.all([
      drainDueReminders(org, { today: "2025-01-20" }),
      drainDueReminders(org, { today: "2025-01-20" }),
    ]);
    expect(a.live).toBe(true);
    expect(b.live).toBe(true);

    // THE assertion: exactly ONE email left the building across both drains, and
    // the two runs together claim-and-send the reminder exactly once.
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(a.sent + b.sent).toBe(1);

    // Exactly one 'sent' row, carrying evidence (the CHECK forbids any other shape).
    const rows = await svc()
      .from("maintenance_reminder_log")
      .select("status, sent_at, provider_message_id")
      .eq("org_id", org)
      .eq("status", "sent");
    expect((rows.data ?? []).length).toBe(1);
    expect((rows.data ?? [])[0]?.sent_at).not.toBeNull();
    expect((rows.data ?? [])[0]?.provider_message_id).toBe("mock-msg-id");
  });

  it("a subsequent drain does NOT re-send an already-sent reminder", async () => {
    sendMock.mockClear();
    const again = await drainDueReminders(org, { today: "2025-01-20" });
    expect(again.sent).toBe(0);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("a row stranded in 'sending' (claim won, mark never landed) is NOT re-sent", async () => {
    sendMock.mockClear();
    // Simulate a drain that crashed AFTER winning the claim but BEFORE marking
    // sent: a row sitting in 'sending'. Because the claim only ever matches
    // 'pending', this row can never be re-claimed — and so never re-sent.
    const ins = await svc()
      .from("maintenance_reminder_log")
      .insert({
        org_id: org,
        warranty_id: warranty,
        job_id: job,
        kind: "expiry",
        due_date: "2026-01-01",
        scheduled_for: "2025-12-02",
        channel: "email",
        status: "sending",
      })
      .select("id")
      .single();
    expect(ins.error, ins.error?.message).toBeNull();
    const strandedId = String(ins.data?.id ?? "");

    await drainDueReminders(org, { today: "2025-01-20" });
    expect(sendMock).not.toHaveBeenCalled();

    const row = await svc()
      .from("maintenance_reminder_log")
      .select("status")
      .eq("org_id", org)
      .eq("id", strandedId);
    expect((row.data ?? [])[0]?.status).toBe("sending");
  });
});
