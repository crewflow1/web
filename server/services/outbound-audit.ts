import "server-only";

/**
 * Unified outbound audit — the read model (MP Wave R4 · Communications audit).
 *
 * ONE cross-channel view of every outbound communication and what happened to it,
 * folded from three org-scoped sources. Every read is:
 *   - ACTIVE-ORG PINNED with an explicit `.eq("org_id", orgId)` (RLS admits every
 *     org the caller belongs to, so a dual-org member must not see another of
 *     their orgs' sends under the active shell);
 *   - LOUD — a query error THROWS `readFailure`, never renders as an empty audit;
 *   - F-1 SAFE — paged through `fetchAllRows` with a stable (created_at, id) order.
 *
 * `messages` and `comm_events` are read on the USER-JWT client (RLS + the pin).
 * The AI-receptionist ledgers (`ai_reply_transports` / `ai_reply_delivery_receipts`)
 * are RLS-locked to zero tenant policies BY DESIGN, so they are read on the
 * service-role client WITH THE SAME MANDATORY org pin — a read-only projection of
 * the org's own auto-sent SMS, never a cross-tenant surface.
 */

import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { fetchAllRows } from "@/lib/supabase/paginate";
import { readFailure, type SupabaseReadError } from "@/lib/supabase/read-failure";
import {
  foldCommEvents,
  buildOutboundAudit,
  type AuditMessageInput,
  type AuditReceptionistInput,
  type CommEventInput,
  type OutboundAuditEntry,
} from "@/lib/inbox/outbound-audit";

type Row = Record<string, unknown>;

type ReadChain = {
  eq: (k: string, v: unknown) => ReadChain;
  order: (col: string, opts: { ascending: boolean }) => ReadChain;
  range: (
    from: number,
    to: number,
  ) => Promise<{ data: Row[] | null; error: SupabaseReadError | null }>;
};
type ReadClient = { from: (t: string) => { select: (cols: string) => ReadChain } };

const s = (v: unknown): string | null => (typeof v === "string" ? v : v == null ? null : String(v));

/**
 * Build the org's unified outbound audit entries (newest first). The three reads
 * are complete (F-1) and org-pinned; the fold is pure.
 */
export async function listOutboundAudit(orgId: string): Promise<OutboundAuditEntry[]> {
  const supabase = (await createClient()) as unknown as ReadClient;
  const admin = createAdminClient() as unknown as ReadClient;

  // 1. Outbound messages (user-JWT, RLS + active-org pin).
  const { data: msgRows, error: msgErr } = await fetchAllRows<Row>((from, to) =>
    supabase
      .from("messages")
      .select("id, channel, to_addr, status, failure_reason, provider_id, direction, created_at")
      .eq("org_id", orgId)
      .eq("direction", "outbound")
      .order("created_at", { ascending: false })
      .order("id", { ascending: true })
      .range(from, to),
  );
  if (msgErr) throw readFailure("outbound audit: messages", msgErr as SupabaseReadError);

  // 2. Resend delivery events (user-JWT, RLS + active-org pin).
  const { data: evtRows, error: evtErr } = await fetchAllRows<Row>((from, to) =>
    supabase
      .from("comm_events")
      .select("id, provider_message_id, event_type, occurred_at")
      .eq("org_id", orgId)
      .order("occurred_at", { ascending: false })
      .order("id", { ascending: true })
      .range(from, to),
  );
  if (evtErr) throw readFailure("outbound audit: comm_events", evtErr as SupabaseReadError);

  // 3. Receptionist SMS transports (service-role — RLS-locked table — WITH org pin).
  const { data: txRows, error: txErr } = await fetchAllRows<Row>((from, to) =>
    admin
      .from("ai_reply_transports")
      .select("id, to_ref, status, failure_reason, provider_message_id, created_at")
      .eq("org_id", orgId)
      .order("created_at", { ascending: false })
      .order("id", { ascending: true })
      .range(from, to),
  );
  if (txErr) throw readFailure("outbound audit: ai_reply_transports", txErr as SupabaseReadError);

  // 3b. Their latest delivery receipts (service-role, org-pinned). Fold newest
  // status per provider message id.
  const { data: rcptRows, error: rcptErr } = await fetchAllRows<Row>((from, to) =>
    admin
      .from("ai_reply_delivery_receipts")
      .select("provider_message_id, status, error_code, created_at")
      .eq("org_id", orgId)
      .order("created_at", { ascending: false })
      .order("provider_message_id", { ascending: true })
      .range(from, to),
  );
  if (rcptErr)
    throw readFailure("outbound audit: ai_reply_delivery_receipts", rcptErr as SupabaseReadError);

  const latestReceipt = new Map<string, { status: string | null; error_code: string | null }>();
  for (const r of rcptRows) {
    const pmid = s(r.provider_message_id);
    if (!pmid || latestReceipt.has(pmid)) continue; // first-seen under created_at DESC = latest
    latestReceipt.set(pmid, { status: s(r.status), error_code: s(r.error_code) });
  }

  const messages: AuditMessageInput[] = msgRows.map((m) => ({
    id: String(m.id),
    channel: s(m.channel),
    to_addr: s(m.to_addr),
    status: s(m.status),
    failure_reason: s(m.failure_reason),
    provider_id: s(m.provider_id),
    created_at: String(m.created_at),
  }));

  const commEvents: CommEventInput[] = evtRows.map((e) => ({
    provider_message_id: s(e.provider_message_id),
    event_type: String(e.event_type ?? ""),
    occurred_at: s(e.occurred_at),
  }));

  const receptionist: AuditReceptionistInput[] = txRows.map((t) => {
    const pmid = s(t.provider_message_id);
    const rcpt = pmid ? latestReceipt.get(pmid) : undefined;
    return {
      id: String(t.id),
      to_ref: s(t.to_ref),
      transport_status: s(t.status),
      failure_reason: s(t.failure_reason),
      provider_message_id: pmid,
      created_at: String(t.created_at),
      receipt_status: rcpt?.status ?? null,
      receipt_error_code: rcpt?.error_code ?? null,
    };
  });

  return buildOutboundAudit({ messages, commFold: foldCommEvents(commEvents), receptionist });
}
