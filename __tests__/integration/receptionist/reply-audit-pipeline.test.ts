import { expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient } from "../_harness";
import {
  enforceAndAuditReply,
  produceAndEnforceReply,
} from "@/server/services/receptionist";

/**
 * Reply Production & Audit pipeline — real-Postgres proof of the AI Receptionist
 * Programme R4 (REPLY PRODUCTION & AUDIT PIPELINE).
 *
 * The unit tier proves the pure producer's determinism and the security tier proves,
 * as a matter of SOURCE, that there is one write path and the audit is mandatory. This
 * tier proves the BEHAVIOUR the mocks can't — that when the CANONICAL SERVICE actually
 * runs its Draft → Enforce → Audit pass against a live database, the audit is really
 * written, and that the migration's storage, RLS, append-only guard, privilege model
 * and CHECK constraints all hold in Postgres ("mocks prove intent; real infrastructure
 * proves behaviour"). The load-bearing R4 claims are proven here:
 *
 *   • EVERY attempted reply creates EXACTLY ONE audit record — proven by driving the
 *     real service (`produceAndEnforceReply` / `enforceAndAuditReply`), not by calling
 *     the RPC directly, so the assertion is about the actual execution path.
 *   • EVERY verdict is audited — an `allow` (auto-sendable), a `review` (a held
 *     commitment) and a `block` (a refused prohibition) each leave a row that records
 *     the decision verbatim; a held or refused reply is NEVER recorded as auto-sent.
 *   • the ledger is APPEND-ONLY — UPDATE and DELETE are rejected even for service_role.
 *   • the ledger is SERVICE-ROLE-ONLY — anon cannot read it, insert into it, or call
 *     the SECURITY DEFINER write primitive (RLS:hq).
 *   • the database itself pins the verdict codomain and deny-by-default — a verdict
 *     outside {allow,review,block}, or an `allowed` that disagrees with the verdict, is
 *     rejected at the CHECK, so a stored row can never misrepresent a reply's fate.
 *
 * Runs only against a live DB (describeIntegration): skipped locally with no database,
 * FAILED loudly in CI if the database is missing. The ledger is append-only (even
 * service_role cannot DELETE), so these tests intentionally leave their rows behind —
 * harmless in the ephemeral CI database, and proving exactly that is one of the tests
 * below. Rows are addressed by a per-call correlation id so each assertion sees only
 * its own writes.
 */

// ai_reply_audits / record_ai_reply_audit are service-role-only internals and are NOT
// in the generated Database types. Cast to the minimal surface this suite exercises
// (the same `as unknown as` convention the executor-shadow suite uses) rather than
// reaching for `any`.
type RpcResult<T> = { data: T | null; error: { message: string } | null };
type Term<T> = PromiseLike<RpcResult<T>>;
type Filterable<T> = Term<T> & { eq(column: string, value: unknown): Term<T> };
type AuditTable = {
  select(columns?: string): Filterable<Record<string, unknown>[]>;
  insert(row: Record<string, unknown>): Filterable<null>;
  update(patch: Record<string, unknown>): Filterable<null>;
  delete(): Filterable<null>;
};
type AuditClient = {
  rpc<T = unknown>(fn: string, args: Record<string, unknown>): Term<T>;
  from(table: string): AuditTable;
};

const TABLE = "ai_reply_audits";
const RPC = "record_ai_reply_audit";

const svc = (): AuditClient => serviceClient() as unknown as AuditClient;
const anon = (): AuditClient => anonClient() as unknown as AuditClient;

// The columns every assertion below reads back — the full captured record.
const COLUMNS =
  "id, org_id, employee_slug, channel, enquiry_id, lead_id, customer_ref, " +
  "correlation_id, draft, verdict, allowed, categories, reason, safe_text, metadata";

/** Read every audit row filed under one correlation id, as service_role. */
function rowsFor(correlationId: string): Filterable<Record<string, unknown>[]> {
  return svc().from(TABLE).select(COLUMNS).eq("correlation_id", correlationId);
}

// Two pre-vetted drafts that deterministically exercise the non-`allow` verdicts of
// the harvested guardrail (lib/receptionist/policy.ts): a price COMMITMENT is held for
// review; an absolute SAFETY claim is refused (block). Neither is ever composed by the
// producer — they are supplied straight to `enforceAndAuditReply` to prove those fates
// are audited just as faithfully as an `allow`.
const REVIEW_DRAFT = "Sure, that'll cost £450 including VAT.";
const BLOCK_DRAFT = "Don't worry, your gas boiler is completely safe.";

/**
 * Assert an anon read obtained no row — denial being equally valid whether it arrives
 * as a hard privilege error or as an RLS-filtered empty set. A returned row is the only
 * failure.
 */
function expectAnonDenied(res: RpcResult<Record<string, unknown>[]>): void {
  if (res.error) return;
  expect(res.data ?? []).toHaveLength(0);
}

describeIntegration("Reply audit pipeline · ai_reply_audits (R4)", () => {
  it("produceAndEnforceReply writes EXACTLY ONE audit row and returns its real id (allow)", async () => {
    const correlationId = crypto.randomUUID();
    const orgId = crypto.randomUUID();

    // The full canonical pipeline: compose → enforce → audit.
    const outcome = await produceAndEnforceReply({
      org_id: orgId,
      channel: "phone",
      correlation_id: correlationId,
    });

    // The deterministic producer's voice acknowledgement is a clean `allow`.
    expect(outcome.decision.verdict).toBe("allow");
    expect(outcome.decision.allowed).toBe(true);
    expect(outcome.draft).toContain("Thanks for your call");

    // EXACTLY ONE row — not zero (unaudited), not two (double-written).
    const read = await rowsFor(correlationId);
    expect(read.error, read.error?.message).toBeNull();
    expect(read.data).toHaveLength(1);

    const row = read.data?.[0] ?? {};
    // The service's returned handle is the real stored row.
    expect(row.id).toBe(outcome.audit_id);
    // The decision is captured verbatim, stamped with the AI employee it concerns.
    expect(row.employee_slug).toBe("voice-receptionist-ai");
    expect(row.channel).toBe("phone");
    expect(row.org_id).toBe(orgId);
    expect(row.verdict).toBe("allow");
    expect(row.allowed).toBe(true);
    expect(row.categories).toEqual([]);
    expect(row.draft).toBe(outcome.draft);
    // An `allow` carries its auto-sendable remainder (the draft itself).
    expect(row.safe_text).toBe(outcome.draft.trim());
    // The producer path stamps its provenance into the execution metadata.
    expect(row.metadata).toMatchObject({ producer: "deterministic_acknowledgement" });
  });

  it("audits a REVIEW verdict — a held price commitment is recorded, never auto-sent", async () => {
    const correlationId = crypto.randomUUID();

    const outcome = await enforceAndAuditReply({
      org_id: crypto.randomUUID(),
      channel: "sms",
      correlation_id: correlationId,
      draft: REVIEW_DRAFT,
    });
    expect(outcome.decision.verdict).toBe("review");
    expect(outcome.decision.allowed).toBe(false);

    const read = await rowsFor(correlationId);
    expect(read.data).toHaveLength(1);
    const row = read.data?.[0] ?? {};
    expect(row.verdict).toBe("review");
    // DENY BY DEFAULT: a commitment is stored as NOT auto-sendable.
    expect(row.allowed).toBe(false);
    expect(row.categories).toEqual(["price"]);
    expect(row.draft).toBe(REVIEW_DRAFT);
  });

  it("audits a BLOCK verdict — a refused safety claim is still recorded, not auto-sent", async () => {
    const correlationId = crypto.randomUUID();

    const outcome = await enforceAndAuditReply({
      org_id: crypto.randomUUID(),
      channel: "whatsapp_msg",
      correlation_id: correlationId,
      draft: BLOCK_DRAFT,
    });
    expect(outcome.decision.verdict).toBe("block");
    expect(outcome.decision.allowed).toBe(false);

    const read = await rowsFor(correlationId);
    expect(read.data).toHaveLength(1);
    const row = read.data?.[0] ?? {};
    expect(row.verdict).toBe("block");
    expect(row.allowed).toBe(false);
    expect(row.categories).toEqual(["safety_claim"]);
    expect(row.draft).toBe(BLOCK_DRAFT);
  });

  it("captures the organisation, conversation, customer, correlation and metadata anchors", async () => {
    const correlationId = crypto.randomUUID();
    const orgId = crypto.randomUUID();
    const enquiryId = crypto.randomUUID();
    const leadId = crypto.randomUUID();

    const outcome = await enforceAndAuditReply({
      org_id: orgId,
      channel: "instagram_dm",
      correlation_id: correlationId,
      enquiry_id: enquiryId,
      lead_id: leadId,
      customer_ref: "@a.customer",
      metadata: { dedup_key: "ig-msg-42" },
      draft: "Thanks for your message — a member of the team will get back to you shortly.",
    });
    expect(outcome.decision.verdict).toBe("allow");

    const read = await rowsFor(correlationId);
    expect(read.data).toHaveLength(1);
    const row = read.data?.[0] ?? {};
    // Every anchor that threads the reply to who and what it concerns is stored.
    expect(row.org_id).toBe(orgId);
    expect(row.enquiry_id).toBe(enquiryId);
    expect(row.lead_id).toBe(leadId);
    expect(row.customer_ref).toBe("@a.customer");
    expect(row.correlation_id).toBe(correlationId);
    expect(row.metadata).toMatchObject({ dedup_key: "ig-msg-42" });
  });

  it("the ledger is append-only — UPDATE and DELETE are rejected even for service_role", async () => {
    const correlationId = crypto.randomUUID();
    const outcome = await produceAndEnforceReply({
      org_id: crypto.randomUUID(),
      channel: "phone",
      correlation_id: correlationId,
    });

    // A recorded verdict can never be rewritten to resemble something it is not…
    const updated = await svc()
      .from(TABLE)
      .update({ verdict: "block", reason: "tampered" })
      .eq("correlation_id", correlationId);
    expect(updated.error, "UPDATE must be blocked by the append-only guard").not.toBeNull();

    // …nor erased.
    const deleted = await svc().from(TABLE).delete().eq("correlation_id", correlationId);
    expect(deleted.error, "DELETE must be blocked by the append-only guard").not.toBeNull();

    // The row survived both attempts — still exactly one, unchanged.
    const read = await rowsFor(correlationId);
    expect(read.data).toHaveLength(1);
    expect(read.data?.[0]?.id).toBe(outcome.audit_id);
    expect(read.data?.[0]?.verdict).toBe("allow");
  });

  it("is service-role-only (RLS:hq) — anon cannot read, insert, or call the write RPC", async () => {
    const correlationId = crypto.randomUUID();
    await produceAndEnforceReply({
      org_id: crypto.randomUUID(),
      channel: "phone",
      correlation_id: correlationId,
    });

    // service_role (BYPASSRLS) sees the row…
    const asService = await rowsFor(correlationId);
    expect(asService.error, asService.error?.message).toBeNull();
    expect(asService.data).toHaveLength(1);

    // …anon does not (RLS enabled, zero policies → deny).
    expectAnonDenied(await anon().from(TABLE).select("id").eq("correlation_id", correlationId));

    // anon cannot call the SECURITY DEFINER write function — EXECUTE is service_role-only.
    const anonRpc = await anon().rpc<string>(RPC, {
      p_org_id: crypto.randomUUID(),
      p_employee_slug: "voice-receptionist-ai",
      p_channel: "phone",
      p_correlation_id: crypto.randomUUID(),
      p_draft: "x",
      p_verdict: "allow",
      p_allowed: true,
      p_reason: "test",
    });
    expect(anonRpc.error, "anon must not be able to file a reply audit").not.toBeNull();

    // anon cannot write around the RPC with a direct insert either.
    const anonInsert = await anon().from(TABLE).insert({
      org_id: crypto.randomUUID(),
      employee_slug: "voice-receptionist-ai",
      channel: "phone",
      correlation_id: crypto.randomUUID(),
      draft: "x",
      verdict: "allow",
      allowed: true,
      reason: "test",
    });
    expect(anonInsert.error, "anon must not be able to insert into the ledger").not.toBeNull();
  });

  it("the database pins the verdict codomain and deny-by-default — bad rows are rejected at the CHECK", async () => {
    // A verdict outside {allow,review,block} is rejected by the CHECK, even via the RPC.
    const badVerdict = await svc().rpc<string>(RPC, {
      p_org_id: crypto.randomUUID(),
      p_employee_slug: "voice-receptionist-ai",
      p_channel: "phone",
      p_correlation_id: crypto.randomUUID(),
      p_draft: "x",
      p_verdict: "maybe",
      p_allowed: false,
      p_reason: "test",
    });
    expect(badVerdict.error, "a verdict outside the guardrail codomain must be rejected").not.toBeNull();

    // `allowed = (verdict = 'allow')` in DDL: a row that calls a held reply auto-sendable
    // is rejected by the database itself — the ledger cannot record a lie. (A direct
    // service_role insert, to prove the guarantee is the DB's, not the RPC's.)
    const mismatch = await svc().from(TABLE).insert({
      org_id: crypto.randomUUID(),
      employee_slug: "voice-receptionist-ai",
      channel: "phone",
      correlation_id: crypto.randomUUID(),
      draft: "x",
      verdict: "review",
      allowed: true,
      reason: "test",
    });
    expect(mismatch.error, "allowed=true with a non-allow verdict must be rejected by the CHECK").not.toBeNull();
  });
});
