import { expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient } from "../_harness";
import {
  dispatchReceptionistReply,
  dispatchReply,
  enforceAndAuditReply,
} from "@/server/services/receptionist";

/**
 * Outbound Transport pipeline — real-Postgres proof of the AI Receptionist Programme
 * R5 (FIRST OUTBOUND TRANSPORT).
 *
 * R4 closed the INTERNAL loop (Draft → Enforce → Audit) and proved it against a live
 * database. R5 carries an enforced, audited, auto-sendable reply out through exactly
 * ONE transport — SMS (missed-call text-back) — over the reused lib/comms provider
 * seam, and records every OUTCOME in the append-only `ai_reply_transports` ledger. The
 * unit tier pins the provider seam's graceful-degradation contract and the security
 * tier proves, as a matter of SOURCE, that the only path to a provider runs through the
 * enforcement seam and the audit ledger. This tier proves the BEHAVIOUR the mocks
 * can't — that when the CANONICAL SERVICE actually runs against Postgres, the
 * directive's five validation criteria hold end to end:
 *
 *   (1) EVERY outbound originates from the canonical pipeline — a transport row is only
 *       ever produced by driving `dispatchReceptionistReply` / `dispatchReply`, threaded
 *       to the audit that authorised it (`reply_audit_id === audit_id`).
 *   (2) EVERY outbound has a MANDATORY audit record — the transport is filed only after
 *       `enforceAndAuditReply` has written the audit; the ledger's DB gate refuses any
 *       transport whose audit is absent or not an allowed reply.
 *   (3) NO transport can bypass enforcement — a `review` (held) or `block` (refused)
 *       reply is audited and STOPS (skipped/not_auto_sendable, zero transport rows); and
 *       the database itself rejects a transport filed against a non-allow audit, so the
 *       guarantee survives even a caller that bypasses the service.
 *   (4) FAILED transport attempts are as fully audited as successful ones — the
 *       no-provider (CI) path and an undialable destination each leave a durable
 *       `failed` row threaded to its audit.
 *   (5) NO duplicate messages — once a SENT transport exists for an idempotency key, a
 *       second dispatch short-circuits (duplicate, audit_id null) without composing,
 *       enforcing, auditing, or sending again.
 *
 * And the storage invariants the migration promises: RLS:hq (service-role-only),
 * append-only (UPDATE/DELETE rejected even for service_role), the born-state coupling
 * (a `sent` row needs a provider message id; a `failed` row must not carry one), and
 * the org-match gate.
 *
 * Runs only against a live DB (describeIntegration): skipped locally with no database,
 * FAILED loudly in CI if the database is missing. The ledger is append-only, so these
 * tests intentionally leave their rows behind — harmless in the ephemeral CI database,
 * and proving exactly that is one of the tests below. Rows are addressed by per-call
 * org / correlation / audit ids so each assertion sees only its own writes.
 */

// ai_reply_transports / ai_reply_audits and their record_* primitives are
// service-role-only internals and are NOT in the generated Database types. Cast to the
// minimal surface this suite exercises (the same `as unknown as` convention the reply
// audit suite uses) rather than reaching for `any`.
type RpcResult<T> = { data: T | null; error: { message: string } | null };
type Term<T> = PromiseLike<RpcResult<T>>;
// `eq` is chainable (Supabase filter builders return themselves), so it yields a
// `Filterable<T>`, letting filters compose and reads terminate in the awaited result.
type Filterable<T> = Term<T> & { eq(column: string, value: unknown): Filterable<T> };
type LedgerTable = {
  select(columns?: string): Filterable<Record<string, unknown>[]>;
  insert(row: Record<string, unknown>): Filterable<null>;
  update(patch: Record<string, unknown>): Filterable<null>;
  delete(): Filterable<null>;
};
type LedgerClient = {
  rpc<T = unknown>(fn: string, args: Record<string, unknown>): Term<T>;
  from(table: string): LedgerTable;
};

const TRANSPORTS = "ai_reply_transports";
const AUDITS = "ai_reply_audits";
const TRANSPORT_RPC = "record_ai_reply_transport";
const EMPLOYEE_SLUG = "voice-receptionist-ai";

const svc = (): LedgerClient => serviceClient() as unknown as LedgerClient;
const anon = (): LedgerClient => anonClient() as unknown as LedgerClient;

// The columns every transport assertion reads back — the full captured record.
const T_COLUMNS =
  "id, reply_audit_id, org_id, employee_slug, channel, provider, to_ref, " +
  "provider_message_id, status, failure_reason, cost_usd, latency_ms, attempt, " +
  "dedup_key, correlation_id, metadata";

// A pre-vetted clean `allow` draft (the same one the R4 audit suite uses): a plain
// acknowledgement the harvested guardrail passes. Supplied straight to the audit path
// to seed the allowed audits the transport tests build on.
const ALLOW_DRAFT =
  "Thanks for your message — a member of the team will get back to you shortly.";
// Two drafts that deterministically exercise the non-`allow` verdicts: a price
// COMMITMENT is held for review; an absolute SAFETY claim is refused (block).
const REVIEW_DRAFT = "Sure, that'll cost £450 including VAT.";
const BLOCK_DRAFT = "Don't worry, your gas boiler is completely safe.";

/** Every transport row filed against one audit, as service_role. */
async function transportsForAudit(auditId: string): Promise<Record<string, unknown>[]> {
  const res = await svc().from(TRANSPORTS).select(T_COLUMNS).eq("reply_audit_id", auditId);
  expect(res.error, res.error?.message).toBeNull();
  return res.data ?? [];
}

/** Every transport row for one org + idempotency key, as service_role. */
async function transportsForKey(
  orgId: string,
  dedupKey: string,
): Promise<Record<string, unknown>[]> {
  const res = await svc()
    .from(TRANSPORTS)
    .select("id, status")
    .eq("org_id", orgId)
    .eq("dedup_key", dedupKey);
  expect(res.error, res.error?.message).toBeNull();
  return res.data ?? [];
}

/** Every audit row for one org, as service_role. */
async function auditsForOrg(orgId: string): Promise<Record<string, unknown>[]> {
  const res = await svc().from(AUDITS).select("id").eq("org_id", orgId);
  expect(res.error, res.error?.message).toBeNull();
  return res.data ?? [];
}

/**
 * Seed a real, allowed `ai_reply_audits` row through the canonical audit path (not a
 * raw insert), returning its id — the precondition the transport gate demands.
 */
async function seedAllowedAudit(orgId: string): Promise<string> {
  const outcome = await enforceAndAuditReply({
    org_id: orgId,
    channel: "sms",
    correlation_id: crypto.randomUUID(),
    draft: ALLOW_DRAFT,
  });
  expect(outcome.decision.allowed, "seed draft must be a clean allow").toBe(true);
  return outcome.audit_id;
}

/**
 * File a SENT transport through the service-role write primitive, returning its id.
 * Used to stand up the "a message already went out" precondition for the no-duplicate,
 * append-only and RLS tests (the CI service path only ever produces `failed`, so a
 * `sent` row must be seeded through the RPC directly).
 */
async function seedSentTransport(args: {
  auditId: string;
  orgId: string;
  dedupKey?: string | null;
  // Optional: defaults to a globally-unique id. The ledger is append-only (rows
  // persist across runs) and `provider_message_id` is uniquely indexed, so a fixed
  // value would collide on re-run — every seeded send mints its own.
  providerMessageId?: string;
  toRef?: string;
}): Promise<string> {
  const res = await svc().rpc<string>(TRANSPORT_RPC, {
    p_reply_audit_id: args.auditId,
    p_org_id: args.orgId,
    p_employee_slug: EMPLOYEE_SLUG,
    p_channel: "sms",
    p_to_ref: args.toRef ?? "+447700900000",
    p_status: "sent",
    p_correlation_id: crypto.randomUUID(),
    p_provider: "twilio",
    p_provider_message_id: args.providerMessageId ?? `SM-${crypto.randomUUID()}`,
    p_dedup_key: args.dedupKey ?? null,
  });
  expect(res.error, res.error?.message).toBeNull();
  expect(res.data, "seeded sent transport must return an id").toBeTruthy();
  return res.data as string;
}

/**
 * Assert an anon read obtained no row — denial being equally valid whether it arrives
 * as a hard privilege error or as an RLS-filtered empty set. A returned row is the only
 * failure.
 */
function expectAnonDenied(res: RpcResult<Record<string, unknown>[]>): void {
  if (res.error) return;
  expect(res.data ?? []).toHaveLength(0);
}

describeIntegration("Outbound transport pipeline · ai_reply_transports (R5)", () => {
  it("dispatchReceptionistReply (allow, no provider) writes 1 audit + 1 failed transport, threaded end to end", async () => {
    // Criteria (1),(2),(4): the full canonical outbound path against the CI environment
    // (no Twilio configured). The reply is composed, enforced, audited, then the
    // transport degrades gracefully to a recorded failed/no_provider attempt.
    const orgId = crypto.randomUUID();
    const enquiryId = crypto.randomUUID();

    const outcome = await dispatchReceptionistReply({
      org_id: orgId,
      channel: "phone", // a missed call…
      enquiry_id: enquiryId,
      customer_ref: "+447700900000", // …texted back over SMS.
    });

    // The deterministic acknowledgement is a clean allow, and it was audited.
    expect(outcome.decision?.verdict).toBe("allow");
    expect(outcome.decision?.allowed).toBe(true);
    expect(outcome.audit_id).toBeTruthy();
    expect(outcome.correlation_id).toBeTruthy();

    // The transport degraded gracefully: a recorded failed/no_provider attempt (no send).
    expect(outcome.transport.attempted).toBe(true);
    expect(outcome.transport.duplicate).toBe(false);
    expect(outcome.transport.status).toBe("failed");
    expect(outcome.transport.failure_reason).toBe("no_provider");
    expect(outcome.transport.provider_message_id).toBeNull();
    expect(outcome.transport.transport_id).toBeTruthy();

    // EXACTLY ONE audit for the org — not zero (unaudited), not two (double-written).
    expect(await auditsForOrg(orgId)).toHaveLength(1);

    // EXACTLY ONE transport, threaded to the audit that authorised it.
    const transports = await transportsForAudit(outcome.audit_id as string);
    expect(transports).toHaveLength(1);
    const t = transports[0] ?? {};
    expect(t.id).toBe(outcome.transport.transport_id);
    expect(t.reply_audit_id).toBe(outcome.audit_id); // (1) originates from the pipeline
    expect(t.org_id).toBe(orgId);
    expect(t.employee_slug).toBe(EMPLOYEE_SLUG);
    expect(t.channel).toBe("sms"); // the one transport R5 ships
    expect(t.status).toBe("failed"); // (4) the failure is durably recorded
    expect(t.failure_reason).toBe("no_provider");
    expect(t.provider).toBeNull();
    expect(t.provider_message_id).toBeNull();
    expect(t.to_ref).toBe("+447700900000");
    expect(t.correlation_id).toBe(outcome.correlation_id); // threaded trace
    expect(t.dedup_key).toBe(enquiryId); // idempotency falls back to the conversation
    expect(t.metadata).toMatchObject({ producer: "missed_call_text_back" });
  });

  it("records a failed/invalid_destination attempt for an undialable number — still threaded to its audit", async () => {
    // Criterion (4): a real attempt that never reaches a provider is still audited AND
    // recorded failed. The draft is a clean allow; only the DESTINATION is undialable.
    const orgId = crypto.randomUUID();
    const outcome = await dispatchReply({
      org_id: orgId,
      channel: "sms",
      correlation_id: crypto.randomUUID(),
      draft: ALLOW_DRAFT,
      destination: "not-a-phone-number",
    });

    expect(outcome.decision?.allowed).toBe(true);
    expect(outcome.transport.status).toBe("failed");
    expect(outcome.transport.failure_reason).toBe("invalid_destination");
    expect(outcome.transport.provider_message_id).toBeNull();

    const transports = await transportsForAudit(outcome.audit_id as string);
    expect(transports).toHaveLength(1);
    const t = transports[0] ?? {};
    expect(t.status).toBe("failed");
    expect(t.failure_reason).toBe("invalid_destination");
    expect(t.to_ref).toBe("not-a-phone-number"); // captured verbatim for forensics
    expect(t.provider).toBeNull();
  });

  it("a REVIEW reply is audited but NEVER reaches transport (skipped/not_auto_sendable, zero transport rows)", async () => {
    // Criterion (3), service level: deny by default. A held price commitment is audited
    // (allowed=false) and STOPS — no transport row is ever produced.
    const orgId = crypto.randomUUID();
    const outcome = await dispatchReply({
      org_id: orgId,
      channel: "sms",
      correlation_id: crypto.randomUUID(),
      draft: REVIEW_DRAFT,
      destination: "+447700900000",
    });

    expect(outcome.decision?.verdict).toBe("review");
    expect(outcome.decision?.allowed).toBe(false);
    expect(outcome.audit_id).toBeTruthy(); // audited…
    expect(outcome.transport.attempted).toBe(false); // …but not sent
    expect(outcome.transport.status).toBe("skipped");
    expect(outcome.transport.failure_reason).toBe("not_auto_sendable");
    expect(outcome.transport.transport_id).toBeNull();

    expect(await auditsForOrg(orgId)).toHaveLength(1);
    expect(await transportsForAudit(outcome.audit_id as string)).toHaveLength(0);
  });

  it("a BLOCK reply is audited but NEVER reaches transport (skipped/not_auto_sendable, zero transport rows)", async () => {
    // Criterion (3), service level: a refused absolute-safety claim is audited and STOPS.
    const orgId = crypto.randomUUID();
    const outcome = await dispatchReply({
      org_id: orgId,
      channel: "sms",
      correlation_id: crypto.randomUUID(),
      draft: BLOCK_DRAFT,
      destination: "+447700900000",
    });

    expect(outcome.decision?.verdict).toBe("block");
    expect(outcome.decision?.allowed).toBe(false);
    expect(outcome.transport.attempted).toBe(false);
    expect(outcome.transport.status).toBe("skipped");
    expect(outcome.transport.failure_reason).toBe("not_auto_sendable");
    expect(await transportsForAudit(outcome.audit_id as string)).toHaveLength(0);
  });

  it("the DATABASE refuses a transport filed against a non-allow (or absent) audit — the bypass-proof gate", async () => {
    // Criterion (3), database level: even a caller reaching PAST the service cannot file
    // a transport unless its audit is an allowed reply. This is the load-bearing proof
    // that "no execution path can reach a transport adapter without first passing through
    // both the canonical enforcement seam and the mandatory audit ledger".
    const orgId = crypto.randomUUID();

    // Seed a REVIEW (not-allowed) audit through the real audit path.
    const reviewAudit = await enforceAndAuditReply({
      org_id: orgId,
      channel: "sms",
      correlation_id: crypto.randomUUID(),
      draft: REVIEW_DRAFT,
    });
    expect(reviewAudit.decision.allowed).toBe(false);

    // The gate rejects a transport (even a `failed` one) against a non-allow audit.
    const againstReview = await svc().rpc<string>(TRANSPORT_RPC, {
      p_reply_audit_id: reviewAudit.audit_id,
      p_org_id: orgId,
      p_employee_slug: EMPLOYEE_SLUG,
      p_channel: "sms",
      p_to_ref: "+447700900000",
      p_status: "failed",
      p_correlation_id: crypto.randomUUID(),
      p_failure_reason: "provider_error",
    });
    expect(
      againstReview.error,
      "a transport against a non-allow audit must be rejected by the gate",
    ).not.toBeNull();
    expect(await transportsForAudit(reviewAudit.audit_id)).toHaveLength(0);

    // And a transport against a NON-EXISTENT audit (no matching row → not allowed) too.
    const againstMissing = await svc().rpc<string>(TRANSPORT_RPC, {
      p_reply_audit_id: crypto.randomUUID(),
      p_org_id: orgId,
      p_employee_slug: EMPLOYEE_SLUG,
      p_channel: "sms",
      p_to_ref: "+447700900000",
      p_status: "failed",
      p_correlation_id: crypto.randomUUID(),
      p_failure_reason: "provider_error",
    });
    expect(
      againstMissing.error,
      "a transport against a missing audit must be rejected by the gate",
    ).not.toBeNull();
  });

  it("the gate rejects an org that disagrees with the audit's org", async () => {
    // The transport must belong to the same tenant as the reply it carries.
    const orgId = crypto.randomUUID();
    const otherOrg = crypto.randomUUID();
    const auditId = await seedAllowedAudit(orgId);

    const mismatched = await svc().rpc<string>(TRANSPORT_RPC, {
      p_reply_audit_id: auditId,
      p_org_id: otherOrg, // ← does not match the audit's org
      p_employee_slug: EMPLOYEE_SLUG,
      p_channel: "sms",
      p_to_ref: "+447700900000",
      p_status: "failed",
      p_correlation_id: crypto.randomUUID(),
      p_failure_reason: "no_provider",
    });
    expect(mismatched.error, "org_id must match the audit's org").not.toBeNull();
    expect(await transportsForAudit(auditId)).toHaveLength(0);
  });

  it("the gate pins the born state — a sent row needs a provider message id; a failed row must not carry one", async () => {
    const orgId = crypto.randomUUID();
    const auditId = await seedAllowedAudit(orgId);

    // sent without a provider message id → rejected.
    const sentNoId = await svc().rpc<string>(TRANSPORT_RPC, {
      p_reply_audit_id: auditId,
      p_org_id: orgId,
      p_employee_slug: EMPLOYEE_SLUG,
      p_channel: "sms",
      p_to_ref: "+447700900000",
      p_status: "sent",
      p_correlation_id: crypto.randomUUID(),
      p_provider: "twilio",
      // p_provider_message_id omitted
    });
    expect(sentNoId.error, "a sent transport requires a provider_message_id").not.toBeNull();

    // failed WITH a provider message id → rejected.
    const failedWithId = await svc().rpc<string>(TRANSPORT_RPC, {
      p_reply_audit_id: auditId,
      p_org_id: orgId,
      p_employee_slug: EMPLOYEE_SLUG,
      p_channel: "sms",
      p_to_ref: "+447700900000",
      p_status: "failed",
      p_correlation_id: crypto.randomUUID(),
      p_provider: "twilio",
      p_provider_message_id: "SM_should_not_be_here",
      p_failure_reason: "provider_error",
    });
    expect(
      failedWithId.error,
      "a failed transport must not carry a provider_message_id",
    ).not.toBeNull();

    // Neither malformed attempt was filed.
    expect(await transportsForAudit(auditId)).toHaveLength(0);
  });

  it("the ledger is append-only — UPDATE and DELETE are rejected even for service_role", async () => {
    const orgId = crypto.randomUUID();
    const auditId = await seedAllowedAudit(orgId);
    const transportId = await seedSentTransport({
      auditId,
      orgId,
      dedupKey: crypto.randomUUID(),
    });

    // A recorded transport can never be rewritten…
    const updated = await svc()
      .from(TRANSPORTS)
      .update({ failure_reason: "tampered" })
      .eq("id", transportId);
    expect(updated.error, "UPDATE must be blocked by the append-only guard").not.toBeNull();

    // …nor erased.
    const deleted = await svc().from(TRANSPORTS).delete().eq("id", transportId);
    expect(deleted.error, "DELETE must be blocked by the append-only guard").not.toBeNull();

    // The row survived both attempts, unchanged.
    const survivors = await transportsForAudit(auditId);
    expect(survivors).toHaveLength(1);
    expect(survivors[0]?.id).toBe(transportId);
    expect(survivors[0]?.status).toBe("sent");
    expect(survivors[0]?.failure_reason).toBeNull();
  });

  it("is service-role-only (RLS:hq) — anon cannot read, insert, or call the write RPC", async () => {
    const orgId = crypto.randomUUID();
    const auditId = await seedAllowedAudit(orgId);
    const transportId = await seedSentTransport({
      auditId,
      orgId,
      dedupKey: crypto.randomUUID(),
    });

    // service_role (BYPASSRLS) sees the row…
    const asService = await svc().from(TRANSPORTS).select("id").eq("id", transportId);
    expect(asService.error, asService.error?.message).toBeNull();
    expect(asService.data).toHaveLength(1);

    // …anon does not (RLS enabled, zero policies → deny).
    expectAnonDenied(await anon().from(TRANSPORTS).select("id").eq("id", transportId));

    // anon cannot call the SECURITY DEFINER write function — EXECUTE is service_role-only.
    const anonRpc = await anon().rpc<string>(TRANSPORT_RPC, {
      p_reply_audit_id: auditId,
      p_org_id: orgId,
      p_employee_slug: EMPLOYEE_SLUG,
      p_channel: "sms",
      p_to_ref: "+447700900000",
      p_status: "failed",
      p_correlation_id: crypto.randomUUID(),
      p_failure_reason: "no_provider",
    });
    expect(anonRpc.error, "anon must not be able to file a transport").not.toBeNull();

    // anon cannot write around the RPC with a direct insert either.
    const anonInsert = await anon().from(TRANSPORTS).insert({
      reply_audit_id: auditId,
      org_id: orgId,
      employee_slug: EMPLOYEE_SLUG,
      channel: "sms",
      to_ref: "+447700900000",
      status: "failed",
      failure_reason: "no_provider",
      correlation_id: crypto.randomUUID(),
    });
    expect(anonInsert.error, "anon must not be able to insert into the ledger").not.toBeNull();
  });

  it("NO duplicate messages — a dispatch short-circuits once a SENT transport exists for the key", async () => {
    // Criterion (5): idempotency. Stand up a prior SENT transport for a dedup key, then
    // dispatch again for the same key — it must short-circuit BEFORE composing,
    // enforcing, auditing, or sending, leaving the ledgers untouched.
    const orgId = crypto.randomUUID();
    const dedupKey = `wa-msg-${crypto.randomUUID()}`;
    const seedAudit = await seedAllowedAudit(orgId);
    const sentId = await seedSentTransport({
      auditId: seedAudit,
      orgId,
      dedupKey,
    });

    const auditsBefore = (await auditsForOrg(orgId)).length; // the single seed audit
    const transportsBefore = (await transportsForKey(orgId, dedupKey)).length; // the seed send

    const outcome = await dispatchReceptionistReply({
      org_id: orgId,
      channel: "phone",
      customer_ref: "+447700900000",
      metadata: { dedup_key: dedupKey }, // same idempotency key as the prior send
    });

    // Short-circuited: duplicate, no audit, no new send — pointing at the prior row.
    expect(outcome.transport.duplicate).toBe(true);
    expect(outcome.transport.attempted).toBe(false);
    expect(outcome.transport.status).toBe("skipped");
    expect(outcome.transport.failure_reason).toBe("duplicate");
    expect(outcome.transport.transport_id).toBe(sentId);
    expect(outcome.audit_id).toBeNull();
    expect(outcome.correlation_id).toBeNull();
    expect(outcome.draft).toBeNull();
    expect(outcome.decision).toBeNull();

    // Nothing new was written on either ledger.
    expect(await auditsForOrg(orgId)).toHaveLength(auditsBefore);
    expect(await transportsForKey(orgId, dedupKey)).toHaveLength(transportsBefore);
  });

  it("the partial unique index backstops the app guard — a second SENT row for a key is rejected by the DB", async () => {
    // The application short-circuit (previous test) is the first line; the
    // `(dedup_key) where status='sent'` partial unique index is the database backstop
    // that makes a second successful send for the same key impossible even under a race.
    const orgId = crypto.randomUUID();
    const dedupKey = `race-${crypto.randomUUID()}`;
    const auditId = await seedAllowedAudit(orgId);

    await seedSentTransport({
      auditId,
      orgId,
      dedupKey,
    });

    // A second SENT row for the same key must be rejected by the unique index. Its
    // provider message id is unique, so the ONLY thing it collides on is the dedup key.
    const second = await svc().rpc<string>(TRANSPORT_RPC, {
      p_reply_audit_id: auditId,
      p_org_id: orgId,
      p_employee_slug: EMPLOYEE_SLUG,
      p_channel: "sms",
      p_to_ref: "+447700900000",
      p_status: "sent",
      p_correlation_id: crypto.randomUUID(),
      p_provider: "twilio",
      p_provider_message_id: `SM-${crypto.randomUUID()}`,
      p_dedup_key: dedupKey,
    });
    expect(second.error, "a second sent transport for one key must be rejected").not.toBeNull();

    // Exactly one SENT row survived for the key.
    const sent = (await transportsForKey(orgId, dedupKey)).filter((r) => r.status === "sent");
    expect(sent).toHaveLength(1);
  });
});
