import { afterAll, beforeAll, expect, it } from "vitest";
import { describeIntegration, serviceClient } from "../_harness";
import { emitNotifications } from "@/server/services/notifications-service";
import { notifyOnPortalReplyToOrg } from "@/lib/notifications/events";

/**
 * Cross-customer / cross-org isolation of the portal-reply notification
 * (Train F, direction b: customer → tenant), driven against real Postgres.
 *
 * When customer A replies in org A, the in-app notification must reach org A's
 * staff and NOBODY in org B. The whole isolation boundary is `org_id` +
 * audience 'customer' + user_id null (RLS resolves that to every member of the
 * org; the end-customer has no user row / membership). This proves it through
 * the real emit path — the pure emitter + the service-role insert.
 *
 * AUTHORED per Train F directive; run with the integration suite
 * (vitest.integration.config.ts) against a live DB, not the security suite.
 */

type Res = { data: Array<Record<string, unknown>> | null; error: unknown };
interface Sel extends PromiseLike<Res> {
  eq(c: string, v: unknown): Sel;
}
const db = (c: unknown) =>
  c as unknown as {
    from(t: string): {
      select(c: string): Sel;
      insert(r: Record<string, unknown>): {
        select(c: string): {
          single(): PromiseLike<{
            data: { id: string } | null;
            error: { message: string } | null;
          }>;
        };
      };
      delete(): { eq(c: string, v: unknown): PromiseLike<Res> };
    };
  };

const T = `it-reply-notif-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describeIntegration("Portal reply notification · org isolation (real Postgres)", () => {
  let orgA = "";
  let orgB = "";
  let custA = "";
  let ticketA = "";
  const svc = () => db(serviceClient());

  const mk = async (table: string, row: Record<string, unknown>) => {
    const r = await svc().from(table).insert(row).select("id").single();
    if (r.error) throw new Error(`${table}: ${r.error.message}`);
    return String(r.data?.id ?? "");
  };

  beforeAll(async () => {
    orgA = await mk("organizations", { name: "Reply A", slug: `${T}-a` });
    orgB = await mk("organizations", { name: "Reply B", slug: `${T}-b` });
    custA = await mk("customers", { org_id: orgA, name: "A Homeowner" });
    // A portal thread in org A (customer_id set) with the customer speaking last.
    ticketA = await mk("support_tickets", {
      org_id: orgA,
      customer_id: custA,
      subject: "Question about the invoice",
      status: "open",
    });
  });

  afterAll(async () => {
    // Best-effort teardown; cascades handle the children.
    await svc().from("notifications").delete().eq("org_id", orgA);
    await svc().from("notifications").delete().eq("org_id", orgB);
    await svc().from("support_tickets").delete().eq("org_id", orgA);
    await svc().from("customers").delete().eq("org_id", orgA);
    await svc().from("organizations").delete().eq("id", orgA);
    await svc().from("organizations").delete().eq("id", orgB);
  });

  it("emits one org-A notification and NONE for org B", async () => {
    await emitNotifications(
      notifyOnPortalReplyToOrg({
        org_id: orgA,
        ticket_id: ticketA,
        ticket_number: 1,
        customer_name: "A Homeowner",
      }),
    );

    const aRows = await svc()
      .from("notifications")
      .select("org_id, audience, user_id, type, source_id, body")
      .eq("org_id", orgA)
      .eq("type", "support.portal_customer_reply");
    const a = aRows.data ?? [];
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({
      org_id: orgA,
      audience: "customer",
      user_id: null,
      source_id: ticketA,
    });
    // No message body ever rides into the notification — fixed copy only.
    expect(String(a[0]?.body)).toBe(
      "Open the thread to read their reply and respond.",
    );

    const bRows = await svc()
      .from("notifications")
      .select("id")
      .eq("org_id", orgB);
    expect(bRows.data ?? []).toHaveLength(0);
  });
});
