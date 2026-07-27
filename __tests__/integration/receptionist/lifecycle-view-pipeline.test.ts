import { expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient } from "../_harness";

/**
 * Delivery-monitoring read model — real-Postgres proof of the AI Receptionist Programme R9
 * (DELIVERY MONITORING — OPERATOR VISIBILITY).
 *
 * R4–R7 built the outbound lifecycle as three append-only ledgers: `ai_reply_audits`
 * (every reply + its enforcement verdict), `ai_reply_transports` (every send attempt) and
 * `ai_reply_delivery_receipts` (the provider's async terminal fate). R9 adds a READ-ONLY
 * view, `ai_reply_lifecycle`, that folds audit ⟕ transport ⟕ latest-receipt into one row so
 * an HQ operator can see, for any reply, the whole chain. The unit tier pins the pure
 * stage/filter fold; the security tier proves, as a matter of SOURCE, that the migration is
 * a projection with no write path and the pages add no send. This tier proves the
 * BEHAVIOUR the others can't — that when the view actually runs against Postgres the
 * directive's monitoring guarantees hold end to end:
 *
 *   (1) CORRECT JOIN — an allowed reply that was sent and delivered surfaces as ONE row
 *       carrying its audit, its transport and its terminal receipt together.
 *   (2) MISSING RECEIPT IS A VISIBLE ABSENCE — a sent transport the provider hasn't
 *       reported on yet appears with NULL delivery_* and receipt_count 0, never hidden.
 *   (3) FAILED TRANSPORT IS VISIBLE WITH ITS CAUSE — a failed send appears with
 *       transport_status='failed', its failure_reason, no provider message id, no receipt.
 *   (4) HELD / BLOCKED REPLIES ARE VISIBLE WITHOUT A TRANSPORT — a blocked or
 *       review-required reply (allowed=false, so the enforcement gate forbids a transport)
 *       still appears, its transport_* and delivery_* all NULL.
 *   (5) MOST-SIGNIFICANT RECEIPT — when several receipts exist for one send the view
 *       surfaces the terminal one over an earlier interim, and counts them all.
 *   (6) TENANT-SCOPED — a query for one org returns only that org's replies.
 *
 * And the read-only invariant the migration promises: the view is NOT writable — an
 * UPDATE / DELETE / INSERT through `ai_reply_lifecycle` is rejected by Postgres itself
 * (a multi-relation join is not auto-updatable and no INSTEAD OF trigger exists), and it is
 * readable ONLY by service_role (SELECT revoked from anon; base-table RLS denies JWT
 * clients through the view). The read model can observe the ledgers; it can never mutate
 * them, and it opens no new write path.
 *
 * Runs only against a live DB (describeIntegration): skipped locally with no database,
 * FAILED loudly in CI if the database is missing. The ledgers are append-only, so these
 * tests intentionally leave their rows behind — harmless in the ephemeral CI database. Each
 * assertion seeds its own org (a fresh uuid) so it sees only its own writes.
 */

// The receptionist ledgers, their record_* primitives and the ai_reply_lifecycle view are
// service-role-only internals, NOT in the generated Database types. Cast to the minimal
// surface this suite exercises (the same `as unknown as` convention the ledger suites use)
// rather than reaching for `any`.
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

const VIEW = "ai_reply_lifecycle";
const AUDIT_RPC = "record_ai_reply_audit";
const TRANSPORT_RPC = "record_ai_reply_transport";
const RECEIPT_RPC = "record_ai_reply_delivery_receipt";
const EMPLOYEE_SLUG = "voice-receptionist-ai";

const svc = (): LedgerClient => serviceClient() as unknown as LedgerClient;
const anon = (): LedgerClient => anonClient() as unknown as LedgerClient;

const ALLOW_DRAFT = "Thanks for your message — a member of the team will be in touch shortly.";

/** The lifecycle columns this suite reads (a subset of the view's 33). */
const VIEW_COLUMNS =
  "audit_id, org_id, correlation_id, verdict, allowed, enforcement_reason, " +
  "transport_id, transport_status, transport_failure_reason, provider_message_id, " +
  "receipt_id, delivery_status, delivery_terminal, delivery_error_code, receipt_count";

/** Seed an audit with an explicit verdict through the canonical write primitive. */
async function seedAudit(args: {
  orgId: string;
  verdict: "allow" | "review" | "block";
  allowed: boolean;
  reason: string;
}): Promise<string> {
  const res = await svc().rpc<string>(AUDIT_RPC, {
    p_org_id: args.orgId,
    p_employee_slug: EMPLOYEE_SLUG,
    p_channel: "sms",
    p_correlation_id: crypto.randomUUID(),
    p_draft: ALLOW_DRAFT,
    p_verdict: args.verdict,
    p_allowed: args.allowed,
    p_reason: args.reason,
  });
  expect(res.error, res.error?.message).toBeNull();
  expect(res.data, "seeded audit must return an id").toBeTruthy();
  return res.data as string;
}

/** File a SENT transport (mints a unique provider message id — the receipt correlation key). */
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
  });
  expect(res.error, res.error?.message).toBeNull();
  expect(res.data, "seeded sent transport must return an id").toBeTruthy();
  return { transportId: res.data as string, providerMessageId };
}

/** File a FAILED transport — no provider, no message id, a recorded failure reason. */
async function seedFailedTransport(args: {
  auditId: string;
  orgId: string;
  reason: string;
}): Promise<string> {
  const res = await svc().rpc<string>(TRANSPORT_RPC, {
    p_reply_audit_id: args.auditId,
    p_org_id: args.orgId,
    p_employee_slug: EMPLOYEE_SLUG,
    p_channel: "sms",
    p_to_ref: "+447700900000",
    p_status: "failed",
    p_correlation_id: crypto.randomUUID(),
    p_provider: null,
    p_provider_message_id: null,
    p_failure_reason: args.reason,
  });
  expect(res.error, res.error?.message).toBeNull();
  return res.data as string;
}

/** Record a delivery receipt against a sent transport's provider message id. */
async function recordReceipt(args: {
  providerMessageId: string;
  status: string;
  errorCode?: string;
}): Promise<void> {
  const res = await svc().rpc(RECEIPT_RPC, {
    p_provider_message_id: args.providerMessageId,
    p_status: args.status,
    p_error_code: args.errorCode ?? null,
  });
  expect(res.error, res.error?.message).toBeNull();
}

/** The lifecycle rows for one org, read through the view as service_role. */
async function lifecycleForOrg(orgId: string): Promise<Record<string, unknown>[]> {
  const res = await svc().from(VIEW).select(VIEW_COLUMNS).eq("org_id", orgId);
  expect(res.error, res.error?.message).toBeNull();
  return res.data ?? [];
}

/** The single lifecycle row for one audit, or throw. */
async function rowForAudit(orgId: string, auditId: string): Promise<Record<string, unknown>> {
  const rows = (await lifecycleForOrg(orgId)).filter((r) => r.audit_id === auditId);
  expect(rows, `exactly one lifecycle row for audit ${auditId}`).toHaveLength(1);
  return rows[0] as Record<string, unknown>;
}

/** Denial is valid whether it arrives as a privilege error or an RLS-filtered empty set. */
function expectAnonDenied(res: RpcResult<Record<string, unknown>[]>): void {
  if (res.error) return;
  expect(res.data ?? []).toHaveLength(0);
}

describeIntegration("Delivery-monitoring read model · ai_reply_lifecycle (R9)", () => {
  it("folds audit → transport → terminal receipt into ONE row (demonstration 1)", async () => {
    const orgId = crypto.randomUUID();
    const auditId = await seedAudit({ orgId, verdict: "allow", allowed: true, reason: "clean" });
    const { transportId, providerMessageId } = await seedSentTransport({ auditId, orgId });
    await recordReceipt({ providerMessageId, status: "delivered" });

    const row = await rowForAudit(orgId, auditId);
    // The audit facts…
    expect(row.verdict).toBe("allow");
    expect(row.allowed).toBe(true);
    // …joined to the transport…
    expect(row.transport_id).toBe(transportId);
    expect(row.transport_status).toBe("sent");
    expect(row.provider_message_id).toBe(providerMessageId);
    // …joined to its terminal receipt…
    expect(row.receipt_id).toBeTruthy();
    expect(row.delivery_status).toBe("delivered");
    expect(row.delivery_terminal).toBe(true);
    // …with the full receipt count rolled up.
    expect(row.receipt_count).toBe(1);
  });

  it("shows a sent-but-unreported send as a VISIBLE missing receipt (demonstration 2)", async () => {
    const orgId = crypto.randomUUID();
    const auditId = await seedAudit({ orgId, verdict: "allow", allowed: true, reason: "clean" });
    const { transportId } = await seedSentTransport({ auditId, orgId });
    // Deliberately record NO receipt — the provider hasn't called back yet.

    const row = await rowForAudit(orgId, auditId);
    expect(row.transport_id).toBe(transportId);
    expect(row.transport_status).toBe("sent");
    // The absence is explicit, not a hidden row: delivery_* are NULL, the count is 0.
    expect(row.receipt_id).toBeNull();
    expect(row.delivery_status).toBeNull();
    expect(row.delivery_terminal).toBeNull();
    expect(row.receipt_count).toBe(0);
  });

  it("shows a FAILED transport with its cause and no receipt (demonstration 3)", async () => {
    const orgId = crypto.randomUUID();
    const auditId = await seedAudit({ orgId, verdict: "allow", allowed: true, reason: "clean" });
    const transportId = await seedFailedTransport({ auditId, orgId, reason: "no_provider" });

    const row = await rowForAudit(orgId, auditId);
    expect(row.transport_id).toBe(transportId);
    expect(row.transport_status).toBe("failed");
    expect(row.transport_failure_reason).toBe("no_provider");
    // A failed send never reached the provider, so it carries no message id and no receipt.
    expect(row.provider_message_id).toBeNull();
    expect(row.receipt_id).toBeNull();
    expect(row.delivery_status).toBeNull();
    expect(row.receipt_count).toBe(0);
  });

  it("shows a BLOCKED reply even though it never acquired a transport (demonstration 4)", async () => {
    const orgId = crypto.randomUUID();
    const auditId = await seedAudit({
      orgId,
      verdict: "block",
      allowed: false,
      reason: "pii_detected",
    });

    const row = await rowForAudit(orgId, auditId);
    expect(row.verdict).toBe("block");
    expect(row.allowed).toBe(false);
    expect(row.enforcement_reason).toBe("pii_detected");
    // The enforcement gate forbids a transport for a non-allowed reply — so the chain is
    // audit-only, and the view still surfaces it (transport_* / delivery_* all NULL).
    expect(row.transport_id).toBeNull();
    expect(row.transport_status).toBeNull();
    expect(row.receipt_id).toBeNull();
    expect(row.receipt_count).toBe(0);
  });

  it("shows a REVIEW-required reply with no transport (demonstration 4, held branch)", async () => {
    const orgId = crypto.randomUUID();
    const auditId = await seedAudit({
      orgId,
      verdict: "review",
      allowed: false,
      reason: "manual_review",
    });

    const row = await rowForAudit(orgId, auditId);
    expect(row.verdict).toBe("review");
    expect(row.allowed).toBe(false);
    expect(row.transport_id).toBeNull();
    expect(row.receipt_id).toBeNull();
  });

  it("surfaces the MOST SIGNIFICANT receipt — terminal over interim — and counts all", async () => {
    const orgId = crypto.randomUUID();
    const auditId = await seedAudit({ orgId, verdict: "allow", allowed: true, reason: "clean" });
    const { providerMessageId } = await seedSentTransport({ auditId, orgId });

    // An interim status, then the terminal one — order of arrival must not matter.
    await recordReceipt({ providerMessageId, status: "queued" });
    await recordReceipt({ providerMessageId, status: "delivered" });

    const row = await rowForAudit(orgId, auditId);
    // The lateral pick prefers the terminal receipt (terminal desc, created_at desc)…
    expect(row.delivery_status).toBe("delivered");
    expect(row.delivery_terminal).toBe(true);
    // …while the roll-up still reflects the full lifecycle depth.
    expect(row.receipt_count).toBe(2);
  });

  it("carries a terminal NON-delivery's error code through to the operator (demonstration 3)", async () => {
    const orgId = crypto.randomUUID();
    const auditId = await seedAudit({ orgId, verdict: "allow", allowed: true, reason: "clean" });
    const { providerMessageId } = await seedSentTransport({ auditId, orgId });
    await recordReceipt({ providerMessageId, status: "undelivered", errorCode: "30008" });

    const row = await rowForAudit(orgId, auditId);
    expect(row.delivery_status).toBe("undelivered");
    expect(row.delivery_terminal).toBe(true);
    expect(row.delivery_error_code).toBe("30008");
  });

  it("is TENANT-SCOPED — one org's query never returns another org's replies (demonstration 6)", async () => {
    const orgA = crypto.randomUUID();
    const orgB = crypto.randomUUID();
    const auditA = await seedAudit({ orgId: orgA, verdict: "allow", allowed: true, reason: "clean" });
    const auditB = await seedAudit({ orgId: orgB, verdict: "block", allowed: false, reason: "pii" });

    const rowsA = await lifecycleForOrg(orgA);
    const rowsB = await lifecycleForOrg(orgB);
    expect(rowsA.map((r) => r.audit_id)).toEqual([auditA]);
    expect(rowsB.map((r) => r.audit_id)).toEqual([auditB]);
    // No bleed either direction.
    expect(rowsA.every((r) => r.org_id === orgA)).toBe(true);
    expect(rowsB.every((r) => r.org_id === orgB)).toBe(true);
  });

  it("is NOT WRITABLE — UPDATE / DELETE / INSERT through the view are rejected", async () => {
    const orgId = crypto.randomUUID();
    const auditId = await seedAudit({ orgId, verdict: "allow", allowed: true, reason: "clean" });
    const { providerMessageId } = await seedSentTransport({ auditId, orgId });
    await recordReceipt({ providerMessageId, status: "delivered" });

    // A multi-relation join view is not auto-updatable and has no INSTEAD OF trigger, so
    // Postgres itself refuses every write verb through it.
    const updated = await svc()
      .from(VIEW)
      .update({ delivery_status: "failed" })
      .eq("audit_id", auditId);
    expect(updated.error, "UPDATE through the view must be rejected").not.toBeNull();

    const deleted = await svc().from(VIEW).delete().eq("audit_id", auditId);
    expect(deleted.error, "DELETE through the view must be rejected").not.toBeNull();

    const inserted = await svc().from(VIEW).insert({
      audit_id: crypto.randomUUID(),
      org_id: orgId,
      verdict: "allow",
      allowed: true,
    });
    expect(inserted.error, "INSERT through the view must be rejected").not.toBeNull();

    // The underlying ledger row is untouched — the delivered receipt still reads delivered.
    const row = await rowForAudit(orgId, auditId);
    expect(row.delivery_status).toBe("delivered");
    expect(row.delivery_terminal).toBe(true);
  });

  it("is READABLE ONLY by service_role — anon reads nothing through the view", async () => {
    const orgId = crypto.randomUUID();
    const auditId = await seedAudit({ orgId, verdict: "allow", allowed: true, reason: "clean" });

    // service_role (the HQ admin client) sees the row…
    const asService = await svc().from(VIEW).select("audit_id").eq("org_id", orgId);
    expect(asService.error, asService.error?.message).toBeNull();
    expect(asService.data?.map((r) => r.audit_id)).toEqual([auditId]);

    // …anon does not: SELECT is revoked from anon on the view, and the base-table RLS
    // (enabled, zero policies) denies it through the security_invoker view regardless.
    expectAnonDenied(await anon().from(VIEW).select("audit_id").eq("org_id", orgId));
  });
});
