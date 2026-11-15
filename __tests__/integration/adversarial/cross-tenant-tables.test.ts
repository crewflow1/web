/* eslint-disable @typescript-eslint/no-explicit-any -- catalogue-driven; see _fixture.ts */
import { afterAll, beforeAll, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { describeIntegration } from "../_harness";
import {
  createWorld,
  destroyWorld,
  loadSurface,
  mkActor,
  orgColumnOf,
  pkFilter,
  publicTables,
  qs,
  rawFetch,
  seedOrgRows,
  svc,
  type Actor,
  type Relation,
  type SeedResult,
  type Surface,
  type World,
} from "./_fixture";
import { writeReport } from "./_report";

/**
 * ATTACK 2 (+ the table half of ATTACK 1) — horizontal isolation, catalogue-driven.
 *
 * Two real organisations. The row factory plants one row in EVERY org-scoped table it
 * can for org B (the victim). Then six attackers — the anonymous public-key holder;
 * org A's owner, admin and staff; a signed-up user with NO organisation; and a former
 * admin of org B whose membership was removed while their JWT is still valid (ATTACK 4,
 * stale access) — each with a REAL GoTrue session, go at each of B's rows over raw
 * PostgREST, by direct primary key:
 *
 *   READ    GET    /t?<pk>=eq.<B row>            and  GET /t?org_id=eq.<B>
 *   UPDATE  PATCH  /t?<pk>=eq.<B row>            body: steal it (org_id := A) / deface it
 *   DELETE  DELETE /t?<pk>=eq.<B row>
 *   INSERT  POST   /t                            body: a clone of B's row, org_id = B
 *
 * The verdict is never the HTTP status (a 200 with [] and a 403 are both fine): it is
 * GROUND TRUTH re-read with the service role — B's row must be byte-identical and B's
 * row count unchanged — plus "no B row was returned to the attacker".
 *
 * A POSITIVE CONTROL keeps this honest: B's own owner must be able to read B's planted
 * row in a healthy share of the tables. Without it, a misconfigured probe (wrong URL,
 * wrong filter) would "pass" by seeing nothing anywhere.
 *
 * New tables are covered automatically. The only ledgers are (a) UNSEEDABLE_BUDGET —
 * how many org-scoped tables the factory may fail to seed before the suite demands
 * attention, and (b) CROSS_ORG_READABLE — tables whose rows are deliberately visible
 * outside the owning org, each with a reason.
 */

/** Org-scoped tables the factory is allowed to fail on (multi-row coherence CHECKs etc.). */
const UNSEEDABLE_BUDGET = 60;

/** Deliberately cross-org readable rows. Empty today — any entry needs a reason. */
const CROSS_ORG_READABLE: ReadonlyMap<string, string> = new Map<string, string>([]);

/**
 * RESIDUAL (register ST-08, P3). Bare single-column foreign keys through which a member
 * can still create a row IN THEIR OWN ORG that points at another org's parent. Each was
 * reviewed for the two things that turn such a reference into a hole — a service-role
 * reader that loads children by parent id alone, or a SECURITY DEFINER trigger that
 * writes to the parent — and none was found on a public / portal / cron surface (the
 * four that did have one — quote_line_items, invoice_reminders, support_messages and the
 * polymorphic tenant_attachments — are fixed and pinned in
 * cross-tenant-injection.test.ts). They are the same set the INTERNAL_RLS allowlist in
 * rls/cross-tenant-fk-completeness.test.ts tracks as the composite-FK backlog.
 *
 * This ledger only ever SHRINKS: a reference accepted here that is not listed fails.
 */
const RESIDUAL_BARE_REFERENCES: ReadonlySet<string> = new Set([
  "assets.supplier_id -> suppliers",
  "bank_statement_lines.bank_statement_id -> bank_statements",
  "bank_statement_lines.matched_invoice_id -> invoices",
  "bank_statement_lines.matched_payment_id -> invoice_payments",
  "calls.lead_id -> leads",
  "conversations.lead_id -> leads",
  "expense_drafts.finance_id -> finances",
  "expense_drafts.supplier_id -> suppliers",
  "import_audit.import_id -> imports",
  "import_audit.import_row_id -> import_rows",
  "import_files.import_id -> imports",
  "import_rows.file_id -> import_files",
  "import_rows.import_id -> imports",
  "inbound_enquiries.conversation_id -> receptionist_conversations",
  "inbound_enquiries.lead_id -> leads",
  "invoice_payments.bank_line_id -> bank_statement_lines",
  "job_documents.job_id -> jobs",
  "leads.property_id -> properties",
  "missed_call_textbacks.call_id -> calls",
  "payroll_lines.payroll_run_id -> payroll_runs",
  "properties.customer_id -> customers",
  "review_requests.customer_id -> customers",
  "review_requests.job_id -> jobs",
  "rota_entries.job_id -> jobs",
  "site_diary_entries.job_id -> jobs",
  "site_reports.customer_id -> customers",
  "site_reports.job_id -> jobs",
  "snags.job_id -> jobs",
]);

type Violation = { table: string; attacker: string; attack: string; detail: string };

describeIntegration("ADVERSARIAL · cross-tenant table access by direct id (every org-scoped table)", () => {
  let w: World | null = null;
  let surface: Surface;
  let seedB: SeedResult;
  let seedA: SeedResult;
  let noOrg: Actor;
  let exMember: Actor;
  const violations: Violation[] = [];
  const stats = { tables: 0, probes: 0, controlReadable: 0, controlGranted: 0 };

  beforeAll(async () => {
    surface = await loadSurface();
    w = await createWorld("sectenant-xt");
    seedB = await seedOrgRows(surface, w.B.id, w.B.owner.id, `${w.tag}-b`);
    seedA = await seedOrgRows(surface, w.A.id, w.A.owner.id, `${w.tag}-a`);
    // Two more attackers with REAL sessions and NO current right to anything:
    //   noOrg    — signed up, never onboarded: `authenticated` role, zero memberships.
    //   exMember — was an ADMIN of org B; the membership was deleted AFTER they signed
    //              in, so they still hold an unexpired JWT minted while they were a member.
    noOrg = await mkActor(w.tag, "no-org", null, null);
    exMember = await mkActor(w.tag, "ex-b-admin", w.B.id, "admin");
    const gone = await svc().from("memberships").delete().eq("org_id", w.B.id).eq("user_id", exMember.id);
    if (gone.error) throw new Error(gone.error.message);
    w.extras.push(noOrg, exMember);
  }, 300_000);

  afterAll(async () => {
    writeReport("cross-tenant-tables.json", {
      stats,
      seeded: [...seedB.rows.keys()].sort(),
      unseeded: Object.fromEntries(seedB.unseeded),
      violations,
    });
    await destroyWorld(w);
  }, 300_000);

  const truth = async (rel: Relation, filter: Record<string, string>): Promise<any | null> => {
    let q = svc().from(rel.name).select("*");
    for (const [k, v] of Object.entries(filter)) q = q.eq(k, v.replace(/^eq\./, ""));
    const r = await q.maybeSingle();
    if (r.error) throw new Error(`ground truth ${rel.name}: ${r.error.message}`);
    return r.data;
  };
  const countFor = async (rel: Relation, orgCol: string, orgId: string): Promise<number> => {
    const r = await svc().from(rel.name).select("*", { count: "exact", head: true }).eq(orgCol, orgId);
    if (r.error) throw new Error(`ground truth count ${rel.name}: ${r.error.message}`);
    return r.count ?? 0;
  };

  it("the row factory covers the org-scoped catalogue (unseedable tables stay within budget)", () => {
    const total = publicTables(surface).filter((r) => orgColumnOf(r)).length;
    expect(seedB.rows.size, "no rows seeded — the attack below would be vacuous").toBeGreaterThan(100);
    expect(
      seedB.unseeded.size,
      `row factory could not seed ${seedB.unseeded.size}/${total} org-scoped tables — extend OVERRIDES in _fixture.ts:\n` +
        [...seedB.unseeded].map(([t, why]) => `  ${t}: ${why}`).join("\n"),
    ).toBeLessThanOrEqual(UNSEEDABLE_BUDGET);
  });

  it("no attacker (anon, A-owner, A-admin, A-staff, a no-org user, a removed B admin with a stale JWT) can read, steal, deface, delete or forge a row of org B", async () => {
    const world = w!;
    const attackers: { label: string; bearer: string | undefined; actor: Actor | null }[] = [
      { label: "anon", bearer: undefined, actor: null },
      { label: "A-owner", bearer: world.A.owner.token, actor: world.A.owner },
      { label: "A-admin", bearer: world.A.admin.token, actor: world.A.admin },
      { label: "A-staff", bearer: world.A.staff.token, actor: world.A.staff },
      { label: "no-org-user", bearer: noOrg.token, actor: noOrg },
      { label: "removed-B-admin(stale JWT)", bearer: exMember.token, actor: exMember },
    ];

    for (const rel of publicTables(surface)) {
      const orgCol = orgColumnOf(rel);
      const row = seedB.rows.get(rel.name);
      if (!orgCol || !row || rel.name === "memberships") continue;
      const filter = pkFilter(rel, row);
      if (!filter) continue;
      stats.tables++;
      const before = await truth(rel, filter);
      const beforeCount = await countFor(rel, orgCol, world.B.id);
      const path = `/rest/v1/${rel.name}`;

      // POSITIVE CONTROL — B's own owner.
      if (rel.authenticated.includes("SELECT")) {
        stats.controlGranted++;
        const own = await rawFetch(`${path}?${qs(filter)}`, { bearer: world.B.owner.token });
        if (own.status === 200 && Array.isArray(own.json) && own.json.length === 1) stats.controlReadable++;
      }

      for (const atk of attackers) {
        const note = (attack: string, detail: string) =>
          violations.push({ table: rel.name, attacker: atk.label, attack, detail });

        // READ by id, and by org.
        for (const [attack, query] of [
          ["read-by-id", qs(filter)],
          ["read-by-org", `${orgCol}=eq.${world.B.id}&limit=5`],
        ] as const) {
          stats.probes++;
          const r = await rawFetch(`${path}?${query}`, { bearer: atk.bearer });
          if (r.status >= 200 && r.status < 300 && Array.isArray(r.json) && r.json.length > 0) {
            if (!CROSS_ORG_READABLE.has(rel.name)) note(attack, `returned ${r.json.length} row(s) of org B`);
          }
        }

        // UPDATE — steal the row into A, then deface a text column.
        const textCol = rel.columns.find(
          (c) => c.type === "text" && !c.generated && !rel.pk.includes(c.name) && c.name !== orgCol && !rel.fks.some((f) => f.cols.includes(c.name)),
        );
        const patches: [string, Record<string, unknown>][] = [["steal(org:=A)", { [orgCol]: world.A.id }]];
        if (textCol) patches.push([`deface(${textCol.name})`, { [textCol.name]: "adv-pwned" }]);
        for (const [attack, body] of patches) {
          stats.probes++;
          const r = await rawFetch(`${path}?${qs(filter)}`, {
            method: "PATCH",
            bearer: atk.bearer,
            body,
            headers: { Prefer: "return=representation" },
          });
          if (r.status >= 200 && r.status < 300 && Array.isArray(r.json) && r.json.length > 0) {
            note(attack, `PATCH returned ${r.json.length} row(s)`);
          }
        }

        // DELETE.
        stats.probes++;
        const del = await rawFetch(`${path}?${qs(filter)}`, {
          method: "DELETE",
          bearer: atk.bearer,
          headers: { Prefer: "return=representation" },
        });
        if (del.status >= 200 && del.status < 300 && Array.isArray(del.json) && del.json.length > 0) {
          note("delete", `DELETE returned ${del.json.length} row(s)`);
        }

        // INSERT a forged clone into org B.
        stats.probes++;
        const clone: Record<string, unknown> = {};
        for (const c of rel.columns) {
          if (c.generated || c.identity) continue;
          if (rel.pk.includes(c.name)) {
            if (c.type === "uuid") clone[c.name] = randomUUID();
            continue;
          }
          if (/^(created_at|updated_at)$/.test(c.name)) continue;
          clone[c.name] = row[c.name];
        }
        const ins = await rawFetch(path, {
          method: "POST",
          bearer: atk.bearer,
          body: clone,
          headers: { Prefer: "return=minimal" },
        });

        // GROUND TRUTH after this attacker's whole salvo.
        const after = await truth(rel, filter);
        if (after === null) note("delete", "row of org B is GONE");
        else if (JSON.stringify(after) !== JSON.stringify(before)) note("update", "row of org B was MODIFIED");
        const afterCount = await countFor(rel, orgCol, world.B.id);
        if (afterCount > beforeCount) {
          note("insert", `forged row landed in org B (HTTP ${ins.status})`);
          // Remove the forgery so later attackers start from a clean baseline.
          if (clone.id) await svc().from(rel.name).delete().eq("id", clone.id as string);
        }
      }
    }

    expect(
      violations,
      `CROSS-TENANT VIOLATIONS:\n${violations.map((v) => `  ${v.table} · ${v.attacker} · ${v.attack} · ${v.detail}`).join("\n")}`,
    ).toEqual([]);
  }, 900_000);

  it("positive control: org B's own owner CAN read its planted rows (the probes are not vacuous)", () => {
    expect(stats.tables).toBeGreaterThan(100);
    expect(stats.controlGranted).toBeGreaterThan(50);
    // Owner reads the large majority of its own rows in client-readable tables. (Not
    // 100%: some tables are readable only by an assignee / a specific capability.)
    expect(stats.controlReadable / stats.controlGranted).toBeGreaterThan(0.8);
  });

  it("no NEW way to plant a row in the attacker's own org that points at org B's parent rows", async () => {
    // For every table with a NOT NULL foreign key to another org-scoped table: A's owner
    // inserts a row with org_id = A but the parent id of ORG B. A landed row is a
    // cross-tenant reference (the class the composite-FK programme closed).
    const world = w!;
    const landed: string[] = [];
    for (const rel of publicTables(surface)) {
      const orgCol = orgColumnOf(rel);
      const aRow = seedA.rows.get(rel.name);
      if (!orgCol || !aRow || !rel.authenticated.includes("INSERT")) continue;
      for (const fk of rel.fks) {
        const parentB = seedB.rows.get(fk.ref_table);
        const single = fk.cols.filter((c) => c !== orgCol);
        if (!parentB || single.length !== 1 || fk.ref_table === rel.name) continue;
        const col = single[0];
        const refCol = col ? fk.ref_cols[fk.cols.indexOf(col)] : undefined;
        if (!col || !refCol) continue;
        const clone: Record<string, unknown> = {};
        for (const c of rel.columns) {
          if (c.generated || c.identity) continue;
          if (rel.pk.includes(c.name)) {
            if (c.type === "uuid") clone[c.name] = randomUUID();
            continue;
          }
          if (/^(created_at|updated_at)$/.test(c.name)) continue;
          clone[c.name] = aRow[c.name];
        }
        clone[orgCol] = world.A.id;
        clone[col] = parentB[refCol];
        stats.probes++;
        const r = await rawFetch(`/rest/v1/${rel.name}`, {
          method: "POST",
          bearer: world.A.owner.token,
          body: clone,
          headers: { Prefer: "return=representation" },
        });
        if (r.status >= 200 && r.status < 300) {
          landed.push(`${rel.name}.${col} -> ${fk.ref_table} (org B)`);
          if (clone.id) await svc().from(rel.name).delete().eq("id", clone.id as string);
        }
      }
    }
    writeReport("cross-tenant-fk-plant.json", { landed });
    const unexpected = landed.filter((l) => !RESIDUAL_BARE_REFERENCES.has(l.replace(/ \(org B\)$/, "")));
    expect(
      unexpected,
      "NEW cross-tenant reference accepted (a row in the attacker's org pointing at a victim-org parent). " +
        "Make the foreign key composite — (col, org_id) -> parent(id, org_id) — as in 20261301000000:\n  " +
        unexpected.join("\n  "),
    ).toEqual([]);
  }, 600_000);
});
