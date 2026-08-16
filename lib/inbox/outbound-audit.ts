/**
 * Unified outbound audit — the pure fold (MP Wave R4 · Communications audit).
 *
 * NO `server-only`, NO I/O. The read model (server/services/outbound-audit.ts)
 * fetches three org-scoped sources and hands them here to be folded into ONE
 * cross-channel list of "who did we send what, on which channel, and what
 * happened to it". Kept pure so the join/fold is deterministic and unit-tested
 * without a database.
 *
 * The three sources:
 *   1. `messages` (direction='outbound') — inbox replies on any channel.
 *   2. `comm_events` — Resend delivery events, folded per provider message id
 *      into delivered/opened/clicked/bounced flags that ENRICH the matching
 *      email message.
 *   3. AI-receptionist SMS — `ai_reply_transports` acceptance + the latest
 *      `ai_reply_delivery_receipts` terminal status, one entry per transport.
 */

/** A comm_events row, reduced to what the fold needs. */
export type CommEventInput = {
  provider_message_id: string | null;
  event_type: string;
  occurred_at: string | null;
};

/** The per-message delivery telemetry derived from its comm_events. */
export type CommEventFold = {
  delivered: boolean;
  opened: boolean;
  clicked: boolean;
  bounced: boolean;
  complained: boolean;
  last_event_at: string | null;
  /** The most advanced lifecycle state, for the status column. */
  latest_state: string | null;
};

/** An outbound message row, reduced to what the audit needs. */
export type AuditMessageInput = {
  id: string;
  channel: string | null;
  to_addr: string | null;
  status: string | null;
  failure_reason: string | null;
  provider_id: string | null;
  created_at: string;
};

/** A receptionist SMS transport + its latest receipt, reduced. */
export type AuditReceptionistInput = {
  id: string;
  to_ref: string | null;
  transport_status: string | null;
  failure_reason: string | null;
  provider_message_id: string | null;
  created_at: string;
  /** Latest delivery-receipt status for this transport, if any. */
  receipt_status: string | null;
  receipt_error_code: string | null;
};

/** One row in the unified audit. */
export type OutboundAuditEntry = {
  id: string;
  source: "inbox" | "receptionist";
  channel: string;
  recipient: string | null;
  /** The most meaningful lifecycle status: opened > clicked > delivered > sent/... */
  status: string;
  error: string | null;
  opened: boolean;
  clicked: boolean;
  bounced: boolean;
  provider_message_id: string | null;
  occurred_at: string;
};

// Ordering of email lifecycle states, most-advanced last.
const STATE_RANK: Record<string, number> = {
  bounced: 5,
  complained: 5,
  clicked: 4,
  opened: 3,
  delivered: 2,
  sent: 1,
};

/**
 * Fold a flat list of comm_events into per-message telemetry keyed by the
 * provider message id. Distinct opens/clicks collapse to a boolean; the latest
 * `occurred_at` and the most-advanced state are retained.
 */
export function foldCommEvents(events: CommEventInput[]): Map<string, CommEventFold> {
  const out = new Map<string, CommEventFold>();
  for (const e of events) {
    const key = e.provider_message_id;
    if (!key) continue;
    const cur =
      out.get(key) ??
      ({
        delivered: false,
        opened: false,
        clicked: false,
        bounced: false,
        complained: false,
        last_event_at: null,
        latest_state: null,
      } satisfies CommEventFold);

    switch (e.event_type) {
      case "delivered":
        cur.delivered = true;
        break;
      case "opened":
        cur.opened = true;
        break;
      case "clicked":
        cur.clicked = true;
        break;
      case "bounced":
        cur.bounced = true;
        break;
      case "complained":
        cur.complained = true;
        break;
    }

    if (e.occurred_at && (!cur.last_event_at || e.occurred_at > cur.last_event_at)) {
      cur.last_event_at = e.occurred_at;
    }
    const rank = STATE_RANK[e.event_type] ?? 0;
    const curRank = cur.latest_state ? (STATE_RANK[cur.latest_state] ?? 0) : -1;
    if (rank > curRank) cur.latest_state = e.event_type;

    out.set(key, cur);
  }
  return out;
}

/**
 * Build the unified, newest-first audit list from the three sources. Email
 * messages are enriched from the comm_events fold (matched by provider_id);
 * receptionist SMS entries take the latest receipt status over the transport
 * acceptance. Deterministic: ties on occurred_at break by id.
 */
export function buildOutboundAudit(input: {
  messages: AuditMessageInput[];
  commFold: Map<string, CommEventFold>;
  receptionist: AuditReceptionistInput[];
}): OutboundAuditEntry[] {
  const entries: OutboundAuditEntry[] = [];

  for (const m of input.messages) {
    const fold = m.provider_id ? input.commFold.get(m.provider_id) : undefined;
    const status = fold?.latest_state ?? m.status ?? "unknown";
    entries.push({
      id: `msg:${m.id}`,
      source: "inbox",
      channel: m.channel ?? "chat",
      recipient: m.to_addr,
      status,
      error: m.failure_reason,
      opened: fold?.opened ?? false,
      clicked: fold?.clicked ?? false,
      bounced: fold?.bounced ?? false,
      provider_message_id: m.provider_id,
      occurred_at: fold?.last_event_at ?? m.created_at,
    });
  }

  for (const r of input.receptionist) {
    entries.push({
      id: `rcpt:${r.id}`,
      source: "receptionist",
      channel: "sms",
      recipient: r.to_ref,
      status: r.receipt_status ?? r.transport_status ?? "unknown",
      error: r.failure_reason ?? r.receipt_error_code,
      opened: false,
      clicked: false,
      bounced: r.receipt_status === "undelivered" || r.receipt_status === "failed",
      provider_message_id: r.provider_message_id,
      occurred_at: r.created_at,
    });
  }

  entries.sort((a, b) => {
    if (a.occurred_at !== b.occurred_at) return a.occurred_at < b.occurred_at ? 1 : -1;
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  });

  return entries;
}

/** A stable page of the audit — F-1-safe reads happen upstream; this slices. */
export function pageOutboundAudit(
  entries: OutboundAuditEntry[],
  page: number,
  pageSize: number,
): { rows: OutboundAuditEntry[]; page: number; pageCount: number; total: number } {
  const total = entries.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(Math.max(1, page), pageCount);
  const start = (safePage - 1) * pageSize;
  return {
    rows: entries.slice(start, start + pageSize),
    page: safePage,
    pageCount,
    total,
  };
}
