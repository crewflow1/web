import { expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient } from "../_harness";
import {
  enforceAndAuditReply,
  recordSmsDeliveryReceipt,
} from "@/server/services/receptionist";

/**
 * Async delivery-receipt pipeline — real-Postgres proof of the AI Receptionist
 * Programme R7 (ASYNC DELIVERY RECEIPTS).
 *
 * R5 carried an enforced, audited reply out over one transport and recorded the
 * provider's SYNCHRONOUS acceptance (`ai_reply_transports`). R7 completes the lifecycle:
 * the provider's ASYNCHRONOUS terminal status (delivered / undelivered / failed /
 * canceled) arrives over an authenticated status-callback webhook and is recorded as a
 * NEW, append-only receipt row correlated to the transport by the provider's message id
 * — the transport is NEVER mutated. The unit tier pins the vocabulary, the Twilio
 * verification/parsing, and the route's decision tree with mocks; the security tier
 * proves, as a matter of SOURCE, that a receipt has exactly one write path and the route
 * adds no new send. This tier proves the BEHAVIOUR the mocks can't — that when
 * `recordSmsDeliveryReceipt` actually runs against Postgres the directive's invariants
 * hold end to end:
 *
 *   (1) CORRELATION — a receipt is bound to exactly the SENT transport whose provider
 *       message id it names; its org / audit / employee / channel / provider are copied
 *       FROM that authoritative row, never trusted from the caller.
 *   (2) TERMINAL STATE — the provider's final state is recorded, and `terminal` is a
 *       generated fact of the row (delivered/undelivered/failed/canceled → true).
 *   (3) IDEMPOTENCY — a duplicate callback for the same (message id, status) is a no-op
 *       that returns the pre-existing receipt; no duplicate history, no corruption.
 *   (4) LIFECYCLE — distinct statuses for one send append distinct rows (queued → sent →
 *       delivered), so the delivery history is the transport PLUS its ordered receipts.
 *   (5) UNKNOWN IDENTIFIER — a message id the ledger never sent records NOTHING and is
 *       reported as unknown (the webhook answers 404).
 *   (6) TRACEABILITY — every receipt walks back receipt → transport → audit → enquiry.
 *
 * And the storage invariants the migration promises: RLS:hq (service-role-only),
 * append-only (UPDATE/DELETE rejected even for service_role), and the correlation guard
 * (a receipt orphaned, mislinked across tenants, or naming a message id its transport
 * never carried is refused by the database itself).
 *
 * Runs only against a live DB (describeIntegration): skipped locally with no database,
 * FAILED loudly in CI if the database is missing. The ledgers are append-only, so these
 * tests intentionally leave their rows behind — harmless in the ephemeral CI database.
 * Rows are addressed by per-call org / message id so each assertion sees only its own
 * writes.
 */

// The receptionist ledgers + their record_* primitives are service-role-only internals
// and are NOT in the generated Database types. Cast to the minimal surface this suite
// exercises (the same `as unknown as` convention the transport suite uses) rather than
// reaching for `any`.
type RpcResult<T> = { data: T | null; error: { message: string } | null };
type Term<T> = PromiseLike<RpcResult<T>>;
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
const RECEIPTS = "ai_reply_delivery_receipts";
const TRANSPORT_RPC = "record_ai_reply_transport";
const RECEIPT_RPC = "record_ai_reply_delivery_receipt";
const EMPLOYEE_SLUG = "voice-receptionist-ai";

const svc = (): LedgerClient => serviceClient() as unknown as LedgerClient;
const anon = (): LedgerClient => anonClient() as unknown as LedgerClient;

const ALLOW_DRAFT =
  "Thanks for your message — a member of the team will get back to you shortly.";

const R_COLUMNS =
  "id, transport_id, reply_audit_id, org_id, employee_slug, channel, provider, " +
  "provider_message_id, status, terminal, provider_status, error_code, correlation_id, metadata";

const T_COLUMNS =
  "id, reply_audit_id, org_id, employee_slug, channel, provider, provider_message_id, " +
  "status, correlation_id";

/** Seed a real, allowed audit through the canonical audit path, returning its id. */
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
 * File a SENT transport through the service-role write primitive, returning its id and
 * the provider message id it carries (the correlation key R7 ingests receipts against).
 * The CI service path only ever produces `failed`, so a `sent` row must be seeded
 * directly. Each seed mints a globally-unique message id (the ledger is append-only and
 * the id is uniquely indexed, so a fixed value would collide on re-run).
 */
async function seedSentTransport(args: {
  auditId: string;
  orgId: string;
}): Promise<{ transportId: string; providerMessageId: string }> {
  const providerMessageId = `SM-${crypto.randomUUID()}`;
  const res = await svc().rpc<string>(TRANSPORT_RPC, {
    p_reply_audit_id: args.auditId,
    p_org_id: args.orgId,
    p_employee_slug: EMPLOYEE_SLUG,
    p_channel: "sms",
    p_to_ref: "+447700900000",
    p_status: "sent",
    p_correlation_id: crypto.randomUUID(),
    p_provider: "twilio",
    p_provider_message_id: providerMessageId,
    p_dedup_key: null,
  });
  expect(res.error, res.error?.message).toBeNull();
  expect(res.data, "seeded sent transport must return an id").toBeTruthy();
  return { transportId: res.data as string, providerMessageId };
}

/** Read a single transport row (service_role), or throw. */
async function readTransport(transportId: string): Promise<Record<string, unknown>> {
  const res = await svc().from(TRANSPORTS).select(T_COLUMNS).eq("id", transportId);
  expect(res.error, res.error?.message).toBeNull();
  const row = (res.data ?? [])[0];
  expect(row, "transport must exist").toBeTruthy();
  return row as Record<string, unknown>;
}

/** Every receipt row for one provider message id (service_role). */
async function receiptsForMessageId(sid: string): Promise<Record<string, unknown>[]> {
  const res = await svc().from(RECEIPTS).select(R_COLUMNS).eq("provider_message_id", sid);
  expect(res.error, res.error?.message).toBeNull();
  return res.data ?? [];
}

/** A convenience: seed an allowed audit + sent transport in one call. */
async function seedSend(): Promise<{
  orgId: string;
  auditId: string;
  transportId: string;
  providerMessageId: string;
}> {
  const orgId = crypto.randomUUID();
  const auditId = await seedAllowedAudit(orgId);
  const { transportId, providerMessageId } = await seedSentTransport({ auditId, orgId });
  return { orgId, auditId, transportId, providerMessageId };
}

/** Denial is valid whether it arrives as a privilege error or an RLS-filtered empty set. */
function expectAnonDenied(res: RpcResult<Record<string, unknown>[]>): void {
  if (res.error) return;
  expect(res.data ?? []).toHaveLength(0);
}

describeIntegration("Async delivery-receipt pipeline · ai_reply_delivery_receipts (R7)", () => {
  it("records a terminal delivery receipt correlated to its transport (criteria 1,2)", async () => {
    const { orgId, auditId, transportId, providerMessageId } = await seedSend();
    const transport = await readTransport(transportId);

    const result = await recordSmsDeliveryReceipt({
      providerMessageId,
      status: "delivered",
    });

    // The service reports a fresh, terminal receipt threaded to the right transport.
    expect(result.recorded).toBe(true);
    if (!result.recorded) throw new Error("unreachable");
    expect(result.duplicate).toBe(false);
    expect(result.terminal).toBe(true);
    expect(result.status).toBe("delivered");
    expect(result.transport_id).toBe(transportId);
    expect(result.reply_audit_id).toBe(auditId);
    expect(result.org_id).toBe(orgId);
    expect(result.receipt_id).toBeTruthy();

    // EXACTLY ONE receipt row, its linkage copied FROM the transport (not the caller).
    const rows = await receiptsForMessageId(providerMessageId);
    expect(rows).toHaveLength(1);
    const r = rows[0] ?? {};
    expect(r.id).toBe(result.receipt_id);
    expect(r.transport_id).toBe(transportId); // (1) correlation anchor
    expect(r.reply_audit_id).toBe(auditId); // denormalised from the transport
    expect(r.org_id).toBe(orgId);
    expect(r.employee_slug).toBe(EMPLOYEE_SLUG);
    expect(r.channel).toBe("sms");
    expect(r.provider).toBe("twilio");
    expect(r.provider_message_id).toBe(providerMessageId);
    expect(r.status).toBe("delivered");
    expect(r.terminal).toBe(true); // (2) terminal is a generated fact
    expect(r.correlation_id).toBe(transport.correlation_id); // threaded trace
    expect(r.provider_status).toBeNull();
    expect(r.error_code).toBeNull();
  });

  it("preserves the raw provider status and error code on a non-delivery", async () => {
    const { providerMessageId } = await seedSend();

    const result = await recordSmsDeliveryReceipt({
      providerMessageId,
      status: "undelivered",
      providerStatus: "Undelivered",
      errorCode: "30008",
    });

    expect(result.recorded).toBe(true);
    if (!result.recorded) throw new Error("unreachable");
    expect(result.terminal).toBe(true);

    const rows = await receiptsForMessageId(providerMessageId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("undelivered");
    expect(rows[0]?.provider_status).toBe("Undelivered");
    expect(rows[0]?.error_code).toBe("30008");
  });

  it("is idempotent — a duplicate (message id, status) callback is a no-op (criterion 3)", async () => {
    const { providerMessageId } = await seedSend();

    const first = await recordSmsDeliveryReceipt({ providerMessageId, status: "delivered" });
    const second = await recordSmsDeliveryReceipt({ providerMessageId, status: "delivered" });

    expect(first.recorded).toBe(true);
    expect(second.recorded).toBe(true);
    if (!first.recorded || !second.recorded) throw new Error("unreachable");

    // The first is fresh; the second is a recognised duplicate pointing at the SAME row.
    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(second.receipt_id).toBe(first.receipt_id);

    // No duplicate history — exactly one row for the (message id, status).
    expect(await receiptsForMessageId(providerMessageId)).toHaveLength(1);
  });

  it("appends distinct rows for distinct lifecycle statuses of one send (criterion 4)", async () => {
    const { providerMessageId } = await seedSend();

    // A non-terminal interim status, then the terminal one — the ordered lifecycle.
    const queued = await recordSmsDeliveryReceipt({ providerMessageId, status: "queued" });
    const delivered = await recordSmsDeliveryReceipt({ providerMessageId, status: "delivered" });

    expect(queued.recorded && delivered.recorded).toBe(true);
    if (!queued.recorded || !delivered.recorded) throw new Error("unreachable");

    // Terminal correctness: 'queued' is interim, 'delivered' is final.
    expect(queued.terminal).toBe(false);
    expect(delivered.terminal).toBe(true);
    expect(delivered.receipt_id).not.toBe(queued.receipt_id);

    // Two receipt rows for the one send — the delivery history is transport + receipts.
    const rows = await receiptsForMessageId(providerMessageId);
    expect(rows).toHaveLength(2);
    const byStatus = new Map(rows.map((r) => [r.status as string, r]));
    expect(byStatus.get("queued")?.terminal).toBe(false);
    expect(byStatus.get("delivered")?.terminal).toBe(true);
  });

  it("records terminal correctness across the terminal vocabulary", async () => {
    // Each of the four terminal states is recorded as terminal=true; against its own send.
    for (const status of ["undelivered", "failed", "canceled"] as const) {
      const { providerMessageId } = await seedSend();
      const result = await recordSmsDeliveryReceipt({ providerMessageId, status });
      expect(result.recorded, status).toBe(true);
      if (!result.recorded) throw new Error("unreachable");
      expect(result.terminal, status).toBe(true);
      const rows = await receiptsForMessageId(providerMessageId);
      expect(rows[0]?.terminal, status).toBe(true);
    }
  });

  it("records NOTHING for an unknown provider message id (criterion 5)", async () => {
    const unknownSid = `SM-unknown-${crypto.randomUUID()}`;

    const result = await recordSmsDeliveryReceipt({
      providerMessageId: unknownSid,
      status: "delivered",
    });

    expect(result.recorded).toBe(false);
    if (result.recorded) throw new Error("unreachable");
    expect(result.reason).toBe("unknown_message");

    // Nothing was written — the ledger never saw this id.
    expect(await receiptsForMessageId(unknownSid)).toHaveLength(0);
  });

  it("every receipt walks back receipt → transport → audit (criterion 6)", async () => {
    const { auditId, transportId, providerMessageId } = await seedSend();

    await recordSmsDeliveryReceipt({ providerMessageId, status: "delivered" });

    // receipt → transport
    const receipt = (await receiptsForMessageId(providerMessageId))[0] ?? {};
    expect(receipt.transport_id).toBe(transportId);

    // transport → audit (the receipt's denormalised reply_audit_id equals the transport's)
    const transport = await readTransport(transportId);
    expect(transport.reply_audit_id).toBe(auditId);
    expect(receipt.reply_audit_id).toBe(transport.reply_audit_id);

    // audit exists and is the enforced reply this whole chain descends from.
    const auditRes = await svc()
      .from("ai_reply_audits")
      .select("id, org_id, channel")
      .eq("id", auditId);
    expect(auditRes.error, auditRes.error?.message).toBeNull();
    expect(auditRes.data).toHaveLength(1);
    expect(auditRes.data?.[0]?.channel).toBe("sms");
  });

  it("the ledger is append-only — UPDATE and DELETE are rejected even for service_role", async () => {
    const { providerMessageId } = await seedSend();
    const result = await recordSmsDeliveryReceipt({ providerMessageId, status: "delivered" });
    expect(result.recorded).toBe(true);
    if (!result.recorded) throw new Error("unreachable");
    const receiptId = result.receipt_id;

    // A recorded receipt can never be rewritten…
    const updated = await svc()
      .from(RECEIPTS)
      .update({ status: "failed" })
      .eq("id", receiptId);
    expect(updated.error, "UPDATE must be blocked by the append-only guard").not.toBeNull();

    // …nor erased.
    const deleted = await svc().from(RECEIPTS).delete().eq("id", receiptId);
    expect(deleted.error, "DELETE must be blocked by the append-only guard").not.toBeNull();

    // The row survived both attempts, unchanged.
    const survivors = await receiptsForMessageId(providerMessageId);
    expect(survivors).toHaveLength(1);
    expect(survivors[0]?.id).toBe(receiptId);
    expect(survivors[0]?.status).toBe("delivered");
  });

  it("the correlation guard refuses an orphaned, mislinked, or dishonest receipt", async () => {
    const { orgId, auditId, transportId, providerMessageId } = await seedSend();

    // (a) A receipt against a NON-EXISTENT transport → rejected (orphaned).
    const orphan = await svc().from(RECEIPTS).insert({
      transport_id: crypto.randomUUID(),
      reply_audit_id: auditId,
      org_id: orgId,
      employee_slug: EMPLOYEE_SLUG,
      channel: "sms",
      provider: "twilio",
      provider_message_id: providerMessageId,
      status: "delivered",
      correlation_id: crypto.randomUUID(),
    });
    expect(orphan.error, "a receipt against a missing transport must be rejected").not.toBeNull();

    // (b) A receipt naming a message id its transport never carried → rejected (dishonest).
    const wrongId = await svc().from(RECEIPTS).insert({
      transport_id: transportId,
      reply_audit_id: auditId,
      org_id: orgId,
      employee_slug: EMPLOYEE_SLUG,
      channel: "sms",
      provider: "twilio",
      provider_message_id: `SM-mismatch-${crypto.randomUUID()}`,
      status: "delivered",
      correlation_id: crypto.randomUUID(),
    });
    expect(wrongId.error, "a receipt with a mismatched message id must be rejected").not.toBeNull();

    // (c) A receipt whose org disagrees with the transport's → rejected (cross-tenant).
    const wrongOrg = await svc().from(RECEIPTS).insert({
      transport_id: transportId,
      reply_audit_id: auditId,
      org_id: crypto.randomUUID(), // ← not the transport's org
      employee_slug: EMPLOYEE_SLUG,
      channel: "sms",
      provider: "twilio",
      provider_message_id: providerMessageId,
      status: "delivered",
      correlation_id: crypto.randomUUID(),
    });
    expect(wrongOrg.error, "a cross-tenant receipt must be rejected").not.toBeNull();

    // None of the three dishonest inserts were filed.
    expect(await receiptsForMessageId(providerMessageId)).toHaveLength(0);
  });

  it("is service-role-only (RLS:hq) — anon cannot read, insert, or call the write RPC", async () => {
    const { orgId, auditId, transportId, providerMessageId } = await seedSend();
    const result = await recordSmsDeliveryReceipt({ providerMessageId, status: "delivered" });
    expect(result.recorded).toBe(true);
    if (!result.recorded) throw new Error("unreachable");

    // service_role (BYPASSRLS) sees the row…
    const asService = await svc().from(RECEIPTS).select("id").eq("id", result.receipt_id);
    expect(asService.error, asService.error?.message).toBeNull();
    expect(asService.data).toHaveLength(1);

    // …anon does not (RLS enabled, zero policies → deny).
    expectAnonDenied(await anon().from(RECEIPTS).select("id").eq("id", result.receipt_id));

    // anon cannot call the SECURITY DEFINER write function — EXECUTE is service_role-only.
    const anonRpc = await anon().rpc<unknown>(RECEIPT_RPC, {
      p_provider_message_id: providerMessageId,
      p_status: "failed",
    });
    expect(anonRpc.error, "anon must not be able to file a receipt").not.toBeNull();

    // anon cannot write around the RPC with a direct insert either.
    const anonInsert = await anon().from(RECEIPTS).insert({
      transport_id: transportId,
      reply_audit_id: auditId,
      org_id: orgId,
      employee_slug: EMPLOYEE_SLUG,
      channel: "sms",
      provider: "twilio",
      provider_message_id: providerMessageId,
      status: "failed",
      correlation_id: crypto.randomUUID(),
    });
    expect(anonInsert.error, "anon must not be able to insert into the ledger").not.toBeNull();

    // Only the one service-recorded receipt exists — no anon write leaked through.
    expect(await receiptsForMessageId(providerMessageId)).toHaveLength(1);
  });
});
