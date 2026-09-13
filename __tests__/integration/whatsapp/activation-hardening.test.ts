import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { anonClient, describeIntegration, serviceClient, userClient } from "../_harness";
import {
  processInboundEnquiry,
  dispatchHumanReviewedReply,
  enforceAndAuditReply,
} from "@/server/services/receptionist";
import { sweepWhatsAppWebhookEvents, WHATSAPP_SWEEP_MAX_ATTEMPTS } from "@/server/services/whatsapp-events-sweep";
import { processMetaWhatsAppPayload } from "@/server/services/whatsapp-webhook-handler";

/**
 * WhatsApp activation hardening (2026-09-13 from-zero audit) — real Postgres.
 *
 * This suite re-runs the audit's TWO PROVEN EXPLOITS the way the audit proved
 * they SUCCEEDED, and proves they now FAIL:
 *
 *   P1-1 — a tenant admin's authenticated PostgREST INSERT/UPDATE on
 *          whatsapp_number_routes (the cross-tenant phone_number_id claim /
 *          message-interception primitive) is now DENIED; service-role
 *          provisioning still works.
 *   P1-2 — a tenant admin's direct UPDATE of ai_receptionist_setups
 *          status='live' (self-arming the AI channel) is now REFUSED by the
 *          trigger, on UPDATE and on a born-live INSERT; the tenant's own
 *          fields stay editable and the HQ (service-role) path still works.
 *
 * Plus the behavioural proofs for the wave's P2 fixes that are DB-coupled:
 * opt-out suppression end to end (STOP → recorded → drafting suppressed →
 * outbound refused → START → restored), the failed-event sweep (reclaim,
 * re-run, dead-letter), the pre-send claim ledger's RLS posture, and the
 * normalised-endpoint replay backstop (provider_message_id threading).
 */

type Res<T> = { data: T | null; error: { message: string; code?: string } | null };
type Row = Record<string, unknown>;
interface Sel extends PromiseLike<Res<Row[]>> {
  select(columns?: string): Sel;
  eq(column: string, value: unknown): Sel;
  maybeSingle(): PromiseLike<Res<Row>>;
}
interface Ins extends PromiseLike<Res<Row[]>> {
  select(columns?: string): { single(): PromiseLike<Res<Row>> };
}
interface Upd extends PromiseLike<Res<null>> {
  eq(column: string, value: unknown): Upd;
  select(columns?: string): Upd & PromiseLike<Res<Row[]>>;
}
interface Table {
  select(columns?: string): Sel;
  insert(rows: Row | Row[]): Ins & PromiseLike<Res<null>>;
  update(patch: Row): Upd;
  delete(): Upd;
}
const db = (client: unknown) => client as unknown as { from(t: string): Table };

const TOKEN = `it-wa-hard-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const WHATSAPP_FLAG = "NEXT_PUBLIC_FEATURE_WHATSAPP";

describeIntegration("whatsapp activation hardening · real Postgres", () => {
  let orgA = "";
  let orgB = "";
  let adminAId = "";
  let adminAToken = "";
  const createdUserIds: string[] = [];

  const svc = () => db(serviceClient());

  async function makeUser(suffix: string): Promise<{ id: string; token: string }> {
    const email = `${TOKEN}-${suffix}@example.test`;
    const password = `Pw-${TOKEN}-${suffix}-${Math.random().toString(36).slice(2)}`;
    const created = await serviceClient().auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    expect(created.error, created.error?.message).toBeNull();
    const id = created.data.user?.id ?? "";
    createdUserIds.push(id);
    const mirrored = await svc()
      .from("users")
      .insert({ id, email, full_name: `WA-Hard ${suffix}` })
      .select("id")
      .single();
    expect(mirrored.error, mirrored.error?.message).toBeNull();
    const signedIn = await anonClient().auth.signInWithPassword({ email, password });
    expect(signedIn.error, signedIn.error?.message).toBeNull();
    const token = signedIn.data.session?.access_token ?? "";
    if (!id || !token) throw new Error(`failed to mint user ${suffix}`);
    return { id, token };
  }

  beforeAll(async () => {
    const a = await svc()
      .from("organizations")
      .insert({ name: "WA-Hard Org A", slug: `${TOKEN}-a` })
      .select("id")
      .single();
    expect(a.error, a.error?.message).toBeNull();
    orgA = String(a.data?.id ?? "");
    const b = await svc()
      .from("organizations")
      .insert({ name: "WA-Hard Org B", slug: `${TOKEN}-b` })
      .select("id")
      .single();
    expect(b.error, b.error?.message).toBeNull();
    orgB = String(b.data?.id ?? "");

    const adminA = await makeUser("admin-a");
    adminAId = adminA.id;
    adminAToken = adminA.token;
    const m = await svc()
      .from("memberships")
      .insert({ org_id: orgA, user_id: adminAId, role: "admin" })
      .select("user_id")
      .single();
    expect(m.error, m.error?.message).toBeNull();
  });

  afterEach(() => vi.unstubAllEnvs());

  afterAll(async () => {
    for (const org of [orgA, orgB]) {
      if (org) await svc().from("organizations").delete().eq("id", org);
    }
    for (const id of createdUserIds) {
      if (id) await serviceClient().auth.admin.deleteUser(id);
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // P1-1 — whatsapp_number_routes provisioning lock.
  // ═══════════════════════════════════════════════════════════════════════

  it("P1-1 EXPLOIT BLOCKED: a tenant admin can no longer INSERT a number route (the cross-tenant claim)", async () => {
    // The audit's exploit verbatim: org A's admin pre-claims a phone_number_id
    // (which in reality belongs to org B) via authenticated PostgREST. With the
    // old policy the WITH CHECK passed (is_org_admin(orgA)) and first-claim won
    // the UNIQUE — interception at activation. It must now be DENIED.
    const asAdminA = db(userClient(adminAToken));
    const attempt = await asAdminA.from("whatsapp_number_routes").insert({
      phone_number_id: `PNID_STEAL_${TOKEN}`,
      org_id: orgA,
      active: true,
    });
    expect(attempt.error, "tenant insert must be refused by RLS").not.toBeNull();

    // Ground truth: nothing landed.
    const rows = await svc()
      .from("whatsapp_number_routes")
      .select("id")
      .eq("phone_number_id", `PNID_STEAL_${TOKEN}`);
    expect(rows.error).toBeNull();
    expect(rows.data ?? []).toHaveLength(0);
  });

  it("P1-1: a tenant admin can no longer UPDATE a route; service-role provisioning still works; tenant SELECT survives", async () => {
    // Service-role provisions org A's real route (the HQ act).
    const pnid = `PNID_REAL_${TOKEN}`;
    const seeded = await svc()
      .from("whatsapp_number_routes")
      .insert({ phone_number_id: pnid, org_id: orgA, active: true })
      .select("id")
      .single();
    expect(seeded.error, seeded.error?.message).toBeNull();

    // Tenant admin tries to repoint / deactivate it — an UPDATE with no policy
    // matches 0 rows under RLS (PostgREST reports success with nothing done).
    const asAdminA = db(userClient(adminAToken));
    const upd = await asAdminA
      .from("whatsapp_number_routes")
      .update({ org_id: orgB })
      .eq("phone_number_id", pnid)
      .select("id");
    const updRows = (upd as unknown as { data: Row[] | null }).data ?? [];
    expect(updRows, "tenant update must affect zero rows").toHaveLength(0);

    // Ground truth: still org A's route, still active.
    const check = await svc()
      .from("whatsapp_number_routes")
      .select("org_id, active")
      .eq("phone_number_id", pnid);
    expect(check.data?.[0]?.org_id).toBe(orgA);
    expect(check.data?.[0]?.active).toBe(true);

    // The org-scoped member SELECT is kept (operator visibility).
    const visible = await asAdminA.from("whatsapp_number_routes").select("phone_number_id").eq("org_id", orgA);
    expect(visible.error).toBeNull();
    expect((visible.data ?? []).map((r) => r.phone_number_id)).toContain(pnid);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // P1-2 — ai_receptionist_setups: tenant self-arming blocked.
  // ═══════════════════════════════════════════════════════════════════════

  it("P1-2 EXPLOIT BLOCKED: a tenant admin cannot UPDATE status='live' (self-arming); legit fields still editable; HQ path intact", async () => {
    // Tenant creates their legitimate setup row (the app's own INSERT shape).
    const asAdminA = db(userClient(adminAToken));
    const ins = await asAdminA
      .from("ai_receptionist_setups")
      .insert({ org_id: orgA, enabled: true, whatsapp_number: "+44 7700 900001" })
      .select("id")
      .single();
    expect(ins.error, ins.error?.message).toBeNull();
    const setupId = String(ins.data?.id ?? "");

    // THE EXPLOIT: direct PostgREST UPDATE of the HQ lifecycle column. The
    // audit proved this succeeded (row-level RLS passed); the trigger must now
    // refuse it loudly.
    const arm = await asAdminA
      .from("ai_receptionist_setups")
      .update({ status: "live" })
      .eq("id", setupId);
    expect(arm.error, "tenant status write must be refused").not.toBeNull();
    expect(arm.error?.message ?? "").toMatch(/HQ-only/i);

    // Variants: test stamps and configuration provenance are equally locked.
    const stamp = await asAdminA
      .from("ai_receptionist_setups")
      .update({ test_whatsapp_at: new Date().toISOString() })
      .eq("id", setupId);
    expect(stamp.error).not.toBeNull();
    const prov = await asAdminA
      .from("ai_receptionist_setups")
      .update({ configured_at: new Date().toISOString(), configured_by: adminAId })
      .eq("id", setupId);
    expect(prov.error).not.toBeNull();

    // The tenant's OWN fields stay freely editable (the app's save payload).
    const legit = await asAdminA
      .from("ai_receptionist_setups")
      .update({ enabled: false, business_hours: "8-6 Mon-Fri", trade_type: "electrician" })
      .eq("id", setupId);
    expect(legit.error, legit.error?.message).toBeNull();

    // Ground truth: status untouched.
    const truth = await svc().from("ai_receptionist_setups").select("status, enabled").eq("id", setupId);
    expect(truth.data?.[0]?.status).toBe("not_started");
    expect(truth.data?.[0]?.enabled).toBe(false);

    // HQ (service-role — the super-admin client's role) can still run the lifecycle.
    const hq = await svc().from("ai_receptionist_setups").update({ status: "live" }).eq("id", setupId);
    expect(hq.error, hq.error?.message).toBeNull();
    const after = await svc().from("ai_receptionist_setups").select("status").eq("id", setupId);
    expect(after.data?.[0]?.status).toBe("live");

    // Cleanup for later tests in this suite (org A eligibility stays a per-test decision).
    await svc().from("ai_receptionist_setups").delete().eq("id", setupId);
  });

  it("P1-2: a tenant admin cannot INSERT a row born status='live' (the create-bypass)", async () => {
    const asAdminA = db(userClient(adminAToken));
    const born = await asAdminA
      .from("ai_receptionist_setups")
      .insert({ org_id: orgA, enabled: true, status: "live" });
    expect(born.error, "born-live insert must be refused").not.toBeNull();
    expect(born.error?.message ?? "").toMatch(/HQ-only/i);
    const rows = await svc().from("ai_receptionist_setups").select("id").eq("org_id", orgA);
    expect(rows.data ?? []).toHaveLength(0);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // P2-7 — STOP / opt-out, end to end.
  // ═══════════════════════════════════════════════════════════════════════

  async function enableWhatsApp(orgId: string): Promise<void> {
    const res = await svc()
      .from("ai_receptionist_setups")
      .insert({ org_id: orgId, enabled: true, status: "live" })
      .select("id")
      .single();
    expect(res.error, res.error?.message).toBeNull();
  }

  it("P2-7 END TO END: STOP records the opt-out and suppresses drafting; START restores; interim messages never re-subscribe", async () => {
    vi.stubEnv(WHATSAPP_FLAG, "true");
    const org = await svc()
      .from("organizations")
      .insert({ name: "WA-Hard OptOut Org", slug: `${TOKEN}-opt` })
      .select("id")
      .single();
    const orgId = String(org.data?.id ?? "");
    await enableWhatsApp(orgId);
    const pnid = `PNID_OPT_${TOKEN}`;
    await svc().from("whatsapp_number_routes").insert({ phone_number_id: pnid, org_id: orgId, active: true });
    const waId = "447700900444";

    const envelope = (wamid: string, body: string) =>
      ({
        object: "whatsapp_business_account",
        entry: [
          {
            id: `waba_${TOKEN}`,
            changes: [
              {
                field: "messages",
                value: {
                  messaging_product: "whatsapp",
                  metadata: { display_phone_number: "+441234", phone_number_id: pnid },
                  contacts: [{ wa_id: waId, profile: { name: "Stopper" } }],
                  messages: [
                    { id: wamid, from: waId, type: "text", timestamp: "1700000000", text: { body } },
                  ],
                },
              },
            ],
          },
        ],
      }) as never;

    // 1. "STOP" — ingested, opt-out recorded, NO audit (no AI turn).
    const r1 = await processMetaWhatsAppPayload(envelope(`wamid.${TOKEN}.stop`, "STOP!"));
    expect(r1.dispatched).toBe(1);
    const opted = await svc().from("whatsapp_optouts").select("wa_id, source_wamid").eq("org_id", orgId);
    expect(opted.data).toHaveLength(1);
    expect(opted.data?.[0]?.wa_id).toBe(waId);
    expect(opted.data?.[0]?.source_wamid).toBe(`wamid.${TOKEN}.stop`);

    // 2. An ordinary follow-up: ingested but still suppressed (no re-subscribe,
    //    no AI drafting) — and no audit exists for this org at all.
    const r2 = await processMetaWhatsAppPayload(envelope(`wamid.${TOKEN}.mid`, "are you there?"));
    expect(r2.dispatched).toBe(1);
    const still = await svc().from("whatsapp_optouts").select("wa_id").eq("org_id", orgId);
    expect(still.data).toHaveLength(1);
    const audits = await svc().from("ai_reply_audits").select("id").eq("org_id", orgId);
    expect(audits.data ?? [], "no AI turn may run for an opted-out sender").toHaveLength(0);

    // 3. Explicit "START" removes the suppression — and since the removal runs
    //    BEFORE the ingestion core, the START message itself already gets an
    //    AI turn again (its audit is the first restoration proof).
    await processMetaWhatsAppPayload(envelope(`wamid.${TOKEN}.start`, "START"));
    const cleared = await svc().from("whatsapp_optouts").select("wa_id").eq("org_id", orgId);
    expect(cleared.data ?? []).toHaveLength(0);
    const auditsOnStart = await svc().from("ai_reply_audits").select("id").eq("org_id", orgId);
    expect((auditsOnStart.data ?? []).length).toBe(1);

    // 4. The next message drafts again (held for review under the auto-send
    //    posture — but the AI turn RAN, which is the restoration proof).
    await processMetaWhatsAppPayload(envelope(`wamid.${TOKEN}.after`, "great, can you quote me?"));
    const auditsAfter = await svc().from("ai_reply_audits").select("id, verdict").eq("org_id", orgId);
    expect((auditsAfter.data ?? []).length).toBe(2);

    await svc().from("organizations").delete().eq("id", orgId);
  });

  it("P2-7 OUTBOUND: transportReply refuses an opted-out recipient with recorded reason 'opted_out' (human approval included)", async () => {
    const recipient = "+447700900555";
    // whatsapp_optouts FKs organizations — use a real org throughout.
    const org = await svc()
      .from("organizations")
      .insert({ name: "WA-Hard OptOut Out", slug: `${TOKEN}-out` })
      .select("id")
      .single();
    const realOrg = String(org.data?.id ?? "");
    await svc().from("whatsapp_optouts").insert({ org_id: realOrg, wa_id: "447700900555", source_wamid: null });

    // A held WhatsApp draft, then a human approves it — even human authority
    // cannot message an opted-out recipient: the transport records the refusal.
    const held = await enforceAndAuditReply({
      org_id: realOrg,
      channel: "whatsapp_msg",
      correlation_id: crypto.randomUUID(),
      draft: "Thanks — we will get back to you shortly.",
    });
    expect(held.decision.verdict).toBe("review"); // auto-send posture hold
    const outcome = await dispatchHumanReviewedReply({
      org_id: realOrg,
      channel: "whatsapp_msg",
      draft: "Thanks — we will get back to you shortly.",
      review_audit_id: held.audit_id,
      reviewed_by: crypto.randomUUID(),
      destination: recipient,
    });
    expect(outcome.transport.status).toBe("failed");
    expect(outcome.transport.failure_reason).toBe("opted_out");

    await svc().from("organizations").delete().eq("id", realOrg);
  });

  it("P2-7 RLS: anon cannot write the opt-out ledger; members cannot fabricate/erase one", async () => {
    const org = await svc()
      .from("organizations")
      .insert({ name: "WA-Hard OptOut RLS", slug: `${TOKEN}-optrls` })
      .select("id")
      .single();
    const orgId = String(org.data?.id ?? "");
    const anonWrite = await db(anonClient())
      .from("whatsapp_optouts")
      .insert({ org_id: orgId, wa_id: "447700900666" });
    expect(anonWrite.error).not.toBeNull();

    // Seed one as service, then prove the authenticated member cannot delete it.
    await svc().from("whatsapp_optouts").insert({ org_id: orgA, wa_id: "447700900777", source_wamid: null });
    const asAdminA = db(userClient(adminAToken));
    await asAdminA.from("whatsapp_optouts").delete().eq("org_id", orgA);
    const still = await svc().from("whatsapp_optouts").select("wa_id").eq("org_id", orgA);
    expect((still.data ?? []).map((r) => r.wa_id)).toContain("447700900777");
    // ...but CAN see their org's rows (operator visibility).
    const visible = await asAdminA.from("whatsapp_optouts").select("wa_id").eq("org_id", orgA);
    expect((visible.data ?? []).map((r) => r.wa_id)).toContain("447700900777");

    await svc().from("whatsapp_optouts").delete().eq("org_id", orgA);
    await svc().from("organizations").delete().eq("id", orgId);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // P2-6 — pre-send claim ledger (DB posture; the wire-once proof is unit-tier).
  // ═══════════════════════════════════════════════════════════════════════

  it("P2-6: ai_reply_send_claims is service-role-only and the PK makes the second claim collide", async () => {
    const key = `claim-${TOKEN}`;
    const first = await svc().from("ai_reply_send_claims").insert({ org_id: orgA, dedup_key: key });
    expect(first.error).toBeNull();
    const second = await svc().from("ai_reply_send_claims").insert({ org_id: orgA, dedup_key: key });
    expect(second.error, "second claim must collide on the PK").not.toBeNull();
    expect(second.error?.code).toBe("23505");

    // Zero policies: anon and authenticated tenants can neither read nor write.
    const anonRead = await db(anonClient()).from("ai_reply_send_claims").select("dedup_key").eq("org_id", orgA);
    expect(anonRead.data ?? []).toHaveLength(0);
    const tenantWrite = await db(userClient(adminAToken))
      .from("ai_reply_send_claims")
      .insert({ org_id: orgA, dedup_key: `tenant-${TOKEN}` });
    expect(tenantWrite.error).not.toBeNull();

    await svc().from("ai_reply_send_claims").delete().eq("org_id", orgA);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // P2-4 — failed-event sweep against the real claim table.
  // ═══════════════════════════════════════════════════════════════════════

  it("P2-4: the sweep re-runs a FAILED ingress row to completion (enquiry created, processed stamped, attempts counted)", async () => {
    vi.stubEnv(WHATSAPP_FLAG, "true");
    const org = await svc()
      .from("organizations")
      .insert({ name: "WA-Hard Sweep Org", slug: `${TOKEN}-swp` })
      .select("id")
      .single();
    const orgId = String(org.data?.id ?? "");
    const pnid = `PNID_SWEEP_${TOKEN}`;
    await svc().from("whatsapp_number_routes").insert({ phone_number_id: pnid, org_id: orgId, active: true });

    // A FAILED claim row, exactly as markFailed leaves one: claimed, error set,
    // processed_at NULL. Payload is the normalized message the handler stores.
    const wamid = `wamid.${TOKEN}.sweep1`;
    const failedRow = await svc()
      .from("whatsapp_webhook_events")
      .insert({
        event_key: `msg:${wamid}`,
        kind: "message",
        wamid,
        phone_number_id: pnid,
        org_id: orgId,
        claimed_at: new Date(Date.now() - 60_000).toISOString(),
        error_message: "transient: leads insert failed",
        payload: {
          phone_number_id: pnid,
          wamid,
          caller: "447700900888",
          contact_name: "Sweep",
          raw_text: "my roof is leaking",
          message_type: "text",
          has_media: false,
          media: null,
          provider_timestamp: "1700000000",
        },
      })
      .select("id")
      .single();
    expect(failedRow.error, failedRow.error?.message).toBeNull();

    const summary = await sweepWhatsAppWebhookEvents({ batch: 50 });
    expect(summary.ok).toBe(true);
    expect(summary.reclaimed).toBeGreaterThanOrEqual(1);
    expect(summary.dispatched).toBeGreaterThanOrEqual(1);

    const after = await svc()
      .from("whatsapp_webhook_events")
      .select("processed_at, attempts, error_message, dead_lettered_at")
      .eq("event_key", `msg:${wamid}`);
    expect(after.data?.[0]?.processed_at, "sweep must complete the row").not.toBeNull();
    expect(after.data?.[0]?.attempts).toBe(1);
    expect(after.data?.[0]?.dead_lettered_at).toBeNull();

    const enquiries = await svc().from("inbound_enquiries").select("id, provider_message_id").eq("org_id", orgId);
    expect(enquiries.data).toHaveLength(1);
    expect(enquiries.data?.[0]?.provider_message_id).toBe(wamid);

    await svc().from("whatsapp_webhook_events").delete().eq("event_key", `msg:${wamid}`);
    await svc().from("organizations").delete().eq("id", orgId);
  });

  it("P2-4: a row at max attempts is DEAD-LETTERED (stamped, excluded, never silently dropped)", async () => {
    vi.stubEnv(WHATSAPP_FLAG, "true");
    const wamid = `wamid.${TOKEN}.dead1`;
    const row = await svc()
      .from("whatsapp_webhook_events")
      .insert({
        event_key: `msg:${wamid}`,
        kind: "message",
        wamid,
        phone_number_id: `PNID_DEAD_${TOKEN}`,
        org_id: null,
        claimed_at: new Date(Date.now() - 60_000).toISOString(),
        error_message: "permanent poison",
        attempts: WHATSAPP_SWEEP_MAX_ATTEMPTS,
        payload: { wamid, raw_text: "poison" },
      })
      .select("id")
      .single();
    expect(row.error, row.error?.message).toBeNull();

    const summary = await sweepWhatsAppWebhookEvents({ batch: 50 });
    expect(summary.dead_lettered).toBeGreaterThanOrEqual(1);

    const after = await svc()
      .from("whatsapp_webhook_events")
      .select("dead_lettered_at, processed_at, error_message")
      .eq("event_key", `msg:${wamid}`);
    expect(after.data?.[0]?.dead_lettered_at).not.toBeNull();
    expect(after.data?.[0]?.processed_at, "dead-letter is NOT completion").toBeNull();
    expect(after.data?.[0]?.error_message).toBe("permanent poison");

    // Dead-lettered ⇒ no longer a sweep candidate.
    const again = await sweepWhatsAppWebhookEvents({ batch: 50 });
    const touched = await svc()
      .from("whatsapp_webhook_events")
      .select("attempts")
      .eq("event_key", `msg:${wamid}`);
    expect(touched.data?.[0]?.attempts).toBe(WHATSAPP_SWEEP_MAX_ATTEMPTS);
    void again;

    await svc().from("whatsapp_webhook_events").delete().eq("event_key", `msg:${wamid}`);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // P2-5 — normalised endpoint replay backstop (service-level proof).
  // ═══════════════════════════════════════════════════════════════════════

  it("P2-5: threading provider_message_id makes a replayed normalised event fold to ONE enquiry + ONE lead", async () => {
    const org = await svc()
      .from("organizations")
      .insert({ name: "WA-Hard Replay Org", slug: `${TOKEN}-rpl` })
      .select("id")
      .single();
    const orgId = String(org.data?.id ?? "");
    const key = `evt-${TOKEN}`;

    // Exactly what the hardened route now passes: dedup_key doubles as
    // provider_message_id, arming the (org, provider_message_id) backstop.
    const input = {
      org_id: orgId,
      channel: "phone" as const,
      raw_text: "missed call",
      caller: "+447700900999",
      dedup_key: key,
      provider_message_id: key,
    };
    const first = await processInboundEnquiry(input);
    const replay = await processInboundEnquiry(input);
    expect(replay.enquiry_id).toBe(first.enquiry_id);
    expect(replay.lead_id).toBe(first.lead_id);

    const enquiries = await svc().from("inbound_enquiries").select("id").eq("org_id", orgId);
    expect(enquiries.data).toHaveLength(1);
    const leads = await svc().from("leads").select("id").eq("org_id", orgId);
    expect(leads.data).toHaveLength(1);

    await svc().from("organizations").delete().eq("id", orgId);
  });
});
