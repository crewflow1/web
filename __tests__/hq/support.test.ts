import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  SUPPORT_STATUSES,
  SUPPORT_PRIORITIES,
  SUPPORT_CATEGORIES,
  SUPPORT_ACTIVE_STATUSES,
  SUPPORT_PRIORITY_RANK,
  SUPPORT_SORTS,
  isActiveStatus,
  isValidStatus,
  isValidPriority,
  isValidCategory,
  badgeText,
  sortTickets,
  filterTickets,
  type SupportTicketRow,
  type SupportStatus,
  type SupportPriority,
} from "@/lib/hq/support";

/**
 * HQ-7 Support OS contract tests.
 *
 * Pinned:
 *   1. Status/priority/category vocab matches the CEO directive
 *      verbatim and can't drift.
 *   2. Sort + filter pure functions behave correctly on edge cases.
 *   3. Migration shape: 2 tables, RLS enabled with the correct
 *      policies, indexes, ticket-number trigger, status-update
 *      trigger.
 *   4. Server actions on BOTH sides re-check auth + write
 *      admin_activity_log.
 *   5. Customer-side action only emits author_kind='customer',
 *      internal=false (DB-level CHECK enforces this too).
 *   6. HQ-side action can mark internal=true.
 *   7. RLS: support_messages SELECT filters internal=true away from
 *      tenants (pinned via migration text).
 *   8. Customer sidebar carries the new Support link.
 *   9. HQ_NAV no longer marks /admin/support as Coming soon and
 *      renders a badge count from countOpenSupportTicketsForHq.
 *  10. Page wiring: list + detail render every directive-mandated
 *      control (status, priority, category, reply, internal-note,
 *      assignment).
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

const MIGRATION = read("supabase/migrations/20260610000000_support_os.sql");
const HQ_SNAPSHOT = read("server/services/hq-support-snapshot.ts");
const CUSTOMER_SVC = read("server/services/customer-support-service.ts");
const CUSTOMER_ACTIONS = read("app/(app)/support/actions.ts");
const HQ_ACTIONS = read("app/admin/support/actions.ts");
const CUSTOMER_LIST = read("app/(app)/support/page.tsx");
const CUSTOMER_NEW = read("app/(app)/support/new/page.tsx");
const CUSTOMER_DETAIL = read("app/(app)/support/[id]/page.tsx");
const HQ_LIST = read("app/admin/support/page.tsx");
const HQ_DETAIL = read("app/admin/support/[id]/page.tsx");
// Reply form moved into a sibling client component during the
// Phase 5 completion sweep so the customer-visible-send can be
// gated behind a confirm. Tests that pinned reply-form internals
// now read the dedicated file.
const HQ_DETAIL_REPLY = read("app/admin/support/[id]/_reply-form.tsx");
const SIDEBAR = read("app/(app)/_components/sidebar.tsx");
const HQ_LAYOUT = read("app/admin/layout.tsx");

// =====================================================================
// 1. Vocab matches the CEO directive
// =====================================================================

describe("status / priority / category vocab — matches directive verbatim", () => {
  it("statuses are exactly: open, in_progress, waiting_on_customer, resolved, closed", () => {
    expect(SUPPORT_STATUSES).toEqual([
      "open",
      "in_progress",
      "waiting_on_customer",
      "resolved",
      "closed",
    ]);
  });

  it("priorities are exactly: low, normal, high, urgent", () => {
    expect(SUPPORT_PRIORITIES).toEqual(["low", "normal", "high", "urgent"]);
  });

  it("categories cover billing/onboarding/migration/bug/feature_request/account/other", () => {
    expect(SUPPORT_CATEGORIES).toEqual([
      "billing",
      "onboarding",
      "migration",
      "bug",
      "feature_request",
      "account",
      "other",
    ]);
  });

  it("active statuses exclude resolved + closed", () => {
    expect(SUPPORT_ACTIVE_STATUSES).toEqual([
      "open",
      "in_progress",
      "waiting_on_customer",
    ]);
    expect(isActiveStatus("open")).toBe(true);
    expect(isActiveStatus("resolved")).toBe(false);
    expect(isActiveStatus("nonsense")).toBe(false);
  });

  it("priority rank orders urgent first, low last", () => {
    expect(SUPPORT_PRIORITY_RANK.urgent).toBeLessThan(SUPPORT_PRIORITY_RANK.high);
    expect(SUPPORT_PRIORITY_RANK.high).toBeLessThan(SUPPORT_PRIORITY_RANK.normal);
    expect(SUPPORT_PRIORITY_RANK.normal).toBeLessThan(SUPPORT_PRIORITY_RANK.low);
  });

  it("validators reject anything outside the canonical set", () => {
    for (const s of SUPPORT_STATUSES) expect(isValidStatus(s)).toBe(true);
    expect(isValidStatus("invalid")).toBe(false);
    for (const p of SUPPORT_PRIORITIES) expect(isValidPriority(p)).toBe(true);
    expect(isValidPriority("p0")).toBe(false);
    for (const c of SUPPORT_CATEGORIES) expect(isValidCategory(c)).toBe(true);
    expect(isValidCategory("misc")).toBe(false);
  });

  it("sort options cover priority / status / date / customer", () => {
    expect(SUPPORT_SORTS).toContain("priority");
    expect(SUPPORT_SORTS).toContain("status");
    expect(SUPPORT_SORTS).toContain("newest");
    expect(SUPPORT_SORTS).toContain("oldest");
    expect(SUPPORT_SORTS).toContain("customer");
    expect(SUPPORT_SORTS).toContain("needs_attention");
  });
});

// =====================================================================
// 2. Sort + filter
// =====================================================================

function row(overrides: Partial<SupportTicketRow> = {}): SupportTicketRow {
  return {
    id: "t1",
    org_id: "o1",
    org_name: "Org",
    ticket_number: 1,
    subject: "subject",
    status: "open",
    priority: "normal",
    category: "other",
    created_at: "2026-05-22T12:00:00Z",
    last_reply_at: null,
    last_reply_kind: null,
    ...overrides,
  };
}

describe("sortTickets", () => {
  it("needs_attention: active first, customer-last-replied before HQ, urgent first, oldest first", () => {
    const rows = [
      row({ id: "a", status: "resolved" }),
      row({ id: "b", status: "in_progress", last_reply_kind: "hq", priority: "normal" }),
      row({
        id: "c",
        status: "open",
        last_reply_kind: "customer",
        priority: "urgent",
        created_at: "2026-05-20T00:00:00Z",
      }),
      row({
        id: "d",
        status: "open",
        last_reply_kind: "customer",
        priority: "normal",
        created_at: "2026-05-19T00:00:00Z",
      }),
    ];
    const sorted = sortTickets(rows, "needs_attention");
    expect(sorted[0]?.id).toBe("c"); // active + customer-replied + urgent
    expect(sorted[1]?.id).toBe("d"); // active + customer-replied + oldest
    expect(sorted[2]?.id).toBe("b"); // active + we-replied
    expect(sorted[3]?.id).toBe("a"); // resolved
  });

  it("priority: urgent → high → normal → low", () => {
    const rows: SupportPriority[] = ["low", "urgent", "normal", "high"];
    const sorted = sortTickets(
      rows.map((p, i) => row({ id: String(i), priority: p })),
      "priority",
    );
    expect(sorted.map((t) => t.priority)).toEqual([
      "urgent",
      "high",
      "normal",
      "low",
    ]);
  });

  it("customer: alphabetical by org_name", () => {
    const sorted = sortTickets(
      [
        row({ id: "1", org_name: "Charlie" }),
        row({ id: "2", org_name: "Alpha" }),
        row({ id: "3", org_name: "Bravo" }),
      ],
      "customer",
    );
    expect(sorted.map((t) => t.org_name)).toEqual(["Alpha", "Bravo", "Charlie"]);
  });

  it("newest / oldest are inverse", () => {
    const rows = [
      row({ id: "old", created_at: "2026-01-01T00:00:00Z" }),
      row({ id: "new", created_at: "2026-05-01T00:00:00Z" }),
    ];
    expect(sortTickets(rows, "newest")[0]?.id).toBe("new");
    expect(sortTickets(rows, "oldest")[0]?.id).toBe("old");
  });

  it("status: open → in_progress → waiting_on_customer → resolved → closed", () => {
    const statuses: SupportStatus[] = [
      "closed",
      "open",
      "resolved",
      "waiting_on_customer",
      "in_progress",
    ];
    const sorted = sortTickets(
      statuses.map((s, i) => row({ id: String(i), status: s })),
      "status",
    );
    expect(sorted.map((t) => t.status)).toEqual([
      "open",
      "in_progress",
      "waiting_on_customer",
      "resolved",
      "closed",
    ]);
  });
});

describe("filterTickets", () => {
  const rows = [
    row({ id: "1", subject: "Setup payment", category: "billing", priority: "high", status: "open", org_name: "Adams Roofing" }),
    row({ id: "2", subject: "Import broken", category: "migration", priority: "urgent", status: "in_progress", org_name: "Bell Bricks" }),
    row({ id: "3", subject: "Resolved one", category: "bug", priority: "low", status: "resolved", org_name: "Cosmos Co" }),
  ];

  it("q matches subject", () => {
    expect(filterTickets(rows, { q: "import" }).map((t) => t.id)).toEqual(["2"]);
  });

  it("q matches customer name", () => {
    expect(filterTickets(rows, { q: "Adams" }).map((t) => t.id)).toEqual(["1"]);
  });

  it("q matches ticket number prefix", () => {
    const stamped = rows.map((r, i) => row({ ...r, ticket_number: i + 10 }));
    expect(filterTickets(stamped, { q: "#10" }).length).toBe(1);
  });

  it("status='active' includes open / in_progress / waiting_on_customer only", () => {
    expect(filterTickets(rows, { status: "active" }).map((t) => t.id)).toEqual([
      "1",
      "2",
    ]);
  });

  it("status='resolved' includes only resolved", () => {
    expect(filterTickets(rows, { status: "resolved" }).map((t) => t.id)).toEqual([
      "3",
    ]);
  });

  it("category filter narrows correctly", () => {
    expect(filterTickets(rows, { category: "migration" })).toHaveLength(1);
  });

  it("priority filter narrows correctly", () => {
    expect(filterTickets(rows, { priority: "urgent" })).toHaveLength(1);
  });

  it("status='all' is a no-op", () => {
    expect(filterTickets(rows, { status: "all" })).toHaveLength(rows.length);
  });
});

describe("badgeText", () => {
  it("returns null at 0 so the UI hides the badge", () => {
    expect(badgeText(0)).toBeNull();
  });
  it("returns the count as a string for 1..99", () => {
    expect(badgeText(1)).toBe("1");
    expect(badgeText(99)).toBe("99");
  });
  it("clamps to 99+ above 99", () => {
    expect(badgeText(100)).toBe("99+");
    expect(badgeText(1234)).toBe("99+");
  });
});

// =====================================================================
// 3. Migration shape
// =====================================================================

describe("migration 20260610000000 — support_os", () => {
  it("creates both tables", () => {
    expect(MIGRATION).toMatch(/create table if not exists public\.support_tickets/);
    expect(MIGRATION).toMatch(/create table if not exists public\.support_messages/);
  });

  it("enforces the directive's statuses in a CHECK", () => {
    for (const s of SUPPORT_STATUSES) {
      expect(MIGRATION).toMatch(new RegExp(`'${s}'`));
    }
  });

  it("enforces the directive's priorities in a CHECK", () => {
    for (const p of SUPPORT_PRIORITIES) {
      expect(MIGRATION).toMatch(new RegExp(`'${p}'`));
    }
  });

  it("enforces the directive's categories in a CHECK", () => {
    for (const c of SUPPORT_CATEGORIES) {
      expect(MIGRATION).toMatch(new RegExp(`'${c}'`));
    }
  });

  it("RLS enabled on BOTH tables", () => {
    expect(MIGRATION).toMatch(/alter table public\.support_tickets enable row level security/);
    expect(MIGRATION).toMatch(/alter table public\.support_messages enable row level security/);
  });

  it("tenant SELECT policy scoped via current_org_ids()", () => {
    expect(MIGRATION).toMatch(/support_tickets_select[\s\S]*current_org_ids\(\)/);
    expect(MIGRATION).toMatch(/support_messages_select[\s\S]*current_org_ids\(\)/);
  });

  it("support_messages tenant SELECT excludes internal=true", () => {
    expect(MIGRATION).toMatch(/support_messages_select[\s\S]*internal = false/);
  });

  it("INSERT on support_messages forces author_kind='customer' AND internal=false", () => {
    expect(MIGRATION).toMatch(/support_messages_insert[\s\S]*author_kind = 'customer'[\s\S]*internal = false/);
  });

  it("DB-level CHECK: customer messages cannot be internal", () => {
    expect(MIGRATION).toMatch(/check \(author_kind = 'hq' or internal = false\)/);
  });

  it("unique (org_id, ticket_number) — per-org counter", () => {
    expect(MIGRATION).toMatch(/unique \(org_id, ticket_number\)/);
  });

  it("ticket-number trigger uses SECURITY DEFINER + locks org row", () => {
    expect(MIGRATION).toMatch(/_support_tickets_set_number[\s\S]*security definer/);
    expect(MIGRATION).toMatch(/for update/);
  });

  it("after-insert trigger updates parent ticket's last_reply_at + advances status", () => {
    expect(MIGRATION).toMatch(/_support_messages_after_insert/);
    expect(MIGRATION).toMatch(/last_reply_at\s+=\s+new\.created_at/);
    expect(MIGRATION).toMatch(/last_reply_kind\s+=\s+new\.author_kind/);
    expect(MIGRATION).toMatch(/case[\s\S]*waiting_on_customer/);
  });

  it("indexes cover org+recent, status+priority, open partial, assigned partial", () => {
    expect(MIGRATION).toMatch(/support_tickets_org_recent_idx/);
    expect(MIGRATION).toMatch(/support_tickets_status_priority_idx/);
    expect(MIGRATION).toMatch(/support_tickets_open_idx/);
    expect(MIGRATION).toMatch(/support_tickets_assigned_idx/);
    expect(MIGRATION).toMatch(/support_messages_ticket_idx/);
  });
});

// =====================================================================
// 4. Server actions — both sides
// =====================================================================

describe("customer server actions", () => {
  it("createSupportTicket gates on requireOrgContext()", () => {
    expect(CUSTOMER_ACTIONS).toMatch(/requireOrgContext/);
  });

  it("seeds a customer-kind first message after ticket insert", () => {
    expect(CUSTOMER_ACTIONS).toMatch(/author_kind: "customer"/);
    expect(CUSTOMER_ACTIONS).toMatch(/internal: false/);
  });

  it("uses Zod to validate every directive enum", () => {
    expect(CUSTOMER_ACTIONS).toMatch(/z\.enum\(SUPPORT_PRIORITIES\)/);
    expect(CUSTOMER_ACTIONS).toMatch(/z\.enum\(SUPPORT_CATEGORIES\)/);
  });

  it("writes admin_activity_log on create + reply", () => {
    expect(CUSTOMER_ACTIONS).toMatch(/recordAdminActivity/);
    expect(CUSTOMER_ACTIONS).toMatch(/"support\.ticket_created"/);
    expect(CUSTOMER_ACTIONS).toMatch(/"support\.customer_reply"/);
  });

  it("never sets internal=true (DB CHECK enforces; pinning belt-and-braces here)", () => {
    expect(CUSTOMER_ACTIONS).not.toMatch(/internal:\s*true/);
  });
});

describe("HQ server actions", () => {
  it("every action re-checks isSuperAdminEmail", () => {
    expect(HQ_ACTIONS).toMatch(/isSuperAdminEmail/);
    expect(HQ_ACTIONS).toMatch(/requireAdmin/);
  });

  it("exports replyAsHq + setTicketStatus + setTicketPriority + setTicketCategory + assignTicket", () => {
    for (const fn of [
      "replyAsHq",
      "setTicketStatus",
      "setTicketPriority",
      "setTicketCategory",
      "assignTicket",
    ]) {
      expect(HQ_ACTIONS).toMatch(new RegExp(`export async function ${fn}`));
    }
  });

  it("dual-writes admin_activity_log (ticket + org targets)", () => {
    const occurrences = (HQ_ACTIONS.match(/recordAdminActivity\(/g) ?? []).length;
    // 5 actions, most write 2 audit rows = 8+ in practice.
    expect(occurrences).toBeGreaterThanOrEqual(7);
  });

  it("Zod schemas enforce closed-set enums", () => {
    expect(HQ_ACTIONS).toMatch(/z\.enum\(SUPPORT_STATUSES\)/);
    expect(HQ_ACTIONS).toMatch(/z\.enum\(SUPPORT_PRIORITIES\)/);
    expect(HQ_ACTIONS).toMatch(/z\.enum\(SUPPORT_CATEGORIES\)/);
  });

  it("replyAsHq supports internal=true (HQ-only notes)", () => {
    expect(HQ_ACTIONS).toMatch(/internal: isInternal/);
    expect(HQ_ACTIONS).toMatch(/"support\.internal_note"/);
    expect(HQ_ACTIONS).toMatch(/"support\.hq_reply"/);
  });

  it("setTicketStatus stamps resolved_at / closed_at and clears them on reopen", () => {
    expect(HQ_ACTIONS).toMatch(/patch\.resolved_at = now/);
    expect(HQ_ACTIONS).toMatch(/patch\.closed_at = now/);
    expect(HQ_ACTIONS).toMatch(/patch\.resolved_at = null/);
  });
});

// =====================================================================
// 5. Customer page wiring
// =====================================================================

describe("customer-side pages", () => {
  it("list page uses listMySupportTickets (RLS-scoped service)", () => {
    expect(CUSTOMER_LIST).toMatch(/listMySupportTickets/);
  });

  it("new-ticket form wires every directive field", () => {
    expect(CUSTOMER_NEW).toMatch(/name="subject"/);
    expect(CUSTOMER_NEW).toMatch(/name="body"/);
    expect(CUSTOMER_NEW).toMatch(/name="priority"/);
    expect(CUSTOMER_NEW).toMatch(/name="category"/);
    expect(CUSTOMER_NEW).toMatch(/action=\{createSupportTicket\}/);
  });

  it("detail page renders the thread + reply form for active tickets", () => {
    expect(CUSTOMER_DETAIL).toMatch(/replyToSupportTicket/);
    expect(CUSTOMER_DETAIL).toMatch(/loadMySupportTicket/);
  });

  it("detail page hides reply form when ticket is resolved/closed", () => {
    expect(CUSTOMER_DETAIL).toMatch(/isClosed/);
    expect(CUSTOMER_DETAIL).toMatch(/Open a new ticket/);
  });
});

describe("customer service — never leaks HQ author names", () => {
  it("masks HQ author_name as 'CrewFlow Support' (PII firewall)", () => {
    expect(CUSTOMER_SVC).toMatch(/"CrewFlow Support"/);
  });
});

// =====================================================================
// 6. HQ page wiring
// =====================================================================

describe("HQ page wiring", () => {
  it("list page calls listSupportTicketsForHq + filterTickets + sortTickets", () => {
    expect(HQ_LIST).toMatch(/listSupportTicketsForHq/);
    expect(HQ_LIST).toMatch(/filterTickets/);
    expect(HQ_LIST).toMatch(/sortTickets/);
  });

  it("list page renders 4 KPI tiles (active/urgent/owe-customer/resolved-7d)", () => {
    expect(HQ_LIST).toMatch(/Active/);
    expect(HQ_LIST).toMatch(/Urgent/);
    expect(HQ_LIST).toMatch(/Awaiting CrewFlow/);
    expect(HQ_LIST).toMatch(/Resolved this week/);
  });

  it("list page shows internal-notes badge on rows that have them", () => {
    expect(HQ_LIST).toMatch(/internal notes/);
  });

  it("detail page wires every state-changing form (status/priority/category)", () => {
    expect(HQ_DETAIL).toMatch(/setTicketStatus/);
    expect(HQ_DETAIL).toMatch(/setTicketPriority/);
    expect(HQ_DETAIL).toMatch(/setTicketCategory/);
    expect(HQ_DETAIL).toMatch(/replyAsHq/);
  });

  it("detail page surfaces internal note checkbox", () => {
    // The reply UI is the sibling client component since Phase 5 —
    // the page just embeds <SupportReplyForm/>.
    expect(HQ_DETAIL).toMatch(/<SupportReplyForm/);
    expect(HQ_DETAIL_REPLY).toMatch(/name="internal"/);
    expect(HQ_DETAIL_REPLY).toMatch(/Internal note/);
  });

  it("detail page links back to /admin/customers/<org_id>", () => {
    expect(HQ_DETAIL).toMatch(/\/admin\/customers\/\$\{ticket\.org_id\}/);
  });

  it("HQ snapshot service runs one batched query for messages (no N+1)", () => {
    expect(HQ_SNAPSHOT).toMatch(/\.in\("ticket_id", ticketIds\)/);
  });

  it("HQ snapshot exposes countOpenSupportTicketsForHq for the badge", () => {
    expect(HQ_SNAPSHOT).toMatch(/export async function countOpenSupportTicketsForHq/);
  });
});

// =====================================================================
// 7. Sidebar / HQ_NAV / badge wiring
// =====================================================================

describe("Customer sidebar", () => {
  it("carries a /support link in ADMIN_LINKS", () => {
    expect(SIDEBAR).toMatch(/href: "\/support", label: "Support"/);
  });
  it("also offers Support to staff role", () => {
    // Both link arrays expose /support so even staff can raise tickets.
    const supportCount = (SIDEBAR.match(/"\/support"/g) ?? []).length;
    expect(supportCount).toBeGreaterThanOrEqual(2);
  });
});

describe("HQ_NAV — support is ready + badge wired", () => {
  it("support entry has no shipsIn flag", () => {
    expect(HQ_LAYOUT).toMatch(/href: "\/admin\/support", label: "Support queue" \}/);
    expect(HQ_LAYOUT).not.toMatch(/href: "\/admin\/support"[^}]*shipsIn:/);
  });

  it("countOpenSupportTicketsForHq drives the badge", () => {
    expect(HQ_LAYOUT).toMatch(/countOpenSupportTicketsForHq/);
    expect(HQ_LAYOUT).toMatch(/supportBadge/);
  });

  it("layout best-effort wraps count (failures degrade to no badge)", () => {
    expect(HQ_LAYOUT).toMatch(/\.catch\(\(\) => 0\)/);
  });

  it("NavLink renders badge prop for the support entry", () => {
    expect(HQ_LAYOUT).toMatch(/badge=\{[^}]*supportBadge/);
  });
});
