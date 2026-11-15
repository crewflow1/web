/* eslint-disable @typescript-eslint/no-explicit-any -- catalogue-driven; see _fixture.ts */
import { afterAll, beforeAll, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describeIntegration } from "../_harness";
import {
  createWorld,
  destroyWorld,
  loadSurface,
  orgColumnOf,
  pkFilter,
  publicTables,
  qs,
  rawFetch,
  seedOrgRows,
  svc,
  type Column,
  type Relation,
  type World,
} from "./_fixture";
import { writeReport } from "./_report";

/**
 * MASS ASSIGNMENT THROUGH THE DATA API — which COLUMNS can a `staff` JWT actually
 * change? (register ST-09 / ST-10; generalisation of the injection workstream's INJ-01.)
 *
 * Row-level reach (staff-vertical-escalation.test.ts) says WHICH ROWS staff can touch.
 * This says WHAT they can do to them. For every org-scoped table the row factory can
 * seed, org A's staff member sends one PATCH per column — a REAL change of value
 * (money +1, the next allowed status, another user's id in an *_by column, org_id := a
 * different org, …) — against an OWNER-authored row, straight at PostgREST. Ground
 * truth (service role) decides whether the column changed; it is then restored.
 * Two passes: the job unassigned, then assigned to the staff member (the assigned-job
 * RLS scope widens what staff can see and therefore write).
 *
 * The result is compared, column by column, with a reviewed ledger
 * (staff-writable-columns.ledger.json). The suite fails when
 *   • staff can change a (table, column) that is not in the ledger → a new column or
 *     table became client-writable. Decide: restrict it, or record it with a class;
 *   • a ledger entry is no longer writable → delete it (the ledger only shrinks).
 * and, independently of any ledger, when
 *   • ANY org column can be changed (moving a row to another tenant);
 *   • any table in NEVER_STAFF_WRITABLE is writable at all.
 *
 * Ledger classes (hand-reviewed against the server actions' role checks):
 *   INTENDED  a server action with no role gate performs the same write for staff.
 *   OPEN      staff can write it directly but the product gives them no such action
 *             (RPC-only state machines, or role-gated actions) — tracked in the register.
 *
 * With ADV_REPORT_DIR set, the full (table, column, staff_can_update) matrix is written
 * as staff-column-mutation.csv.
 */

type LedgerEntry = { class: "INTENDED" | "OPEN"; note: string; unassigned: string[]; assigned: string[] };
const LEDGER: Record<string, LedgerEntry> = JSON.parse(
  readFileSync(path.join(__dirname, "staff-writable-columns.ledger.json"), "utf8"),
).tables;

/** Fixed by 20261303000000 / 20261304000000 (+ the admin-only parents). Never writable by staff. */
const NEVER_STAFF_WRITABLE: readonly string[] = [
  "invoices", "invoice_line_items", "invoice_payments", "invoice_payment_intents", "payments",
  "quotes", "quote_line_items", "quote_versions", "quote_templates", "quote_template_lines",
  "price_book_items", "bank_statements", "bank_statement_lines", "finances", "job_budgets",
  "job_valuations", "payroll_runs", "payroll_lines", "staff_compensation", "api_keys",
  "webhook_endpoints", "membership_permissions", "org_sso_config", "org_subscriptions",
  "messages", "conversations", "inbound_enquiries", "whatsapp_assistant_actions", "calls",
  "missed_call_textbacks", "voice_notes", "lead_followup_state", "service_catalog",
  "notifications",
];

function enumValues(rel: Relation, col: string): string[] {
  for (const chk of rel.checks) {
    const m = new RegExp(`\\(\\(?${col}\\)?(?:::text)? = ANY \\(\\(?ARRAY\\[([^\\]]*)\\]`).exec(chk);
    if (m) return [...(m[1] ?? "").matchAll(/'([^']*)'/g)].map((x) => x[1] ?? "");
  }
  return [];
}
function mutate(rel: Relation, c: Column, v: any, w: World, orgCol: string): any {
  if (c.name === orgCol) return w.B.id;
  const fk = rel.fks.find((f) => f.cols.includes(c.name));
  if (c.type === "uuid") {
    if (fk?.ref_table === "users") return v === w.A.admin.id ? w.A.staff.id : w.A.admin.id;
    if (fk) return undefined;
    return randomUUID();
  }
  if (c.enum?.length) return c.enum.find((e) => e !== v) ?? undefined;
  if (c.type === "boolean") return !v;
  if (/^(integer|bigint|smallint|numeric|double precision|real)/.test(c.type)) return (Number(v) || 0) + 1;
  if (c.type === "date") return "2031-03-03";
  if (c.type.startsWith("timestamp")) return "2031-03-03T03:03:03+00:00";
  if (c.type === "jsonb" || c.type === "json") return { adv: true };
  if (c.type.endsWith("[]")) return c.type.startsWith("text") ? ["adv"] : undefined;
  if (c.type === "text" || c.type.startsWith("character") || c.type === "citext") {
    const ev = enumValues(rel, c.name);
    if (ev.length) return ev.find((e) => e !== v) ?? undefined;
    return `${v ?? ""}-adv`;
  }
  return undefined;
}

type Pass = Record<string, { readable: boolean; changed: string[]; tried: string[] }>;

describeIntegration("ADVERSARIAL · mass assignment — which columns can a staff JWT change, table by table", () => {
  let w: World | null = null;
  const out: { unassigned: Pass; assigned: Pass; insert: Record<string, number> } = { unassigned: {}, assigned: {}, insert: {} };
  const orgColumnChanged: string[] = [];

  beforeAll(async () => {
    w = await createWorld("sectenant-mut");
    const s = await loadSurface();
    const world = w;
    const seed = await seedOrgRows(s, world.A.id, world.A.owner.id, world.tag);

    const run = async (bucket: Pass) => {
      for (const rel of publicTables(s)) {
        const orgCol = orgColumnOf(rel);
        const row0 = seed.rows.get(rel.name);
        if (!orgCol || !row0 || rel.name === "memberships") continue;
        const f = pkFilter(rel, row0);
        if (!f) continue;
        const match = Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v.replace(/^eq\./, "")]));
        const truth = async () => (await svc().from(rel.name).select("*").match(match).maybeSingle()).data as any;
        let cur = await truth();
        if (!cur) continue;
        const read = await rawFetch(`/rest/v1/${rel.name}?${qs(f)}`, { bearer: world.A.staff.token });
        const readable = read.status === 200 && Array.isArray(read.json) && read.json.length === 1;
        const changed: string[] = [];
        const tried: string[] = [];
        for (const c of rel.columns) {
          if (c.generated || c.identity || rel.pk.includes(c.name)) continue;
          const nv = mutate(rel, c, cur[c.name], world, orgCol);
          if (nv === undefined) continue;
          tried.push(c.name);
          await rawFetch(`/rest/v1/${rel.name}?${qs(f)}`, { method: "PATCH", bearer: world.A.staff.token, body: { [c.name]: nv } });
          const after = await truth();
          if (!after) {
            changed.push(c.name);
            if (c.name === orgCol) orgColumnChanged.push(`${rel.name}.${c.name} (row left the org)`);
            break;
          }
          if (JSON.stringify(after[c.name]) !== JSON.stringify(cur[c.name])) {
            changed.push(c.name);
            if (c.name === orgCol) orgColumnChanged.push(`${rel.name}.${c.name}`);
            await svc().from(rel.name).update({ [c.name]: cur[c.name] }).match(match);
            cur = (await truth()) ?? cur;
          }
        }
        bucket[rel.name] = { readable, changed, tried };
      }
    };

    await run(out.unassigned);
    const job = seed.rows.get("jobs");
    if (job) {
      await svc().from("jobs").update({ assigned_to: world.A.staff.id }).eq("id", job.id);
      await svc().from("job_assignments").insert({ org_id: world.A.id, job_id: job.id, user_id: world.A.staff.id });
    }
    await run(out.assigned);

    // INSERT (recorded for the evidence report): a staff-sent clone of the owner's row.
    for (const rel of publicTables(s)) {
      const orgCol = orgColumnOf(rel);
      const row = seed.rows.get(rel.name);
      if (!orgCol || !row || rel.name === "memberships") continue;
      const clone: any = {};
      for (const c of rel.columns) {
        if (c.generated || c.identity) continue;
        if (rel.pk.includes(c.name)) {
          if (c.type === "uuid") clone[c.name] = randomUUID();
          continue;
        }
        if (/^(created_at|updated_at)$/.test(c.name)) continue;
        clone[c.name] = row[c.name];
      }
      const r = await rawFetch(`/rest/v1/${rel.name}`, { method: "POST", bearer: world.A.staff.token, body: clone, headers: { Prefer: "return=minimal" } });
      out.insert[rel.name] = r.status;
      if (r.status < 300 && clone.id) await svc().from(rel.name).delete().eq("id", clone.id);
    }
  }, 900_000);

  afterAll(async () => {
    const lines = ["table,column,pass,staff_can_update,ledger_class"];
    for (const pass of ["unassigned", "assigned"] as const) {
      for (const [t, v] of Object.entries(out[pass])) {
        for (const c of v.tried) lines.push(`${t},${c},${pass},${v.changed.includes(c)},${v.changed.includes(c) ? (LEDGER[t]?.class ?? "UNLISTED") : ""}`);
      }
    }
    writeReport("staff-column-mutation.json", out);
    if (process.env.ADV_REPORT_DIR) {
      const { writeFileSync } = await import("node:fs");
      writeFileSync(path.join(process.env.ADV_REPORT_DIR, "staff-column-mutation.csv"), lines.join("\n") + "\n");
    }
    await destroyWorld(w);
  }, 300_000);

  it("the probe covered the catalogue", () => {
    expect(Object.keys(out.unassigned).length).toBeGreaterThan(100);
    const tried = Object.values(out.unassigned).reduce((n, v) => n + v.tried.length, 0);
    expect(tried).toBeGreaterThan(1000);
  });

  it("staff can NEVER change a row's org column (no moving rows between tenants)", () => {
    expect(orgColumnChanged).toEqual([]);
  });

  it("staff can write NOTHING in the money / credential / comms-record tables", () => {
    const hit: string[] = [];
    for (const pass of ["unassigned", "assigned"] as const) {
      for (const t of NEVER_STAFF_WRITABLE) {
        const v = out[pass][t];
        if (v?.changed.length) hit.push(`${t} [${pass}]: ${v.changed.join(",")}`);
      }
    }
    expect(hit).toEqual([]);
    expect(NEVER_STAFF_WRITABLE.filter((t) => LEDGER[t]), "a NEVER_STAFF_WRITABLE table is in the ledger").toEqual([]);
    // Staff cannot INSERT into them either (2xx = a row landed).
    const inserted = NEVER_STAFF_WRITABLE.filter((t) => (out.insert[t] ?? 999) < 300 && t !== "finances");
    expect(inserted).toEqual([]);
  });

  for (const pass of ["unassigned", "assigned"] as const) {
    it(`every column staff can change (${pass} job) is in the reviewed ledger — and the ledger has no stale entries`, () => {
      const unexpected: string[] = [];
      const stale: string[] = [];
      for (const [t, v] of Object.entries(out[pass])) {
        const allowed = new Set(LEDGER[t]?.[pass] ?? []);
        for (const c of v.changed) if (!allowed.has(c)) unexpected.push(`${t}.${c}`);
        for (const c of allowed) if (v.tried.includes(c) && !v.changed.includes(c)) stale.push(`${t}.${c}`);
      }
      expect(
        unexpected,
        "a staff JWT can change column(s) not in staff-writable-columns.ledger.json. Restrict them " +
          "(role-aware policy / column grant) or add them to the ledger with a class and a reason.",
      ).toEqual([]);
      expect(stale, "ledger lists column(s) staff can no longer change — remove them").toEqual([]);
    });
  }
});
