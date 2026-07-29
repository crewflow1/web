import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

const MIG_ITEMS = "supabase/migrations/20261063000000_stock_items.sql";
const MIG_LEDGER = "supabase/migrations/20261064000000_stock_movements.sql";
const MIG_RPCS = "supabase/migrations/20261065000000_stock_rpcs.sql";
const ACTIONS = "app/(app)/stock/actions.ts";
const SERVICE = "server/services/stock.ts";
const LIB_BALANCE = "lib/stock/balance.ts";
const LIB_MOVEMENTS = "lib/stock/movements.ts";
const LIB_SCHEMA = "lib/stock/schema.ts";
const UI_RECEIVE = "app/(app)/purchase-orders/[id]/_receive-into-stock.tsx";
const UI_MOVE = "app/(app)/stock/items/[id]/_move-forms.tsx";
const DOC = "docs/operational-stock.md";

/** Strip SQL line comments so NEGATIVE assertions test the EXECUTABLE statements. */
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
// 1. THE ACCOUNTING BOUNDARY — stock must never move money
// ---------------------------------------------------------------------------

describe("operational stock never touches `finances`", () => {
  // THE headline invariant of this milestone, and the reason it was allowed to
  // ship while CEO decision D1 (stock valuation) is undecided.
  //
  // Purchased materials are ALREADY expensed by recordSupplierBill. If a stock
  // movement ever posted to `finances`, the same spend would land twice — once
  // when the supplier invoiced, once when the boards were issued — and every
  // affected job's cost would be silently inflated. Invisible until year end,
  // and one line of code away at any time.
  const surfaces: Array<[string, string]> = [
    [MIG_ITEMS, sqlOnly(read(MIG_ITEMS))],
    [MIG_LEDGER, sqlOnly(read(MIG_LEDGER))],
    [MIG_RPCS, sqlOnly(read(MIG_RPCS))],
    [ACTIONS, codeOf(read(ACTIONS))],
    [SERVICE, codeOf(read(SERVICE))],
    [LIB_BALANCE, codeOf(read(LIB_BALANCE))],
    [LIB_MOVEMENTS, codeOf(read(LIB_MOVEMENTS))],
    [LIB_SCHEMA, codeOf(read(LIB_SCHEMA))],
    [UI_RECEIVE, codeOf(read(UI_RECEIVE))],
    [UI_MOVE, codeOf(read(UI_MOVE))],
  ];

  for (const [name, src] of surfaces) {
    it(`${name} contains no executable reference to finances`, () => {
      expect(src).not.toMatch(/\bfinances\b/);
    });
  }

  it("no migration in this diff writes to finances or puts a trigger on it", () => {
    for (const [, src] of surfaces) {
      expect(src).not.toMatch(/insert\s+into\s+public\.finances/i);
      expect(src).not.toMatch(/update\s+public\.finances/i);
      expect(src).not.toMatch(/delete\s+from\s+public\.finances/i);
      expect(src).not.toMatch(/on\s+public\.finances/i);
    }
  });

  it("the schema carries NO money column at all — a valuation cannot be computed", () => {
    // Not "does not post a cost": there is nowhere to put one. `unit_price`,
    // `cost`, `value`, `amount`, `vat` do not exist on stock_items or
    // stock_movements, so even a well-meaning report cannot invent a figure.
    const sql = sqlOnly(read(MIG_ITEMS)) + "\n" + sqlOnly(read(MIG_LEDGER));
    for (const money of [
      "unit_cost",
      "unit_price",
      "cost",
      "value",
      "amount",
      "vat_rate",
      "vat_total",
      "subtotal",
      "line_total",
      "currency",
      "price",
    ]) {
      expect(sql, `${money} appears in the stock schema`).not.toMatch(
        new RegExp(`\\b${money}\\s+(numeric|integer|text|money|decimal)`, "i"),
      );
    }
  });

  it("no stock RPC accepts or writes a money value", () => {
    const sql = sqlOnly(read(MIG_RPCS));
    for (const money of ["p_price", "p_cost", "p_value", "p_amount", "p_vat"]) {
      expect(sql, `${money} is a parameter of a stock RPC`).not.toMatch(
        new RegExp(`\\b${money}\\b`),
      );
    }
  });

  it("the boundary is DOCUMENTED where a contributor will actually read it", () => {
    // Three places, because the temptation arrives from three directions: the
    // schema, the module, and the domain doc.
    for (const [name, src] of [
      [MIG_ITEMS, read(MIG_ITEMS)],
      [MIG_LEDGER, read(MIG_LEDGER)],
      [MIG_RPCS, read(MIG_RPCS)],
      [LIB_MOVEMENTS, read(LIB_MOVEMENTS)],
      [DOC, read(DOC)],
    ] as const) {
      expect(src, `${name} must state the accounting boundary`).toMatch(
        /ACCOUNTING BOUNDARY/,
      );
      expect(src, `${name} must name the double-count risk`).toMatch(
        /double-count|double count/i,
      );
      expect(src, `${name} must name D1 as undecided`).toMatch(/D1/);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. The ledger is APPEND-ONLY, structurally
// ---------------------------------------------------------------------------

describe("stock_movements is append-only", () => {
  const sql = sqlOnly(read(MIG_LEDGER));

  it("refuses EVERY update with a dedicated trigger", () => {
    expect(sql).toMatch(/create trigger stock_movements_append_only\s*\n?\s*before update/i);
    expect(sql).toMatch(/is immutable — record a correction movement/);
  });

  it("refuses every targeted delete, for EVERY role, while allowing org teardown", () => {
    expect(sql).toMatch(/create trigger stock_movements_no_delete\s*\n?\s*before delete/i);
    // The 20261047000000 idiom: during a cascade the parent org is already
    // invisible, so a targeted delete always sees it and is always refused.
    expect(sql).toMatch(/if exists \(select 1 from public\.organizations where id = old\.org_id\)/);
    expect(sql).toMatch(/the ledger is append-only/);
  });

  it("grants NO update or delete policy — a member is refused twice over", () => {
    expect(sql).toMatch(/create policy "stock_movements: members can select"/);
    expect(sql).toMatch(/create policy "stock_movements: members can insert"/);
    expect(sql).not.toMatch(/create policy "stock_movements: [^"]*update"/);
    expect(sql).not.toMatch(/create policy "stock_movements: [^"]*delete"/);
  });

  it("has NO stored balance column anywhere in the milestone", () => {
    // The whole design: a stored running total is a second source of truth that
    // lies silently the first time a write is lost.
    // Scoped to the TABLE migrations: `v_balance numeric` in the RPCs is a
    // local variable inside a transaction, not a stored column.
    const tables = sqlOnly(read(MIG_ITEMS)) + "\n" + sql;
    for (const col of ["current_quantity", "quantity_on_hand", "on_hand", "stock_level", "qty_on_hand"]) {
      expect(tables, `${col} would be a second source of truth`).not.toMatch(
        new RegExp(`\\b${col}\\b`, "i"),
      );
    }
    expect(sql, "balance must be derived by a function").toMatch(
      /create or replace function public\.stock_balance\(/,
    );
  });

  it("the balance function and the view are SECURITY INVOKER, so RLS still applies", () => {
    const fn = sql.slice(
      sql.indexOf("create or replace function public.stock_balance("),
      sql.indexOf("grant execute on function public.stock_balance"),
    );
    expect(fn).not.toMatch(/security definer/i);
    // A view runs as its OWNER by default, which would bypass RLS entirely.
    expect(sql).toMatch(/create or replace view public\.stock_balances\s*\n?\s*with \(security_invoker = true\)/i);
  });

  it("the SIGN is assigned by trigger, so a caller cannot forge it", () => {
    expect(sql).toMatch(/create trigger stock_movements_derive\s*\n?\s*before insert/i);
    expect(sql).toMatch(/new\.effect := new\.qty;/);
    expect(sql).toMatch(/new\.effect := - new\.qty;/);
    expect(sql).toMatch(/new\.effect := - v_effect;/);
    expect(sql).toMatch(/check \(qty > 0\)/);
  });

  it("a reason is STRUCTURALLY required on adjustments and corrections", () => {
    expect(sql).toMatch(/stock_movements_reason_required/);
    expect(sql).toMatch(/movement_type not in \('adjustment_in', 'adjustment_out', 'correction'\)/);
  });

  it("writes tenant activity by TRIGGER only, and never on DELETE", () => {
    // Triggers are the only legal writers of activity_log (20260516200000), and
    // an AFTER DELETE trigger on a table that cascades from organizations is the
    // exact shape of the teardown bug 20261052 had to rescue.
    expect(sql).toMatch(/after insert on public\.stock_movements/i);
    expect(sql).not.toMatch(/after (insert or )?(update or )?delete on public\.stock_movements/i);
  });
});

// ---------------------------------------------------------------------------
// 3. Tenancy is STRUCTURAL, not merely policy
// ---------------------------------------------------------------------------

describe("stock tenant binding", () => {
  const sql = sqlOnly(read(MIG_LEDGER));

  it("binds the movement to its item, site, delivery line and corrected row by COMPOSITE FK", () => {
    for (const [cols, target] of [
      ["stock_item_id, org_id", "public.stock_items \\(id, org_id\\)"],
      ["site_id, org_id", "public.sites \\(id, org_id\\)"],
      ["grn_line_id, org_id", "public.goods_received_lines \\(id, org_id\\)"],
      ["corrects_movement_id, org_id", "public.stock_movements \\(id, org_id\\)"],
    ] as const) {
      expect(
        sql,
        `${cols} must be bound by composite FK`,
      ).toMatch(new RegExp(`foreign key \\(${cols}\\)\\s*\\n?\\s*references ${target}`, "i"));
    }
  });

  it("creates the candidate keys those FKs need (additive, never rejecting a row)", () => {
    expect(sql).toMatch(/sites_id_org_key unique \(id, org_id\)/i);
    expect(sql).toMatch(/goods_received_lines_id_org_key unique \(id, org_id\)/i);
    expect(sql).toMatch(/stock_movements_id_org_key unique \(id, org_id\)/i);
    expect(sqlOnly(read(MIG_ITEMS))).toMatch(/stock_items_id_org_key unique \(id, org_id\)/i);
  });

  it("uses DEFERRABLE NO ACTION, not RESTRICT — org teardown must stay possible", () => {
    // RESTRICT can never be deferred, so a `delete from organizations` that
    // cascades one side before the other would abort GDPR erasure outright.
    expect(sql).toMatch(/on delete no action deferrable initially deferred/i);
    expect(sql).not.toMatch(/on delete restrict/i);
  });

  it("guards job_id by trigger, because a composite FK cannot express SET NULL", () => {
    // Losing a job must lose the LINK, never the movement — the ledger outlives
    // every job run from it (the 20261011000000 constraint).
    expect(sql).toMatch(/job_id\s+uuid references public\.jobs\(id\) on delete set null/i);
    expect(sql).toMatch(/raise exception 'job % is not in org %'/);
  });

  it("guards stock_items.preferred_supplier_id the same way", () => {
    const items = sqlOnly(read(MIG_ITEMS));
    expect(items).toMatch(/create trigger stock_items_supplier_org/i);
    expect(items).toMatch(/raise exception 'supplier % is not in org %'/);
  });

  it("enables RLS on both tables", () => {
    expect(sqlOnly(read(MIG_ITEMS))).toMatch(/alter table public\.stock_items enable row level security/i);
    expect(sql).toMatch(/alter table public\.stock_movements enable row level security/i);
  });
});

// ---------------------------------------------------------------------------
// 4. Negative stock is refused, under a lock
// ---------------------------------------------------------------------------

describe("negative stock is refused and the check is serialised", () => {
  const sql = sqlOnly(read(MIG_RPCS));

  it("every outbound path takes the per-(item, site) advisory lock BEFORE reading", () => {
    // The refusal is a read-then-write and is only sound under a lock: two
    // operators issuing the last 10 units otherwise both read "10 available".
    // Proven with two real psql sessions — with the lock one commits and one is
    // refused (balance 0); without it both commit and the balance is -10.
    // Transcript in docs/operational-stock.md.
    const locks = sql.match(/pg_advisory_xact_lock\(\s*\n?\s*hashtext\('stock_balance'\)/g) ?? [];
    expect(locks.length, "issue + transfer + adjustment + correction").toBe(4);
    expect(sql).toMatch(/create or replace function public\.stock_lock_key\(/);
  });

  it("refuses to issue, transfer, adjust down or reverse below zero", () => {
    expect(sql).toMatch(/not enough %: % in stock at this site/);
    expect(sql).toMatch(/not enough %: % in stock at the site it is leaving/);
    expect(sql).toMatch(/cannot write off % of %/);
    expect(sql).toMatch(/cannot reverse % units/);
  });

  it("keeps every RPC SECURITY INVOKER so RLS and every guard still apply", () => {
    // A SECURITY DEFINER write path would be a privileged back door around every
    // policy, composite FK and guard trigger on the path.
    const names = [
      "record_stock_receipt_from_grn",
      "record_stock_issue",
      "record_stock_transfer",
      "record_stock_adjustment",
      "record_stock_correction",
    ];
    for (const name of names) {
      const start = sql.indexOf(`create or replace function public.${name}(`);
      expect(start, `${name} not found`).toBeGreaterThan(-1);
      const header = sql.slice(start, sql.indexOf("$$", start));
      expect(header, `${name} must not be SECURITY DEFINER`).not.toMatch(/security definer/i);
    }
  });

  it("adjustments are ADMIN-ONLY — the one movement with no counterparty", () => {
    expect(sql).toMatch(/if auth\.uid\(\) is not null and not public\.is_org_admin\(p_org_id\) then/);
    expect(sql).toMatch(/only an owner or admin can adjust stock/);
    // and the app mirrors it so a member sees a sentence, not a raw refusal
    expect(codeOf(read(ACTIONS))).toMatch(/ctx\.membership\.role === "owner" \|\| ctx\.membership\.role === "admin"/);
  });
});

// ---------------------------------------------------------------------------
// 5. GRN → stock: idempotent, posted-only, and the void rule
// ---------------------------------------------------------------------------

describe("the GRN → stock bridge", () => {
  const sql = sqlOnly(read(MIG_RPCS));
  const ledger = sqlOnly(read(MIG_LEDGER));

  it("is IDEMPOTENT by a partial unique index, not merely by a pre-check", () => {
    expect(ledger).toMatch(
      /create unique index if not exists stock_movements_grn_line_receipt_uniq\s*\n?\s*on public\.stock_movements \(grn_line_id\)\s*\n?\s*where movement_type = 'receipt'/i,
    );
    // …and the RPC returns the existing movement rather than an error, so a
    // double tap in a yard reads as success.
    expect(sql).toMatch(/return v_existing;/);
    expect(sql).toMatch(/when unique_violation then/);
  });

  it("refuses a delivery that has not been POSTED", () => {
    expect(sql).toMatch(/post it before taking it into stock/);
  });

  it("never infers a stock item from the free-text ordered line", () => {
    // PO lines are free text (20261006000000). Guessing produces a balance for
    // the wrong product that nobody can later reconcile.
    expect(read(MIG_RPCS)).toMatch(/NEVER infers/);
    expect(read(UI_RECEIVE)).toMatch(/NOTHING SPECULATIVE IS/);
    // The quantity is NOT a form field — it comes from the posted line.
    expect(codeOf(read(UI_RECEIVE))).not.toMatch(/name="qty"/);
    const actions = codeOf(read(ACTIONS));
    const start = actions.indexOf("export async function receiveIntoStock(");
    expect(start).toBeGreaterThan(-1);
    expect(actions.slice(start), "the receive action must not send a quantity").not.toMatch(
      /p_qty:/,
    );
  });

  it("REFUSES to void a GRN whose stock receipt still stands", () => {
    // The rule this milestone chose (see the 20261065000000 header): the goods
    // are real, an auto-reversal could breach the negative-stock floor, and
    // every other correction in this codebase is explicit and reasoned.
    expect(sql).toMatch(/create trigger goods_received_notes_stock_guard\s*\n?\s*before update/i);
    expect(sql).toMatch(/correct the stock receipt first, then void this delivery/);
    // asked of ANOTHER row, which is why it is not an index predicate
    expect(sql).toMatch(/not exists \(\s*\n?\s*select 1 from public\.stock_movements c/);
    // BEFORE UPDATE only — never on the org-teardown cascade path
    expect(sql).not.toMatch(/(before|after)\s+delete on public\.goods_received_notes/i);
  });

  it("keeps the M4 material-request column a PLAIN COLUMN with the FK recorded as debt", () => {
    // The M4 lane owns migration slots 66/67; their table does not exist yet, so
    // an FK here would not apply. The contract is the RPC parameter.
    expect(ledger).toMatch(/material_request_line_id uuid,/);
    expect(ledger).not.toMatch(/material_request_line_id uuid[^,]*references/i);
    expect(read(MIG_LEDGER)).toMatch(/PLAIN COLUMN, NO FOREIGN KEY/);
    expect(read(MIG_LEDGER)).toMatch(/RECORDED DEFERRED DEBT/);
  });

  it("FREEZES record_stock_issue's optional material-request parameter", () => {
    // The M4 lane calls this exact signature. Renaming it, making it required,
    // or moving it ahead of a defaulted parameter breaks a lane that cannot
    // see this file.
    expect(sql).toMatch(/p_material_request_line_id uuid default null,/);
    expect(read(MIG_RPCS)).toMatch(/FROZEN CONTRACT WITH THE M4 MATERIAL-REQUESTS LANE/);
    // and the app always sends it, so the shape M4 will use is exercised today
    expect(codeOf(read(ACTIONS))).toMatch(/p_material_request_line_id: null,/);
  });
});

// ---------------------------------------------------------------------------
// 6. Active-org pinning on every new read and write
// ---------------------------------------------------------------------------

describe("stock surfaces pin the ACTIVE org, not just RLS", () => {
  const actions = codeOf(read(ACTIONS));
  const service = codeOf(read(SERVICE));

  it("EVERY read in the service filters on org_id", () => {
    const selects = service.match(/\.select\(/g) ?? [];
    const pins = service.match(/\.eq\("org_id", orgId\)/g) ?? [];
    expect(selects.length).toBeGreaterThan(0);
    expect(pins.length).toBe(selects.length);
  });

  it("EVERY RPC call passes ctx.org.id as p_org_id — no call site slipped a different value", () => {
    const pinned = actions.match(/p_org_id:\s*ctx\.org\.id/g) ?? [];
    const all = actions.match(/p_org_id:/g) ?? [];
    expect(pinned.length).toBe(5); // receipt + issue + transfer + adjust + correct
    expect(all.length).toBe(pinned.length);
  });

  it("every by-id WRITE on stock_items is org-pinned AND count-gated", () => {
    for (const name of ["updateStockItem", "setStockItemActive"]) {
      const start = actions.indexOf(`export async function ${name}(`);
      expect(start, `${name} not found`).toBeGreaterThan(-1);
      const rest = actions.slice(start + 1);
      const next = rest.indexOf("\nexport async function ");
      const body = next === -1 ? rest : rest.slice(0, next);
      expect(body, `${name} has no active-org pin`).toMatch(/\.eq\("org_id", ctx\.org\.id\)/);
      expect(body, `${name} is not count-gated`).toMatch(/count: "exact"/);
      expect(body, `${name} must treat a zero-row write as a refusal`).toMatch(/count === 0|!count/);
    }
  });

  it("performs NO cache revalidation — it stalls the action's state commit", () => {
    // Load-bearing, not style. Every stock route is `force-dynamic`, so there is
    // no cache entry to invalidate; but Next re-renders each named route INSIDE
    // the server-action response, and with them in the payload `useActionState`
    // on /stock/items/[id] never committed the returned state — the movement
    // landed, the POST returned 200, and the form sat on "Saving…" for ever, so
    // an operator would issue the same stock twice. Every write here
    // hard-navigates instead (window.location.assign), which fetches the
    // destination fresh. e2e/stock.spec.ts drives the journey that regressed.
    expect(actions).not.toMatch(/revalidatePath\(/);
    expect(actions).not.toMatch(/revalidateTag\(/);
    expect(read(ACTIONS), "the reason must survive next to the absence").toMatch(
      /deep-swap commit race/,
    );
  });

  it("every stock write hard-navigates rather than trusting the client router", () => {
    for (const f of [UI_MOVE, UI_RECEIVE, "app/(app)/stock/items/_form.tsx"]) {
      expect(codeOf(read(f)), `${f} must use a full document navigation`).toMatch(
        /window\.location\.assign\(state\.redirectTo\)/,
      );
      expect(codeOf(read(f)), `${f} must not router.push a form result`).not.toMatch(
        /router\.push\(/,
      );
    }
  });

  it("never reaches for the service-role admin client on this surface", () => {
    // The admin client bypasses RLS entirely, which would defeat the admin-only
    // adjustment gate (the RPCs are SECURITY INVOKER precisely so it applies).
    for (const src of [actions, service, codeOf(read(UI_RECEIVE)), codeOf(read(UI_MOVE))]) {
      expect(src).not.toMatch(/createAdminClient/);
      expect(src).not.toMatch(/SERVICE_ROLE/);
    }
  });
});

// ---------------------------------------------------------------------------
// 7. Loud reads (#480) — an empty stock page must never mean a failed query
// ---------------------------------------------------------------------------

describe("stock reads fail loudly", () => {
  const service = read(SERVICE);
  const serviceCode = codeOf(service);

  it("every read binds `error` and throws readFailure", () => {
    // Comment-stripped: the file header talks ABOUT `.select(` and would
    // otherwise inflate the denominator.
    const selects = (serviceCode.match(/\.select\(/g) ?? []).length;
    const throws = (serviceCode.match(/throw readFailure\(/g) ?? []).length;
    expect(selects).toBeGreaterThan(0);
    expect(throws).toBe(selects);
  });

  it("uses none of the three error-discarding shapes", () => {
    // The ratchet in loud-read-failures.test.ts counts these globally; asserting
    // them here too means a regression names THIS file instead of moving a
    // number in a shared ledger.
    expect(serviceCode).not.toMatch(/const \{ data(?:: [A-Za-z_$][A-Za-z0-9_$]*)? \} = await/);
    expect(serviceCode).not.toMatch(/const \{ count(?:: [A-Za-z_$][A-Za-z0-9_$]*)? \} = await/);
  });

  it("the ONE best-effort read says so and cannot invent a signal", () => {
    // The briefing must never break the dashboard, so loadLowStockSignal
    // degrades to "no signal" — which is the same output as a tenant that
    // tracks nothing. It can miss a line; it can never emit a false one.
    expect(service).toMatch(/BEST-EFFORT BY CONTRACT/);
    expect(service).toMatch(/return EMPTY_LOW_STOCK;/);
  });
});

// ---------------------------------------------------------------------------
// 8. No bare `users(...)` embed can be created on the new tables
// ---------------------------------------------------------------------------

describe("PostgREST embed safety on the new tables", () => {
  it("each new table has exactly ONE foreign key to users", () => {
    // Two FKs to the same target makes a bare `users(...)` embed ambiguous and
    // PostgREST rejects the WHOLE query with PGRST201 — the incident pinned by
    // postgrest-embed-ambiguity.test.ts, which showed weeks of empty states.
    // Keeping it at one means the reviewed-pairs list needs no new entry.
    for (const [name, sql] of [
      [MIG_ITEMS, sqlOnly(read(MIG_ITEMS))],
      [MIG_LEDGER, sqlOnly(read(MIG_LEDGER))],
    ] as const) {
      const refs = sql.match(/references public\.users\(id\)/g) ?? [];
      expect(refs.length, `${name} has ${refs.length} FKs to users`).toBe(1);
    }
  });

  it("no stock surface embeds users at all — names are resolved by explicit reads", () => {
    for (const f of [SERVICE, ACTIONS]) {
      expect(codeOf(read(f)), `${f} embeds users`).not.toMatch(/users\s*\(/);
    }
  });
});
