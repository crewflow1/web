import { afterAll, beforeAll, expect, it } from "vitest";
import {
  anonClient,
  describeIntegration,
  serviceClient,
  userClient,
} from "../_harness";
import { buildOrgExport } from "@/server/services/gdpr-export";
import {
  KNOWN_ORG_SCOPED_TABLES,
  EXCLUDED_FROM_EXPORT,
  ORG_EXPORT_TABLES,
} from "@/lib/gdpr/export-tables";

/**
 * GDPR data-portability EXPORT — proven against real Postgres.
 *
 * The trust-boundary properties, each pinned below:
 *   1. OWN ROWS ONLY — the export of org A contains A's rows and NONE of B's,
 *      even for a legitimate MULTI-ORG member (the #456 active-org property).
 *   2. CROSS-ORG ISOLATION — an admin who is NOT a member of org B, exporting
 *      with orgId=B, gets ZERO rows (RLS is the backstop behind the org pin).
 *   3. SECRETS EXCLUDED — a `customers.portal_token` present in the DB is
 *      column-redacted out of the export; credential TABLES never appear.
 *   4. MANIFEST CORRECT — table set, per-table counts, totals are accurate and
 *      deterministic for an injected generated-at.
 *   5. DRIFT GUARD — the hand-maintained snapshot matches the LIVE base-table
 *      schema, so a new org-scoped table forces an explicit classification.
 *   6. AUDIT LOG — admin insert into gdpr_export_log succeeds; a non-admin
 *      member insert is refused by RLS (the export-log admin-write gate).
 */

type Res<T> = { data: T | null; error: { message: string } | null };
type Row = Record<string, unknown>;
interface Sel extends PromiseLike<Res<Row[]>> {
  eq(column: string, value: unknown): Sel;
}
interface Ins extends PromiseLike<Res<Row[]>> {
  select(columns?: string): { single(): PromiseLike<Res<Row>> };
}
interface Table {
  select(columns?: string, opts?: Record<string, unknown>): Sel;
  insert(rows: Row | Row[]): Ins;
}
const db = (client: unknown) => client as unknown as { from(t: string): Table };

const TOKEN = `it-gdpr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describeIntegration("gdpr export · org-pinned, redacted, isolated", () => {
  let orgA = "";
  let orgB = "";
  const A: Record<string, string> = {};
  const B: Record<string, string> = {};

  // Multi-org user: OWNER of A and B, "working in" A.
  let dualToken = "";
  // Admin of A only (NOT a member of B) — the cross-org control.
  let aOnlyToken = "";
  // A plain member (role='staff') of A — the non-admin audit-write control.
  let memberToken = "";

  async function mintUser(
    label: string,
  ): Promise<{ id: string; token: string }> {
    const email = `${TOKEN}-${label}@example.test`;
    const password = `Pw-${TOKEN}-${Math.random().toString(36).slice(2)}`;
    const created = await serviceClient().auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    expect(created.error, created.error?.message).toBeNull();
    const id = created.data.user?.id ?? "";
    const mirrored = await db(serviceClient())
      .from("users")
      .insert({ id, email, full_name: `GDPR export ${label}` })
      .select("id")
      .single();
    expect(mirrored.error, mirrored.error?.message).toBeNull();
    const signedIn = await anonClient().auth.signInWithPassword({
      email,
      password,
    });
    expect(signedIn.error, signedIn.error?.message).toBeNull();
    return { id, token: signedIn.data.session?.access_token ?? "" };
  }

  async function seedOrg(org: string, tag: string, into: Record<string, string>) {
    const svc = db(serviceClient());

    // A customer WITH a portal_token — the redaction probe.
    const customer = await svc
      .from("customers")
      .insert({
        org_id: org,
        name: `Customer ${tag}`,
        email: `c-${tag}@example.test`,
        // portal_token is a uuid access token — redaction is by column NAME, so
        // any valid value proves the strip.
        portal_token: crypto.randomUUID(),
      })
      .select("id")
      .single();
    expect(customer.error, customer.error?.message).toBeNull();
    into.customer = String(customer.data?.id ?? "");

    const job = await svc
      .from("jobs")
      .insert({
        org_id: org,
        customer_id: into.customer,
        status: "new",
      })
      .select("id")
      .single();
    expect(job.error, job.error?.message).toBeNull();
    into.job = String(job.data?.id ?? "");

    const finance = await svc
      .from("finances")
      .insert({ org_id: org, amount: 123.45, vat_rate: 20 })
      .select("id")
      .single();
    expect(finance.error, finance.error?.message).toBeNull();
    into.finance = String(finance.data?.id ?? "");
  }

  beforeAll(async () => {
    const svc = db(serviceClient());

    const oa = await svc
      .from("organizations")
      .insert({ name: `Org A ${TOKEN}`, slug: `org-a-${TOKEN}` })
      .select("id")
      .single();
    expect(oa.error, oa.error?.message).toBeNull();
    orgA = String(oa.data?.id ?? "");

    const ob = await svc
      .from("organizations")
      .insert({ name: `Org B ${TOKEN}`, slug: `org-b-${TOKEN}` })
      .select("id")
      .single();
    expect(ob.error, ob.error?.message).toBeNull();
    orgB = String(ob.data?.id ?? "");

    const dual = await mintUser("dual");
    dualToken = dual.token;
    const aOnly = await mintUser("aonly");
    aOnlyToken = aOnly.token;
    const member = await mintUser("member");
    memberToken = member.token;

    // Memberships: dual = owner of A and B; aOnly = admin of A only;
    // member = staff of A only.
    const mem = await svc.from("memberships").insert([
      { org_id: orgA, user_id: dual.id, role: "owner" },
      { org_id: orgB, user_id: dual.id, role: "owner" },
      { org_id: orgA, user_id: aOnly.id, role: "admin" },
      { org_id: orgA, user_id: member.id, role: "staff" },
    ]);
    expect(mem.error, mem.error?.message).toBeNull();

    await seedOrg(orgA, "A", A);
    await seedOrg(orgB, "B", B);
  });

  afterAll(async () => {
    if (!orgA && !orgB) return;
    const svc = db(serviceClient());
    // Teardown removes both orgs (cascade removes all seeded rows).
    for (const id of [orgA, orgB]) {
      if (id) {
        await (
          svc.from("organizations") as unknown as {
            delete(): { eq(c: string, v: unknown): PromiseLike<unknown> };
          }
        )
          .delete()
          .eq("id", id);
      }
    }
  });

  it("1. exports org A's rows only — never org B's (multi-org member)", async () => {
    const exp = await buildOrgExport({
      orgId: orgA,
      generatedAt: "2026-01-01T00:00:00.000Z",
      client: userClient(dualToken) as never,
    });

    const byTable = new Map(exp.tables.map((t) => [t.table, t]));
    const customers = byTable.get("customers");
    expect(customers).toBeTruthy();

    // Every exported row across every table is org A. Not one is org B.
    for (const t of exp.tables) {
      for (const row of t.rows) {
        if ("org_id" in row) expect(row.org_id).toBe(orgA);
        expect(row.org_id).not.toBe(orgB);
      }
    }
    // The A customer is present; the B customer id is absent everywhere.
    const custIds = (customers?.rows ?? []).map((r) => r.id);
    expect(custIds).toContain(A.customer);
    expect(custIds).not.toContain(B.customer);
  });

  it("2. an admin of A exporting orgId=B gets ZERO rows (RLS backstop)", async () => {
    const exp = await buildOrgExport({
      orgId: orgB,
      generatedAt: "2026-01-01T00:00:00.000Z",
      client: userClient(aOnlyToken) as never,
    });
    // aOnly is not a member of B — RLS denies every row.
    expect(exp.manifest.total_rows).toBe(0);
    for (const t of exp.tables) expect(t.rowCount).toBe(0);
  });

  it("3. redacts portal_token and never names a credential table", async () => {
    const exp = await buildOrgExport({
      orgId: orgA,
      generatedAt: "2026-01-01T00:00:00.000Z",
      client: userClient(dualToken) as never,
    });
    const customers = exp.tables.find((t) => t.table === "customers");
    const row = (customers?.rows ?? []).find((r) => r.id === A.customer);
    expect(row, "seeded customer present in export").toBeTruthy();
    // The token column was in the DB but must NOT be in the export.
    expect(row && "portal_token" in row).toBe(false);
    // The business fields survive.
    expect(row?.name).toBe("Customer A");

    // No credential table appears anywhere in the export.
    const exported = new Set(exp.tables.map((t) => t.table));
    for (const t of [
      "accounting_connections",
      "bank_connections",
      "api_keys",
      "webhook_endpoints",
      "telematics_connections",
      "staff_secrets",
    ]) {
      expect(exported.has(t)).toBe(false);
    }
  });

  it("4. manifest is accurate + deterministic", async () => {
    const exp = await buildOrgExport({
      orgId: orgA,
      generatedAt: "2026-02-02T03:04:05.000Z",
      client: userClient(dualToken) as never,
    });
    const m = exp.manifest;
    expect(m.generated_at).toBe("2026-02-02T03:04:05.000Z");
    expect(m.export_kind).toBe("gdpr-data-portability-export");
    expect(m.scope).toMatch(/export-only/);
    // table_count = exported tables that exist in this DB (skipped excluded).
    expect(m.table_count).toBe(exp.tables.length);
    expect(m.table_count + m.skipped_tables.length).toBe(ORG_EXPORT_TABLES.length);
    // Per-table counts sum to the total.
    const sum = m.tables.reduce((n, t) => n + t.rowCount, 0);
    expect(sum).toBe(m.total_rows);
    // Our seeded tables each hold exactly one A row.
    for (const table of ["customers", "jobs", "finances"]) {
      expect(m.tables.find((t) => t.table === table)?.rowCount).toBe(1);
    }
    // The deny-list is surfaced with reasons.
    expect(m.excluded_tables.length).toBe(Object.keys(EXCLUDED_FROM_EXPORT).length);
    expect(m.excluded_tables.find((e) => e.table === "api_keys")).toBeTruthy();
  });

  it("5. every snapshot-exported table exists in the LIVE schema", async () => {
    // A dropped/renamed table would make the export silently skip it; probe each
    // exported table with a service-role limit-0 read and assert it is NOT a
    // missing-relation. (The opposite direction — a NEW org-scoped table — is
    // caught at snapshot-regeneration time via the query in export-tables.ts.)
    const svc = db(serviceClient());
    const missing: string[] = [];
    for (const table of ORG_EXPORT_TABLES) {
      const res = await svc.from(table).select("org_id").eq("org_id", orgA);
      if (
        res.error &&
        /does not exist|could not find the table|schema cache/i.test(
          res.error.message,
        )
      ) {
        missing.push(table);
      }
    }
    expect(missing, `snapshot tables absent from live schema: ${missing}`).toEqual(
      [],
    );

    // Partition closure: every exported/excluded table is a member of KNOWN.
    const known = new Set<string>(KNOWN_ORG_SCOPED_TABLES);
    for (const t of ORG_EXPORT_TABLES) expect(known.has(t)).toBe(true);
    for (const t of Object.keys(EXCLUDED_FROM_EXPORT))
      expect(known.has(t)).toBe(true);
  });

  it("6. audit log: admin insert allowed, non-admin member refused (RLS)", async () => {
    // Admin (owner) of A may write an export-log row.
    const okAdmin = await db(userClient(dualToken))
      .from("gdpr_export_log")
      .insert({
        org_id: orgA,
        format: "zip",
        status: "generated",
        table_count: 1,
        row_count: 1,
        truncated: false,
      });
    expect(okAdmin.error, "admin insert should succeed").toBeNull();

    // A plain staff member of A may NOT — the admin-write RLS gate refuses.
    const refused = await db(userClient(memberToken))
      .from("gdpr_export_log")
      .insert({
        org_id: orgA,
        format: "zip",
        status: "generated",
        table_count: 1,
        row_count: 1,
        truncated: false,
      });
    expect(refused.error, "non-admin insert must be refused").not.toBeNull();
  });
});
