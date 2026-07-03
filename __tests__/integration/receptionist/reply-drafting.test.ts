import { afterAll, afterEach, expect, it, vi } from "vitest";
import { describeIntegration, serviceClient } from "../_harness";
import {
  dispatchReceptionistReply,
  processInboundEnquiry,
} from "@/server/services/receptionist";
import { getConversationContext } from "@/server/services/receptionist-conversation-context";

/**
 * Conversation-Aware Reply Drafting — real-Postgres proof of the AI Receptionist Programme R13
 * (CONVERSATION-AWARE REPLY DRAFTING).
 *
 * R4 shipped a FIXED acknowledgement composer; R13 replaces it with a conversation-aware draft
 * GENERATOR (server/services/receptionist-draft.ts::generateReplyDraft) that consumes ONLY the
 * canonical R12 context and reaches a model ONLY through the existing abstraction — WITHOUT widening
 * the pipeline. The unit tier pins the pure prompt builder and the generator's every leg with the
 * model + context MOCKED; the security tier proves, as a matter of SOURCE, that the draft is built
 * only from the canonical context, the provider reached only through the abstraction, and no new path
 * bypasses Enforce → Audit → Transport. This tier proves the BEHAVIOUR the others can't — that when
 * the CANONICAL SERVICE runs against Postgres, driven the way a real inbound webhook drives it
 * (`processInboundEnquiry`), the generator is wired in faithfully and the directive holds end to end.
 *
 * The proof turns on a single observable. In the CI environment NO LLM key is configured, so
 * getTextProvider() returns null and the generator DEGRADES to the deterministic acknowledgement —
 * byte-for-byte the reply R4 shipped — recording WHY on the draft's provenance, which the canonical
 * service folds verbatim into the mandatory `ai_reply_audits.metadata`. That `fallback_reason` is a
 * tight, positive witness of the whole R13 wiring:
 *
 *   • 'no_provider'     ⇒ a conversation id threaded ALL the way (processInboundEnquiry →
 *                         maybeTextBackMissedCall → dispatch → generator) AND the canonical R12
 *                         context was fetched and FOUND for it — only the absent CI provider stopped
 *                         a model draft. The end-to-end thread + context consumption, in one value.
 *   • 'no_context'      ⇒ the generator consulted the canonical context and it resolved to null under
 *                         the caller's org — R12's ORGANISATION SCOPE, inherited wholesale. A draft
 *                         can never be built from another tenant's conversation.
 *   • 'no_conversation' ⇒ the generator returned BEFORE any context fetch — a null thread carries no
 *                         canonical context to reason over.
 *
 * Every leg degrades to the SAME deterministic acknowledgement and NEVER throws, so generation is
 * total; and every generated draft still flows the ONE pipeline — composed → enforced (allow) →
 * audited → transported — no parallel path, no bypass.
 *
 * Runs only against a live DB (describeIntegration): skipped locally with no database, FAILED loudly
 * in CI if the database is missing. The audit/transport ledgers are append-only, so these tests
 * intentionally leave those rows behind (harmless in the ephemeral CI database); the seeded orgs —
 * cascading their enquiries and leads — are dropped in afterAll, and the un-FK'd admin_activity_log
 * rows are cleared by org id, exactly as the R6 suite does. Rows are addressed by per-test org ids so
 * each assertion sees only its own.
 */

// ai_reply_audits / ai_reply_transports are service-role-only internals and are NOT in the generated
// Database types. Cast to the minimal surface this suite exercises (the same `as unknown as`
// convention the R6/R12 suites use) rather than reaching for `any`.
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
}
const svc = (): Client => serviceClient() as unknown as Client;

const FLAG = "NEXT_PUBLIC_FEATURE_MISSED_CALL_TEXTBACK";
const AUDITS = "ai_reply_audits";
const TRANSPORTS = "ai_reply_transports";

// The two deterministic acknowledgements the FALLBACK composes — byte-for-byte the replies R4
// shipped. A missed CALL (voice channel) gets the voice phrasing; a written channel the message one.
const VOICE_ACK = "Thanks for your call — a member of the team will call you back shortly.";
const MESSAGE_ACK = "Thanks for your message — a member of the team will get back to you shortly.";

const CALLER = "+447700900000";
const A_COLUMNS =
  "id, org_id, channel, verdict, allowed, draft, enquiry_id, correlation_id, metadata";
const T_COLUMNS = "id, reply_audit_id, org_id, channel, status, failure_reason, metadata";

// Every org this suite stands up, dropped in afterAll (cascading inbound_enquiries and leads). The
// append-only audit/transport rows can't be deleted and are left behind.
const createdOrgs: string[] = [];

/** Stand up a real organisation the inbound processor can write against, tracked for teardown. */
async function freshOrg(): Promise<string> {
  const slug = `it-r13-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const res = await svc()
    .from("organizations")
    .insert({ name: "R13 Reply Drafting Org", slug })
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

describeIntegration("Conversation-aware reply drafting (R13)", () => {
  afterAll(async () => {
    for (const id of createdOrgs) {
      // The inbound processor's HQ audit (admin_activity_log, written when a lead is created) has NO
      // org FK, so the org delete does not cascade it — clear it explicitly, exactly as R6 does.
      await svc().from("admin_activity_log").delete().eq("metadata->>org_id", id);
      await svc().from("organizations").delete().eq("id", id);
    }
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("FLAG ON — a missed call drafts through the R13 generator: the audit records 'no_provider' provenance (the conversation id threaded end-to-end AND its canonical context was consulted), still exactly 1 audit + 1 transport", async () => {
    vi.stubEnv(FLAG, "true");
    const orgId = await freshOrg();
    const callSid = `CA-${crypto.randomUUID()}`;
    const rawText = "Missed call from a prospective customer.";

    const result = await processInboundEnquiry({
      org_id: orgId,
      channel: "phone",
      caller: CALLER,
      raw_text: rawText,
      dedup_key: callSid,
    });

    // A conversation was resolved and the inbound turn threaded onto it (Step 0 + the inbound
    // append), so the generator had a canonical context to consult when the text-back fired.
    const convId = result.conversation_id as string;
    expect(convId, "the missed call resolves a conversation").toBeTruthy();

    const tb = result.textback;
    expect(tb.attempted, "flag ON ⇒ the live path is attempted").toBe(true);
    if (!tb.attempted) throw new Error("unreachable");
    if (!("dispatch" in tb)) throw new Error(`text-back errored: ${tb.error}`);
    const dispatch = tb.dispatch;

    // The ONE pipeline is intact with the GENERATOR as the draft source: composed → enforced
    // (allow) → audited → transported. The draft is the deterministic acknowledgement (no provider
    // in CI) — byte-for-byte the pre-R13 reply.
    expect(dispatch.decision?.verdict).toBe("allow");
    expect(dispatch.decision?.allowed).toBe(true);
    expect(dispatch.draft, "the deterministic missed-call acknowledgement").toBe(VOICE_ACK);
    expect(dispatch.audit_id).toBeTruthy();

    // EXACTLY ONE audit, threaded to the inbound enquiry, carrying the GENERATOR's provenance. The
    // decisive R13 tell is fallback_reason 'no_provider': NOT 'no_conversation' (so a conversation id
    // threaded ALL the way through), and NOT 'no_context' (so the canonical R12 context was fetched
    // and FOUND for that id) — only the absent CI provider stopped a model draft. The whole R13
    // wiring — thread + context consumption — is witnessed by this single value.
    const audits = await auditsForOrg(orgId);
    expect(audits, "exactly one audit — not zero, not a parallel path").toHaveLength(1);
    const audit = audits[0] ?? {};
    expect(audit.id).toBe(dispatch.audit_id);
    expect(audit.channel, "the audit records the inbound channel").toBe("phone");
    expect(audit.verdict).toBe("allow");
    expect(audit.allowed).toBe(true);
    expect(audit.draft).toBe(VOICE_ACK);
    expect(audit.enquiry_id, "the audit is threaded to the inbound enquiry").toBe(
      result.enquiry_id,
    );
    expect(audit.metadata).toMatchObject({
      producer: "deterministic_acknowledgement",
      fallback_reason: "no_provider",
      model: null,
      input_tokens: 0,
      output_tokens: 0,
      dedup_key: callSid, // the caller's metadata is preserved UNDER the folded provenance
    });

    // EXACTLY ONE transport, threaded to that audit — the generated draft still flows Enforce →
    // Audit → Transport, no bypass, degrading to failed/no_provider in CI exactly as pre-R13.
    const transports = await transportsForOrg(orgId);
    expect(transports, "exactly one transport, threaded to its audit").toHaveLength(1);
    expect(transports[0]?.reply_audit_id).toBe(dispatch.audit_id);
    expect(transports[0]?.status).toBe("failed");
    expect(transports[0]?.failure_reason).toBe("no_provider");

    // And the canonical context the generator CONSULTED carried the customer's actual inbound words
    // — every draft is produced from the canonical R12 context, never an independent reconstruction.
    const ctx = await getConversationContext({ org_id: orgId, conversation_id: convId });
    expect(ctx, "the conversation assembles a canonical context").not.toBeNull();
    const customerTurn = ctx?.messages.find((m) => m.role === "customer");
    expect(customerTurn?.text, "the consulted context carries the inbound turn verbatim").toBe(
      rawText,
    );
  });

  it("the generator's context consumption is ORGANISATION-SCOPED — the SAME conversation drafts from its owner's context ('no_provider'), but is invisible to another org ('no_context'); neither ever throws or bleeds", async () => {
    const orgOwner = await freshOrg();
    const orgOther = await freshOrg();

    // Seed a real conversation in the OWNER org. Flag OFF ⇒ the inbound is ingested and threaded, but
    // NO reply is dispatched — so seeding writes not one audit of its own.
    const seed = await processInboundEnquiry({
      org_id: orgOwner,
      channel: "sms",
      caller: CALLER,
      raw_text: "The owner org's customer, asking for help.",
    });
    const convId = seed.conversation_id as string;
    expect(convId, "the seeded contact resolves a conversation").toBeTruthy();
    expect(await auditsForOrg(orgOwner), "seeding under flag OFF writes no audit").toHaveLength(0);

    // OWNER dispatch: the generator fetches THIS org's canonical context → FOUND → degrades on the
    // absent CI provider. fallback_reason 'no_provider' proves the context was consulted and found.
    const owned = await dispatchReceptionistReply({
      org_id: orgOwner,
      channel: "sms",
      conversation_id: convId,
      customer_ref: CALLER,
    });
    expect(owned.audit_id, "the owner's dispatch is audited").toBeTruthy();
    expect(owned.draft).toBe(MESSAGE_ACK);
    const ownerAudits = await auditsForOrg(orgOwner);
    expect(ownerAudits, "exactly the owner's one dispatched audit").toHaveLength(1);
    expect(ownerAudits[0]?.metadata).toMatchObject({
      producer: "deterministic_acknowledgement",
      fallback_reason: "no_provider", // context FOUND under the owning org
    });

    // FOREIGN dispatch: another org asks to draft over the OWNER's conversation id. The generator
    // fetches context UNDER orgOther → null (R12's org scope, propagated unchanged) → fallback_reason
    // 'no_context'. A draft can NEVER be built from another tenant's conversation; it degrades to the
    // acknowledgement, carrying zero cross-tenant content, and never throws.
    const foreign = await dispatchReceptionistReply({
      org_id: orgOther,
      channel: "sms",
      conversation_id: convId, // the OWNER's conversation, seen from the wrong org
      customer_ref: CALLER,
    });
    expect(foreign.audit_id, "the foreign dispatch is still audited").toBeTruthy();
    expect(foreign.draft, "the deterministic acknowledgement — no cross-tenant content").toBe(
      MESSAGE_ACK,
    );
    const otherAudits = await auditsForOrg(orgOther);
    expect(otherAudits, "exactly the foreign org's one audit").toHaveLength(1);
    expect(otherAudits[0]?.metadata).toMatchObject({
      producer: "deterministic_acknowledgement",
      fallback_reason: "no_context", // the OWNER's conversation is invisible to orgOther
    });
  });

  it("a contactless enquiry (no conversation) drafts the deterministic acknowledgement — 'no_conversation', the context fetch never attempted", async () => {
    const orgId = await freshOrg();

    // A null conversation id is the no-contact-⇒-no-thread case. The generator returns at its first
    // gate, BEFORE any context fetch — a null thread carries no canonical context to reason over.
    const out = await dispatchReceptionistReply({
      org_id: orgId,
      channel: "sms",
      conversation_id: null,
      customer_ref: CALLER,
    });
    expect(out.audit_id, "the contactless reply is still audited").toBeTruthy();
    expect(out.draft, "the pre-R13 acknowledgement, unchanged").toBe(MESSAGE_ACK);

    const audits = await auditsForOrg(orgId);
    expect(audits).toHaveLength(1);
    const audit = audits[0] ?? {};
    // 'no_conversation' (NOT 'no_context') is the tell: the generator returned before the context
    // fetch. The draft is still governed and audited — the acknowledgement is a clean allow.
    expect(audit.verdict).toBe("allow");
    expect(audit.allowed).toBe(true);
    expect(audit.metadata).toMatchObject({
      producer: "deterministic_acknowledgement",
      fallback_reason: "no_conversation",
      model: null,
      input_tokens: 0,
      output_tokens: 0,
      cost_usd: null,
      latency_ms: null,
    });
  });
});
