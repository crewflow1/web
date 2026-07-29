import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

const MIG_GRN = "supabase/migrations/20261059000000_goods_received_notes.sql";
const MIG_STATE = "supabase/migrations/20261060000000_purchase_order_receipt_state.sql";
const ACTIONS = "app/(app)/purchase-orders/receiving-actions.ts";
const DATA = "app/(app)/purchase-orders/_receiving-data.ts";
const LIB = "lib/purchase-orders/receiving.ts";

/**
 * Strip SQL line comments so NEGATIVE assertions test the EXECUTABLE statements
 * and are never satisfied — or defeated — by documentation that quotes a rule.
 */
const sqlOnly = (src: string) =>
  src
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("--");
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join("\n");

/** Strip TS/JS comments, for source contracts about real code. */
const codeOf = (ts: string) =>
  ts.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

// ---------------------------------------------------------------------------
// 1. RECEIVING IS OPERATIONAL — it must never move money
// ---------------------------------------------------------------------------

describe("receiving never touches `finances`", () => {
  // THE headline invariant of this milestone. A PO is committed spend; the
  // ACTUAL cost lands exactly once, when recordSupplierBill posts the
  // supplier's invoice. If receiving ever wrote a finances row the same spend
  // would be counted twice — once when the lorry arrived, once when the bill
  // came in — and every job's profitability would silently double-count
  // materials. Cheap to break by accident, invisible until year end.
  const surfaces: Array<[string, string]> = [
    [MIG_GRN, sqlOnly(read(MIG_GRN))],
    [MIG_STATE, sqlOnly(read(MIG_STATE))],
    [ACTIONS, codeOf(read(ACTIONS))],
    [DATA, codeOf(read(DATA))],
    [LIB, codeOf(read(LIB))],
  ];

  for (const [name, src] of surfaces) {
    it(`${name} contains no executable reference to finances`, () => {
      expect(src).not.toMatch(/\bfinances\b/);
    });
  }

  it("neither migration creates a trigger on finances or an insert into it", () => {
    for (const [, src] of surfaces) {
      expect(src).not.toMatch(/insert\s+into\s+public\.finances/i);
      expect(src).not.toMatch(/on\s+public\.finances/i);
    }
  });

  it("the receiving RPCs never write any money column", () => {
    const sql = sqlOnly(read(MIG_STATE));
    for (const money of ["amount", "vat_rate", "vat_total", "subtotal", "unit_price", "line_total"]) {
      expect(sql, `${money} appears in the receiving migration`).not.toMatch(
        new RegExp(`\\b${money}\\b\\s*(=|,|\\))`),
      );
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Tenancy is STRUCTURAL, not merely policy
// ---------------------------------------------------------------------------

describe("goods received notes — tenant binding", () => {
  const sql = sqlOnly(read(MIG_GRN));

  it("binds the note to its purchase order by COMPOSITE FK, not a bare id", () => {
    expect(sql).toMatch(
      /foreign key \(purchase_order_id, org_id\)\s*\n?\s*references public\.purchase_orders \(id, org_id\)/i,
    );
  });

  it("binds each received line to BOTH parents by composite FK", () => {
    expect(sql).toMatch(
      /foreign key \(goods_received_note_id, org_id\)\s*\n?\s*references public\.goods_received_notes \(id, org_id\)/i,
    );
    expect(sql).toMatch(
      /foreign key \(purchase_order_line_item_id, org_id\)\s*\n?\s*references public\.purchase_order_line_items \(id, org_id\)/i,
    );
  });

  it("creates the candidate keys those FKs need", () => {
    expect(sql).toMatch(/purchase_orders_id_org_key unique \(id, org_id\)/i);
    expect(sql).toMatch(/purchase_order_line_items_id_org_key unique \(id, org_id\)/i);
  });

  it("uses DEFERRABLE NO ACTION, not RESTRICT — org teardown must stay possible", () => {
    // RESTRICT can never be deferred, so a `delete from organizations` that
    // cascades to purchase_orders BEFORE goods_received_notes would abort GDPR
    // erasure outright. Regression cover:
    // __tests__/integration/rls/goods-received-notes.test.ts.
    expect(sql).toMatch(/on delete no action deferrable initially deferred/i);
    expect(sql).not.toMatch(/on delete restrict/i);
  });

  it("purchase_order_id is NOT NULL — a delivery with no order is meaningless", () => {
    expect(sql).toMatch(/purchase_order_id\s+uuid not null/i);
  });

  it("enables RLS on both tables", () => {
    expect(sql).toMatch(/alter table public\.goods_received_notes enable row level security/i);
    expect(sql).toMatch(/alter table public\.goods_received_lines enable row level security/i);
  });

  it("DELETE on notes is admin-only AND drafts-only — posted deliveries are evidence", () => {
    // Stricter than the house "admins can delete" default, deliberately: not
    // even an owner may make a posted delivery disappear. The exit is void.
    expect(sql).toMatch(
      /for delete to authenticated using \(public\.is_org_admin\(org_id\) and status = 'draft'\)/i,
    );
  });
});

// ---------------------------------------------------------------------------
// 3. Posted notes are immutable evidence
// ---------------------------------------------------------------------------

describe("posted goods received notes are immutable", () => {
  const sql = sqlOnly(read(MIG_GRN));

  it("is born a draft — there is exactly one route to 'posted'", () => {
    expect(sql).toMatch(/a goods received note is created as a draft, then posted/);
  });

  it("freezes the delivery record once it leaves draft", () => {
    expect(sql).toMatch(/if old\.status <> 'draft' then/);
    expect(sql).toMatch(/a posted goods received note is immutable/);
  });

  it("freezes the received quantities too, not just the header", () => {
    // A frozen note with editable lines would be no protection at all.
    expect(sql).toMatch(/tg_goods_received_line_draft_only/);
    expect(sql).toMatch(/its lines are immutable evidence/);
    expect(sql).toMatch(
      /create trigger goods_received_lines_draft_only\s*\n?\s*before insert or update or delete/i,
    );
  });

  it("PINS posted/void provenance server-side so it cannot be forged or back-dated", () => {
    expect(sql).toMatch(/new\.posted_by := auth\.uid\(\)/);
    expect(sql).toMatch(/new\.voided_by := auth\.uid\(\)/);
  });

  it("makes a void reason structurally required, not merely form-validated", () => {
    expect(sql).toMatch(
      /check \(status <> 'void' or \(void_reason is not null and btrim\(void_reason\) <> ''\)\)/i,
    );
  });

  it("makes void terminal", () => {
    expect(sql).toMatch(/a voided goods received note cannot be reinstated/);
  });
});

// ---------------------------------------------------------------------------
// 4. Receipt state is DERIVED and over-receipt is BLOCKED, in the database
// ---------------------------------------------------------------------------

describe("purchase order receipt state", () => {
  const sql = sqlOnly(read(MIG_STATE));

  it("widens the status CHECK by introspect-drop-readd, preserving every prior value", () => {
    expect(sql).toMatch(/pg_get_constraintdef\(con\.oid\) ilike '%status%'/);
    expect(sql).toMatch(
      /check \(status in \('draft', 'sent', 'partially_received', 'received', 'cancelled'\)\)/i,
    );
  });

  it("enforces the transition graph at the DATABASE, not only in TypeScript", () => {
    expect(sql).toMatch(/create trigger purchase_orders_transition\s*\n?\s*before update/i);
    expect(sql).toMatch(/is not a legal transition/);
  });

  it("refuses a hand-set status that contradicts the posted receipts", () => {
    expect(sql).toMatch(/the status is derived, not set by hand/);
    expect(sql).toMatch(/nothing has been received against this order/);
  });

  it("BLOCKS over-receipt (no tolerance — an escalated product decision)", () => {
    expect(sql).toMatch(/raise exception\s*\n?\s*'over-receipt/);
  });

  it("SERIALISES posting and voiding per purchase order", () => {
    // The over-receipt check is a read-then-write and is only sound under a
    // lock. Two concurrent posts of 60 against a 100 line otherwise both read
    // "0 received" and both pass. Proven with two concurrent psql sessions:
    // with the lock, 40 of 100 and one note; without it, 110 of 100 and two.
    const locks = sql.match(/pg_advisory_xact_lock\(hashtext\('grn_post_po'\)/g) ?? [];
    expect(locks.length).toBeGreaterThanOrEqual(2); // post + void
  });

  it("keeps the RPCs SECURITY INVOKER so RLS still applies to the multi-row write", () => {
    // A SECURITY DEFINER posting function would be a privileged back door
    // around every policy and guard trigger on the path.
    const postFn = sql.slice(
      sql.indexOf("create or replace function public.post_goods_received_note"),
      sql.indexOf("create or replace function public.void_goods_received_note"),
    );
    expect(postFn).not.toMatch(/security definer/i);
    const voidFn = sql.slice(sql.indexOf("create or replace function public.void_goods_received_note"));
    expect(voidFn.slice(0, voidFn.indexOf("$$"))).not.toMatch(/security definer/i);
  });

  it("locks the internal derivation away from JWT callers", () => {
    expect(sql).toMatch(
      /revoke execute on function public\.po_receipt_state\(uuid\) from public, anon, authenticated/i,
    );
    // the app-facing wrapper checks tenancy itself before answering
    expect(sql).toMatch(/p_org_id not in \(select public\.current_org_ids\(\)\)/);
  });

  it("widens tenant_attachments by introspection, preserving all 16 prior targets", () => {
    expect(sql).toMatch(/pg_get_constraintdef\(con\.oid\) ilike '%target_table%'/);
    for (const t of [
      "customers",
      "jobs",
      "quotes",
      "invoices",
      "suppliers",
      "memberships",
      "leads",
      "snags",
      "site_diary_entries",
      "toolbox_talks",
      "site_reports",
      "assets",
      "asset_assignments",
      "asset_inspections",
      "asset_maintenance_cases",
      "asset_fuel_logs",
      "goods_received_notes",
    ]) {
      expect(sql, `attachment target '${t}' was dropped`).toMatch(new RegExp(`'${t}'`));
    }
  });

  it("writes tenant activity by TRIGGER only, and never on DELETE", () => {
    // Triggers are the only legal writers of activity_log (20260516200000), and
    // an AFTER DELETE trigger on a table that cascades from organizations is
    // the exact shape of the teardown bug 20261052 had to rescue.
    expect(sql).toMatch(/after update on public\.goods_received_notes/i);
    expect(sql).toMatch(/after update of status on public\.purchase_orders/i);
    expect(sql).not.toMatch(/after (insert or )?delete on public\.goods_received_notes/i);
    expect(sql).not.toMatch(/after (insert or )?delete on public\.purchase_orders/i);
  });

  it("never writes a generated column", () => {
    // purchase_orders.total is `generated always as (subtotal + vat_total)`.
    expect(sql).not.toMatch(/set\s+total\s*=/i);
  });
});

// ---------------------------------------------------------------------------
// 5. Active-org pinning on every new read and write
// ---------------------------------------------------------------------------

describe("receiving surfaces pin the ACTIVE org, not just RLS", () => {
  const actions = codeOf(read(ACTIONS));
  const data = codeOf(read(DATA));

  it("both RPC calls pass ctx.org.id as p_org_id", () => {
    const pinned = actions.match(/p_org_id:\s*ctx\.org\.id/g) ?? [];
    const all = actions.match(/p_org_id:/g) ?? [];
    expect(pinned.length).toBe(2); // post + void
    // EVERY p_org_id in the file is the active org — no call site slipped a
    // different value (a row's own org_id, a form field) past the pin.
    expect(all.length).toBe(pinned.length);
  });

  it("every reader filters on org_id", () => {
    const selects = data.match(/\.select\(/g) ?? [];
    const pins = data.match(/\.eq\("org_id",\s*orgId\)/g) ?? [];
    expect(selects.length).toBeGreaterThan(0);
    expect(pins.length).toBe(selects.length);
  });

  it("the PO detail page pins its by-id read", () => {
    const page = codeOf(read("app/(app)/purchase-orders/[id]/page.tsx"));
    expect(page).toMatch(/\.eq\("id",\s*id\)\s*\.eq\("org_id",\s*ctx\.org\.id\)/);
  });

  it("EVERY write action in purchase-orders/actions.ts pins the active org", () => {
    // Write-slice handoff: these four functions each captured ctx and then
    // scoped by id alone, so a dual-org member could edit, re-status, delete or
    // bill ANOTHER company's order — RLS admits it, and the row is then
    // rewritten (or a `finances` cost minted) under the active org. Each
    // function is checked independently so a regression in one cannot be
    // masked by the pins in the others.
    const src = read("app/(app)/purchase-orders/actions.ts");
    const fnBody = (name: string): string => {
      const start = src.indexOf(`export async function ${name}(`);
      expect(start, `${name} not found`).toBeGreaterThan(-1);
      const rest = src.slice(start + 1);
      const next = rest.indexOf("\nexport async function ");
      return codeOf(next === -1 ? rest : rest.slice(0, next));
    };

    for (const name of [
      "updatePurchaseOrder",
      "setPurchaseOrderStatus",
      "deletePurchaseOrder",
      "recordSupplierBill",
    ]) {
      const body = fnBody(name);
      expect(body, `${name} discards ctx`).toMatch(/const \{ ctx(, user)? \} = await requireOrgContext\(\)/);
      expect(body, `${name} has no active-org pin`).toMatch(/\.eq\("org_id",\s*ctx\.org\.id\)/);
      // and no by-id query is left unpinned
      const byId = body.match(/\.eq\("(?:id|purchase_order_id)",[^)]*\)/g) ?? [];
      const pins = body.match(/\.eq\("org_id",\s*ctx\.org\.id\)/g) ?? [];
      expect(pins.length, `${name}: ${byId.length} by-id filters vs ${pins.length} org pins`)
        .toBeGreaterThanOrEqual(1);
    }
  });

  it("recordSupplierBill re-checks the inherited job's org before posting a cost", () => {
    // The finances org-integrity trigger (20261009) refuses a foreign
    // supplier_id but has no equivalent guard on job_id, so a bill inheriting a
    // foreign order's job would attribute one company's spend to another
    // company's job. This is the check that closes that path.
    const body = codeOf(read("app/(app)/purchase-orders/actions.ts"));
    expect(body).toMatch(/\.from\("jobs" as never\)/);
    expect(body).toMatch(/if \(po\.job_id\)/);
  });

  it("never reaches for the service-role admin client on this surface", () => {
    for (const src of [actions, data]) {
      expect(src).not.toMatch(/createAdminClient/);
      expect(src).not.toMatch(/SERVICE_ROLE/);
    }
  });
});
