/* eslint-disable @typescript-eslint/no-explicit-any -- catalogue-driven; see _fixture.ts */
import { afterAll, beforeAll, expect, it } from "vitest";
import { describeIntegration } from "../_harness";
import {
  as,
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
  type SeedResult,
  type Surface,
  type World,
} from "./_fixture";
import { writeReport } from "./_report";

/**
 * ATTACK 3 — vertical escalation: a `staff` JWT against its OWN organisation, straight
 * at PostgREST (no route gate, no capability check, no UI).
 *
 * PART 1 · THE STAFF-REACH LEDGER (catalogue-driven ratchet).
 * The row factory plants one OWNER-authored row in every org-scoped table of org A;
 * A's staff member then tries to read it by id, rewrite it and delete it. What staff
 * can actually do is compared with three explicit ledgers below. The suite fails when
 *   - staff can reach a table that is NOT in the ledger  → a new table shipped
 *     member-wide. Decide: scope it to admins (is_org_admin), or add it here knowingly.
 *   - a ledger entry is no longer reachable              → remove it (keep it honest).
 * This is the gate that would have caught invoices/payments (20261275000000),
 * price_book_items (20261277000000) and the seven financial child tables
 * (20261303000000 — register ST-05) before they shipped.
 *
 * The ledger is a RECORD OF WHAT IS, not a statement that every entry is ideal. Entries
 * the programme considers worth a product decision are called out in
 * docs/programme/security-tenant/VULNERABILITY-REGISTER.md (ST-07 observations).
 *
 * PART 2 · NAMED ESCALATIONS. The specific owner/admin operations a staff member must
 * never complete: change a role, add or remove a member, touch pay, issue an API key,
 * alter billing / the organisation / SSO / permissions, or read the money tables.
 */

/** Tables where a staff JWT can read an org-wide (not self-authored) row by id. */
const STAFF_CAN_READ: ReadonlySet<string> = new Set([
  "accounting_export_log", "accounting_pushed_entities",
  "ai_receptionist_setups", "asset_calibration_certificates", "asset_fuel_logs",
  "asset_inspection_schedules", "asset_inspection_templates", "asset_inspections",
  "asset_maintenance_cases", "asset_qr_identities", "asset_service_schedules", "assets",
  "automation_approvals", "automation_custom_rules", "automation_rules", "automation_schedules",
  "automation_workflow_versions", "blueprint_versions", "calendar_event_links",
  "calendar_pulled_events", "call_events", "calls", "comm_events", "compliance_documents",
  "conversations", "customer_contacts", "customer_portal_preferences", "email_inbound_routes",
  "expense_budgets", "expense_drafts", "fleet_vehicles", "gdpr_erasure_log", "gdpr_export_log",
  "goods_received_lines", "goods_received_notes", "hmrc_submissions", "inbound_enquiries",
  "inspection_plan_template_items", "inspection_plan_templates", "invoice_reminders",
  "job_milestones", "job_template_checklist_items", "job_template_milestones", "job_templates",
  "lead_followup_state", "leave_requests", "maintenance_reminder_log", "memberships",
  "merchant_catalogue_items", "merchant_po_submissions", "messages", "missed_call_textbacks",
  "org_payment_connections", "org_settings", "org_subscriptions", "properties", "report_subscriptions", "retention_policies", "retention_purge_log",
  "service_booking_slots", "service_bookings", "service_catalog", "signatures",
  "site_inductions", "site_visitors", "sites", "staff_qualifications", "stock_items",
  "stocktake_lines", "stocktake_sessions", "suppliers", "support_messages", "support_tickets",
  "telematics_readings", "tenant_attachments", "voice_notes", "whatsapp_assistant_actions",
  "whatsapp_inbound_media", "whatsapp_number_routes", "whatsapp_optouts",
  "worker_signoff_tokens",
]);

/**
 * PROBE CORRECTION (2026-11-15) — NOT new access. Until now the read probe used
 * `select=*`, which a table with a column ACL refuses outright, so these eight tables
 * (token columns hidden by a column ACL, member-wide SELECT policy) were recorded as
 * "not readable by staff". With the probe on the primary key the truth shows: a staff
 * JWT reads the NON-TOKEN columns of its org's integration connection rows (provider,
 * status, institution / tenant / VRN, phone numbers with monthly cost). That is an
 * existing, test-pinned design — rls/{accounting,bank,calendar,hmrc,telematics}-
 * connections + telephony ("a MEMBER can STILL read the non-token columns") — and is
 * recorded as finding LP-F1 for a founder decision (docs/programme/
 * security-least-privilege/ENFORCEMENT.md). The tokens themselves stay unreadable:
 * asserted by the TOKEN_ACL case below.
 */
const STAFF_CAN_READ_NON_TOKEN_COLUMNS: readonly string[] = [
  "accounting_connections", "bank_connections", "calendar_connections", "calendar_watch_channels",
  "hmrc_connections", "merchant_connections", "phone_numbers", "telematics_connections",
];

/** Tables where a staff JWT can UPDATE an org-wide row it did not author. */
const STAFF_CAN_UPDATE: ReadonlySet<string> = new Set([
  // 2026-11-14 least-privilege enforcement (20261340): 15 tables removed — the operations
  // modules (assets, fleet, stock, suppliers, goods receiving) and properties are
  // owner/admin-write at the data layer. Nothing was added. (20261345 then removed
  // permit_conditions from all three ledgers: its rows follow the parent permit.)
  "inspection_plan_templates", "site_visitors",
]);

/** Tables where a staff JWT can DELETE an org-wide row it did not author. */
const STAFF_CAN_DELETE: ReadonlySet<string> = new Set([
  "inspection_plan_template_items", ]);

/**
 * Money / credential / governance tables. Independent of the ledgers above: a staff JWT
 * must reach NONE of these, and they may never be added to a ledger. (ST-05 closed the
 * last seven.)
 */
const NEVER_STAFF: readonly string[] = [
  "invoices", "invoice_line_items", "invoice_payments", "invoice_payment_intents", "payments",
  "quotes", "quote_line_items", "quote_versions", "quote_templates", "quote_template_lines",
  "price_book_items", "finances", "job_budgets", "job_valuations", "job_billing_plans",
  "job_billing_stages", "bank_statements", "bank_statement_lines", "supplier_payments", "payroll_runs", "payroll_lines", "payroll_tax_profiles",
  "cis_contractor_profiles", "cis_subcontractors", "api_keys", "webhook_endpoints",
  "org_sso_config", "org_scim_config", "membership_permissions", "permission_audit",
  "billing_invoices", "billing_events",
  "staff_secrets",
];

/**
 * Credential stores whose ROW is member-readable by design but whose token columns are
 * hidden by a column ACL (see STAFF_CAN_READ_NON_TOKEN_COLUMNS). These three were on
 * NEVER_STAFF, where the old `select=*` probe passed vacuously. What must hold — and is
 * now asserted — is that the whole row (i.e. the tokens) is refused to a staff JWT and
 * that staff can change or delete nothing.
 */
const TOKEN_ACL: readonly string[] = ["accounting_connections", "bank_connections", "hmrc_connections"];

type Reach = { table: string; read: boolean; update: boolean; del: boolean };

describeIntegration("ADVERSARIAL · vertical escalation — a staff JWT against its own org", () => {
  let w: World | null = null;
  let surface: Surface;
  let seed: SeedResult;
  const reach: Reach[] = [];

  beforeAll(async () => {
    surface = await loadSurface();
    w = await createWorld("sectenant-vert");
    seed = await seedOrgRows(surface, w.A.id, w.A.owner.id, `${w.tag}-a`);

    const staff = w.A.staff.token;
    const probe: { rel: (typeof surface.relations)[number]; filter: Record<string, string>; row: Record<string, any> }[] = [];
    for (const rel of publicTables(surface)) {
      const orgCol = orgColumnOf(rel);
      const row = seed.rows.get(rel.name);
      if (!orgCol || !row || rel.name === "memberships") continue;
      const filter = pkFilter(rel, row);
      if (filter) probe.push({ rel, filter, row });
    }
    // READ + UPDATE first for every table; DELETE in a second pass so a successful
    // delete (which may cascade) cannot hide another table's row from the read probe.
    for (const { rel, filter, row } of probe) {
      const orgCol = orgColumnOf(rel)!;
      // Row reach is measured on the PRIMARY KEY, not `select=*`: a table with a column
      // ACL (20261341–43: customers, customer_contacts, users, assets, fleet_vehicles)
      // refuses `*` outright although staff still reach the row. Column reach is pinned
      // separately in rls/private-column-acl.test.ts.
      const r = await rawFetch(`/rest/v1/${rel.name}?${qs(filter)}&select=${rel.pk.join(",")}`, { bearer: staff });
      const read = r.status === 200 && Array.isArray(r.json) && r.json.length === 1;
      const textCol = rel.columns.find(
        (c) => c.type === "text" && !c.generated && !rel.pk.includes(c.name) && c.name !== orgCol && !rel.fks.some((f) => f.cols.includes(c.name)),
      );
      let update = false;
      if (textCol) {
        const u = await rawFetch(`/rest/v1/${rel.name}?${qs(filter)}`, {
          method: "PATCH",
          bearer: staff,
          body: { [textCol.name]: row[textCol.name] },
          headers: { Prefer: "return=representation" },
        });
        update = u.status === 200 && Array.isArray(u.json) && u.json.length === 1;
      }
      reach.push({ table: rel.name, read, update, del: false });
    }
    for (const { rel, filter } of probe) {
      await rawFetch(`/rest/v1/${rel.name}?${qs(filter)}`, { method: "DELETE", bearer: staff });
    }
    for (const { rel, filter } of probe) {
      let q = svc().from(rel.name).select("*", { count: "exact", head: true });
      for (const [k, v] of Object.entries(filter)) q = q.eq(k, v.replace(/^eq\./, ""));
      const c = await q;
      const entry = reach.find((x) => x.table === rel.name)!;
      entry.del = (c.count ?? 0) === 0;
    }
  }, 600_000);

  afterAll(async () => {
    writeReport("staff-reach.json", { reach, unseeded: seed ? Object.fromEntries(seed.unseeded) : {} });
    await destroyWorld(w);
  }, 300_000);

  const diff = (kind: "read" | "update" | "del", ledger: ReadonlySet<string>) => {
    const actual = new Set(reach.filter((r) => r[kind]).map((r) => r.table));
    const probed = new Set(reach.map((r) => r.table));
    return {
      unexpected: [...actual].filter((t) => !ledger.has(t)).sort(),
      stale: [...ledger].filter((t) => probed.has(t) && !actual.has(t)).sort(),
    };
  };

  it("the probe covered the catalogue", () => {
    expect(reach.length).toBeGreaterThan(100);
  });

  for (const [kind, ledger, name] of [
    ["read", new Set([...STAFF_CAN_READ, ...STAFF_CAN_READ_NON_TOKEN_COLUMNS]), "STAFF_CAN_READ"],
    ["update", STAFF_CAN_UPDATE, "STAFF_CAN_UPDATE"],
    ["del", STAFF_CAN_DELETE, "STAFF_CAN_DELETE"],
  ] as const) {
    it(`staff ${kind === "del" ? "delete" : kind} reach matches the ${name} ledger exactly`, () => {
      const d = diff(kind, ledger);
      expect(
        d.unexpected,
        `a staff JWT can ${kind === "del" ? "DELETE" : kind.toUpperCase()} an org-wide row in table(s) not in ${name}. ` +
          "Scope the table to admins (is_org_admin) or add it to the ledger deliberately.",
      ).toEqual([]);
      expect(d.stale, `${name} lists table(s) staff can no longer reach — remove them`).toEqual([]);
    });
  }

  it("a staff JWT reaches NONE of the money / credential / governance tables", () => {
    for (const ledger of [STAFF_CAN_READ, STAFF_CAN_UPDATE, STAFF_CAN_DELETE]) {
      expect(NEVER_STAFF.filter((t) => ledger.has(t)), "a NEVER_STAFF table is in a ledger").toEqual([]);
    }
    const hit = reach.filter((r) => NEVER_STAFF.includes(r.table) && (r.read || r.update || r.del));
    expect(hit, JSON.stringify(hit)).toEqual([]);
    // Not vacuous: most of the named tables really were seeded and probed.
    const probed = reach.filter((r) => NEVER_STAFF.includes(r.table)).length;
    expect(probed).toBeGreaterThanOrEqual(20);
  });

  it("TOKEN_ACL · staff cannot read a whole credential row (the token columns), nor update or delete it", async () => {
    const world = w!;
    for (const t of TOKEN_ACL) {
      const row = seed.rows.get(t);
      expect(row, `${t} was not seeded`).toBeTruthy();
      const whole = await rawFetch(`/rest/v1/${t}?org_id=eq.${world.A.id}&select=*`, { bearer: world.A.staff.token });
      expect(whole.status, `${t}: select=* must be refused (column ACL on the tokens)`).toBeGreaterThanOrEqual(400);
      const r = reach.find((x) => x.table === t);
      expect(r && !r.update && !r.del, `${t}: staff must not update / delete`).toBe(true);
    }
  });

  // ── PART 2 · named escalations ─────────────────────────────────────────────

  const membership = async (userId: string) =>
    (await svc().from("memberships").select("id, role").eq("org_id", w!.A.id).eq("user_id", userId).maybeSingle()).data as
      | { id: string; role: string }
      | null;

  it("staff cannot read the organisation's activity log — only their own actions (UI-coverage S-1)", async () => {
    // The log copies quote/invoice totals and customer contact details into metadata;
    // staff are refused on those tables, so the log must not hand them the same facts.
    const world = w!;
    const marker = `sectenant-activity-${Date.now()}`;
    const rows = [
      { org_id: world.A.id, actor_id: world.A.owner.id, actor_name: "Owner", action: "quote.created",
        target_table: "quotes", target_id: crypto.randomUUID(), metadata: { marker, number: "Q-0001", total: 12345.67 } },
      { org_id: world.A.id, actor_id: world.A.owner.id, actor_name: "Owner", action: "customer.created",
        target_table: "customers", target_id: crypto.randomUUID(), metadata: { marker, email: "private@example.test", phone: "+440000000000" } },
      { org_id: world.A.id, actor_id: world.A.staff.id, actor_name: "Staff", action: "time_entry.created",
        target_table: "time_entries", target_id: crypto.randomUUID(), metadata: { marker } },
    ];
    const ins = await svc().from("activity_log").insert(rows);
    expect(ins.error, ins.error?.message).toBeNull();
    const pick = (c: ReturnType<typeof as>) =>
      c.from("activity_log").select("actor_id, action, metadata").eq("metadata->>marker", marker);

    const staffSees = await pick(as(world.A.staff.token));
    expect(staffSees.error, staffSees.error?.message).toBeNull();
    expect(staffSees.data?.map((r: any) => r.action), "staff see only what they did").toEqual(["time_entry.created"]);

    for (const token of [world.A.owner.token, world.A.admin.token]) {
      const sees = await pick(as(token));
      expect(sees.error, sees.error?.message).toBeNull();
      expect(sees.data, "owners and admins keep the whole organisation log").toHaveLength(3);
    }
    const other = await pick(as(world.B.owner.token));
    expect(other.data ?? [], "another tenant sees none of it").toHaveLength(0);
  });

  it("staff cannot promote themselves, demote the owner, or add/remove a member", async () => {
    const world = w!;
    const staff = as(world.A.staff.token);
    const mine = (await membership(world.A.staff.id))!;
    const owners = (await membership(world.A.owner.id))!;

    await staff.from("memberships").update({ role: "owner" }).eq("id", mine.id);
    await staff.from("memberships").update({ role: "admin" }).eq("user_id", world.A.staff.id);
    await staff.from("memberships").update({ role: "staff" }).eq("id", owners.id);
    await staff.from("memberships").delete().eq("id", owners.id);
    await staff.from("memberships").insert({ org_id: world.A.id, user_id: world.B.staff.id, role: "admin" });
    // …and cannot join org B at all.
    await staff.from("memberships").insert({ org_id: world.B.id, user_id: world.A.staff.id, role: "owner" });

    expect((await membership(world.A.staff.id))?.role).toBe("staff");
    expect((await membership(world.A.owner.id))?.role).toBe("owner");
    expect(await membership(world.B.staff.id)).toBeNull();
    const inB = await svc().from("memberships").select("id").eq("org_id", world.B.id).eq("user_id", world.A.staff.id);
    expect(inB.data).toEqual([]);
  });

  it("an ADMIN cannot make themselves owner or remove the owner through the Data API either", async () => {
    const world = w!;
    const admin = as(world.A.admin.token);
    const mine = (await membership(world.A.admin.id))!;
    const owners = (await membership(world.A.owner.id))!;
    await admin.from("memberships").update({ role: "owner" }).eq("id", mine.id);
    await admin.from("memberships").delete().eq("id", owners.id);
    expect((await membership(world.A.admin.id))?.role).toBe("admin");
    expect((await membership(world.A.owner.id))?.role).toBe("owner");
  });

  it("staff cannot read a colleague's pay, nor set their own", async () => {
    const world = w!;
    await svc().from("staff_compensation").upsert(
      [
        { user_id: world.A.admin.id, hourly_pay: 41.5, emergency_contact: { name: "ICE", phone: "07700900000", relationship: "x" } },
        { user_id: world.A.staff.id, hourly_pay: 15 },
      ],
      { onConflict: "user_id" },
    );
    const staff = as(world.A.staff.token);
    const others = await staff.from("staff_compensation").select("user_id, hourly_pay").neq("user_id", world.A.staff.id);
    expect(others.data ?? []).toEqual([]);
    // Self-read is allowed by design (a worker may see their own rate).
    const self = await staff.from("staff_compensation").select("hourly_pay").eq("user_id", world.A.staff.id);
    expect(self.data).toEqual([{ hourly_pay: 15 }]);
    // Self-raise is not.
    await staff.from("staff_compensation").update({ hourly_pay: 500 }).eq("user_id", world.A.staff.id);
    await staff.from("staff_compensation").upsert({ user_id: world.A.staff.id, hourly_pay: 500 }, { onConflict: "user_id" });
    const truth = await svc().from("staff_compensation").select("hourly_pay").eq("user_id", world.A.staff.id).single();
    expect(Number(truth.data?.hourly_pay)).toBe(15);
  });

  it("staff cannot change the organisation (name, plan, status, MFA policy, Stripe ids)", async () => {
    const world = w!;
    const before = (await svc().from("organizations").select("*").eq("id", world.A.id).single()).data;
    const staff = as(world.A.staff.token);
    for (const patch of [
      { name: "pwned" },
      { plan: "enterprise" },
      { status: "active", trial_ends_at: "2099-01-01T00:00:00Z" },
      { require_mfa: false },
      { stripe_customer_id: "cus_attacker", stripe_subscription_id: "sub_attacker" },
      { bank_details: { account_number: "00000000", sort_code: "00-00-00" } },
    ]) {
      await staff.from("organizations").update(patch).eq("id", world.A.id);
    }
    await staff.from("organizations").delete().eq("id", world.A.id);
    const after = (await svc().from("organizations").select("*").eq("id", world.A.id).single()).data;
    expect(after).toEqual(before);
  });

  it("staff cannot issue an API key, a webhook endpoint, an SSO config, a permission grant or a subscription", async () => {
    const world = w!;
    const staff = as(world.A.staff.token);
    const mine = (await membership(world.A.staff.id))!;
    const attempts: [string, Record<string, unknown>][] = [
      ["api_keys", { org_id: world.A.id, name: "adv", key_prefix: "crewflow_sk_AAAAAAAA", key_hash: "a".repeat(64), scopes: ["*"] }],
      ["webhook_endpoints", { org_id: world.A.id, url: "https://attacker.example.test/hook", secret: `whsec_${"A".repeat(43)}`, status: "paused" }],
      ["org_sso_config", { org_id: world.A.id, protocol: "saml", saml_idp_entity_id: "x", saml_idp_sso_url: "https://attacker.example.test/sso", saml_idp_x509_cert: "x" }],
      ["membership_permissions", { org_id: world.A.id, membership_id: mine.id, module: "*", action: "*" }],
      ["org_subscriptions", { org_id: world.A.id, plan_key: "enterprise", status: "active" }],
      ["impersonation_sessions", { admin_user_id: world.A.staff.id, target_org_id: world.B.id }],
    ];
    const counts = async () => {
      const out: Record<string, number> = {};
      for (const [t] of attempts) {
        const col = t === "impersonation_sessions" ? "target_org_id" : "org_id";
        const val = t === "impersonation_sessions" ? world.B.id : world.A.id;
        out[t] = (await svc().from(t).select("*", { count: "exact", head: true }).eq(col, val)).count ?? -1;
      }
      return out;
    };
    const before = await counts();
    for (const [t, row] of attempts) {
      const r = await staff.from(t).insert(row);
      expect(r.error, `${t}: a staff insert must be refused`).not.toBeNull();
    }
    expect(await counts()).toEqual(before);
  });
});
