import { afterAll, beforeAll, expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient, userClient } from "../_harness";

/**
 * Company Intelligence Database — real-Postgres proof of RLS:hq (Module 1).
 *
 * The hq_sales_* family is the most sensitive data surface in HQ: prospect
 * intelligence on real UK construction companies — names, decision-maker
 * contacts, phone numbers, AI research, pipeline value. The security tier pins
 * the CONTRACT against source text (RLS enabled, ZERO policies, no escalation
 * surface, tenant-decoupled). This tier proves the BEHAVIOUR a mock — and even
 * the source check — cannot: that against a LIVE database with the real
 * migrations applied, the RLS actually DENIES every JWT client at runtime.
 *
 * What only a real Postgres can show:
 *   1. RLS:hq is REAL — a service_role client (BYPASSRLS) reads the family,
 *      but neither an anonymous JWT nor an AUTHENTICATED (customer/staff) JWT
 *      can read a single row — even from tables the migrations SEED (sources,
 *      scripts, objections, learnings), so "zero" is a true denial, never a
 *      vacuously-empty table.
 *   2. The denial covers WRITES too — an anon insert is rejected and creates
 *      no row.
 *   3. The GENERATED search_tsv is computed by the DB and is full-text
 *      queryable (it can never drift from its source text).
 *   4. The AI-traceability columns round-trip and the schema defaults
 *      (generated_by → 'ai', likelihood_band → 'unknown', risk_level →
 *      'medium', status → 'final') are applied by Postgres, not the app.
 *   5. The family's foreign keys cascade INSIDE hq_sales (a deleted company
 *      takes its contacts with it) — the structural mirror of "no FK into a
 *      tenant table": the prospect DB is self-contained and never wired into
 *      customer RLS.
 *
 * Runs only against a live DB (describeIntegration): skips locally with no DB,
 * fails loudly in CI if the DB is missing. The integration config runs files
 * serially, so the auth user this suite mints can't race the other suites; we
 * delete it (and the probe company, which cascades) on teardown.
 */

type Res<T> = { data: T | null; error: { message: string } | null };
type Thenable<T> = PromiseLike<Res<T>>;
type Row = Record<string, unknown>;

interface Sel extends Thenable<Row[]> {
  eq(column: string, value: unknown): Sel;
  textSearch(
    column: string,
    query: string,
    opts?: { type?: string; config?: string },
  ): Sel;
  limit(n: number): Sel;
  single(): Thenable<Row>;
}
interface InsertChain extends Thenable<Row[]> {
  select(columns?: string): Sel;
}
interface DelChain extends Thenable<null> {
  eq(column: string, value: unknown): DelChain;
}
interface Table {
  select(columns?: string): Sel;
  insert(rows: Row | Row[]): InsertChain;
  delete(): DelChain;
}
interface Db {
  from(table: string): Table;
}
const db = (client: unknown): Db => client as unknown as Db;

// An all-letters token, unique per run, so a full-text search scopes cleanly to
// THIS suite's rows. (Letters only: the 'english' tsvector parser keeps a
// pure-alpha word as one lexeme and won't stem it to nothing.)
function alpha(n: number): string {
  const a = "abcdefghijklmnopqrstuvwxyz";
  let s = "";
  for (let i = 0; i < n; i++) s += a[Math.floor(Math.random() * a.length)];
  return s;
}
const TOKEN = `hqsales${alpha(12)}`;
const MODEL = `claude-probe-${alpha(6)}`;

// Probe set: a representative slice of the 17-table family. The first three we
// seed below; the last four are SEEDED BY THEIR MIGRATIONS, so a service_role
// read returns rows and an anon/authenticated read returning ZERO is a genuine
// RLS denial of existing data — not an empty table.
const PROBE_TABLES = [
  "hq_sales_companies",
  "hq_sales_contacts",
  "hq_sales_research_reports",
  "hq_sales_sources",
  "hq_sales_call_scripts",
  "hq_sales_objections",
  "hq_sales_learnings",
] as const;

async function rowCount(client: unknown, table: string): Promise<number> {
  const res = await db(client).from(table).select("*").limit(50);
  // Denial may surface as an RLS-filtered empty set (error null) OR a
  // permission error (data null) depending on grants — either way ZERO rows
  // reach the caller, which is the only thing the security property cares about.
  return (res.data ?? []).length;
}

/** Mint a REAL authenticated (role=authenticated) user + access token. */
async function mintAuthedUser(): Promise<{ token: string; userId: string }> {
  const email = `it-hqsales-${Date.now()}-${alpha(6)}@probe.crewflow.test`;
  const password = `Pw!${alpha(10)}${Date.now()}`;
  const created = await serviceClient().auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  expect(created.error, created.error?.message).toBeNull();
  const userId = created.data.user?.id;
  if (!userId) throw new Error("could not mint an authenticated probe user");

  const signedIn = await anonClient().auth.signInWithPassword({ email, password });
  expect(signedIn.error, signedIn.error?.message).toBeNull();
  const token = signedIn.data.session?.access_token;
  if (!token) throw new Error("authenticated probe user has no access token");
  return { token, userId };
}

describeIntegration("HQ Company Intelligence Database · RLS:hq + schema behaviour (Module 1)", () => {
  let companyId = "";
  let authToken = "";
  let authUserId = "";

  beforeAll(async () => {
    const svc = db(serviceClient());

    const company = await svc
      .from("hq_sales_companies")
      .insert({
        name: `Probe ${TOKEN} Construction Ltd`,
        summary: `RLS probe company ${TOKEN}`,
        county: "Devon",
        industry: "Construction",
      })
      .select("id")
      .single();
    expect(company.error, company.error?.message).toBeNull();
    companyId = String((company.data as { id?: string })?.id ?? "");
    if (!companyId) throw new Error("probe company insert returned no id");

    const contact = await svc
      .from("hq_sales_contacts")
      .insert({ company_id: companyId, full_name: `Probe Contact ${TOKEN}` })
      .select("id");
    expect(contact.error, contact.error?.message).toBeNull();

    const report = await svc
      .from("hq_sales_research_reports")
      .insert({
        company_id: companyId,
        summary: `AI research ${TOKEN}`,
        best_angle: "Cut the office admin",
        generated_by: "ai",
        model: MODEL,
      })
      .select("id");
    expect(report.error, report.error?.message).toBeNull();

    const minted = await mintAuthedUser();
    authToken = minted.token;
    authUserId = minted.userId;
  });

  afterAll(async () => {
    // Deleting the company cascades to its contacts + research reports.
    if (companyId) await db(serviceClient()).from("hq_sales_companies").delete().eq("id", companyId);
    if (authUserId) await serviceClient().auth.admin.deleteUser(authUserId);
  });

  it("service_role (BYPASSRLS) DOES see rows in every probed table — the denial probes are non-vacuous", async () => {
    const svc = serviceClient();
    for (const table of PROBE_TABLES) {
      expect(await rowCount(svc, table), `service_role should see ${table}`).toBeGreaterThan(0);
    }
  });

  it("RLS:hq — an ANONYMOUS JWT reads ZERO rows from every hq_sales_* table", async () => {
    const anon = anonClient();
    for (const table of PROBE_TABLES) {
      expect(await rowCount(anon, table), `anon leaked rows from ${table}`).toBe(0);
    }
  });

  it("RLS:hq — an AUTHENTICATED (customer/staff) JWT reads ZERO rows too", async () => {
    const user = userClient(authToken);
    for (const table of PROBE_TABLES) {
      expect(await rowCount(user, table), `authenticated JWT leaked rows from ${table}`).toBe(0);
    }
  });

  it("the probe company exists for service_role with the Postgres defaults applied", async () => {
    const res = await db(serviceClient())
      .from("hq_sales_companies")
      .select("*")
      .eq("id", companyId);
    expect(res.error, res.error?.message).toBeNull();
    const row = (res.data ?? [])[0] as Row | undefined;
    expect(row).toBeTruthy();
    expect(row?.status).toBe("new"); // pipeline default
    expect(row?.country).toBe("United Kingdom"); // default
    expect(row?.source).toBe("manual"); // default FK
  });

  it("RLS:hq — an anonymous JWT cannot WRITE either: the insert is rejected and creates no row", async () => {
    const writeToken = `denywrite${alpha(8)}`;
    const attempt = await db(anonClient())
      .from("hq_sales_companies")
      .insert({ name: `Anon Intruder ${writeToken} Ltd` })
      .select("id");
    // Either a permission/RLS error (data null) or zero returned rows — never a
    // created row.
    expect((attempt.data ?? []).length).toBe(0);

    // Ground truth via service_role: no such row was written.
    const check = await db(serviceClient())
      .from("hq_sales_companies")
      .select("id")
      .textSearch("search_tsv", writeToken, { type: "websearch", config: "english" });
    expect(check.error, check.error?.message).toBeNull();
    expect((check.data ?? []).length).toBe(0);
  });

  it("the GENERATED search_tsv is computed by the DB and is full-text queryable", async () => {
    const res = await db(serviceClient())
      .from("hq_sales_companies")
      .select("id, name")
      .textSearch("search_tsv", TOKEN, { type: "websearch", config: "english" });
    expect(res.error, res.error?.message).toBeNull();
    const hits = (res.data ?? []) as { id: string }[];
    expect(hits.some((h) => h.id === companyId)).toBe(true);
  });

  it("AI-traceability columns round-trip and report defaults are applied by Postgres", async () => {
    const res = await db(serviceClient())
      .from("hq_sales_research_reports")
      .select("*")
      .eq("company_id", companyId);
    expect(res.error, res.error?.message).toBeNull();
    const seeded = (res.data ?? []).find((r) => r.model === MODEL) as Row | undefined;
    expect(seeded).toBeTruthy();
    expect(seeded?.generated_by).toBe("ai"); // we set it
    expect(seeded?.model).toBe(MODEL); // round-trips
    expect(seeded?.likelihood_band).toBe("unknown"); // default
    expect(seeded?.risk_level).toBe("medium"); // default
    expect(seeded?.status).toBe("final"); // default

    // A minimal report (company_id only) DEFAULTS generated_by to 'ai'.
    const minimal = await db(serviceClient())
      .from("hq_sales_research_reports")
      .insert({ company_id: companyId })
      .select("generated_by, status");
    expect(minimal.error, minimal.error?.message).toBeNull();
    expect((minimal.data ?? [])[0]?.generated_by).toBe("ai");
  });

  it("intra-family FKs cascade INSIDE hq_sales — a deleted company takes its contacts with it", async () => {
    const svc = db(serviceClient());

    const company = await svc
      .from("hq_sales_companies")
      .insert({ name: `Cascade ${alpha(8)} Ltd` })
      .select("id")
      .single();
    expect(company.error, company.error?.message).toBeNull();
    const cid = String((company.data as { id: string }).id);

    const contact = await svc
      .from("hq_sales_contacts")
      .insert({ company_id: cid, full_name: "Jane Cascade" })
      .select("id")
      .single();
    expect(contact.error, contact.error?.message).toBeNull();
    const contactId = String((contact.data as { id: string }).id);

    const del = await svc.from("hq_sales_companies").delete().eq("id", cid);
    expect(del.error, del.error?.message).toBeNull();

    const after = await svc.from("hq_sales_contacts").select("id").eq("id", contactId);
    expect(after.error, after.error?.message).toBeNull();
    expect((after.data ?? []).length).toBe(0); // cascaded away with its company
  });
});
