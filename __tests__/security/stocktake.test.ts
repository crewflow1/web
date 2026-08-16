import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

const MIG_SESSIONS = "supabase/migrations/20261144000000_stocktake_sessions.sql";
const MIG_RPCS = "supabase/migrations/20261144000001_stocktake_rpcs.sql";
const ACTIONS = "app/(app)/stock/stocktake-actions.ts";
const SERVICE = "server/services/stocktake.ts";
const LIB = "lib/stocktake/schema.ts";

/** Strip SQL line comments so NEGATIVE assertions test EXECUTABLE statements. */
const sqlOnly = (src: string) =>
  src
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("--");
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join("\n");

/** Strip TS/JS comments for source contracts about real code. */
const codeOf = (ts: string) =>
  ts.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

// ---------------------------------------------------------------------------
// 1. THE ACCOUNTING BOUNDARY — a stocktake must never move money
// ---------------------------------------------------------------------------
describe("stocktake never touches `finances`", () => {
  const surfaces: Array<[string, string]> = [
    [MIG_SESSIONS, sqlOnly(read(MIG_SESSIONS))],
    [MIG_RPCS, sqlOnly(read(MIG_RPCS))],
    [ACTIONS, codeOf(read(ACTIONS))],
    [SERVICE, codeOf(read(SERVICE))],
    [LIB, codeOf(read(LIB))],
  ];

  for (const [name, src] of surfaces) {
    it(`${name} contains no executable reference to finances`, () => {
      expect(src).not.toMatch(/\bfinances\b/);
    });
  }

  it("no stocktake migration writes to finances or triggers on it", () => {
    for (const [, src] of surfaces.slice(0, 2)) {
      expect(src).not.toMatch(/insert\s+into\s+public\.finances/i);
      expect(src).not.toMatch(/update\s+public\.finances/i);
      expect(src).not.toMatch(/on\s+public\.finances/i);
    }
  });

  it("the stocktake schema carries NO money column, and the RPCs take no money param", () => {
    const sql = sqlOnly(read(MIG_SESSIONS)) + "\n" + sqlOnly(read(MIG_RPCS));
    for (const money of ["unit_cost", "unit_price", "cost", "value", "price", "vat_rate", "amount", "currency"]) {
      expect(sql, `${money} appears in the stocktake schema/RPCs`).not.toMatch(
        new RegExp(`\\b${money}\\s+(numeric|integer|text|money|decimal)`, "i"),
      );
    }
    for (const p of ["p_price", "p_cost", "p_value", "p_amount", "p_vat"]) {
      expect(sql, `${p} is a stocktake RPC parameter`).not.toMatch(new RegExp(`\\b${p}\\b`));
    }
  });

  it("posting reuses record_stock_adjustment — it does NOT insert movements itself", () => {
    // The whole safety of posting rides on going through the ledger's own admin-
    // gated, floor-checked, lock-taking path. A direct movement insert here would
    // be a second write path around all of that.
    const sql = sqlOnly(read(MIG_RPCS));
    expect(sql).toMatch(/public\.record_stock_adjustment\(p_org_id/);
    const post = sql.slice(sql.indexOf("function public.post_stocktake_session"));
    const body = post.slice(0, post.indexOf("grant execute on function public.post_stocktake_session"));
    expect(body, "post must not insert stock_movements directly").not.toMatch(
      /insert\s+into\s+public\.stock_movements/i,
    );
  });

  it("states the boundary and D1 where a contributor will read it", () => {
    for (const f of [MIG_SESSIONS, MIG_RPCS]) {
      expect(read(f), `${f} must state the accounting boundary`).toMatch(/ACCOUNTING BOUNDARY/);
      expect(read(f), `${f} must name D1`).toMatch(/D1/);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Tenancy is STRUCTURAL, and RLS is enabled
// ---------------------------------------------------------------------------
describe("stocktake tenant binding", () => {
  const sql = sqlOnly(read(MIG_SESSIONS));

  it("enables RLS on both new tables", () => {
    expect(sql).toMatch(/alter table public\.stocktake_sessions enable row level security/i);
    expect(sql).toMatch(/alter table public\.stocktake_lines enable row level security/i);
  });

  it("binds every cross-table reference by COMPOSITE (id, org_id) FK", () => {
    for (const [cols, target] of [
      ["site_id, org_id", "public\\.sites \\(id, org_id\\)"],
      ["session_id, org_id", "public\\.stocktake_sessions \\(id, org_id\\)"],
      ["stock_item_id, org_id", "public\\.stock_items \\(id, org_id\\)"],
      ["posted_movement_id, org_id", "public\\.stock_movements \\(id, org_id\\)"],
    ] as const) {
      expect(sql, `${cols} must be a composite FK`).toMatch(
        new RegExp(`foreign key \\(${cols}\\)\\s*\\n?\\s*references ${target}`, "i"),
      );
    }
  });

  it("gives each new table exactly ONE FK to users (no PGRST201 embed ambiguity)", () => {
    // stocktake_sessions has opened_by/posted_by/cancelled_by — three user FKs —
    // so nothing may EMBED users on it. The service resolves names by explicit
    // reads (asserted below), never an embed, which is what keeps it safe.
    const linesBlock = sql.slice(sql.indexOf("create table if not exists public.stocktake_lines"));
    const lineUserFks = linesBlock.match(/references public\.users\(id\)/g) ?? [];
    expect(lineUserFks.length).toBe(1); // counted_by only
  });

  it("the read service is org-pinned on every select and never embeds users", () => {
    const service = codeOf(read(SERVICE));
    const selects = service.match(/\.select\(/g) ?? [];
    const pins = service.match(/\.eq\("org_id", orgId\)/g) ?? [];
    expect(selects.length).toBeGreaterThan(0);
    expect(pins.length).toBe(selects.length);
    expect(service, "no users(...) embed").not.toMatch(/users\s*\(/);
  });
});

// ---------------------------------------------------------------------------
// 3. Lifecycle + authority are enforced in the DATABASE
// ---------------------------------------------------------------------------
describe("stocktake lifecycle and authority are structural", () => {
  const sessions = sqlOnly(read(MIG_SESSIONS));
  const rpcs = sqlOnly(read(MIG_RPCS));

  it("the transition trigger freezes terminal states and gates → posted", () => {
    expect(sessions).toMatch(/create trigger stocktake_sessions_transition\s*\n?\s*before update/i);
    expect(sessions).toMatch(/if old\.status in \('posted', 'cancelled'\) then/);
    // → posted needs the marker AND an admin, only from counting.
    expect(sessions).toMatch(/if new\.status = 'posted' then/);
    expect(sessions).toMatch(/v_marker <> new\.id::text/);
    expect(sessions).toMatch(/only an owner or admin can post a stocktake/);
    expect(sessions).toMatch(/a stocktake is posted from counting/);
  });

  it("a session is born 'open' — a direct insert of a posted session is refused", () => {
    expect(sessions).toMatch(/create trigger stocktake_sessions_insert_open\s*\n?\s*before insert/i);
    expect(sessions).toMatch(/it cannot be created already/);
  });

  it("lines are snapshotted only inside the open path (the marker), not by direct insert", () => {
    expect(sessions).toMatch(/create trigger stocktake_lines_authorised_insert\s*\n?\s*before insert/i);
    expect(sessions).toMatch(/current_setting\('crewflow\.stocktake_open', true\)/);
    // JWT-gated so service_role stays trusted.
    expect(sessions).toMatch(/if auth\.uid\(\) is null then\s*\n\s*return new;/);
  });

  it("the line guard freezes the snapshot and gates counted/posted writes", () => {
    expect(sessions).toMatch(/create trigger stocktake_lines_guard\s*\n?\s*before update/i);
    // SQL doubles the apostrophe inside the string literal (line''s).
    expect(sessions).toMatch(/a stocktake line''s snapshot and identity are immutable/);
    // posted_* only through the post marker; counted_qty only while counting.
    expect(sessions).toMatch(/crewflow\.stocktake_post/);
    expect(sessions).toMatch(/this stocktake is not open for counting/);
  });

  it("post is ADMIN-ONLY three times over and ATOMIC/IDEMPOTENT", () => {
    // Explicit gate in the RPC, the transition trigger, and record_stock_adjustment.
    expect(rpcs).toMatch(/if auth\.uid\(\) is not null and not public\.is_org_admin\(p_org_id\) then/);
    expect(rpcs).toMatch(/only an owner or admin can post a stocktake/);
    // Idempotent: session locked FOR UPDATE and must be counting.
    expect(rpcs).toMatch(/for update/);
    expect(rpcs).toMatch(/a % stocktake cannot be posted/);
    // The marker the transition + line posted_* writes require.
    expect(rpcs).toMatch(/set_config\('crewflow\.stocktake_post', p_session_id::text, true\)/);
    expect(rpcs).toMatch(/set_config\('crewflow\.stocktake_post', '', true\)/);
  });

  it("keeps every stocktake RPC SECURITY INVOKER — not a privileged back door", () => {
    for (const name of [
      "open_stocktake_session",
      "start_stocktake_counting",
      "record_stocktake_count",
      "post_stocktake_session",
      "cancel_stocktake_session",
    ]) {
      const start = rpcs.indexOf(`create or replace function public.${name}(`);
      expect(start, `${name} not found`).toBeGreaterThan(-1);
      const header = rpcs.slice(start, rpcs.indexOf("$$", start));
      expect(header, `${name} must not be SECURITY DEFINER`).not.toMatch(/security definer/i);
    }
  });

  it("the variance posted is deterministic: counted − expected(snapshot)", () => {
    expect(rpcs).toMatch(/round\(r\.counted_qty - r\.expected_qty, 2\)/);
    // Only counted lines whose count differs from the frozen snapshot are posted.
    expect(rpcs).toMatch(/counted_qty is not null\s*\n?\s*and counted_qty <> expected_qty/);
  });
});

// ---------------------------------------------------------------------------
// 4. Barcode
// ---------------------------------------------------------------------------
describe("barcode on the item register", () => {
  const sessions = sqlOnly(read(MIG_SESSIONS));

  it("adds a nullable, bounded barcode column, unique per org where present, case-insensitive", () => {
    expect(sessions).toMatch(/add column if not exists barcode text/i);
    expect(sessions).toMatch(
      /create unique index if not exists stock_items_org_barcode_unique\s*\n?\s*on public\.stock_items \(org_id, lower\(barcode\)\)\s*\n?\s*where barcode is not null/i,
    );
  });

  it("scan-to-find matches barcode OR sku, org-pinned and case-insensitively", () => {
    const service = codeOf(read(SERVICE));
    expect(service).toMatch(/barcode\.ilike\.\$\{safe\},sku\.ilike\.\$\{safe\}/);
    const find = service.slice(service.indexOf("export async function findStockItemByCode"));
    expect(find).toMatch(/\.eq\("org_id", orgId\)/);
  });
});

// ---------------------------------------------------------------------------
// 5. Active-org pinning + the stock surface posture on the actions
// ---------------------------------------------------------------------------
describe("stocktake actions pin the active org and follow the stock posture", () => {
  const actions = codeOf(read(ACTIONS));

  it("EVERY RPC call passes ctx.org.id as p_org_id", () => {
    const pinned = actions.match(/p_org_id:\s*ctx\.org\.id/g) ?? [];
    const all = actions.match(/p_org_id:/g) ?? [];
    expect(all.length).toBeGreaterThan(0);
    expect(pinned.length).toBe(all.length);
  });

  it("never reaches for the service-role admin client (it would bypass the post gate)", () => {
    expect(actions).not.toMatch(/createAdminClient/);
    expect(actions).not.toMatch(/SERVICE_ROLE/);
  });

  it("performs no cache revalidation and hard-navigates the interactive forms", () => {
    expect(actions).not.toMatch(/revalidatePath\(/);
    expect(actions).not.toMatch(/revalidateTag\(/);
    for (const f of [
      "app/(app)/stock/stocktake/new/_open-form.tsx",
      "app/(app)/stock/stocktake/[id]/_count-panel.tsx",
    ]) {
      expect(codeOf(read(f)), `${f} must hard-navigate on success`).toMatch(
        /window\.location\.assign\(state\.redirectTo\)/,
      );
      expect(codeOf(read(f)), `${f} must not router.push a form result`).not.toMatch(/router\.push\(/);
    }
  });
});

// ---------------------------------------------------------------------------
// 6. GDPR registry — the new tables are classified for export
// ---------------------------------------------------------------------------
describe("the new tables are registered for GDPR export", () => {
  it("stocktake_sessions and stocktake_lines are in the org-tables snapshot", () => {
    const known = JSON.parse(read("lib/gdpr/org-tables.json")).known as string[];
    expect(known).toContain("stocktake_sessions");
    expect(known).toContain("stocktake_lines");
  });
});
