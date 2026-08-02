import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * VAN / VEHICLE STOCK (20261102000000) — source contracts.
 *
 * A van is a stock LOCATION (a `sites` row, kind = 'vehicle'), so the whole
 * point is that it REUSES the operational-stock ledger rather than forking it.
 * These assertions pin exactly that: no new movement path, the shared write
 * authority, org-pinning everywhere, and the accounting boundary held.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

const MIG = "supabase/migrations/20261102000000_van_stock_locations.sql";
const SERVICE = "server/services/van-stock.ts";
const ACTIONS = "app/(app)/stock/van-actions.ts";
const LIB = "lib/stock/van.ts";

/** Strip SQL line comments so NEGATIVE assertions test executable statements. */
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
// 1. THE ACCOUNTING BOUNDARY — van stock must never move money
// ---------------------------------------------------------------------------

describe("van stock never touches `finances`", () => {
  const surfaces: Array<[string, string]> = [
    [MIG, sqlOnly(read(MIG))],
    [SERVICE, codeOf(read(SERVICE))],
    [ACTIONS, codeOf(read(ACTIONS))],
    [LIB, codeOf(read(LIB))],
  ];

  for (const [name, src] of surfaces) {
    it(`${name} contains no executable reference to finances`, () => {
      expect(src).not.toMatch(/\bfinances\b/);
    });
  }

  it("the migration writes to finances nowhere and puts no trigger on it", () => {
    const sql = sqlOnly(read(MIG));
    expect(sql).not.toMatch(/insert\s+into\s+public\.finances/i);
    expect(sql).not.toMatch(/update\s+public\.finances/i);
    expect(sql).not.toMatch(/delete\s+from\s+public\.finances/i);
    expect(sql).not.toMatch(/on\s+public\.finances/i);
  });

  it("adds no money column and no money RPC parameter", () => {
    const sql = sqlOnly(read(MIG));
    for (const money of ["unit_cost", "unit_price", "cost", "value", "price", "vat", "amount"]) {
      expect(sql, `${money} appears in the van-stock migration`).not.toMatch(
        new RegExp(`\\b${money}\\s+(numeric|integer|text|money|decimal)`, "i"),
      );
    }
    for (const p of ["p_price", "p_cost", "p_value", "p_amount", "p_vat"]) {
      expect(sql).not.toMatch(new RegExp(`\\b${p}\\b`));
    }
  });

  it("states the boundary where a contributor will read it", () => {
    const raw = read(MIG);
    expect(raw).toMatch(/ACCOUNTING BOUNDARY/);
    expect(raw).toMatch(/double-count|double count/i);
    expect(raw).toMatch(/D1/);
  });
});

// ---------------------------------------------------------------------------
// 2. REUSE, NOT A FORK — the movement authority is inherited
// ---------------------------------------------------------------------------

describe("van stock reuses the operational-stock ledger", () => {
  const mig = sqlOnly(read(MIG));
  const actions = codeOf(read(ACTIONS));

  it("defines NO new stock-movement write path in the migration", () => {
    // The whole design is that a van is a `sites` row, so the existing RPCs move
    // its stock. A new movement RPC here would be the fork we are avoiding.
    expect(mig).not.toMatch(/insert\s+into\s+public\.stock_movements/i);
    expect(mig).not.toMatch(/create or replace function public\.record_stock_/i);
    // ...and it takes no advisory lock and sets no write marker: those live in
    // the reused RPCs, and re-implementing them here would be a second, drifting
    // copy of the concurrency rule.
    expect(mig).not.toMatch(/pg_advisory/i);
    expect(mig).not.toMatch(/crewflow\.stock_write/);
  });

  it("loads and returns van stock through record_stock_transfer, never a bare insert", () => {
    // Loading a van is a transfer depot -> van (a conserving pair). A bare
    // transfer_in that manufactures stock is impossible from here because there
    // is no direct movement insert at all.
    expect(actions).toMatch(/rpc\("record_stock_transfer"/);
    expect(actions).not.toMatch(/from\("stock_movements"\)/);
    expect(actions).not.toMatch(/transfer_in/);
    // enabling a van reuses the dedicated sites RPC, which writes only a site.
    expect(actions).toMatch(/rpc\("ensure_vehicle_stock_location"/);
  });

  it("the enable RPC is SECURITY INVOKER and writes only a sites row", () => {
    const start = mig.indexOf("create or replace function public.ensure_vehicle_stock_location(");
    expect(start, "ensure RPC not found").toBeGreaterThan(-1);
    const body = mig.slice(start);
    const header = body.slice(0, body.indexOf("$$"));
    expect(header, "must not be SECURITY DEFINER").not.toMatch(/security definer/i);
    // it inserts a site and nothing else.
    expect(body).toMatch(/insert into public\.sites/i);
    expect(body).not.toMatch(/insert into public\.stock_movements/i);
  });
});

// ---------------------------------------------------------------------------
// 3. The vehicle link is cross-tenant-safe and history-preserving
// ---------------------------------------------------------------------------

describe("the vehicle link", () => {
  const mig = sqlOnly(read(MIG));

  it("adds 'vehicle' to the site kind CHECK without dropping any existing kind", () => {
    expect(mig).toMatch(/add constraint sites_kind_check[\s\S]*?'vehicle'/i);
    for (const kind of ["depot", "yard", "warehouse", "office", "storage_container", "lock_up"]) {
      expect(mig, `${kind} must survive the CHECK rewrite`).toContain(`'${kind}'`);
    }
  });

  it("links to the vehicle ON DELETE SET NULL, never CASCADE — history must survive", () => {
    // A composite (id, org_id) FK would force CASCADE and delete the van's stock
    // record when the vehicle went. The link is a plain FK + guard instead.
    expect(mig).toMatch(
      /vehicle_asset_id uuid\s*\n?\s*references public\.fleet_vehicles\(asset_id\) on delete set null/i,
    );
    expect(mig).not.toMatch(/vehicle_asset_id[\s\S]{0,120}on delete cascade/i);
  });

  it("guards the link's org by a SECURITY DEFINER trigger (RLS cannot see the parent's org)", () => {
    expect(mig).toMatch(
      /create trigger sites_vehicle_org\s*\n?\s*before insert or update on public\.sites/i,
    );
    const start = mig.indexOf("create or replace function public.tg_sites_vehicle_org_integrity()");
    expect(start).toBeGreaterThan(-1);
    const header = mig.slice(start, mig.indexOf("$$", start));
    expect(header).toMatch(/security definer/i);
    expect(mig).toMatch(/raise exception 'vehicle % is not in org %'/);
  });

  it("enforces one stock location per vehicle, and only on vehicle-kind sites", () => {
    expect(mig).toMatch(
      /create unique index if not exists sites_vehicle_asset_uniq\s*\n?\s*on public\.sites \(vehicle_asset_id\)\s*\n?\s*where vehicle_asset_id is not null/i,
    );
    expect(mig).toMatch(/check \(vehicle_asset_id is null or kind = 'vehicle'\)/);
  });
});

// ---------------------------------------------------------------------------
// 4. Active-org pinning on every read and write
// ---------------------------------------------------------------------------

describe("van-stock surfaces pin the ACTIVE org, not just RLS", () => {
  const service = codeOf(read(SERVICE));
  const actions = codeOf(read(ACTIONS));

  it("EVERY read in the service filters on org_id", () => {
    const selects = service.match(/\.select\(/g) ?? [];
    const pins = service.match(/\.eq\("org_id", orgId\)/g) ?? [];
    expect(selects.length).toBeGreaterThan(0);
    expect(pins.length).toBe(selects.length);
  });

  it("EVERY RPC call passes ctx.org.id as p_org_id", () => {
    const pinned = actions.match(/p_org_id:\s*ctx\.org\.id/g) ?? [];
    const all = actions.match(/p_org_id:/g) ?? [];
    expect(all.length).toBeGreaterThan(0);
    expect(pinned.length).toBe(all.length);
  });

  it("the enable action is admin-gated (a member sees a sentence, not a raw refusal)", () => {
    expect(actions).toMatch(/ctx\.membership\.role === "owner" \|\| ctx\.membership\.role === "admin"/);
  });

  it("never reaches for the service-role admin client (it would bypass the admin gate)", () => {
    for (const src of [service, actions]) {
      expect(src).not.toMatch(/createAdminClient/);
      expect(src).not.toMatch(/SERVICE_ROLE/);
    }
  });

  it("the service embeds nothing and fails loudly", () => {
    // No PostgREST embeds (the ambiguity lesson), and every read throws.
    expect(service).not.toMatch(/users\s*\(/);
    const selects = (service.match(/\.select\(/g) ?? []).length;
    const throws = (service.match(/throw readFailure\(/g) ?? []).length;
    expect(throws).toBe(selects);
  });

  it("does no cache revalidation (the deep-swap commit race) and hard-navigates", () => {
    expect(actions).not.toMatch(/revalidatePath\(/);
    expect(actions).not.toMatch(/revalidateTag\(/);
    expect(codeOf(read("app/(app)/stock/vans/_van-forms.tsx"))).toMatch(
      /window\.location\.assign\(state\.redirectTo\)/,
    );
  });
});
