import { afterAll, beforeAll, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { describeIntegration } from "../_harness";
import {
  createWorld,
  destroyWorld,
  loadSurface,
  orgColumnOf,
  publicTables,
  rawFetch,
  seedOrgRows,
  svc,
  type Fn,
  type SeedResult,
  type Surface,
  type World,
} from "./_fixture";
import { writeReport } from "./_report";

/**
 * ATTACK 1 (functions) + ATTACK 2 (org-id-taking RPCs) — catalogue-driven.
 *
 * Every function PostgREST will let a client invoke (public schema, EXECUTE granted to
 * anon or authenticated, not a trigger, not extension-owned) is CALLED — not grepped —
 * by three attackers: the anonymous public-key holder, org A's owner and org A's staff.
 * Arguments are derived from the function's own signature and aimed at the VICTIM:
 * every uuid parameter is bound to org B's id or to the id of a real row org B owns
 * (`p_job_id` → B's job, `p_supplier_id` → B's supplier, …).
 *
 * Two independent verdicts, neither of which trusts the HTTP status or the body text
 * of the function:
 *
 *   WRITE  — ground truth. A full snapshot of org B (every seeded row + per-table row
 *            counts, read with the service role) must be identical before and after
 *            the whole salvo.
 *   READ   — a call that SUCCEEDS and returns anything other than "nothing"
 *            (null / false / 0 / [] / "") while aimed at org B is a disclosure, unless
 *            the function is in DISCLOSES_NOTHING_ABOUT_B with the reason it is safe.
 *            Independently, no response body may contain any id or marker string
 *            planted in org B.
 *
 * This complements rls/secdef-org-rpc-guard.test.ts, which is STATIC (it reads the
 * function body for the canonical guard idiom). A guard that is present in the text
 * but wrong in effect passes that test and fails this one.
 */

/**
 * Functions that legitimately return a non-empty value when called with org B's ids.
 * Each entry states why the value says nothing about org B.
 */
const DISCLOSES_NOTHING_ABOUT_B: ReadonlyMap<string, string> = new Map<string, string>([
  ["cis_derive_verification_expiry", "pure date arithmetic on its own argument; reads no table"],
  ["cis_return_due_date", "pure date arithmetic on its own argument; reads no table"],
  ["cis_statement_due_date", "pure date arithmetic on its own argument; reads no table"],
  ["cis_tax_month_end", "pure date arithmetic on its own argument; reads no table"],
  ["cis_tax_month_start", "pure date arithmetic on its own argument; reads no table"],
  ["inbox_channel_for_enquiry", "pure text mapping of its own argument; reads no table"],
  [
    "current_org_ids",
    "takes no argument; returns the CALLER's own org ids (auth.uid() memberships, or the impersonated org for an HQ operator). The body-leak check below still proves it never returns org B's id.",
  ],
  ["stock_lock_key", "pure hash of its two uuid arguments (advisory-lock key); reads no table"],
]);

type Outcome = {
  fn: string;
  attacker: string;
  status: number;
  code: string | null;
  returned: "nothing" | "value";
  sample: string;
};

function isNothing(v: unknown): boolean {
  if (v === null || v === undefined || v === false || v === 0 || v === "") return true;
  if (Array.isArray(v)) return v.every(isNothing);
  if (typeof v === "object") {
    const vals = Object.values(v as Record<string, unknown>);
    return vals.length === 0 || vals.every(isNothing);
  }
  return false;
}

describeIntegration("ADVERSARIAL · every client-executable function, called with the victim org's ids", () => {
  let w: World | null = null;
  let surface: Surface;
  let seedB: SeedResult;
  const outcomes: Outcome[] = [];

  beforeAll(async () => {
    surface = await loadSurface();
    w = await createWorld("sectenant-rpc");
    seedB = await seedOrgRows(surface, w.B.id, w.B.owner.id, `${w.tag}-b`);
  }, 300_000);

  afterAll(async () => {
    writeReport("rpc-surface.json", { outcomes });
    await destroyWorld(w);
  }, 300_000);

  /** Bind one parameter to the victim. */
  const argFor = (name: string, type: string): unknown => {
    const world = w!;
    const n = name.replace(/^(p_|target_|in_|_)/, "");
    if (type === "uuid") {
      if (/^(org|org_id|organization_id)$/.test(n)) return world.B.id;
      if (/user|assignee|worker|assigned_to|received_by|generated_by/.test(n)) return world.B.staff.id;
      const stem = n.replace(/_id$/, "");
      const candidates = [
        stem, `${stem}s`, `${stem}es`, stem.replace(/y$/, "ies"),
        `job_${stem}s`, `stock_${stem}s`, `${stem}_sessions`, `stocktake_${stem}s`,
        stem === "item" ? "stock_items" : "", stem === "po" ? "purchase_orders" : "",
        stem === "grn" ? "goods_received_notes" : "", stem === "request" ? "material_requests" : "",
        stem === "statement" ? "cis_statements" : "", stem === "return" ? "cis_monthly_returns" : "",
        stem === "from_site" || stem === "to_site" ? "sites" : "", stem === "vehicle_asset" ? "assets" : "",
        stem === "valuation" ? "job_valuations" : "", stem === "stage" ? "job_billing_stages" : "",
        stem === "movement" ? "stock_movements" : "", stem === "session" ? "stocktake_sessions" : "",
        stem === "template" ? "job_templates" : "", stem === "baseline" ? "job_programme_baselines" : "",
        stem === "inspection" ? "asset_inspections" : "", stem === "plan" ? "inspection_test_plans" : "",
        stem === "listing" ? "marketplace_listings" : "", stem === "case" ? "asset_maintenance_cases" : "",
        stem === "schedule" ? "asset_service_schedules" : "", stem === "blueprint_version" ? "blueprint_versions" : "",
        stem === "grn_line" ? "goods_received_note_lines" : "", stem === "material_request_line" ? "material_request_lines" : "",
      ];
      for (const c of candidates) {
        const row = c ? seedB.rows.get(c) : undefined;
        if (row?.id) return row.id;
      }
      return randomUUID();
    }
    if (type === "date") return new Date().toISOString().slice(0, 10);
    if (type.startsWith("timestamp")) return new Date().toISOString();
    if (type === "boolean") return false;
    if (type === "jsonb" || type === "json") return /lines|allocations|edges|milestones|checklist|fulfilled/.test(n) ? [] : {};
    if (type.endsWith("[]")) return [];
    if (/^(integer|bigint|smallint|numeric|double precision|real)/.test(type)) return 1;
    if (/path|object_name/.test(n)) return `${world.B.id}/adv/probe.jpg`;
    if (/query/.test(n)) return "adv";
    return "adv";
  };

  const snapshot = async (): Promise<string> => {
    const world = w!;
    const out: Record<string, unknown> = {};
    for (const rel of publicTables(surface)) {
      const orgCol = orgColumnOf(rel);
      if (!orgCol) continue;
      const c = await svc().from(rel.name).select("*", { count: "exact", head: true }).eq(orgCol, world.B.id);
      out[`${rel.name}#count`] = c.count ?? `ERR ${c.error?.message}`;
      const row = seedB.rows.get(rel.name);
      if (row?.id) {
        const r = await svc().from(rel.name).select("*").eq("id", row.id).maybeSingle();
        out[`${rel.name}#row`] = r.data ?? null;
      }
    }
    return JSON.stringify(out);
  };

  it("no function writes to, or discloses anything about, org B for anon / A-owner / A-staff", async () => {
    const world = w!;
    const attackers: { label: string; bearer: string | undefined }[] = [
      { label: "anon", bearer: undefined },
      { label: "A-owner", bearer: world.A.owner.token },
      { label: "A-staff", bearer: world.A.staff.token },
    ];
    // Marker set: every uuid and adv-marker string planted in org B.
    const markers = new Set<string>([world.B.id, world.B.owner.id, world.B.admin.id, world.B.staff.id]);
    for (const row of seedB.rows.values()) {
      if (typeof row.id === "string") markers.add(row.id);
    }
    const bTag = `${world.tag}-b`;

    const before = await snapshot();
    const disclosures: string[] = [];
    const bodyLeaks: string[] = [];

    const fns: Fn[] = surface.functions;
    expect(fns.length, "catalogue returned no functions — the attack would be vacuous").toBeGreaterThan(50);

    for (const fn of fns) {
      const body: Record<string, unknown> = {};
      const named = fn.arg_names.length >= fn.arg_types.length;
      if (!named && fn.arg_types.length) continue; // positional-only: not callable via PostgREST JSON
      fn.arg_types.forEach((t, i) => {
        const name = fn.arg_names[i];
        if (name) body[name] = argFor(name, t);
      });
      const sentMarkers = new Set(Object.values(body).filter((v): v is string => typeof v === "string"));
      for (const atk of attackers) {
        const r = await rawFetch(`/rest/v1/rpc/${fn.name}`, { method: "POST", bearer: atk.bearer, body });
        const ok = r.status >= 200 && r.status < 300;
        const returned = ok && !isNothing(r.json) ? "value" : "nothing";
        outcomes.push({
          fn: fn.name,
          attacker: atk.label,
          status: r.status,
          code: ok ? null : (r.json?.code ?? null),
          returned,
          sample: r.text.slice(0, 140),
        });
        if (returned === "value" && !DISCLOSES_NOTHING_ABOUT_B.has(fn.name)) {
          disclosures.push(`${fn.name}(${fn.identity_args}) as ${atk.label} → HTTP ${r.status} ${r.text.slice(0, 160)}`);
        }
        if (ok) {
          // A leak is a B marker in the body that the attacker did not send themselves.
          for (const m of markers) {
            if (!sentMarkers.has(m) && r.text.includes(m)) bodyLeaks.push(`${fn.name} as ${atk.label} returned org-B id ${m}`);
          }
          if (r.text.includes(bTag)) bodyLeaks.push(`${fn.name} as ${atk.label} returned an org-B marker string`);
        }
      }
    }

    const after = await snapshot();

    expect(bodyLeaks, `ORG-B DATA IN RPC RESPONSES:\n  ${bodyLeaks.join("\n  ")}`).toEqual([]);
    expect(
      disclosures,
      "functions that returned a non-empty value when aimed at org B — fix the guard, or add to " +
        `DISCLOSES_NOTHING_ABOUT_B with a verified reason:\n  ${disclosures.join("\n  ")}`,
    ).toEqual([]);
    expect(after === before, "org B's data CHANGED after the RPC salvo (a cross-tenant write primitive)").toBe(true);
  }, 900_000);

  it("every allowlisted function still exists (no stale exemptions)", () => {
    const names = new Set(surface.functions.map((f) => f.name));
    for (const name of DISCLOSES_NOTHING_ABOUT_B.keys()) expect(names.has(name), `${name} no longer exists — remove it`).toBe(true);
  });
});
