import { afterAll, beforeAll, expect, it } from "vitest";
import { describeIntegration, serviceClient } from "../_harness";

/**
 * Automation rules + schedules (20261096) — the ENGINE against real Postgres.
 *
 * These exercise the REAL dispatcher and REAL drain, because the guarantees are
 * database behaviour a mock cannot prove:
 *   · a per-org rule OVERRIDE flips enable-state the dispatcher reads;
 *   · the wired actions (send_email_queue, create_invoice_draft) do REAL,
 *     org-scoped, idempotent work through the existing authorities;
 *   · the schedule drain fires due schedules, advances next_run_at, is idempotent
 *     under CONCURRENT drains, and never acts cross-org.
 */

type Db = {
  from: (t: string) => {
    insert: (v: unknown) => {
      select: (c: string) => { single: () => Promise<Res> };
    } & PromiseLike<Res>;
    upsert: (v: unknown, o?: Record<string, unknown>) => PromiseLike<Res>;
    select: (c: string) => {
      eq: (k: string, v: unknown) => {
        eq: (k: string, v: unknown) => PromiseLike<ResList> & {
          maybeSingle: () => Promise<Res>;
        };
        maybeSingle: () => Promise<Res>;
      } & PromiseLike<ResList>;
    };
    update: (v: unknown) => {
      eq: (k: string, v: unknown) => PromiseLike<Res>;
    };
    delete: () => { eq: (k: string, v: unknown) => PromiseLike<Res> };
  };
};
type Res = { data: Record<string, unknown> | null; error: { message: string } | null };
type ResList = { data: Record<string, unknown>[] | null; error: { message: string } | null };
const db = (c: unknown): Db => c as unknown as Db;

const TOKEN = `it-autoeng-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describeIntegration("automation engine · overrides, wired actions, drain", () => {
  let dispatchAutomation: typeof import("@/server/services/automation-dispatcher").dispatchAutomation;
  let drainDueSchedules: typeof import("@/server/services/automation-schedules").drainDueSchedules;
  let occurrenceId: typeof import("@/server/services/automation-schedules").occurrenceId;

  const svc = () => db(serviceClient());
  const uuid = () => crypto.randomUUID();

  async function makeOrg(name: string, email: string | null): Promise<string> {
    const r = await svc()
      .from("organizations")
      .insert({ name, slug: `${TOKEN}-${Math.random().toString(36).slice(2, 8)}`, email })
      .select("id")
      .single();
    expect(r.error, r.error?.message).toBeNull();
    return String(r.data?.id ?? "");
  }

  async function setOverride(orgId: string, ruleKey: string, enabled: boolean) {
    const r = await svc()
      .from("automation_rules")
      .upsert(
        { org_id: orgId, rule_key: ruleKey, enabled },
        { onConflict: "org_id,rule_key" },
      );
    expect(r.error, r.error?.message).toBeNull();
  }

  async function notifCount(orgId: string, sourceId: string): Promise<number> {
    const r = await svc()
      .from("notifications")
      .select("id")
      .eq("org_id", orgId)
      .eq("source_id", sourceId);
    expect(r.error, r.error?.message).toBeNull();
    return (r.data ?? []).length;
  }

  const orgs: string[] = [];

  beforeAll(async () => {
    const disp = await import("@/server/services/automation-dispatcher");
    dispatchAutomation = disp.dispatchAutomation;
    const sched = await import("@/server/services/automation-schedules");
    drainDueSchedules = sched.drainDueSchedules;
    occurrenceId = sched.occurrenceId;
  });

  afterAll(async () => {
    for (const id of orgs) {
      if (id) await svc().from("organizations").delete().eq("id", id);
    }
  });

  // ── A. Rule override toggles the enable-state the dispatcher reads ────────────

  it("a per-org override flips a default-ON rule OFF, then back ON", async () => {
    const org = await makeOrg("Override Probe", null);
    orgs.push(org);
    const ev = (src: string) => ({
      type: "quote.accepted" as never,
      org_id: org,
      source_table: "quotes",
      source_id: src,
      payload: {},
    });

    // Default (no override) — quote_accepted_notify is ON → it runs.
    const s1 = uuid();
    const r1 = await dispatchAutomation(ev(s1));
    expect(r1.ran.find((r) => r.rule_id === "quote_accepted_notify")?.status).toBe("ok");
    expect(await notifCount(org, s1)).toBe(1);

    // Override OFF → the SAME rule is now skipped for this org.
    await setOverride(org, "quote_accepted_notify", false);
    const s2 = uuid();
    const r2 = await dispatchAutomation(ev(s2));
    expect(r2.ran.find((r) => r.rule_id === "quote_accepted_notify")?.status).toBe("skipped");
    expect(await notifCount(org, s2)).toBe(0);

    // Override back ON → it runs again.
    await setOverride(org, "quote_accepted_notify", true);
    const s3 = uuid();
    const r3 = await dispatchAutomation(ev(s3));
    expect(r3.ran.find((r) => r.rule_id === "quote_accepted_notify")?.status).toBe("ok");
    expect(await notifCount(org, s3)).toBe(1);
  });

  it("an override in org A does not affect org B (enable-state is per-org)", async () => {
    const orgA = await makeOrg("Iso A", null);
    const orgB = await makeOrg("Iso B", null);
    orgs.push(orgA, orgB);
    await setOverride(orgA, "quote_accepted_notify", false);

    const sB = uuid();
    const rB = await dispatchAutomation({
      type: "quote.accepted" as never,
      org_id: orgB,
      source_table: "quotes",
      source_id: sB,
      payload: {},
    });
    // Org B has no override → catalogue default (ON) still applies.
    expect(rB.ran.find((r) => r.rule_id === "quote_accepted_notify")?.status).toBe("ok");
    expect(await notifCount(orgB, sB)).toBe(1);
  });

  // ── B. send_email_queue is wired + org-scoped ────────────────────────────────

  it("send_email_queue queues a real email row for the event's org", async () => {
    const org = await makeOrg("Email Probe", "receipts@probe.test");
    orgs.push(org);
    await setOverride(org, "payment_recorded_email_receipt", true);

    const src = uuid();
    const res = await dispatchAutomation({
      type: "payment.recorded" as never,
      org_id: org,
      source_table: "payments",
      source_id: src,
      payload: {},
    });
    expect(res.ran.find((r) => r.rule_id === "payment_recorded_email_receipt")?.status).toBe("ok");

    // A notification was emitted with the email channel…
    const note = await svc()
      .from("notifications")
      .select("id, org_id, type")
      .eq("org_id", org)
      .eq("source_id", src)
      .maybeSingle();
    expect(note.error, note.error?.message).toBeNull();
    expect(note.data?.org_id).toBe(org);
    expect(String(note.data?.type)).toBe("automation.payment.recorded.email");

    // …and a REAL row landed on the email queue for THIS org.
    const q = await svc()
      .from("notification_email_queue")
      .select("id, org_id, notification_id")
      .eq("org_id", org)
      .eq("notification_id", note.data?.id as string);
    expect(q.error, q.error?.message).toBeNull();
    expect((q.data ?? []).length).toBe(1);
  });

  // ── C. create_invoice_draft is wired + org-scoped + idempotent ───────────────

  it("create_invoice_draft creates one draft invoice for the quote, idempotently", async () => {
    const org = await makeOrg("Invoice Probe", null);
    orgs.push(org);
    const cust = await svc()
      .from("customers")
      .insert({ org_id: org, name: "Draft Customer" })
      .select("id")
      .single();
    expect(cust.error, cust.error?.message).toBeNull();
    const quote = await svc()
      .from("quotes")
      .insert({
        org_id: org,
        customer_id: cust.data?.id,
        number: `${TOKEN}-Q1`,
        status: "accepted",
        subtotal: 5000,
        vat_total: 1000,
      })
      .select("id")
      .single();
    expect(quote.error, quote.error?.message).toBeNull();
    const quoteId = String(quote.data?.id);

    await setOverride(org, "quote_accepted_autoinvoice", true);

    const ev = {
      type: "quote.accepted" as never,
      org_id: org,
      source_table: "quotes",
      source_id: quoteId,
      payload: {},
    };
    const r1 = await dispatchAutomation(ev);
    expect(r1.ran.find((r) => r.rule_id === "quote_accepted_autoinvoice")?.status).toBe("ok");

    const inv1 = await svc().from("invoices").select("id, org_id, quote_id").eq("org_id", org).eq("quote_id", quoteId);
    expect(inv1.error, inv1.error?.message).toBeNull();
    expect((inv1.data ?? []).length, "exactly one draft invoice").toBe(1);
    expect(String((inv1.data ?? [])[0]?.org_id)).toBe(org);

    // Re-dispatch the SAME event → the completed run is skipped; still ONE invoice.
    const r2 = await dispatchAutomation(ev);
    expect(r2.ran.find((r) => r.rule_id === "quote_accepted_autoinvoice")?.status).toBe("skipped");
    const inv2 = await svc().from("invoices").select("id").eq("org_id", org).eq("quote_id", quoteId);
    expect((inv2.data ?? []).length, "no duplicate invoice on re-fire").toBe(1);
  });

  it("create_invoice_draft cannot create an invoice from another org's quote", async () => {
    // A crafted cross-org source_id (a real quote id, but dispatched under the
    // WRONG org) resolves to no quote in that org → documented skip, no invoice.
    const orgA = await makeOrg("Draft A", null);
    const orgB = await makeOrg("Draft B", null);
    orgs.push(orgA, orgB);
    const cust = await svc().from("customers").insert({ org_id: orgA, name: "X" }).select("id").single();
    const quote = await svc()
      .from("quotes")
      .insert({
        org_id: orgA,
        customer_id: cust.data?.id,
        number: `${TOKEN}-QX`,
        status: "accepted",
        subtotal: 100,
        vat_total: 20,
      })
      .select("id")
      .single();
    const quoteId = String(quote.data?.id);
    await setOverride(orgB, "quote_accepted_autoinvoice", true);

    const res = await dispatchAutomation({
      type: "quote.accepted" as never,
      org_id: orgB, // wrong org for orgA's quote
      source_table: "quotes",
      source_id: quoteId,
      payload: {},
    });
    expect(res.ran.find((r) => r.rule_id === "quote_accepted_autoinvoice")?.status).toBe("ok");
    // No invoice anywhere for that quote — neither in B (no such quote) nor A.
    const anyInv = await svc().from("invoices").select("id, org_id").eq("quote_id", quoteId);
    expect((anyInv.data ?? []).length).toBe(0);
  });

  // ── D. The schedule drain fires due + advances next_run_at ────────────────────

  it("the drain fires a due schedule, advances next_run_at, and sets last_run_at", async () => {
    const org = await makeOrg("Sched Probe", null);
    orgs.push(org);
    const past = new Date(Date.now() - 60_000).toISOString();
    const sched = await svc()
      .from("automation_schedules")
      .insert({
        org_id: org,
        rule_key: "quote_accepted_notify",
        cron_expr: "*/5 * * * *",
        enabled: true,
        next_run_at: past,
      })
      .select("id, next_run_at")
      .single();
    expect(sched.error, sched.error?.message).toBeNull();
    const schedId = String(sched.data?.id);
    // The drain hashes the DB-CANONICAL next_run_at string, so recompute from it.
    const occSrc = occurrenceId(schedId, String(sched.data?.next_run_at));

    const now = new Date();
    const out = await drainDueSchedules(now, 100);
    const mine = out.results.find((r) => r.schedule_id === schedId);
    expect(mine?.status).toBe("fired");

    // The scheduled fire produced the rule's notification, ORG-SCOPED.
    expect(await notifCount(org, occSrc)).toBe(1);

    // next_run_at advanced into the future; last_run_at stamped.
    const after = await svc()
      .from("automation_schedules")
      .select("next_run_at, last_run_at")
      .eq("id", schedId)
      .maybeSingle();
    expect(after.error, after.error?.message).toBeNull();
    expect(new Date(String(after.data?.next_run_at)).getTime()).toBeGreaterThan(now.getTime());
    expect(after.data?.last_run_at).toBeTruthy();
  });

  // ── E. Concurrent drains fire an occurrence exactly once ─────────────────────

  it("three CONCURRENT drains fire a due occurrence exactly once", async () => {
    const org = await makeOrg("Concurrent Probe", null);
    orgs.push(org);
    const past = new Date(Date.now() - 120_000).toISOString();
    const sched = await svc()
      .from("automation_schedules")
      .insert({
        org_id: org,
        rule_key: "quote_accepted_notify",
        cron_expr: "*/5 * * * *",
        enabled: true,
        next_run_at: past,
      })
      .select("id, next_run_at")
      .single();
    const schedId = String(sched.data?.id);
    const occSrc = occurrenceId(schedId, String(sched.data?.next_run_at));

    const now = new Date();
    const results = await Promise.all([
      drainDueSchedules(now, 100),
      drainDueSchedules(now, 100),
      drainDueSchedules(now, 100),
    ]);
    const fires = results
      .flatMap((r) => r.results)
      .filter((r) => r.schedule_id === schedId && r.status === "fired");
    // Exactly one drain won the optimistic claim for this occurrence.
    expect(fires).toHaveLength(1);
    // …and the side effect happened exactly once.
    expect(await notifCount(org, occSrc)).toBe(1);
  });

  // ── F. The drain never acts cross-org ────────────────────────────────────────

  it("a single drain fires two orgs' schedules, each strictly org-scoped", async () => {
    const orgA = await makeOrg("Drain A", null);
    const orgB = await makeOrg("Drain B", null);
    orgs.push(orgA, orgB);
    const past = new Date(Date.now() - 60_000).toISOString();

    const mk = async (org: string): Promise<{ id: string; next: string }> => {
      const s = await svc()
        .from("automation_schedules")
        .insert({
          org_id: org,
          rule_key: "quote_accepted_notify",
          cron_expr: "*/5 * * * *",
          enabled: true,
          next_run_at: past,
        })
        .select("id, next_run_at")
        .single();
      return { id: String(s.data?.id), next: String(s.data?.next_run_at) };
    };
    const schedA = await mk(orgA);
    const schedB = await mk(orgB);

    await drainDueSchedules(new Date(), 100);

    const occA = occurrenceId(schedA.id, schedA.next);
    const occB = occurrenceId(schedB.id, schedB.next);
    // Each occurrence's notification landed in its OWN org, and NOT the other.
    expect(await notifCount(orgA, occA)).toBe(1);
    expect(await notifCount(orgB, occB)).toBe(1);
    expect(await notifCount(orgB, occA)).toBe(0);
    expect(await notifCount(orgA, occB)).toBe(0);
  });
});
