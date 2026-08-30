import { afterAll, expect, it } from "vitest";
import { describeIntegration, serviceClient } from "../_harness";
import { requeueFailedNotificationEmail } from "@/server/services/notification-email-requeue";

/**
 * Failed-email requeue — real-Postgres proof (L11 item 2).
 *
 * The drain (lib/notifications/email.ts) claims rows with
 * status='queued' AND scheduled_for in the past; after MAX_RETRIES the
 * row is parked at status='failed' forever. This proves the HQ requeue
 * service genuinely un-parks such a row:
 *
 *   • a permanently-failed row (retry_count=6) flips back to the exact
 *     shape the drain's pick-up query claims — status='queued',
 *     scheduled_for <= now, retry_count reset to 0;
 *   • last_error is KEPT as the diagnostic breadcrumb;
 *   • the guarded UPDATE is idempotent/safe: a second requeue of the now
 *     -queued row, and a requeue of a SENT row, both refuse with
 *     not_failed_or_missing and touch nothing — the action can never
 *     resurrect an email that already went out;
 *   • a random uuid (no row) refuses the same way.
 *
 * Fixtures use a dedicated org so teardown removes exactly what was made.
 */

const T = `req-${Date.now().toString(36)}`;
const svc = () => serviceClient();

type QueueRow = {
  id: string;
  status: string;
  retry_count: number;
  last_error: string | null;
  failed_at: string | null;
  scheduled_for: string;
  sent_at: string | null;
};

let orgId: string;
const queueIds: string[] = [];

async function seedQueueRow(row: Record<string, unknown>): Promise<string> {
  const { data, error } = await (svc()
    .from("notification_email_queue" as never) as never as {
    insert: (v: unknown) => {
      select: (c: string) => {
        single: () => Promise<{
          data: { id: string } | null;
          error: { message: string } | null;
        }>;
      };
    };
  })
    .insert({ org_id: orgId, ...row })
    .select("id")
    .single();
  expect(error, error?.message).toBeNull();
  const id = data?.id ?? "";
  queueIds.push(id);
  return id;
}

async function readRow(id: string): Promise<QueueRow> {
  const { data, error } = await (svc()
    .from("notification_email_queue" as never) as never as {
    select: (c: string) => {
      eq: (k: string, v: string) => {
        single: () => Promise<{
          data: QueueRow | null;
          error: { message: string } | null;
        }>;
      };
    };
  })
    .select("id, status, retry_count, last_error, failed_at, scheduled_for, sent_at")
    .eq("id", id)
    .single();
  expect(error, error?.message).toBeNull();
  return data as QueueRow;
}

describeIntegration("failed-email requeue (real Postgres)", () => {
  afterAll(async () => {
    for (const id of queueIds) {
      await (svc().from("notification_email_queue" as never) as never as {
        delete: () => { eq: (k: string, v: string) => Promise<unknown> };
      })
        .delete()
        .eq("id", id);
    }
    if (orgId) {
      await svc().from("organizations").delete().eq("id", orgId);
    }
  });

  it("requeues a permanently-failed row into the drain's claimable shape", async () => {
    const org = await svc()
      .from("organizations")
      .insert({ name: `Requeue Test ${T}`, slug: `requeue-${T}` })
      .select("id")
      .single();
    expect(org.error, org.error?.message).toBeNull();
    orgId = org.data?.id ?? "";

    const failedId = await seedQueueRow({
      to_email: `ops-${T}@example.test`,
      subject: "requeue fixture",
      body_text: "body",
      status: "failed",
      retry_count: 6,
      last_error: "dispatch_error: mailbox full",
      failed_at: new Date(Date.now() - 3600_000).toISOString(),
      scheduled_for: new Date(Date.now() - 7200_000).toISOString(),
    });

    const result = await requeueFailedNotificationEmail(failedId);
    expect(result.ok, JSON.stringify(result)).toBe(true);

    const row = await readRow(failedId);
    // The drain's pick-up predicate: status='queued' + scheduled_for past.
    expect(row.status).toBe("queued");
    expect(new Date(row.scheduled_for).getTime()).toBeLessThanOrEqual(Date.now());
    // Fresh retry budget; failure markers cleared; breadcrumb kept.
    expect(row.retry_count).toBe(0);
    expect(row.failed_at).toBeNull();
    expect(row.last_error).toBe("dispatch_error: mailbox full");

    // CLAIMABLE — the row satisfies the exact filter drainNotificationEmailQueue
    // uses (.eq status queued, scheduled_for ordering). We assert the filter,
    // not the send: running the real drain here could dispatch live email if
    // the local env carries a RESEND_API_KEY.
    const { data: claimable } = await (svc()
      .from("notification_email_queue" as never) as never as {
      select: (c: string) => {
        eq: (k: string, v: string) => {
          eq: (
            k: string,
            v: string,
          ) => {
            lte: (k: string, v: string) => Promise<{ data: unknown[] | null }>;
          };
        };
      };
    })
      .select("id")
      .eq("id", failedId)
      .eq("status", "queued")
      .lte("scheduled_for", new Date().toISOString());
    expect(claimable ?? []).toHaveLength(1);
  });

  it("refuses to requeue a row that is no longer failed (idempotent, never resurrects sent mail)", async () => {
    // The row from the previous test is now 'queued'.
    const queuedId = queueIds[0]!;
    const again = await requeueFailedNotificationEmail(queuedId);
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.reason).toBe("not_failed_or_missing");

    // A SENT row is untouched.
    const sentId = await seedQueueRow({
      to_email: `sent-${T}@example.test`,
      subject: "already sent",
      body_text: "body",
      status: "sent",
      retry_count: 1,
      sent_at: new Date().toISOString(),
    });
    const res = await requeueFailedNotificationEmail(sentId);
    expect(res.ok).toBe(false);
    const sentRow = await readRow(sentId);
    expect(sentRow.status).toBe("sent");
    expect(sentRow.retry_count).toBe(1);
  });

  it("refuses a non-existent id", async () => {
    const res = await requeueFailedNotificationEmail(
      "00000000-0000-4000-8000-000000000000",
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("not_failed_or_missing");
  });
});
