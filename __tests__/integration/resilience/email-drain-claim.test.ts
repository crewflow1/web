import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { describeIntegration, serviceClient } from "../_harness";

/**
 * NOTIFICATION EMAIL DRAIN — a queued email is sent EXACTLY ONCE even when two
 * drains overlap. Real Postgres; the provider (Resend) is the only thing mocked.
 *
 * The drain selected `status='queued'` rows and sent each one with NO claim. Two
 * drains in flight at once therefore each read the same rows and each sent them:
 * every email in the batch went out twice. Overlap is not exotic — the platform
 * delivers cron events at-least-once, the `notifications-drain` cron and the HQ
 * cadence clock both call this drain, and one slow provider call stretches a
 * pass. The queue also carries subcontractor CIS statement emails.
 *
 * (push/SMS got an atomic claim in 20261274000000; the email queue did not.)
 *
 * This file drives the per-row sender — the unit the drain calls for every row —
 * against rows it creates itself. It deliberately does NOT call the batch drain:
 * the local database is shared, and the batch would pick up other suites' rows.
 */

const sent = vi.hoisted(() => ({ calls: [] as { to: string; subject: string }[], fail: false, delayMs: 40 }));

vi.mock("@/lib/email/send", () => ({
  sendEmail: vi.fn(async (input: { to: string; subject: string }) => {
    sent.calls.push({ to: String(input.to), subject: input.subject });
    await new Promise((r) => setTimeout(r, sent.delayMs));
    if (sent.fail) return { sent: false, reason: "error", error: "provider 503" };
    return { sent: true, id: `msg_${sent.calls.length}` };
  }),
}));
// A provider must look configured or the sender short-circuits to 'skipped'.
// Not a real credential — the provider call itself is mocked above.
vi.mock("@/lib/env", async (orig) => {
  const real = (await orig()) as { env: Record<string, unknown> };
  return { ...real, env: { ...real.env, RESEND_API_KEY: "test-placeholder-not-a-key" } };
});

const { sendNotificationEmail } = await import("@/lib/notifications/email");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const svc = () => serviceClient() as unknown as { from(t: string): any };
const TOKEN = `resilience-email-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
let orgId = "";
let seq = 0;

async function queueRow(patch: Record<string, unknown> = {}): Promise<{ id: string; subject: string }> {
  seq += 1;
  const subject = `Resilience ${TOKEN} #${seq}`;
  const r = await svc()
    .from("notification_email_queue")
    .insert({
      org_id: orgId,
      to_email: `recipient-${seq}@example.test`,
      subject,
      body_text: "body",
      status: "queued",
      scheduled_for: new Date(Date.now() - 60_000).toISOString(),
      ...patch,
    })
    .select("id")
    .single();
  expect(r.error, r.error?.message).toBeNull();
  return { id: r.data.id as string, subject };
}
const row = async (id: string) =>
  (await svc().from("notification_email_queue").select("status, retry_count, scheduled_for, sent_at, last_error").eq("id", id).single()).data as {
    status: string;
    retry_count: number;
    scheduled_for: string;
    sent_at: string | null;
    last_error: string | null;
  };
const sendsOf = (subject: string) => sent.calls.filter((c) => c.subject === subject).length;

beforeAll(async () => {
  const org = await svc().from("organizations").insert({ name: `Resilience Email ${TOKEN}`, slug: `${TOKEN}-org` }).select("id").single();
  expect(org.error, org.error?.message).toBeNull();
  orgId = org.data.id as string;
});
afterAll(async () => {
  if (orgId) await svc().from("organizations").delete().eq("id", orgId);
});
beforeEach(() => {
  sent.calls.length = 0;
  sent.fail = false;
});

describeIntegration("notification email drain · exactly-once under overlapping drains", () => {
  it("FIVE overlapping drains pick the same queued row → the email is sent ONCE", async () => {
    const q = await queueRow();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => sendNotificationEmail({ queue_row_id: q.id })),
    );

    expect(sendsOf(q.subject), "one queued email, one provider call").toBe(1);
    expect(results.filter((r) => r.status === "sent")).toHaveLength(1);
    const after = await row(q.id);
    expect(after.status).toBe("sent");
    expect(after.sent_at).toBeTruthy();
  });

  it("a row that is already sent is never sent again", async () => {
    const q = await queueRow();
    await sendNotificationEmail({ queue_row_id: q.id });
    const again = await sendNotificationEmail({ queue_row_id: q.id });
    expect(sendsOf(q.subject)).toBe(1);
    expect(again.status).not.toBe("sent");
  });

  it("a row that is not due yet (quiet hours / retry backoff) is not sent early", async () => {
    const q = await queueRow({ scheduled_for: new Date(Date.now() + 3_600_000).toISOString() });
    const res = await sendNotificationEmail({ queue_row_id: q.id });
    expect(sendsOf(q.subject)).toBe(0);
    expect(res.status).toBe("queued");
    expect((await row(q.id)).status).toBe("queued");
  });

  it("CRASH after claiming: the row is not lost — it becomes claimable again when the lease lapses", async () => {
    const q = await queueRow();
    // A drain claimed the row and died before recording an outcome. The claim is
    // a lease on `scheduled_for`, so that is exactly a queued row whose
    // scheduled_for sits in the (near) future:
    const { EMAIL_CLAIM_LEASE_MS } = await import("@/lib/notifications/email");
    expect(EMAIL_CLAIM_LEASE_MS).toBeGreaterThanOrEqual(60_000);
    await svc()
      .from("notification_email_queue")
      .update({ scheduled_for: new Date(Date.now() + EMAIL_CLAIM_LEASE_MS).toISOString() })
      .eq("id", q.id);
    // While the lease is live nobody else may send it…
    expect((await sendNotificationEmail({ queue_row_id: q.id })).status).toBe("queued");
    expect(sendsOf(q.subject)).toBe(0);
    // …and once it lapses the next drain sends it. Not stuck, not lost.
    await svc()
      .from("notification_email_queue")
      .update({ scheduled_for: new Date(Date.now() - 1_000).toISOString() })
      .eq("id", q.id);
    expect((await sendNotificationEmail({ queue_row_id: q.id })).status).toBe("sent");
    expect(sendsOf(q.subject)).toBe(1);
  });

  it("provider failure under overlap: ONE attempt is made and ONE retry is scheduled (retry_count +1, not +N)", async () => {
    sent.fail = true;
    const q = await queueRow();
    await Promise.all(Array.from({ length: 4 }, () => sendNotificationEmail({ queue_row_id: q.id })));

    expect(sendsOf(q.subject)).toBe(1);
    const after = await row(q.id);
    expect(after.status).toBe("queued"); // re-queued for backoff
    expect(after.retry_count).toBe(1);
    expect(new Date(after.scheduled_for).getTime()).toBeGreaterThan(Date.now());
    expect(after.last_error).toContain("provider 503");
  });
});
