import { afterAll, afterEach, expect, it, vi } from "vitest";
import { describeIntegration, serviceClient } from "../_harness";
import {
  enforceAndAuditReply,
  processInboundEnquiry,
} from "@/server/services/receptionist";

/**
 * Controlled Live Execution — real-Postgres proof of the AI Receptionist Programme
 * R6 (CONTROLLED LIVE EXECUTION).
 *
 * R5 built the ONE outbound pipeline (Compose → Enforce → Audit → Transport) and proved
 * it end to end, but left it a CALLABLE PRIMITIVE — nothing triggered it from a real
 * inbound event. R6 arms exactly ONE real customer-facing behaviour, the missed-call SMS
 * text-back, behind a feature flag that DEFAULTS OFF, wired into the existing inbound
 * processor. The unit tier pins the flag gate hermetically and the security tier proves,
 * as a matter of SOURCE, that the live path introduces no new door to a provider and is
 * captive to the canonical service. This tier proves the BEHAVIOUR the mocks can't — that
 * when the CANONICAL SERVICE actually runs against Postgres, driven the way a real inbound
 * webhook drives it (`processInboundEnquiry`), the directive's SIX validation criteria hold
 * end to end:
 *
 *   (1) FLAG OFF → ZERO OUTBOUND — with the flag unset (the safe default), a missed call
 *       is ingested exactly as pre-R6: an enquiry row, and NOT ONE audit or transport row.
 *   (2) FLAG ON → ONLY THE CANONICAL PIPELINE — armed, a missed call drives
 *       `dispatchReceptionistReply` verbatim: the deterministic acknowledgement is composed,
 *       enforced (allow), audited, and a transport is filed — no parallel path, no bypass.
 *   (3) EVERY LIVE SMS HAS A REPLY AUDIT — the live attempt writes exactly one
 *       `ai_reply_audits` row, threaded to the inbound enquiry it answers.
 *   (4) EVERY LIVE SMS HAS A TRANSPORT RECORD — the live attempt writes exactly one
 *       `ai_reply_transports` row, threaded to the audit that authorised it.
 *   (5) PROVIDER IDENTIFIERS STAY TRACEABLE — a provider message id walks the WHOLE chain
 *       backwards: sid → transport → audit → inbound enquiry, no step detached; and the
 *       provider's synchronous status is recorded against that id (the R6 delivery
 *       increment).
 *   (6) NO DUPLICATE MESSAGES — a replayed missed call (same dedup key as a prior SENT
 *       transport) short-circuits without composing, enforcing, auditing, or sending again.
 *
 * Two scoping gates are proven alongside: armed, a NON-missed-call channel stays inert
 * (only `phone` is R6's behaviour), and a missed call with no caller to answer stays inert
 * — both plain early returns, never a throw, so ingestion is never disturbed.
 *
 * The flag is a genuine runtime toggle: `isMissedCallTextbackLive()` reads process.env at
 * CALL TIME, so it is driven here by vi.stubEnv exactly as a deploy would flip it. In the
 * CI environment no SMS provider is configured, so the live transport degrades to a
 * recorded `failed`/`no_provider` attempt (no vendor call) — the same graceful-degradation
 * path R5's transport suite runs; the flag being ON changes WHETHER the pipeline runs, not
 * how it degrades without a vendor.
 *
 * Runs only against a live DB (describeIntegration): skipped locally with no database,
 * FAILED loudly in CI if the database is missing. The audit/transport ledgers are
 * append-only, so these tests intentionally leave those rows behind (harmless in the
 * ephemeral CI database); the seeded org — cascading its enquiries and leads — is dropped
 * in afterAll. Rows are addressed by per-test org ids so each assertion sees only its own.
 */

// ai_reply_transports / ai_reply_audits and their record_* primitives are
// service-role-only internals and are NOT in the generated Database types. Cast to the
// minimal surface this suite exercises (the same `as unknown as` convention the R5
// transport suite and the spine suites use) rather than reaching for `any`.
type Res<T> = { data: T | null; error: { message: string } | null };
type Thenable<T> = PromiseLike<Res<T>>;
interface Selectable<T> extends Thenable<T[]> {
  eq(column: string, value: unknown): Selectable<T>;
  single(): Thenable<T>;
}
interface Insertable extends Thenable<null> {
  select(columns?: string): Selectable<Record<string, unknown>>;
}
interface Mutable extends Thenable<null> {
  eq(column: string, value: unknown): Mutable;
}
interface Table {
  select(columns?: string): Selectable<Record<string, unknown>>;
  insert(row: Record<string, unknown>): Insertable;
  delete(): Mutable;
}
interface Client {
  from(table: string): Table;
  rpc<T = unknown>(fn: string, args: Record<string, unknown>): Thenable<T>;
}
const svc = (): Client => serviceClient() as unknown as Client;

const FLAG = "NEXT_PUBLIC_FEATURE_MISSED_CALL_TEXTBACK";
const AUDITS = "ai_reply_audits";
const TRANSPORTS = "ai_reply_transports";
const ENQUIRIES = "inbound_enquiries";
const TRANSPORT_RPC = "record_ai_reply_transport";
const EMPLOYEE_SLUG = "voice-receptionist-ai";

// The deterministic acknowledgement the producer composes for a missed CALL (channel
// 'phone') — the exact draft the live text-back enforces, audits and carries over SMS.
const VOICE_ACK = "Thanks for your call — a member of the team will call you back shortly.";
// A pre-vetted clean `allow` draft (the message acknowledgement) — supplied straight to
// the audit path to seed the allowed audits the duplicate / traceability tests build on.
const ALLOW_DRAFT =
  "Thanks for your message — a member of the team will get back to you shortly.";

const CALLER = "+447700900000";
const A_COLUMNS =
  "id, org_id, employee_slug, channel, verdict, allowed, draft, enquiry_id, " +
  "lead_id, customer_ref, correlation_id, metadata";
const T_COLUMNS =
  "id, reply_audit_id, org_id, employee_slug, channel, provider, to_ref, " +
  "provider_message_id, status, failure_reason, dedup_key, correlation_id, metadata";

// Every org this suite stands up, dropped in afterAll (cascading inbound_enquiries and
// leads). The append-only audit/transport rows can't be deleted and are left behind.
const createdOrgs: string[] = [];

/** Stand up a real organisation the inbound processor can write against, tracked for teardown. */
async function freshOrg(): Promise<string> {
  const slug = `it-r6-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const res = await svc()
    .from("organizations")
    .insert({ name: "R6 Live Execution Org", slug })
    .select("id")
    .single();
  expect(res.error, res.error?.message).toBeNull();
  const id = String((res.data as { id: string }).id);
  createdOrgs.push(id);
  return id;
}

/** Every audit row for one org, as service_role. */
async function auditsForOrg(orgId: string): Promise<Record<string, unknown>[]> {
  const res = await svc().from(AUDITS).select(A_COLUMNS).eq("org_id", orgId);
  expect(res.error, res.error?.message).toBeNull();
  return res.data ?? [];
}

/** Every transport row for one org, as service_role. */
async function transportsForOrg(orgId: string): Promise<Record<string, unknown>[]> {
  const res = await svc().from(TRANSPORTS).select(T_COLUMNS).eq("org_id", orgId);
  expect(res.error, res.error?.message).toBeNull();
  return res.data ?? [];
}

/** Every transport row carrying one provider message id — the correlation key's own read. */
async function transportsBySid(sid: string): Promise<Record<string, unknown>[]> {
  const res = await svc().from(TRANSPORTS).select(T_COLUMNS).eq("provider_message_id", sid);
  expect(res.error, res.error?.message).toBeNull();
  return res.data ?? [];
}

/** One audit row by id, or null. */
async function auditById(id: string): Promise<Record<string, unknown> | null> {
  const res = await svc().from(AUDITS).select(A_COLUMNS).eq("id", id);
  expect(res.error, res.error?.message).toBeNull();
  return (res.data ?? [])[0] ?? null;
}

/** One inbound enquiry by id, or null. */
async function enquiryById(id: string): Promise<Record<string, unknown> | null> {
  const res = await svc().from(ENQUIRIES).select("id, org_id, channel, status").eq("id", id);
  expect(res.error, res.error?.message).toBeNull();
  return (res.data ?? [])[0] ?? null;
}

/**
 * Seed a real, allowed `ai_reply_audits` row through the canonical audit path (not a raw
 * insert), returning its id — the precondition the transport gate demands. Optionally
 * threads a specific inbound `enquiry_id`, so the traceability test can walk the whole
 * chain back to a real enquiry.
 */
async function seedAllowedAudit(orgId: string, enquiryId?: string): Promise<string> {
  const outcome = await enforceAndAuditReply({
    org_id: orgId,
    channel: "sms",
    enquiry_id: enquiryId ?? null,
    correlation_id: crypto.randomUUID(),
    draft: ALLOW_DRAFT,
  });
  expect(outcome.decision.allowed, "seed draft must be a clean allow").toBe(true);
  return outcome.audit_id;
}

/**
 * File a SENT transport through the service-role write primitive, returning its id. Stands
 * up the "a message already went out" precondition (the CI service path only ever produces
 * `failed`, so a `sent` row must be seeded through the RPC directly). The optional provider
 * status is recorded in metadata exactly as the live sent branch records it (R6).
 */
async function seedSentTransport(args: {
  auditId: string;
  orgId: string;
  dedupKey?: string | null;
  providerMessageId?: string;
  providerStatus?: string;
}): Promise<string> {
  const metadata: Record<string, unknown> = { producer: "missed_call_text_back" };
  if (args.providerStatus) metadata.provider_status = args.providerStatus;
  const res = await svc().rpc<string>(TRANSPORT_RPC, {
    p_reply_audit_id: args.auditId,
    p_org_id: args.orgId,
    p_employee_slug: EMPLOYEE_SLUG,
    p_channel: "sms",
    p_to_ref: CALLER,
    p_status: "sent",
    p_correlation_id: crypto.randomUUID(),
    p_provider: "twilio",
    // The ledger is append-only and provider_message_id is uniquely indexed, so a fixed
    // value would collide across runs — every seeded send mints its own.
    p_provider_message_id: args.providerMessageId ?? `SM-${crypto.randomUUID()}`,
    p_dedup_key: args.dedupKey ?? null,
    p_metadata: metadata,
  });
  expect(res.error, res.error?.message).toBeNull();
  expect(res.data, "seeded sent transport must return an id").toBeTruthy();
  return res.data as string;
}

describeIntegration("Controlled live execution · missed-call text-back (R6)", () => {
  afterAll(async () => {
    for (const id of createdOrgs) {
      // The inbound processor's HQ audit (admin_activity_log, written by Step 5 when a lead
      // is created) has NO org FK, so the org delete does not cascade it. Clear it
      // explicitly so this suite leaves no admin rows behind for a global-count assertion
      // elsewhere (the spine backfill oracle treats admin_activity_log as sole-written) to
      // trip over. Everything else the processor writes (inbound_enquiries, leads,
      // notifications) is org-scoped and cascades with the org.
      await svc().from("admin_activity_log").delete().eq("metadata->>org_id", id);
      await svc().from("organizations").delete().eq("id", id);
    }
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("FLAG OFF (the default) — a missed call is ingested but sends NOTHING: zero audit, zero transport", async () => {
    // Criterion (1). No stub: the gate resolves to its safe default. The precondition
    // guard makes an accidentally-armed environment fail loudly rather than pass silently.
    expect(process.env[FLAG] ?? "false", "the default-OFF path must not be pre-armed").not.toBe(
      "true",
    );
    const orgId = await freshOrg();

    const result = await processInboundEnquiry({
      org_id: orgId,
      channel: "phone", // a missed call…
      caller: CALLER,
      raw_text: "Missed call, no voicemail.",
    });

    // The inbound event was ingested exactly as pre-R6…
    expect(result.enquiry_id, "the enquiry is still recorded").toBeTruthy();
    expect(await enquiryById(result.enquiry_id)).not.toBeNull();
    // …and the live path stayed wholly inert — the flag gate returned first, never a throw.
    expect(result.textback).toEqual({ attempted: false, reason: "flag_off" });

    // The whole point: NOT ONE outbound artefact exists for this org.
    expect(await auditsForOrg(orgId), "flag OFF ⇒ no reply audit").toHaveLength(0);
    expect(await transportsForOrg(orgId), "flag OFF ⇒ no transport").toHaveLength(0);
  });

  it("FLAG ON — a missed call drives the ONE canonical pipeline: 1 audit + 1 transport, threaded inbound → audit → transport", async () => {
    // Criteria (2),(3),(4): armed, the inbound processor drives dispatchReceptionistReply
    // verbatim. The reply is composed (voice acknowledgement), enforced (allow), audited,
    // and a transport is filed — degrading to failed/no_provider in the CI environment.
    vi.stubEnv(FLAG, "true");
    const orgId = await freshOrg();
    const callSid = `CA-${crypto.randomUUID()}`;

    const result = await processInboundEnquiry({
      org_id: orgId,
      channel: "phone",
      caller: CALLER,
      raw_text: "Missed call from a prospective customer.",
      dedup_key: callSid, // the channel's stable per-call id (Twilio CallSid)
    });

    // The live path ran and surfaced its outcome on the inbound result.
    const tb = result.textback;
    expect(tb.attempted, "flag ON ⇒ the live path is attempted").toBe(true);
    if (!tb.attempted) throw new Error("unreachable");
    if (!("dispatch" in tb)) throw new Error(`text-back errored: ${tb.error}`);
    const dispatch = tb.dispatch;

    // (2) It flowed the canonical pipeline: composed → enforced (allow) → audited.
    expect(dispatch.decision?.verdict).toBe("allow");
    expect(dispatch.decision?.allowed).toBe(true);
    expect(dispatch.draft, "the composed missed-call acknowledgement").toBe(VOICE_ACK);
    expect(dispatch.audit_id).toBeTruthy();
    expect(dispatch.correlation_id).toBeTruthy();
    // The transport degraded gracefully (no vendor in CI) — a recorded failed attempt.
    expect(dispatch.transport.attempted).toBe(true);
    expect(dispatch.transport.duplicate).toBe(false);
    expect(dispatch.transport.status).toBe("failed");
    expect(dispatch.transport.failure_reason).toBe("no_provider");
    expect(dispatch.transport.provider_message_id).toBeNull();
    expect(dispatch.transport.transport_id).toBeTruthy();

    // (3) EXACTLY ONE audit for the org — not zero (unaudited send), not two (a parallel path).
    const audits = await auditsForOrg(orgId);
    expect(audits).toHaveLength(1);
    const audit = audits[0] ?? {};
    expect(audit.id).toBe(dispatch.audit_id);
    expect(audit.employee_slug).toBe(EMPLOYEE_SLUG);
    expect(audit.channel, "the audit records the inbound channel").toBe("phone");
    expect(audit.verdict).toBe("allow");
    expect(audit.allowed).toBe(true);
    expect(audit.draft).toBe(VOICE_ACK);
    expect(audit.enquiry_id, "the audit is threaded to the inbound enquiry").toBe(
      result.enquiry_id,
    );
    expect(audit.lead_id).toBe(result.lead_id);
    expect(audit.customer_ref).toBe(CALLER);
    expect(audit.correlation_id).toBe(dispatch.correlation_id);
    expect(audit.metadata).toMatchObject({
      producer: "deterministic_acknowledgement",
      dedup_key: callSid,
    });

    // (4) EXACTLY ONE transport for the org, threaded to the audit that authorised it.
    const transports = await transportsForOrg(orgId);
    expect(transports).toHaveLength(1);
    const t = transports[0] ?? {};
    expect(t.reply_audit_id, "the transport is threaded to its audit").toBe(dispatch.audit_id);
    expect(t.org_id).toBe(orgId);
    expect(t.employee_slug).toBe(EMPLOYEE_SLUG);
    expect(t.channel, "the one transport R5/R6 ship").toBe("sms");
    expect(t.status).toBe("failed");
    expect(t.failure_reason).toBe("no_provider");
    expect(t.provider).toBeNull();
    expect(t.provider_message_id).toBeNull();
    expect(t.to_ref).toBe(CALLER);
    expect(t.dedup_key, "the CallSid is the idempotency key").toBe(callSid);
    expect(t.correlation_id).toBe(dispatch.correlation_id);
    expect(t.metadata).toMatchObject({ producer: "missed_call_text_back" });

    // Close the chain: inbound enquiry → audit → transport, no step detached.
    const enquiry = await enquiryById(result.enquiry_id);
    expect(enquiry, "the inbound enquiry the whole chain answers").not.toBeNull();
    expect(enquiry?.org_id).toBe(orgId);
    expect(enquiry?.channel).toBe("phone");
    expect(audit.enquiry_id).toBe(enquiry?.id);
  });

  it("FLAG ON, NON-missed-call channel — the live path stays inert (only 'phone' is R6's behaviour)", async () => {
    // The channel gate: armed, an SMS-channel enquiry is an explicit non-goal and sends
    // nothing. Proves flag ON activates ONLY the ONE missed-call behaviour, not a rollout.
    vi.stubEnv(FLAG, "true");
    const orgId = await freshOrg();

    const result = await processInboundEnquiry({
      org_id: orgId,
      channel: "sms",
      caller: CALLER,
      raw_text: "An inbound SMS, not a missed call.",
    });

    expect(result.textback).toEqual({ attempted: false, reason: "unsupported_channel" });
    expect(await auditsForOrg(orgId)).toHaveLength(0);
    expect(await transportsForOrg(orgId)).toHaveLength(0);
  });

  it("FLAG ON, missed call with NO caller — the live path stays inert (nothing to answer)", async () => {
    // The destination gate: a text-back needs a number to answer. Armed but with no caller,
    // the wiring early-returns — never a throw, ingestion undisturbed, nothing sent.
    vi.stubEnv(FLAG, "true");
    const orgId = await freshOrg();

    const result = await processInboundEnquiry({
      org_id: orgId,
      channel: "phone",
      caller: null,
      raw_text: "Missed call, caller withheld.",
    });

    expect(result.textback).toEqual({ attempted: false, reason: "no_destination" });
    expect(await auditsForOrg(orgId)).toHaveLength(0);
    expect(await transportsForOrg(orgId)).toHaveLength(0);
  });

  it("NO duplicate messages — a replayed missed call short-circuits once a SENT transport exists for its CallSid", async () => {
    // Criterion (6): idempotency across a webhook replay. Stand up a prior SENT transport
    // for a CallSid (the first text-back already went out), then re-drive the SAME missed
    // call through the inbound processor — the live path must short-circuit BEFORE
    // composing, enforcing, auditing, or sending again.
    vi.stubEnv(FLAG, "true");
    const orgId = await freshOrg();
    const callSid = `CA-${crypto.randomUUID()}`;
    const seedAudit = await seedAllowedAudit(orgId);
    const sentId = await seedSentTransport({ auditId: seedAudit, orgId, dedupKey: callSid });

    const auditsBefore = (await auditsForOrg(orgId)).length; // the single seed audit

    const result = await processInboundEnquiry({
      org_id: orgId,
      channel: "phone",
      caller: CALLER,
      raw_text: "The SAME missed call, webhook delivered twice.",
      dedup_key: callSid, // same idempotency key as the prior send
    });

    const tb = result.textback;
    expect(tb.attempted).toBe(true);
    if (!tb.attempted) throw new Error("unreachable");
    if (!("dispatch" in tb)) throw new Error(`text-back errored: ${tb.error}`);
    const dispatch = tb.dispatch;

    // Short-circuited: duplicate, no audit, no new send — pointing at the prior SENT row.
    expect(dispatch.transport.duplicate).toBe(true);
    expect(dispatch.transport.attempted).toBe(false);
    expect(dispatch.transport.status).toBe("skipped");
    expect(dispatch.transport.failure_reason).toBe("duplicate");
    expect(dispatch.transport.transport_id).toBe(sentId);
    expect(dispatch.audit_id).toBeNull();
    expect(dispatch.correlation_id).toBeNull();
    expect(dispatch.draft).toBeNull();
    expect(dispatch.decision).toBeNull();

    // Nothing new was written: no second audit, and exactly one SENT transport for the key.
    expect(await auditsForOrg(orgId), "the replay wrote no new audit").toHaveLength(auditsBefore);
    const sentForKey = (await transportsForOrg(orgId)).filter(
      (r) => r.status === "sent" && r.dedup_key === callSid,
    );
    expect(sentForKey, "exactly one SENT message for the CallSid").toHaveLength(1);
    expect(sentForKey[0]?.id).toBe(sentId);
  });

  it("provider identifiers stay traceable — a message id walks sid → transport → audit → inbound enquiry", async () => {
    // Criterion (5): "provider identifiers remain traceable through the complete execution
    // chain … no step may become detached". A live SENT send is un-drivable in CI (no
    // vendor), so a sent transport is seeded — carrying a known sid, the provider's
    // synchronous status (the R6 delivery increment), and threaded to a real audit that
    // itself points at a real inbound enquiry. Then, given only the provider's message id,
    // walk the whole chain backwards.
    const orgId = await freshOrg();

    // A real inbound enquiry at the head of the chain.
    const ins = await svc()
      .from(ENQUIRIES)
      .insert({ org_id: orgId, channel: "phone", caller: CALLER, status: "received" })
      .select("id")
      .single();
    expect(ins.error, ins.error?.message).toBeNull();
    const enquiryId = String((ins.data as { id: string }).id);

    const auditId = await seedAllowedAudit(orgId, enquiryId);
    const sid = `SM-${crypto.randomUUID()}`;
    const dedupKey = `CA-${crypto.randomUUID()}`;
    const transportId = await seedSentTransport({
      auditId,
      orgId,
      dedupKey,
      providerMessageId: sid,
      providerStatus: "queued", // the provider's synchronous status, recorded at acceptance
    });

    // Given ONLY the provider's message id: the transport it correlates to.
    const bySid = await transportsBySid(sid);
    expect(bySid, "the provider message id resolves to exactly one transport").toHaveLength(1);
    const t = bySid[0] ?? {};
    expect(t.id).toBe(transportId);
    expect(t.dedup_key).toBe(dedupKey);
    expect(t.status).toBe("sent");
    // The provider's synchronous outcome is recorded against the message id (R6 delivery).
    expect(t.metadata).toMatchObject({
      producer: "missed_call_text_back",
      provider_status: "queued",
    });

    // …→ the audit that authorised it…
    const auditRef = String(t.reply_audit_id);
    expect(auditRef).toBe(auditId);
    const audit = await auditById(auditRef);
    expect(audit, "the transport's audit").not.toBeNull();
    expect(audit?.allowed).toBe(true);

    // …→ the inbound enquiry that started it. No step detached.
    const enquiryRef = String(audit?.enquiry_id);
    expect(enquiryRef).toBe(enquiryId);
    const enquiry = await enquiryById(enquiryRef);
    expect(enquiry, "the inbound enquiry at the head of the chain").not.toBeNull();
    expect(enquiry?.org_id).toBe(orgId);
  });
});
