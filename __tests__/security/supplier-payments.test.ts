import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

const MIGRATION = "supabase/migrations/20261047000000_supplier_payments.sql";
const MIG_DIR = resolve(ROOT, "supabase/migrations");

/**
 * H2-CIS M2 — trust-boundary pins for the supplier money-OUT ledger.
 *
 * Hermetic: filesystem + source contracts, no database. The live-Postgres proofs
 * (RLS denial, caps, concurrency, immutability) are in
 * __tests__/integration/rls/supplier-payments.test.ts. What THIS tier does is
 * stop the controls being quietly loosened later — the admin-only policy relaxed
 * to the member-read norm, the write-once trigger dropped, a service-role client
 * introduced, or the cost/cash separation blurred.
 */

/** Strip SQL line comments so negative assertions test EXECUTABLE statements. */
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

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next" || entry === ".git") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(full)) out.push(full);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 1. RLS is admin-only on BOTH tables
// ---------------------------------------------------------------------------

describe("supplier payments — RLS is admin-only, stricter than money-in `payments`", () => {
  const sql = sqlOnly(read(MIGRATION));

  it("enables row level security on both ledger tables", () => {
    expect(sql).toMatch(/alter table public\.supplier_payments enable row level security/i);
    expect(sql).toMatch(
      /alter table public\.supplier_payment_allocations enable row level security/i,
    );
  });

  it("gates every policy on public.is_org_admin for both using and with check", () => {
    const policies = sql
      .split(/create policy/i)
      .slice(1)
      .map((s) => s.slice(0, s.indexOf(";")));
    expect(policies.length).toBe(2);
    for (const p of policies) {
      expect(p).toMatch(/for all\s+to authenticated/i);
      expect(p).toMatch(/using\s*\(\s*public\.is_org_admin\(org_id\)\s*\)/i);
      expect(p).toMatch(/with check\s*\(\s*public\.is_org_admin\(org_id\)\s*\)/i);
    }
  });

  it("NEVER grants access via bare org membership", () => {
    // The whole point of the milestone's RLS decision: recording that cash left
    // the bank and that tax was withheld is not an ordinary member's authority.
    // `current_org_ids` here would hand it to every labourer in the org.
    expect(sql).not.toMatch(/current_org_ids/);
  });

  it("declares exactly one policy per table (no second, looser one)", () => {
    // Split on the statement keyword and read each statement's OWN target, so a
    // lazy cross-statement match cannot inflate the count.
    const statements = sql
      .split(/create policy/i)
      .slice(1)
      .map((s) => s.slice(0, s.search(/\bfor\s+(all|select|insert|update|delete)\b/i)));
    for (const table of ["supplier_payments", "supplier_payment_allocations"]) {
      const re = new RegExp(`on public\\.${table}\\b`, "i");
      const hits = statements.filter((s) => re.test(s));
      expect(hits.length, `${table} must have exactly one policy`).toBe(1);
    }
  });

  it("has no permissive per-command policy that could widen reads", () => {
    expect(sql).not.toMatch(/for select\s+to/i);
    expect(sql).not.toMatch(/for insert\s+to/i);
    expect(sql).not.toMatch(/for update\s+to/i);
    expect(sql).not.toMatch(/for delete\s+to/i);
  });

  it("is the LAST migration to define any policy on these tables (replayed state)", () => {
    for (const table of ["supplier_payments", "supplier_payment_allocations"]) {
      const definers = readdirSync(MIG_DIR)
        .filter((f) => f.endsWith(".sql"))
        .filter((f) =>
          new RegExp(`create policy[\\s\\S]{0,200}?${table}\\b`, "i").test(
            readFileSync(resolve(MIG_DIR, f), "utf8"),
          ),
        )
        .sort();
      expect(definers.length).toBeGreaterThanOrEqual(1);
      expect(definers[definers.length - 1]).toBe("20261047000000_supplier_payments.sql");
    }
  });
});

// ---------------------------------------------------------------------------
// 2. The money invariants live in the database
// ---------------------------------------------------------------------------

describe("supplier payments — DB-enforced money integrity", () => {
  const sql = sqlOnly(read(MIGRATION));

  it("enforces net_paid = gross_amount − cis_withheld as a CHECK", () => {
    expect(sql).toMatch(
      /constraint supplier_payments_settlement_identity\s*\n?\s*check\s*\(\s*net_paid = gross_amount - cis_withheld\s*\)/i,
    );
  });

  it("keeps every money column non-negative", () => {
    expect(sql).toMatch(/gross_amount numeric\(12, 2\) not null check \(gross_amount >= 0\)/i);
    expect(sql).toMatch(/cis_withheld numeric\(12, 2\) not null default 0 check \(cis_withheld >= 0\)/i);
    expect(sql).toMatch(/net_paid\s+numeric\(12, 2\) not null check \(net_paid >= 0\)/i);
    expect(sql).toMatch(/amount\s+numeric\(12, 2\) not null check \(amount > 0\)/i);
  });

  it("binds org AND supplier to the payment with a composite FK", () => {
    expect(sql).toMatch(
      /foreign key\s*\(\s*payment_id\s*,\s*org_id\s*,\s*supplier_id\s*\)\s*\n?\s*references\s+public\.supplier_payments\s*\(\s*id\s*,\s*org_id\s*,\s*supplier_id\s*\)/i,
    );
  });

  it("binds org AND supplier to the BILL with a composite FK (a supplier-less cost is unallocatable)", () => {
    expect(sql).toMatch(
      /foreign key\s*\(\s*finance_id\s*,\s*org_id\s*,\s*supplier_id\s*\)\s*\n?\s*references\s+public\.finances\s*\(\s*id\s*,\s*org_id\s*,\s*supplier_id\s*\)/i,
    );
    expect(sql).toMatch(/finances_id_org_supplier_key unique \(id, org_id, supplier_id\)/i);
  });

  it("binds the payment's supplier to the tenant's supplier list", () => {
    expect(sql).toMatch(
      /foreign key\s*\(\s*supplier_id\s*,\s*org_id\s*\)\s*references\s+public\.suppliers\s*\(\s*id\s*,\s*org_id\s*\)/i,
    );
  });

  it("locks BOTH parents FOR UPDATE so the caps are race-free", () => {
    const guard = sql.slice(sql.indexOf("tg_supplier_payment_allocation_guard"));
    const locks = guard.match(/for update/gi) ?? [];
    expect(locks.length, "payment and bill must both be locked").toBe(2);
    // Lock order must be payment-then-bill; the reverse would deadlock.
    expect(guard.indexOf("from public.supplier_payments where id = new.payment_id for update"))
      .toBeLessThan(guard.indexOf("from public.finances where id = new.finance_id for update"));
  });

  it("excludes VOIDED payments from the per-bill cap (so a correction fits)", () => {
    const guard = sql.slice(sql.indexOf("tg_supplier_payment_allocation_guard"));
    expect(guard).toMatch(/join public\.supplier_payments p on p\.id = a\.payment_id/i);
    expect(guard).toMatch(/p\.voided_at is null/i);
  });

  it("computes the bill cap on GROSS (net + VAT), not net", () => {
    const guard = sql.slice(sql.indexOf("tg_supplier_payment_allocation_guard"));
    expect(guard).toMatch(/round\(amount \+ coalesce\(vat_total, 0\), 2\)/i);
  });

  it("pins search_path on every trigger function (no schema-hijack surface)", () => {
    const fns = sql.match(/create or replace function public\.tg_supplier[\s\S]*?as \$\$/gi) ?? [];
    expect(fns.length).toBeGreaterThanOrEqual(5);
    for (const fn of fns) expect(fn).toMatch(/set search_path = public/i);
  });

  it("the atomic RPC is SECURITY INVOKER and gated on is_org_admin", () => {
    const rpc = sql.slice(sql.indexOf("create or replace function public.record_supplier_payment"));
    expect(rpc, "a definer RPC would hand every user the admin's authority").toMatch(
      /security invoker/i,
    );
    expect(rpc).toMatch(/not public\.is_org_admin\(p_org_id\)/i);
    expect(rpc).toMatch(/set search_path = public/i);
    // net_paid is derived inside the RPC, never taken from the caller.
    expect(rpc).toMatch(/v_gross - v_withheld/);
    expect(rpc).not.toMatch(/p_net_paid/);
  });
});

// ---------------------------------------------------------------------------
// 3. Write-once + void, enforced for every role
// ---------------------------------------------------------------------------

describe("supplier payments — the ledger is append-only", () => {
  const sql = sqlOnly(read(MIGRATION));

  it("freezes every financial and binding column on UPDATE", () => {
    const fn = sql.slice(
      sql.indexOf("create or replace function public.tg_supplier_payments_write_once"),
    );
    for (const col of [
      "org_id",
      "supplier_id",
      "paid_at",
      "method",
      "reference",
      "gross_amount",
      "cis_withheld",
      "net_paid",
      "created_by",
      "created_at",
    ]) {
      expect(fn, `${col} must be frozen`).toMatch(
        new RegExp(`new\\.${col}\\s+is distinct from old\\.${col}`, "i"),
      );
    }
  });

  it("makes a void one-way — a voided row is terminal", () => {
    const fn = sql.slice(
      sql.indexOf("create or replace function public.tg_supplier_payments_write_once"),
    );
    expect(fn).toMatch(/if old\.voided_at is not null then[\s\S]{0,300}?raise exception/i);
  });

  it("requires an explicit non-null reason on a void (no NULL hole in the CHECK)", () => {
    // `length(trim(null))` is NULL, and `true and NULL` is NULL, which a CHECK
    // treats as SATISFIED — so the `is not null` term is load-bearing.
    const check = sql.slice(sql.indexOf("supplier_payments_void_evidenced"));
    expect(check).toMatch(/void_reason is not null/i);
    expect(check).toMatch(/length\(trim\(void_reason\)\) between 1 and 500/i);
  });

  it("freezes allocations outright — no permitted UPDATE at all", () => {
    const fn = sql.slice(
      sql.indexOf("create or replace function public.tg_supplier_payment_allocations_frozen"),
    );
    const body = fn.slice(0, fn.indexOf("$$;"));
    expect(body).toMatch(/raise exception/i);
    // Nothing may return NEW — an unconditional refusal is the whole function.
    expect(body).not.toMatch(/return new/i);
  });

  it("refuses DELETE on both tables unless the tenant itself is going", () => {
    for (const fn of [
      "tg_supplier_payments_no_delete",
      "tg_supplier_payment_allocations_no_delete",
    ]) {
      const start = sql.indexOf(`create or replace function public.${fn}`);
      expect(start, `${fn} must exist`).toBeGreaterThan(-1);
      const body = sql.slice(start, sql.indexOf("$$;", start));
      expect(body, `${fn} must refuse`).toMatch(/raise exception/i);
      // The only escape hatch is the parent org already being gone.
      expect(body).toMatch(/exists \(select 1 from public\.organizations where id = old\.org_id\)/i);
    }
    expect(sql).toMatch(/before delete on public\.supplier_payments/i);
    expect(sql).toMatch(/before delete on public\.supplier_payment_allocations/i);
  });

  it("never uses a spoofable session flag to decide whether a delete is allowed", () => {
    expect(sql).not.toMatch(/current_setting\(/i);
    expect(sql).not.toMatch(/pg_trigger_depth\(/i);
    expect(sql).not.toMatch(/session_replication_role/i);
  });

  it("cannot withhold CIS from a supplier with no CIS record", () => {
    const fn = sql.slice(
      sql.indexOf("create or replace function public.tg_supplier_payments_cis_authority"),
    );
    expect(fn).toMatch(/new\.cis_withheld > 0/i);
    expect(fn).toMatch(/from public\.cis_subcontractors c/i);
    expect(fn).toMatch(/security definer/i);
  });
});

// ---------------------------------------------------------------------------
// 4. THE LOAD-BEARING INVARIANT — the ledger never writes cost
// ---------------------------------------------------------------------------

describe("supplier payments — CIS withholding cannot move a cost figure", () => {
  const sql = sqlOnly(read(MIGRATION));

  it("the migration never inserts, updates or deletes a finances row", () => {
    // Cost lives in `finances.amount`. If this ledger could write it, a CIS
    // deduction could be booked as a saving and every affected job's margin
    // would inflate by the tax withheld.
    expect(sql).not.toMatch(/insert into public\.finances/i);
    expect(sql).not.toMatch(/update public\.finances\s+set/i);
    expect(sql).not.toMatch(/delete from public\.finances/i);
    // The ONLY touch on finances is adding a composite-FK target.
    const touches = sql.match(/alter table public\.finances[^;]*/gi) ?? [];
    expect(touches.length).toBe(1);
    expect(touches[0]).toMatch(/add constraint finances_id_org_supplier_key unique/i);
  });

  it("the ledger never writes the money-IN tables either", () => {
    for (const t of ["payments", "invoice_payments", "invoices"]) {
      expect(sql).not.toMatch(new RegExp(`insert into public\\.${t}\\b`, "i"));
      expect(sql).not.toMatch(new RegExp(`update public\\.${t}\\s+set`, "i"));
    }
  });

  it("no application module folds cis_withheld or net_paid into a cost or profit figure", () => {
    // The profitability and commercial-cash engines must stay blind to this
    // ledger. If one of them ever imports it, that is the invariant breaking.
    const engines = [
      ...walk(resolve(ROOT, "lib/profitability")),
      ...walk(resolve(ROOT, "lib/commercial")),
      ...walk(resolve(ROOT, "lib/purchase-orders")),
    ];
    expect(engines.length).toBeGreaterThan(3);
    for (const file of engines) {
      const code = codeOf(readFileSync(file, "utf8"));
      const rel = file.replace(`${ROOT}/`, "");
      expect(code, `${rel} must not read the money-out ledger`).not.toMatch(
        /cis_withheld|net_paid|supplier_payments/,
      );
    }
  });

  it("the pure lib reports withholding as cash and never subtracts it from cost", () => {
    const code = codeOf(read("lib/suppliers/payments.ts"));
    // billedNet is Σ bill amounts — no term drawn from the payment ledger.
    const fn = code.slice(code.indexOf("export function computeSupplierPosition"));
    const billedNet = fn.slice(fn.indexOf("const billedNet"), fn.indexOf("const billedGross"));
    expect(billedNet).toMatch(/input\.bills\.map/);
    expect(billedNet).not.toMatch(/cisWithheld|cis_withheld|netCash|net_paid/);
    // And nothing anywhere subtracts the withholding from a billed figure.
    expect(code).not.toMatch(/billed\w*\s*-\s*\w*[Ww]ithheld/);
  });
});

// ---------------------------------------------------------------------------
// 5. Service + actions contract
// ---------------------------------------------------------------------------

describe("supplier payments service — tenant client only, never service_role", () => {
  const code = codeOf(read("server/services/supplier-payments.ts"));

  it("never reaches for the service-role client (which would bypass admin-only RLS)", () => {
    expect(code).not.toMatch(
      /serviceClient\(|SUPABASE_SERVICE_ROLE_KEY|createServiceClient|createAdminClient/,
    );
  });

  it("uses the tenant server client, so RLS applies to every call", () => {
    expect(code).toMatch(/from "@\/lib\/supabase\/server"/);
    expect(code).toMatch(/import "server-only"/);
  });

  it("writes through the atomic RPC rather than two separate inserts", () => {
    const fn = code.slice(code.indexOf("export async function recordSupplierPayment"));
    expect(fn).toMatch(/rpc\("record_supplier_payment"/);
    expect(fn, "a direct allocation insert would break atomicity").not.toMatch(
      /from\(\s*"supplier_payment_allocations"\s*\)[\s\S]{0,80}insert/,
    );
  });

  it("never echoes a raw database message back to the caller", () => {
    expect(code).not.toMatch(/error:\s*error\.message/);
    expect(code).toMatch(/function friendly\(/);
  });

  it("only the service and its own actions name the ledger tables at all", () => {
    // Any other module reaching these tables would bypass the service's
    // tenant-client discipline and its error translation. Matching the table
    // NAME (not a `.from(...)` shape) catches every access idiom, including the
    // structural casts this codebase uses for post-types tables.
    const sources = [
      ...walk(resolve(ROOT, "app")),
      ...walk(resolve(ROOT, "lib")),
      ...walk(resolve(ROOT, "server")),
    ];
    expect(sources.length).toBeGreaterThan(50);
    const readers = sources
      .filter((f) =>
        /["']supplier_payments["']|["']supplier_payment_allocations["']/.test(
          codeOf(readFileSync(f, "utf8")),
        ),
      )
      .map((f) => f.replace(`${ROOT}/`, ""))
      .sort();
    // The actions file names it too, but ONLY for the double-submit guard.
    //
    // `cis-statements.ts` (H2-CIS M4, 20261055000000) is a READ-ONLY consumer:
    // it joins `supplier_payments` to find each snapshot's payment date and to
    // exclude VOIDED payments from statements and returns. It performs no
    // insert, update or delete against the ledger — that remains the exclusive
    // job of the RPCs this service pins — and it runs on the tenant client, so
    // admin-only RLS still applies. Asserted in its own tier,
    // __tests__/security/cis-statements.test.ts.
    //
    // `aged-ledgers.ts` (the aged-creditors half of /reports/ageing) is another
    // READ-ONLY consumer, admitted on the same terms:
    //   - tenant client only (`createClient` from lib/supabase/server), so the
    //     admin-only RLS on both tables remains the real boundary;
    //   - no insert/update/delete/upsert/rpc anywhere in the file — pinned by
    //     __tests__/security/aged-ledgers-org-scope.test.ts, which also proves
    //     it never even ISSUES these reads for a non-admin role, because an
    //     empty-without-error ledger read would overstate payables by
    //     everything already paid;
    //   - it reads `id, voided_at` and the allocation triple ONLY. It does not
    //     read `gross_amount`, `cis_withheld` or `net_paid`: an aged listing has
    //     no business carrying withholding figures it never displays;
    //   - settlement is computed by `computeBillSettlements`, this domain's own
    //     authority, so no second copy of the payable rule exists.
    //
    // `supplier-performance.ts` joins the same two tables for the SAME reason
    // and under the same terms: it reads `supplier_payments` and
    // `supplier_payment_allocations` to date each bill's settling payment and to
    // exclude VOIDED payments from the settlement-speed measure. It is READ-ONLY
    // — no insert, update, delete or rpc anywhere in the module — it takes the
    // TENANT client as an argument so admin-only RLS applies to every call, and
    // it re-derives no settlement arithmetic (it composes
    // `computeBillSettlements` from lib/suppliers/payments.ts, the authority this
    // service also uses). All three properties are asserted in their own tier,
    // __tests__/security/supplier-performance-readonly.test.ts, and the org
    // pinning is proven against real Postgres in
    // __tests__/integration/rls/supplier-performance-active-org.test.ts.
    expect(readers).toEqual([
      "app/(app)/suppliers/[id]/payments/actions.ts",
      "server/services/aged-ledgers.ts",
      "server/services/cis-statements.ts",
      "server/services/supplier-payments.ts",
      "server/services/supplier-performance.ts",
    ]);
  });
});

describe("supplier payment actions — admin-gated at the app layer too", () => {
  const code = codeOf(read("app/(app)/suppliers/[id]/payments/actions.ts"));

  it("re-checks owner/admin in every exported action (a POST endpoint can be replayed)", () => {
    const bodies = code.split(/export async function /).slice(1);
    expect(bodies.length).toBeGreaterThanOrEqual(2);
    for (const body of bodies) {
      const name = body.slice(0, body.indexOf("("));
      expect(body, `${name} must gate on isManager`).toMatch(/isManager\(ctx\.membership\.role\)/);
    }
  });

  it("gates BEFORE doing any work", () => {
    const bodies = code.split(/export async function /).slice(1);
    for (const body of bodies) {
      const gate = body.indexOf("isManager(ctx.membership.role)");
      const work = body.indexOf("safeParse");
      if (work > -1) expect(gate).toBeLessThan(work);
    }
  });

  it("resolves the org from the session, never from form input", () => {
    expect(code).toMatch(/requireOrgContext\(\)/);
    expect(code).toMatch(/ctx\.org\.id/);
    expect(code).not.toMatch(/formData\.get\(\s*["']org_id["']/);
    expect(code).not.toMatch(/formData\.get\(\s*["']supplier_id["']/);
  });

  it("guards against a double-submit recording the same cash twice", () => {
    // Two identical payments would double-count real cash out AND report the
    // same CIS deduction to HMRC twice. The DB caps cannot catch it.
    const fn = code.slice(code.indexOf("export async function recordPayment"));
    expect(fn).toMatch(/DEDUPE_WINDOW_MS/);
    expect(fn).toMatch(/gte\("created_at", sinceIso\)/);
    const dupIdx = fn.indexOf("DEDUPE_WINDOW_MS");
    const writeIdx = fn.indexOf("recordSupplierPayment(");
    expect(dupIdx, "the guard must run BEFORE the write").toBeLessThan(writeIdx);
  });

  it("requires a reason to void and never offers a delete", () => {
    expect(code).toMatch(/voidSupplierPaymentSchema/);
    expect(code).not.toMatch(/\bdelete\b/i);
  });
});

// ---------------------------------------------------------------------------
// 6. The pure lib stays pure; the ledger stays off customer-facing paths
// ---------------------------------------------------------------------------

describe("lib/suppliers/payments — pure, importable anywhere", () => {
  it("imports no server or database module", () => {
    const code = codeOf(read("lib/suppliers/payments.ts"));
    expect(code).not.toMatch(/server-only/);
    expect(code).not.toMatch(/@supabase\//);
    expect(code).not.toMatch(/@\/lib\/supabase/);
    expect(code).not.toMatch(/next\/(headers|cache|navigation)/);
  });

  it("reads no clock, so every figure is a function of its inputs", () => {
    const code = codeOf(read("lib/suppliers/payments.ts"));
    expect(code).not.toMatch(/Date\.now\(\)/);
    expect(code).not.toMatch(/new Date\(\)/);
  });

  it("shares ONE tolerance with the money-in ledger", () => {
    const code = read("lib/suppliers/payments.ts");
    expect(code).toMatch(/import \{ ALLOCATION_TOLERANCE \} from "@\/lib\/payments\/allocation"/);
    expect(codeOf(code), "no second, divergent tolerance constant").not.toMatch(
      /const\s+\w*TOLERANCE\s*=/,
    );
  });

  it("does its arithmetic through lib/money, never raw floats", () => {
    const code = read("lib/suppliers/payments.ts");
    expect(code).toMatch(/from "@\/lib\/money"/);
    expect(code).toMatch(/round2\(/);
    expect(code).toMatch(/sumMoney\(/);
  });
});

describe("supplier payments — never on a customer-facing path", () => {
  const portalFiles = walk(resolve(ROOT, "app/customer-portal"));

  it("finds the customer-portal tree (guards against a vacuous pass)", () => {
    expect(portalFiles.length).toBeGreaterThan(5);
  });

  it("no customer-portal file touches the money-out ledger", () => {
    // What a builder pays a subcontractor is the customer's clearest window onto
    // the builder's margin. It must never reach a portal path.
    const offenders = portalFiles.filter((f) =>
      /supplier_payments|supplier_payment_allocations|cis_withheld|lib\/suppliers\/payments/.test(
        codeOf(readFileSync(f, "utf8")),
      ),
    );
    expect(offenders, `portal files touching supplier payments: ${offenders.join(", ")}`).toEqual(
      [],
    );
  });

  it("the payments page and the supplier page both gate on owner/admin", () => {
    const page = read("app/(app)/suppliers/[id]/payments/page.tsx");
    expect(page).toMatch(/ctx\.membership\.role === "owner"/);
    expect(page).toMatch(/if \(!isAdmin\)/);

    const supplierPage = read("app/(app)/suppliers/[id]/page.tsx");
    expect(supplierPage).toMatch(/isAdmin \?/);
  });
});

// ---------------------------------------------------------------------------
// 7. Migration hygiene
// ---------------------------------------------------------------------------

describe("migration hygiene", () => {
  it("no two migrations share a numeric prefix", () => {
    // Supabase keys migration identity on the numeric prefix; a collision is
    // invisible to git and silently skips a file on replay.
    const prefixes = readdirSync(MIG_DIR)
      .filter((f) => f.endsWith(".sql"))
      .map((f) => f.split("_")[0]!);
    const dupes = prefixes.filter((p, i) => prefixes.indexOf(p) !== i);
    expect(dupes, `duplicate migration prefixes: ${[...new Set(dupes)].join(", ")}`).toEqual([]);
  });

  it("the M2 migration occupies its reserved slot", () => {
    expect(readdirSync(MIG_DIR)).toContain("20261047000000_supplier_payments.sql");
  });
});
