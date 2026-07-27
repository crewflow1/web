import { afterAll, expect, it } from "vitest";
import { describeIntegration, serviceClient } from "../_harness";
import { enforceAndAuditReply } from "@/server/services/receptionist";
import {
  claimReviewConversation,
  getReviewItem,
  getReviewQueueItem,
  isPendingReview,
  listReviewQueue,
  releaseReviewConversation,
  resolveReviewDismiss,
  resolveReviewSend,
} from "@/server/services/receptionist-review";

/**
 * Reply Review Inbox · human-handoff pipeline — real-Postgres proof of the AI Receptionist
 * Programme R14 (HUMAN HANDOFF & REPLY REVIEW INBOX).
 *
 * R3's policy defers every `review` reply to a human ("the AI drafts, a HUMAN sends"); R4 files it
 * as an `ai_reply_audits` row (verdict='review', allowed=false) that then STOPS at the deny-by-
 * default gate. R14 completes that half: a projection surfaces the held reply, a human owns it,
 * reviews the reconstructed conversation, optionally edits, and SENDS through the EXISTING canonical
 * pipeline — or dismisses. The unit tier pins the pure presentation fold; this tier proves the
 * BEHAVIOUR the mocks can't — that when the orchestration service actually runs against Postgres,
 * the directive's required evidence holds end to end:
 *
 *   (1) REVIEW DECISIONS ENTER THE INBOX — a review-verdict audit surfaces in the queue as PENDING,
 *       and the inbox is the CANONICAL CONSUMER of the conversation engine: it reconstructs the held
 *       reply's whole thread through R11's `reconstructConversation`, with the held reply itself
 *       carried in the timeline at verdict='review'.
 *   (2) ALLOWED REPLIES BYPASS THE INBOX — an allow-verdict audit never enters the queue at all
 *       (the projection is `where verdict = 'review'`); the autonomous path is untouched.
 *   (3) HUMAN EDITS ARE AUDITABLE — a send of EDITED text writes a FRESH `ai_reply_audits` row whose
 *       draft IS the edited text (verbatim), stamped with the reviewer + the automatic verdict + the
 *       held reply, and the resolution ledger flags `edited = true`.
 *   (4) HUMAN SENDS GO THROUGH EXISTING TRANSPORT — the send rides the SAME `ai_reply_transports`
 *       ledger through the SAME DB gate (degrading to failed/no_provider in CI, but a real transport
 *       row, keyed by the held reply, produced by the human-reviewed seam).
 *   (5) THE ABSOLUTE BLOCK IS UNBYPASSABLE — a `block` text is refused even for a human: audited
 *       (verdict='block', allowed=false), transported NOTHING, and the item stays PENDING (it can
 *       only be dismissed, never sent).
 *   (6) DISMISS SENDS NOTHING — a dismissal records the human decision with no transport and no new
 *       reply audit.
 *   (7) RESOLUTION IS TERMINAL — a held reply resolves exactly once; a second resolve is
 *       `already_resolved` and writes no second ledger row (the double-send guard).
 *   (8) OWNERSHIP IS ORG-SCOPED — a claim can only ever target a conversation in the org it names;
 *       naming a foreign org matches nothing.
 *
 * No new send path exists: every send here flows Enforce → Audit → Transport via the R14
 * `dispatchHumanReviewedReply` seam. In the CI environment no SMS provider is configured, so a
 * cleared send degrades to a recorded `failed`/`no_provider` transport (no vendor call) — the same
 * graceful degradation R5/R6 run; a human clearing the review changes WHETHER the send is attempted,
 * never how it degrades without a vendor.
 *
 * Runs only against a live DB (describeIntegration): skipped locally with no database, FAILED loudly
 * in CI if the database is missing. The append-only audit/transport/resolution ledgers cannot be
 * deleted and are intentionally left behind (harmless in the ephemeral CI database); the seeded orgs
 * — cascading conversations, messages, enquiries and leads — are dropped in afterAll, and the minted
 * reviewer users are removed. Rows are addressed by per-test org ids so each assertion sees only its
 * own.
 */

// The reply ledgers, the review resolution ledger, the queue view and their record_* primitives are
// service-role-only internals and are NOT in the generated Database types. Cast to the minimal
// surface this suite exercises (the same `as unknown as` convention the R5/R6 suites use) rather
// than reaching for `any`.
type Res<T> = { data: T | null; error: { message: string } | null };
type Thenable<T> = PromiseLike<Res<T>>;
interface Selectable<T> extends Thenable<T[]> {
  eq(column: string, value: unknown): Selectable<T>;
  limit(count: number): Selectable<T>;
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

const EMPLOYEE_SLUG = "voice-receptionist-ai";
const AUDITS = "ai_reply_audits";
const TRANSPORTS = "ai_reply_transports";
const RESOLUTIONS = "receptionist_review_resolutions";
const ENQUIRIES = "inbound_enquiries";

// Canonical policy drafts (the exact strings the R3 policy suite pins), each seeded and its verdict
// re-asserted at seed time so a policy drift fails LOUDLY here rather than mysteriously downstream.
//   • REVIEW — a price commitment the policy holds for a human.
const REVIEW_DRAFT = "Sure, that'll cost £450 including VAT.";
//   • An EDITED review the human sends instead — still not a prohibited claim, so it clears review.
const EDITED_DRAFT = "Happy to help — I'll get a written quote over to you shortly.";
//   • ALLOW — a clean acknowledgement that never needs a human (proves the bypass).
const ALLOW_DRAFT = "Thanks for your message — a member of the team will get back to you shortly.";
//   • BLOCK — an absolute safety claim; never sendable, not even by a human.
const BLOCK_DRAFT = "Don't worry, your gas boiler is completely safe.";

const INBOUND_TEXT = "Hi, how much to service my boiler?";
const CONTACT = "+447700900123";

const createdOrgs: string[] = [];
const createdUsers: string[] = [];

/** Stand up a real organisation the service can write against, tracked for teardown. */
async function freshOrg(): Promise<string> {
  const slug = `it-r14-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const res = await svc()
    .from("organizations")
    .insert({ name: "R14 Review Inbox Org", slug })
    .select("id")
    .single();
  expect(res.error, res.error?.message).toBeNull();
  const id = String((res.data as { id: string }).id);
  createdOrgs.push(id);
  return id;
}

/** Mint an auth user + mirror it into public.users so an `assignee_id` FK is satisfiable. */
async function freshUser(): Promise<string> {
  const email = `it-r14-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@probe.crewflow.test`;
  const created = await serviceClient().auth.admin.createUser({
    email,
    password: `Pw!${Math.random().toString(36).slice(2)}${Date.now()}`,
    email_confirm: true,
  });
  expect(created.error, created.error?.message).toBeNull();
  const id = created.data.user?.id;
  if (!id) throw new Error("could not mint the reviewer auth user");
  const mirrored = await svc().from("users").insert({ id, email }).select("id").single();
  expect(mirrored.error, mirrored.error?.message).toBeNull();
  createdUsers.push(id);
  return id;
}

/** Resolve a real conversation container (the R10 identity resolver), returning its id. */
async function freshConversation(orgId: string): Promise<string> {
  const res = await svc().rpc<string>("resolve_receptionist_conversation", {
    p_org_id: orgId,
    p_employee_slug: EMPLOYEE_SLUG,
    p_channel: "sms",
    p_contact_ref: CONTACT,
    p_contact_name: "Boiler Prospect",
  });
  expect(res.error, res.error?.message).toBeNull();
  return res.data as string;
}

/** Append one timeline entry through the R10 threading writer. */
async function appendMessage(args: {
  conversationId: string;
  orgId: string;
  direction: "inbound" | "outbound";
  enquiryId?: string | null;
  auditId?: string | null;
}): Promise<void> {
  const res = await svc().rpc("append_receptionist_message", {
    p_conversation_id: args.conversationId,
    p_org_id: args.orgId,
    p_direction: args.direction,
    p_channel: "sms",
    p_enquiry_id: args.enquiryId ?? null,
    p_audit_id: args.auditId ?? null,
  });
  expect(res.error, res.error?.message).toBeNull();
}

/**
 * Seed one reply audit through the CANONICAL audit path (not a raw insert), re-asserting its verdict
 * so a policy drift fails loudly at seed time. Returns the new audit id. Threads the conversation +
 * customer so the queue can resolve the container and the send has a destination.
 */
async function seedAudit(
  orgId: string,
  draft: string,
  expectVerdict: "review" | "allow" | "block",
  opts: { conversationId?: string | null; enquiryId?: string | null } = {},
): Promise<string> {
  const outcome = await enforceAndAuditReply({
    org_id: orgId,
    channel: "sms",
    conversation_id: opts.conversationId ?? null,
    enquiry_id: opts.enquiryId ?? null,
    customer_ref: CONTACT,
    correlation_id: crypto.randomUUID(),
    draft,
  });
  expect(outcome.decision.verdict, `seed draft must classify as ${expectVerdict}`).toBe(
    expectVerdict,
  );
  return outcome.audit_id;
}

/** All audit rows for one org. */
async function auditsForOrg(orgId: string): Promise<Record<string, unknown>[]> {
  const res = await svc()
    .from(AUDITS)
    .select("id, verdict, allowed, draft, conversation_id, customer_ref, metadata")
    .eq("org_id", orgId);
  expect(res.error, res.error?.message).toBeNull();
  return res.data ?? [];
}

/** All transport rows for one org. */
async function transportsForOrg(orgId: string): Promise<Record<string, unknown>[]> {
  const res = await svc()
    .from(TRANSPORTS)
    .select("id, reply_audit_id, status, failure_reason, dedup_key, to_ref, metadata")
    .eq("org_id", orgId);
  expect(res.error, res.error?.message).toBeNull();
  return res.data ?? [];
}

/** All resolution rows for one held reply. */
async function resolutionsFor(reviewAuditId: string): Promise<Record<string, unknown>[]> {
  const res = await svc()
    .from(RESOLUTIONS)
    .select("id, resolution, sent_audit_id, edited, resolved_by, resolved_by_email, note")
    .eq("review_audit_id", reviewAuditId);
  expect(res.error, res.error?.message).toBeNull();
  return res.data ?? [];
}

/** One audit row by id, or null. */
async function auditById(id: string): Promise<Record<string, unknown> | null> {
  const res = await svc()
    .from(AUDITS)
    .select("id, verdict, allowed, draft, metadata")
    .eq("id", id)
    .limit(1);
  expect(res.error, res.error?.message).toBeNull();
  return (res.data ?? [])[0] ?? null;
}

describeIntegration("Reply Review Inbox · human-handoff pipeline (R14)", () => {
  afterAll(async () => {
    for (const id of createdOrgs) {
      await svc().from("organizations").delete().eq("id", id);
    }
    for (const id of createdUsers) {
      await serviceClient().auth.admin.deleteUser(id);
    }
  });

  it("(1) a review-verdict reply ENTERS the queue as PENDING, reconstructed through the conversation engine", async () => {
    const orgId = await freshOrg();
    const conversationId = await freshConversation(orgId);

    // A real inbound message at the head of the thread…
    const ins = await svc()
      .from(ENQUIRIES)
      .insert({
        org_id: orgId,
        channel: "sms",
        caller: CONTACT,
        raw_text: INBOUND_TEXT,
        status: "received",
        conversation_id: conversationId,
      })
      .select("id")
      .single();
    expect(ins.error, ins.error?.message).toBeNull();
    const enquiryId = String((ins.data as { id: string }).id);
    await appendMessage({ conversationId, orgId, direction: "inbound", enquiryId });

    // …answered by a draft the policy HELD for review, threaded into the same conversation.
    const reviewAuditId = await seedAudit(orgId, REVIEW_DRAFT, "review", {
      conversationId,
      enquiryId,
    });
    await appendMessage({ conversationId, orgId, direction: "outbound", auditId: reviewAuditId });

    // It surfaces in the org's queue as exactly one PENDING held reply.
    const queue = await listReviewQueue({ org_id: orgId });
    expect(queue).toHaveLength(1);
    const item = queue[0]!;
    expect(item.review_audit_id).toBe(reviewAuditId);
    expect(item.draft).toBe(REVIEW_DRAFT);
    expect(item.conversation_id).toBe(conversationId);
    expect(item.contact_ref).toBe(CONTACT); // resolved from the container
    expect(item.resolution_id, "an unresolved held reply is pending").toBeNull();
    expect(isPendingReview(item)).toBe(true);

    // CANONICAL CONSUMER: the inbox reconstructs the WHOLE thread through R11 — the held reply is
    // carried in the timeline at verdict='review', beneath the inbound message it answers.
    const detail = await getReviewItem({ review_audit_id: reviewAuditId });
    expect(detail).not.toBeNull();
    const recon = detail!.conversation;
    expect(recon, "the held reply's conversation is reconstructed").not.toBeNull();
    const inbound = recon!.timeline.find((e) => e.direction === "inbound");
    const outbound = recon!.timeline.find((e) => e.direction === "outbound");
    expect(inbound?.inbound_text).toBe(INBOUND_TEXT);
    expect(outbound?.outbound_draft).toBe(REVIEW_DRAFT);
    expect(outbound?.outbound_verdict).toBe("review");
  });

  it("(2) an allow-verdict reply NEVER enters the queue — allowed replies bypass the inbox", async () => {
    const orgId = await freshOrg();
    const conversationId = await freshConversation(orgId);

    // A clean acknowledgement — the autonomous path's bread and butter.
    const allowAuditId = await seedAudit(orgId, ALLOW_DRAFT, "allow", { conversationId });

    // The queue projects ONLY held replies (verdict='review'); the allow audit is invisible to it.
    const queue = await listReviewQueue({ org_id: orgId });
    expect(queue, "an allow reply never surfaces for human review").toHaveLength(0);
    expect(await getReviewQueueItem({ review_audit_id: allowAuditId })).toBeNull();
  });

  it("(3)+(4) a human SEND with an EDIT rides the canonical pipeline: fresh ALLOWED audit (draft = edited text) + a transport row + a 'sent' resolution flagged edited", async () => {
    const orgId = await freshOrg();
    const conversationId = await freshConversation(orgId);
    const reviewAuditId = await seedAudit(orgId, REVIEW_DRAFT, "review", { conversationId });
    const reviewer = crypto.randomUUID(); // resolved_by is an un-FK'd durable fact

    const result = await resolveReviewSend({
      review_audit_id: reviewAuditId,
      text: EDITED_DRAFT, // the human changed the proposed draft before sending
      reviewed_by: reviewer,
      reviewed_by_email: "operator@crewflow.test",
    });

    expect(result.ok, result.ok ? "" : `send failed: ${result.reason}`).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.edited, "the send is flagged as an edit").toBe(true);
    const sentAuditId = result.outcome.audit_id!;

    // (3) A FRESH allowed audit whose draft IS the edited text — the human is the authority that
    //     cleared the review; the original review audit is untouched.
    expect(sentAuditId).not.toBe(reviewAuditId);
    const sent = await auditById(sentAuditId);
    expect(sent?.verdict).toBe("allow");
    expect(sent?.allowed).toBe(true);
    expect(sent?.draft, "the sent audit carries the edited text verbatim").toBe(EDITED_DRAFT);
    // Provenance is complete: the reviewer, the held reply this resolves, and the classifier's
    // verdict on the FINAL (edited) text — here the human softened a price commitment into a clean
    // acknowledgement, so the sent text classifies `allow` while `review_audit_id` still links back
    // to the original `review` the human cleared.
    expect(sent?.metadata).toMatchObject({
      producer: "human_reviewed_send",
      reviewed_by: reviewer,
      review_audit_id: reviewAuditId,
      automatic_verdict: "allow",
    });

    // (4) The send rode the SAME transport ledger, keyed by the held reply, via the human seam
    //     (degrading to failed/no_provider in CI — a real recorded attempt, no vendor call).
    const transports = await transportsForOrg(orgId);
    expect(transports, "exactly one transport for the human send").toHaveLength(1);
    const t = transports[0]!;
    expect(t.reply_audit_id).toBe(sentAuditId);
    expect(t.dedup_key, "the held reply is the idempotency key").toBe(reviewAuditId);
    expect(t.status).toBe("failed");
    expect(t.failure_reason).toBe("no_provider");
    expect(t.metadata).toMatchObject({ producer: "human_reviewed_send" });

    // The resolution ledger records the human decision — sent, by whom, pointing at the new audit,
    // flagged edited.
    const resolutions = await resolutionsFor(reviewAuditId);
    expect(resolutions).toHaveLength(1);
    expect(resolutions[0]).toMatchObject({
      resolution: "sent",
      sent_audit_id: sentAuditId,
      edited: true,
      resolved_by: reviewer,
      resolved_by_email: "operator@crewflow.test",
    });

    // The held reply is no longer pending; the queue now shows it resolved.
    const item = await getReviewQueueItem({ review_audit_id: reviewAuditId });
    expect(item, "the held reply row still exists").not.toBeNull();
    expect(isPendingReview(item!)).toBe(false);
    expect(item!.resolution).toBe("sent");
    expect(item!.resolution_edited).toBe(true);
  });

  it("(4) a human SEND VERBATIM records edited=false and still produces a fresh allowed audit + transport", async () => {
    const orgId = await freshOrg();
    const conversationId = await freshConversation(orgId);
    const reviewAuditId = await seedAudit(orgId, REVIEW_DRAFT, "review", { conversationId });

    const result = await resolveReviewSend({
      review_audit_id: reviewAuditId,
      text: REVIEW_DRAFT, // sent exactly as proposed
      reviewed_by: crypto.randomUUID(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.edited, "an unchanged draft is not an edit").toBe(false);

    const sent = await auditById(result.outcome.audit_id!);
    expect(sent?.verdict).toBe("allow");
    expect(sent?.draft).toBe(REVIEW_DRAFT);
    expect(await transportsForOrg(orgId)).toHaveLength(1);
    const resolutions = await resolutionsFor(reviewAuditId);
    expect(resolutions).toHaveLength(1);
    expect(resolutions[0]?.edited).toBe(false);
  });

  it("(5) a BLOCK can never be sent, even by a human: refused, audited verdict=block, transported NOTHING, item stays pending", async () => {
    const orgId = await freshOrg();
    const conversationId = await freshConversation(orgId);
    const reviewAuditId = await seedAudit(orgId, REVIEW_DRAFT, "review", { conversationId });

    // The human tries to push a prohibited safety claim through the review door.
    const result = await resolveReviewSend({
      review_audit_id: reviewAuditId,
      text: BLOCK_DRAFT,
      reviewed_by: crypto.randomUUID(),
    });

    // Refused — the absolute prohibition holds for humans too.
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("blocked");

    // The refused attempt IS audited (deny-by-default), verdict='block', allowed=false, provenance
    // intact — but it transported nothing.
    const audits = await auditsForOrg(orgId);
    const blockAudit = audits.find((a) => a.verdict === "block");
    expect(blockAudit, "the refused human attempt is audited").toBeTruthy();
    expect(blockAudit?.allowed).toBe(false);
    expect(blockAudit?.metadata).toMatchObject({
      producer: "human_reviewed_send",
      review_audit_id: reviewAuditId,
    });
    expect(await transportsForOrg(orgId), "a block reaches no transport").toHaveLength(0);

    // The held reply is NOT resolved — it stays pending (it can only ever be dismissed now).
    expect(await resolutionsFor(reviewAuditId), "a block is refused, not resolved").toHaveLength(0);
    const item = await getReviewQueueItem({ review_audit_id: reviewAuditId });
    expect(isPendingReview(item!)).toBe(true);
  });

  it("(6) a DISMISS records the human decision, sends nothing, writes no new reply audit", async () => {
    const orgId = await freshOrg();
    const conversationId = await freshConversation(orgId);
    const reviewAuditId = await seedAudit(orgId, REVIEW_DRAFT, "review", { conversationId });
    const auditsBefore = (await auditsForOrg(orgId)).length; // the single held reply

    const reviewer = crypto.randomUUID();
    const result = await resolveReviewDismiss({
      review_audit_id: reviewAuditId,
      reviewed_by: reviewer,
      reviewed_by_email: "operator@crewflow.test",
      note: "Customer already called back.",
    });

    expect(result.ok).toBe(true);

    // No transport, and NO new reply audit — a dismissal is purely a ledger entry.
    expect(await transportsForOrg(orgId)).toHaveLength(0);
    expect(await auditsForOrg(orgId), "dismiss writes no new audit").toHaveLength(auditsBefore);

    const resolutions = await resolutionsFor(reviewAuditId);
    expect(resolutions).toHaveLength(1);
    expect(resolutions[0]).toMatchObject({
      resolution: "dismissed",
      sent_audit_id: null,
      edited: false,
      note: "Customer already called back.",
    });

    const item = await getReviewQueueItem({ review_audit_id: reviewAuditId });
    expect(isPendingReview(item!)).toBe(false);
    expect(item!.resolution).toBe("dismissed");
  });

  it("(7) resolution is TERMINAL: a second resolve of the same held reply is already_resolved and writes no second row", async () => {
    const orgId = await freshOrg();
    const conversationId = await freshConversation(orgId);
    const reviewAuditId = await seedAudit(orgId, REVIEW_DRAFT, "review", { conversationId });

    // First: a clean dismiss.
    const first = await resolveReviewDismiss({
      review_audit_id: reviewAuditId,
      reviewed_by: crypto.randomUUID(),
    });
    expect(first.ok).toBe(true);

    // Second: a concurrent reviewer tries to SEND the same held reply — rejected as already resolved
    // (the resolution ledger's UNIQUE(review_audit_id) is the backstop), with no send attempted.
    const second = await resolveReviewSend({
      review_audit_id: reviewAuditId,
      text: REVIEW_DRAFT,
      reviewed_by: crypto.randomUUID(),
    });
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error("unreachable");
    expect(second.reason).toBe("already_resolved");

    // Exactly one resolution, no transport — the second attempt changed nothing.
    expect(await resolutionsFor(reviewAuditId)).toHaveLength(1);
    expect(await transportsForOrg(orgId)).toHaveLength(0);
  });

  it("(8) conversation ownership is ORG-SCOPED: a claim only matches the naming org; release clears it", async () => {
    const orgA = await freshOrg();
    const orgB = await freshOrg();
    const conversationId = await freshConversation(orgA); // the conversation lives in org A
    const owner = await freshUser();

    // Naming the WRONG org matches nothing — a caller can never claim across the tenant boundary.
    const crossTenant = await claimReviewConversation({
      conversation_id: conversationId,
      org_id: orgB,
      assignee_id: owner,
      assigned_by: owner,
    });
    expect(crossTenant, "a foreign org cannot claim the conversation").toBe(false);

    // Naming the RIGHT org takes ownership.
    const claimed = await claimReviewConversation({
      conversation_id: conversationId,
      org_id: orgA,
      assignee_id: owner,
      assigned_by: owner,
    });
    expect(claimed).toBe(true);

    const owned = await svc()
      .from("receptionist_conversations")
      .select("assignee_id, assigned_by")
      .eq("id", conversationId)
      .single();
    expect(owned.error, owned.error?.message).toBeNull();
    expect((owned.data as { assignee_id: string }).assignee_id).toBe(owner);

    // Release clears the ownership stamp.
    const released = await releaseReviewConversation({
      conversation_id: conversationId,
      org_id: orgA,
    });
    expect(released).toBe(true);
    const after = await svc()
      .from("receptionist_conversations")
      .select("assignee_id, assigned_at, assigned_by")
      .eq("id", conversationId)
      .single();
    expect(after.error, after.error?.message).toBeNull();
    expect((after.data as { assignee_id: string | null }).assignee_id).toBeNull();
  });
});
