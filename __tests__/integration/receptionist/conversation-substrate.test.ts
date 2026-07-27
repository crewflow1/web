import { afterAll, afterEach, expect, it, vi } from "vitest";
import { anonClient, describeIntegration, serviceClient } from "../_harness";
import { processInboundEnquiry } from "@/server/services/receptionist";

/**
 * Conversation & contact-identity substrate — real-Postgres proof of the AI Receptionist
 * Programme R10 (CONVERSATION & CONTACT-IDENTITY SUBSTRATE).
 *
 * R1–R9 shipped a STATELESS, single-shot responder: every inbound message became an
 * isolated `inbound_enquiries` row with no container grouping a contact's messages and no
 * durable contact identity. R10 lays the missing substrate — a persistent, org-scoped
 * CONVERSATION keyed by a resolved contact identity plus a threaded MESSAGE timeline — as
 * shared infrastructure BENEATH the canonical pipeline, threaded onto the EXISTING
 * single-shot flow. The unit tier pins the pure contact-fold and the security tier proves,
 * as a matter of SOURCE, that the substrate is additive, service-role-only, and opens no
 * new outbound path. This tier proves the BEHAVIOUR the mocks can't — that when the
 * CANONICAL SERVICE actually runs against Postgres, driven the way a real inbound webhook
 * drives it (`processInboundEnquiry`), the directive's validation criteria hold end to end:
 *
 *   • REPEAT CONTACT → SAME CONVERSATION — a second inbound from the same contact on the
 *     same channel folds into the one conversation the first created; its counters advance.
 *   • NEW CONTACT → NEW CONVERSATION — a different contact, a different channel, gets its own.
 *   • ORGANISATION ISOLATION — the same contact identifier in two orgs is two conversations;
 *     the UNIQUE (org_id, channel, contact_ref) key can never collide across tenants.
 *   • THE ENQUIRY IS THREADED — the inbound row is linked to its conversation, and an inbound
 *     MESSAGE entry is appended that REFERENCES the enquiry (never copies its content).
 *   • THE OUTBOUND IS THREADED — when the flag-gated reply runs, an outbound MESSAGE entry is
 *     appended that REFERENCES its `ai_reply_audits` row (single source of truth; no copy).
 *   • EXISTING BEHAVIOUR UNCHANGED / NO NEW OUTBOUND — the substrate is inert to the reply:
 *     with the text-back flag OFF a contact is threaded, but NOT ONE audit or transport is
 *     written; the deterministic reply pipeline is untouched.
 *   • THE STORE IS SERVICE-ROLE-ONLY (RLS:hq) — anon cannot read the tables, call the
 *     SECURITY DEFINER write primitives, or insert directly.
 *   • THE DATABASE FOLDS IDENTITY INDEPENDENTLY — the resolver normalises (trim + casefold)
 *     inside Postgres, so casing/whitespace can never split one contact into two, and it
 *     validates message direction in-DDL.
 *
 * Runs only against a live DB (describeIntegration): skipped locally with no database,
 * FAILED loudly in CI if the database is missing. The two substrate tables cascade from the
 * seeded org, so teardown drops the orgs (and clears the un-FK'd admin_activity_log rows the
 * inbound processor writes when a lead is created). Rows are addressed by per-test org ids so
 * each assertion sees only its own writes.
 */

// The substrate tables + their record_* primitives are service-role-only internals and are
// NOT in the generated Database types. Cast to the minimal surface this suite exercises (the
// same `as unknown as` convention the R4/R6 receptionist suites use) rather than reaching for
// `any`.
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
const anon = (): Client => anonClient() as unknown as Client;

const FLAG = "NEXT_PUBLIC_FEATURE_MISSED_CALL_TEXTBACK";
const CONVERSATIONS = "receptionist_conversations";
const MESSAGES = "receptionist_messages";
const AUDITS = "ai_reply_audits";
const TRANSPORTS = "ai_reply_transports";
const ENQUIRIES = "inbound_enquiries";
const RESOLVE_RPC = "resolve_receptionist_conversation";
const APPEND_RPC = "append_receptionist_message";
const EMPLOYEE_SLUG = "voice-receptionist-ai";

const CALLER = "+447700900000";
const OTHER_CALLER = "+447700900999";
const C_COLUMNS =
  "id, org_id, employee_slug, channel, contact_ref, contact_name, status, " +
  "message_count, first_message_at, last_message_at";
const M_COLUMNS = "id, conversation_id, org_id, direction, channel, enquiry_id, audit_id, created_at";

// Every org this suite stands up, dropped in afterAll (cascading inbound_enquiries, leads,
// and the two substrate tables). The append-only audit/transport rows can't be deleted and
// are left behind (harmless in the ephemeral CI database).
const createdOrgs: string[] = [];

/** Stand up a real organisation the inbound processor can write against, tracked for teardown. */
async function freshOrg(): Promise<string> {
  const slug = `it-r10-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const res = await svc()
    .from("organizations")
    .insert({ name: "R10 Conversation Substrate Org", slug })
    .select("id")
    .single();
  expect(res.error, res.error?.message).toBeNull();
  const id = String((res.data as { id: string }).id);
  createdOrgs.push(id);
  return id;
}

/** Every conversation for one org, as service_role. */
async function conversationsForOrg(orgId: string): Promise<Record<string, unknown>[]> {
  const res = await svc().from(CONVERSATIONS).select(C_COLUMNS).eq("org_id", orgId);
  expect(res.error, res.error?.message).toBeNull();
  return res.data ?? [];
}

/** Every message entry on one conversation, as service_role. */
async function messagesFor(conversationId: string): Promise<Record<string, unknown>[]> {
  const res = await svc().from(MESSAGES).select(M_COLUMNS).eq("conversation_id", conversationId);
  expect(res.error, res.error?.message).toBeNull();
  return res.data ?? [];
}

/** One conversation by id, or null. */
async function conversationById(id: string): Promise<Record<string, unknown> | null> {
  const res = await svc().from(CONVERSATIONS).select(C_COLUMNS).eq("id", id);
  expect(res.error, res.error?.message).toBeNull();
  return (res.data ?? [])[0] ?? null;
}

/** One inbound enquiry's conversation link, or null. */
async function enquiryById(id: string): Promise<Record<string, unknown> | null> {
  const res = await svc()
    .from(ENQUIRIES)
    .select("id, org_id, channel, conversation_id")
    .eq("id", id);
  expect(res.error, res.error?.message).toBeNull();
  return (res.data ?? [])[0] ?? null;
}

/** Count audit / transport rows for one org — the "no new outbound" oracle. */
async function outboundCounts(orgId: string): Promise<{ audits: number; transports: number }> {
  const a = await svc().from(AUDITS).select("id").eq("org_id", orgId);
  const t = await svc().from(TRANSPORTS).select("id").eq("org_id", orgId);
  return { audits: (a.data ?? []).length, transports: (t.data ?? []).length };
}

/**
 * Assert an anon read obtained no row — denial being equally valid whether it arrives as a
 * hard privilege error or as an RLS-filtered empty set. A returned row is the only failure.
 */
function expectAnonDenied(res: Res<Record<string, unknown>[]>): void {
  if (res.error) return;
  expect(res.data ?? []).toHaveLength(0);
}

describeIntegration("Conversation & contact-identity substrate (R10)", () => {
  afterAll(async () => {
    for (const id of createdOrgs) {
      // The inbound processor's HQ audit (admin_activity_log, Step 5 when a lead is created)
      // has NO org FK, so the org delete does not cascade it — clear it explicitly. Everything
      // else the processor writes (inbound_enquiries, leads, notifications, and the R10
      // conversations + messages) is org-scoped and cascades with the org.
      await svc().from("admin_activity_log").delete().eq("metadata->>org_id", id);
      await svc().from("organizations").delete().eq("id", id);
    }
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("NEW contact — resolves a new conversation, links the enquiry, threads an inbound message, and (flag OFF) writes NO outbound", async () => {
    // The default flag state: the substrate threads the inbound activity, but the reply
    // pipeline stays wholly inert — existing behaviour unchanged, no new outbound path.
    expect(process.env[FLAG] ?? "false").not.toBe("true");
    const orgId = await freshOrg();

    const result = await processInboundEnquiry({
      org_id: orgId,
      channel: "phone",
      caller: CALLER,
      raw_text: "First missed call from a new contact.",
    });

    // A conversation was resolved and surfaced on the inbound result.
    expect(result.conversation_id, "a contact-bearing inbound resolves a conversation").toBeTruthy();
    const convId = result.conversation_id as string;

    // EXACTLY ONE conversation for the org, carrying the resolved contact identity.
    const convs = await conversationsForOrg(orgId);
    expect(convs).toHaveLength(1);
    const conv = convs[0] ?? {};
    expect(conv.id).toBe(convId);
    expect(conv.employee_slug).toBe(EMPLOYEE_SLUG);
    expect(conv.channel).toBe("phone");
    expect(conv.contact_ref, "the normalised contact identity").toBe(CALLER);
    expect(conv.status).toBe("active");
    expect(conv.message_count, "one inbound message threaded").toBe(1);

    // The inbound enquiry is linked to its conversation.
    const enquiry = await enquiryById(result.enquiry_id);
    expect(enquiry?.conversation_id, "the enquiry is threaded to its conversation").toBe(convId);

    // EXACTLY ONE message entry — an INBOUND one that REFERENCES the enquiry (no content copy).
    const msgs = await messagesFor(convId);
    expect(msgs).toHaveLength(1);
    const m = msgs[0] ?? {};
    expect(m.direction).toBe("inbound");
    expect(m.channel).toBe("phone");
    expect(m.org_id).toBe(orgId);
    expect(m.enquiry_id, "the inbound entry references its authoritative source").toBe(
      result.enquiry_id,
    );
    expect(m.audit_id, "an inbound entry carries no audit reference").toBeNull();

    // NO NEW OUTBOUND: the reply pipeline is untouched with the flag off.
    expect(await outboundCounts(orgId)).toEqual({ audits: 0, transports: 0 });
  });

  it("REPEAT contact on the same channel — folds into the SAME conversation and advances its counters", async () => {
    const orgId = await freshOrg();

    const first = await processInboundEnquiry({
      org_id: orgId,
      channel: "phone",
      caller: CALLER,
      raw_text: "Missed call #1.",
    });
    const convBefore = await conversationById(first.conversation_id as string);
    const firstSeenAt = String(convBefore?.last_message_at);

    const second = await processInboundEnquiry({
      org_id: orgId,
      channel: "phone",
      caller: CALLER,
      raw_text: "Missed call #2 — the SAME contact calling back.",
    });

    // The SAME conversation — a repeat contact never opens a second thread.
    expect(second.conversation_id).toBe(first.conversation_id);

    // Still exactly one conversation for the org, now with two messages.
    const convs = await conversationsForOrg(orgId);
    expect(convs).toHaveLength(1);
    const conv = convs[0] ?? {};
    expect(conv.message_count, "the counter advanced to two").toBe(2);
    // last_message_at advanced (separate transactions ⇒ a later now()).
    expect(
      new Date(String(conv.last_message_at)).getTime(),
      "last_message_at moved forward on the second append",
    ).toBeGreaterThanOrEqual(new Date(firstSeenAt).getTime());

    // Two inbound entries, each referencing its own enquiry — both threaded to the one thread.
    const msgs = await messagesFor(first.conversation_id as string);
    expect(msgs).toHaveLength(2);
    expect(msgs.every((m) => m.direction === "inbound")).toBe(true);
    const referenced = msgs.map((m) => m.enquiry_id).sort();
    expect(referenced).toEqual([first.enquiry_id, second.enquiry_id].sort());

    // Both enquiries point back at the same conversation.
    expect((await enquiryById(first.enquiry_id))?.conversation_id).toBe(first.conversation_id);
    expect((await enquiryById(second.enquiry_id))?.conversation_id).toBe(first.conversation_id);
  });

  it("DIFFERENT contact, same org + channel — gets its OWN conversation", async () => {
    const orgId = await freshOrg();

    const a = await processInboundEnquiry({
      org_id: orgId,
      channel: "phone",
      caller: CALLER,
      raw_text: "Contact A.",
    });
    const b = await processInboundEnquiry({
      org_id: orgId,
      channel: "phone",
      caller: OTHER_CALLER,
      raw_text: "Contact B — a different number.",
    });

    expect(b.conversation_id).not.toBe(a.conversation_id);
    const convs = await conversationsForOrg(orgId);
    expect(convs, "two distinct contacts ⇒ two conversations").toHaveLength(2);
  });

  it("SAME contact, DIFFERENT channel — is a different conversation (the identity key includes channel)", async () => {
    const orgId = await freshOrg();

    const viaPhone = await processInboundEnquiry({
      org_id: orgId,
      channel: "phone",
      caller: CALLER,
      raw_text: "Reached us by phone.",
    });
    const viaSms = await processInboundEnquiry({
      org_id: orgId,
      channel: "sms",
      caller: CALLER,
      raw_text: "Reached us by SMS — same number, different channel.",
    });

    expect(viaSms.conversation_id).not.toBe(viaPhone.conversation_id);
    const convs = await conversationsForOrg(orgId);
    expect(convs).toHaveLength(2);
    expect(convs.map((c) => c.channel).sort()).toEqual(["phone", "sms"]);
  });

  it("casing + whitespace fold to ONE conversation (the service normalises before the DB key)", async () => {
    const orgId = await freshOrg();

    const first = await processInboundEnquiry({
      org_id: orgId,
      channel: "instagram_dm",
      caller: "@Mixed.Case",
      raw_text: "A DM from @Mixed.Case.",
    });
    const second = await processInboundEnquiry({
      org_id: orgId,
      channel: "instagram_dm",
      caller: "  @mixed.case  ", // same identity, incidental casing + whitespace
      raw_text: "The SAME handle, differently cased and padded.",
    });

    expect(second.conversation_id, "casing/whitespace must not split one contact").toBe(
      first.conversation_id,
    );
    const convs = await conversationsForOrg(orgId);
    expect(convs).toHaveLength(1);
    expect(convs[0]?.contact_ref, "the stored identity is normalised").toBe("@mixed.case");
    expect(convs[0]?.message_count).toBe(2);
  });

  it("a contact-LESS inbound — resolves NO conversation, threads no message, still ingests the enquiry", async () => {
    const orgId = await freshOrg();

    const result = await processInboundEnquiry({
      org_id: orgId,
      channel: "phone",
      caller: null, // no contact identifier ⇒ nothing to thread
      raw_text: "Missed call, caller withheld.",
    });

    // The enquiry is durably recorded, unlinked — ingestion never depends on the substrate.
    expect(result.enquiry_id).toBeTruthy();
    expect(result.conversation_id, "no contact ⇒ no conversation").toBeNull();
    expect((await enquiryById(result.enquiry_id))?.conversation_id).toBeNull();

    // No conversation and no message rows exist for the org.
    expect(await conversationsForOrg(orgId)).toHaveLength(0);
  });

  it("ORGANISATION isolation — the same contact identifier in two orgs is two separate conversations", async () => {
    const orgA = await freshOrg();
    const orgB = await freshOrg();

    const a = await processInboundEnquiry({
      org_id: orgA,
      channel: "phone",
      caller: CALLER,
      raw_text: "Org A's caller.",
    });
    const b = await processInboundEnquiry({
      org_id: orgB,
      channel: "phone",
      caller: CALLER, // the identical string, a different tenant
      raw_text: "Org B's caller — same number string, different organisation.",
    });

    expect(b.conversation_id).not.toBe(a.conversation_id);
    expect((await conversationById(a.conversation_id as string))?.org_id).toBe(orgA);
    expect((await conversationById(b.conversation_id as string))?.org_id).toBe(orgB);
    // Each org sees exactly its own single conversation.
    expect(await conversationsForOrg(orgA)).toHaveLength(1);
    expect(await conversationsForOrg(orgB)).toHaveLength(1);
  });

  it("FLAG ON — a missed call threads BOTH an inbound and an outbound entry, the outbound REFERENCING its audit (no copy)", async () => {
    // The reply-bearing path: armed, the missed-call text-back runs, producing an audited
    // reply. The substrate threads that reply as an OUTBOUND entry that references the
    // ai_reply_audits row — one source of truth, never a duplicated draft.
    vi.stubEnv(FLAG, "true");
    const orgId = await freshOrg();

    const result = await processInboundEnquiry({
      org_id: orgId,
      channel: "phone",
      caller: CALLER,
      raw_text: "Missed call — armed text-back.",
      dedup_key: `CA-${crypto.randomUUID()}`,
    });

    const tb = result.textback;
    expect(tb.attempted).toBe(true);
    if (!tb.attempted) throw new Error("unreachable");
    if (!("dispatch" in tb)) throw new Error(`text-back errored: ${tb.error}`);
    const auditId = tb.dispatch.audit_id;
    expect(auditId, "the armed reply produced an audit").toBeTruthy();

    const convId = result.conversation_id as string;
    const conv = await conversationById(convId);
    expect(conv?.message_count, "one inbound + one outbound").toBe(2);

    const msgs = await messagesFor(convId);
    expect(msgs).toHaveLength(2);
    const inbound = msgs.find((m) => m.direction === "inbound") ?? {};
    const outbound = msgs.find((m) => m.direction === "outbound") ?? {};

    // The inbound entry references the enquiry; the outbound references the audit. Neither
    // copies content — each carries a single pointer to its authoritative source.
    expect(inbound.enquiry_id).toBe(result.enquiry_id);
    expect(inbound.audit_id).toBeNull();
    expect(outbound.audit_id, "the outbound entry references its ai_reply_audits row").toBe(auditId);
    expect(outbound.enquiry_id, "an outbound entry carries no enquiry reference").toBeNull();

    // Single source of truth: the referenced audit row exists and IS the content (the message
    // row has no draft column of its own to drift from it).
    const auditRead = await svc().from(AUDITS).select("id, draft").eq("id", auditId as string);
    expect(auditRead.error, auditRead.error?.message).toBeNull();
    expect((auditRead.data ?? [])[0]?.draft, "the audit holds the reply content").toBeTruthy();
  });

  it("is service-role-only (RLS:hq) — anon cannot read the tables, call the write primitives, or insert directly", async () => {
    const orgId = await freshOrg();
    const seeded = await processInboundEnquiry({
      org_id: orgId,
      channel: "phone",
      caller: CALLER,
      raw_text: "Seed a conversation for the RLS probe.",
    });
    const convId = seeded.conversation_id as string;

    // service_role (BYPASSRLS) sees the rows…
    expect(await conversationsForOrg(orgId)).toHaveLength(1);
    expect(await messagesFor(convId)).toHaveLength(1);

    // …anon does not (RLS enabled, zero policies → deny) — on BOTH tables.
    expectAnonDenied(await anon().from(CONVERSATIONS).select("id").eq("org_id", orgId));
    expectAnonDenied(await anon().from(MESSAGES).select("id").eq("conversation_id", convId));

    // anon cannot call either SECURITY DEFINER write primitive — EXECUTE is service_role-only.
    const anonResolve = await anon().rpc<string>(RESOLVE_RPC, {
      p_org_id: orgId,
      p_employee_slug: EMPLOYEE_SLUG,
      p_channel: "phone",
      p_contact_ref: "+447700900123",
      p_contact_name: null,
    });
    expect(anonResolve.error, "anon must not resolve a conversation").not.toBeNull();

    const anonAppend = await anon().rpc<string>(APPEND_RPC, {
      p_conversation_id: convId,
      p_org_id: orgId,
      p_direction: "inbound",
      p_channel: "phone",
      p_enquiry_id: seeded.enquiry_id,
      p_audit_id: null,
    });
    expect(anonAppend.error, "anon must not append a message").not.toBeNull();

    // anon cannot write around the RPCs with a direct insert either.
    const anonConvInsert = await anon().from(CONVERSATIONS).insert({
      org_id: orgId,
      employee_slug: EMPLOYEE_SLUG,
      channel: "phone",
      contact_ref: "+447700900123",
    });
    expect(anonConvInsert.error, "anon must not insert a conversation").not.toBeNull();

    const anonMsgInsert = await anon().from(MESSAGES).insert({
      conversation_id: convId,
      org_id: orgId,
      direction: "inbound",
      channel: "phone",
      enquiry_id: seeded.enquiry_id,
    });
    expect(anonMsgInsert.error, "anon must not insert a message").not.toBeNull();
  });

  it("the DATABASE folds identity independently — the resolver normalises in Postgres and is atomic on the key", async () => {
    // Prove the fold is the DATABASE's, not merely the TypeScript layer's: call the resolver
    // RPC directly with an UN-normalised contact ref and assert it stored the normalised form
    // AND that a second raw variant resolves to the SAME id (INSERT … ON CONFLICT).
    const orgId = await freshOrg();

    const raw1 = await svc().rpc<string>(RESOLVE_RPC, {
      p_org_id: orgId,
      p_employee_slug: EMPLOYEE_SLUG,
      p_channel: "facebook_dm",
      p_contact_ref: "  RAW@Mixed.COM  ",
      p_contact_name: "First Seen Name",
    });
    expect(raw1.error, raw1.error?.message).toBeNull();
    const id1 = raw1.data as string;
    expect(id1).toBeTruthy();
    expect((await conversationById(id1))?.contact_ref, "stored normalised by the DB").toBe(
      "raw@mixed.com",
    );

    const raw2 = await svc().rpc<string>(RESOLVE_RPC, {
      p_org_id: orgId,
      p_employee_slug: EMPLOYEE_SLUG,
      p_channel: "facebook_dm",
      p_contact_ref: "raw@mixed.com",
      p_contact_name: "A Later Name", // must NOT overwrite the first-known name
    });
    expect(raw2.error, raw2.error?.message).toBeNull();
    expect(raw2.data, "the raw variant folds to the same conversation").toBe(id1);
    expect((await conversationById(id1))?.contact_name, "first-known name is preserved").toBe(
      "First Seen Name",
    );

    // An empty identifier resolves to NULL — no contact, no conversation.
    const empty = await svc().rpc<string>(RESOLVE_RPC, {
      p_org_id: orgId,
      p_employee_slug: EMPLOYEE_SLUG,
      p_channel: "facebook_dm",
      p_contact_ref: "   ",
      p_contact_name: null,
    });
    expect(empty.error, empty.error?.message).toBeNull();
    expect(empty.data, "an empty contact ref resolves to null").toBeNull();

    // The append primitive validates direction in-DDL — a bad direction is rejected.
    const badDirection = await svc().rpc<string>(APPEND_RPC, {
      p_conversation_id: id1,
      p_org_id: orgId,
      p_direction: "sideways",
      p_channel: "facebook_dm",
      p_enquiry_id: null,
      p_audit_id: null,
    });
    expect(badDirection.error, "direction must be inbound|outbound").not.toBeNull();
  });
});
