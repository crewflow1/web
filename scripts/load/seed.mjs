#!/usr/bin/env node
/**
 * scripts/load/seed.mjs — synthetic multi-tenant dataset for load testing.
 *
 *   node scripts/load/seed.mjs --orgs 5                       # seed (local)
 *   node scripts/load/seed.mjs --orgs 5 --verify              # compare DB vs expected
 *   node scripts/load/seed.mjs --teardown --tag lt1           # remove everything tagged
 *   node scripts/load/seed.mjs --orgs 2000 --staff 12 --fast  # big staging seed
 *
 * Parameters (per-org BASE values; each org is scaled by a deterministic size
 * tier so the population is heavy-tailed like a real customer base —
 * 60% small ×0.4, 30% medium ×1, 9% large ×3, 1% very large ×10):
 *
 *   --orgs N          organisations                        (default 5)
 *   --staff N         staff members per org                (default 8)
 *   --customers N     customers per org                    (default 60)
 *   --jobs N          jobs per org                         (default 120)
 *   --quotes N        quotes per org                       (default 80)
 *   --invoices N      invoices per org                     (default 60)
 *   --timesheets N    working days of time entries / staff (default 20)
 *   --documents N     job documents per org                (default 30)
 *   --rams N          issued RAMS per org                  (default 6)
 *   --leads N         leads per org                        (default 30)
 *   --costs N         cost/bill rows per org               (default 40)
 *   --invoiceable N   accepted-but-uninvoiced quotes kept per org for the
 *                     POST /api/invoices scenario          (default 10, NOT tier-scaled)
 *   --hq N            HQ operator users (no membership)    (default 2)
 *   --tag T           dataset tag, ^[a-z0-9]{2,12}$        (default lt1)
 *   --seed S          varies the tier/size draw            (default 1)
 *   --anchor D        the dataset's "today" (YYYY-MM-DD)   (default today, UTC)
 *   --flat            disable tiering (every org gets exactly the base counts)
 *   --fast            disable triggers + FK checks while seeding (session_replication_role
 *                     = replica). Much faster for very large seeds, but derived rows
 *                     (activity log, job→rota sync, invoice line-item snapshot, payment
 *                     status sync) are NOT produced. Default is triggers ON.
 *   --manifest PATH   where to write the manifest JSON     (default load/k6/.manifest/<tag>.json)
 *   --db URL          Postgres URL (else LOAD_DATABASE_URL, else local DATABASE_URL)
 *
 * The password every synthetic user shares comes from LOAD_USER_PASSWORD. For a
 * LOCAL target a fixed, obviously-synthetic default is used; for staging the
 * variable is mandatory. It is never printed and never written to the manifest.
 *
 * Deterministic + idempotent + tagged: see scripts/load/sql/seed.sql.
 * Target safety: see scripts/load/_guard.mjs (production is refused, always).
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertTag, authoriseTarget, parseArgs, stagingSentinelSql } from "./_guard.mjs";
import { ltId, ltR, md5hex } from "./_ids.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");
const LOCAL_DB = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
/** Local-only synthetic credential (same posture as e2e/global-setup.ts). */
const LOCAL_DEFAULT_PASSWORD = "Loadtest-Local-Only-1!";

const args = parseArgs(process.argv.slice(2));
const int = (k, d) => {
  const v = args[k] === undefined ? d : Number(args[k]);
  if (!Number.isInteger(v) || v < 0) throw new Error(`--${k} must be a non-negative integer`);
  return v;
};

const tag = assertTag(String(args.tag ?? "lt1"));
const dbUrl = String(args.db ?? process.env.LOAD_DATABASE_URL ?? process.env.DATABASE_URL ?? LOCAL_DB);
const targetKind = authoriseTarget(dbUrl, "database URL");
const seedN = int("seed", 1);
const anchor = String(args.anchor ?? new Date().toISOString().slice(0, 10));
if (!/^\d{4}-\d{2}-\d{2}$/.test(anchor)) throw new Error("--anchor must be YYYY-MM-DD");

// deterministic primitives live in ./_ids.mjs (mirrored in SQL and in load/k6/lib/ids.js)

const TRADES = ["Roofing", "Electrical", "Groundworks", "Joinery", "Plastering", "Building Services", "Scaffolding", "Mechanical", "Construction", "Civils", "Fit-Out", "Brickwork"];
const NAMES = ["Harland", "Okafor", "McAllister", "Devlin", "Ferreira", "Whitcombe", "Nowak", "Brannigan", "Thornley", "Quigley", "Ashdown", "Mulholland", "Castellan", "Doherty", "Lindqvist", "Abernethy", "Trevelyan", "Macready", "Fenwick", "Penhale"];
const pick = (arr, key) => arr[Math.floor(ltR(key) * arr.length)];

function buildOrgs() {
  const base = {
    staff: int("staff", 8),
    customers: int("customers", 60),
    jobs: int("jobs", 120),
    quotes: int("quotes", 80),
    invoices: int("invoices", 60),
    te: int("timesheets", 20),
    docs: int("documents", 30),
    rams: int("rams", 6),
    leads: int("leads", 30),
    fin: int("costs", 40),
  };
  const invoiceable = int("invoiceable", 10);
  const n = int("orgs", 5);
  const flat = Boolean(args.flat);
  const orgs = [];
  for (let idx = 1; idx <= n; idx++) {
    const t = ltR(`${tag}:${seedN}:tier:${idx}`);
    const [tier, factor] = flat ? ["M", 1] : t < 0.6 ? ["S", 0.4] : t < 0.9 ? ["M", 1] : t < 0.99 ? ["L", 3] : ["XL", 10];
    // ±20% deterministic jitter so no two orgs are the same size.
    const sized = (k, min) => {
      const j = flat ? 1 : 0.8 + 0.4 * ltR(`${tag}:${seedN}:size:${k}:${idx}`);
      return Math.max(min, Math.round(base[k] * factor * j));
    };
    const staff = sized("staff", 2);
    const quotes = Math.max(sized("quotes", 4), invoiceable + 2);
    orgs.push({
      idx,
      org_id: ltId(`${tag}:org:${idx}`),
      slug: `lt-${tag}-org-${idx}`,
      name: `${pick(NAMES, `${tag}:orgname:${idx}`)} ${pick(TRADES, `${tag}:orgtrade:${idx}`)} Ltd [LOADTEST ${tag} #${idx}]`,
      // The tenant-isolation marker: appears in this org's customer / job / quote /
      // lead / RAMS text and must NEVER appear in another tenant's responses.
      marker: `ltm_${md5hex(`${tag}:marker:${idx}`).slice(0, 12)}`,
      tier,
      n_staff: staff,
      n_admins: Math.max(1, Math.round(staff * 0.15)),
      n_customers: sized("customers", 5),
      n_jobs: sized("jobs", 6),
      n_quotes: quotes,
      n_invoices: sized("invoices", 2),
      n_invoiceable: invoiceable,
      n_te: base.te,
      n_docs: sized("docs", 2),
      n_rams: Math.max(2, base.rams),
      n_leads: sized("leads", 3),
      n_fin: sized("fin", 3),
    });
  }
  return orgs;
}

function psql(sql, { env = {}, quiet = false } = {}) {
  const r = spawnSync("psql", [dbUrl, "-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-f", "-"], {
    input: sql,
    env: { ...process.env, ...env, PGOPTIONS: "-c client_min_messages=warning" },
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (r.error) throw new Error(`psql not runnable: ${r.error.message} (is psql on PATH?)`);
  if (r.status !== 0) {
    throw new Error(`psql failed (exit ${r.status}):\n${(r.stderr || "").slice(0, 4000)}`);
  }
  if (!quiet && r.stderr?.trim()) process.stderr.write(r.stderr);
  return r.stdout;
}

const guardSql = targetKind === "staging" ? stagingSentinelSql(tag) : "";
const COUNT_TABLES = [
  "organizations", "memberships", "customers", "jobs", "job_assignments", "quotes", "quote_line_items",
  "invoices", "invoice_line_items", "invoice_payments", "time_entries", "rota_entries", "job_documents",
  "risk_assessments", "safety_acknowledgements", "leads", "finances", "activity_log",
];

function countsSql() {
  const parts = COUNT_TABLES.map((t) =>
    t === "organizations"
      ? `select '${t}' as t, count(*) as c from public.organizations where slug like 'lt-${tag}-%'`
      : `select '${t}', count(*) from public.${t} where org_id in (select id from public.organizations where slug like 'lt-${tag}-%')`,
  );
  parts.push(`select 'auth_users', count(*) from auth.users where email like 'lt-${tag}-%@loadtest.crewflow.invalid'`);
  parts.push(`select 'public_users', count(*) from public.users where email like 'lt-${tag}-%@loadtest.crewflow.invalid'`);
  return `select coalesce(json_object_agg(t, c), '{}'::json) from (${parts.join(" union all ")}) x;`;
}
const readCounts = () => JSON.parse(psql(guardSql + countsSql(), { quiet: true }).trim().split("\n").pop());

// ── teardown ─────────────────────────────────────────────────────────────────
/**
 * Removes every row belonging to the tag. Runs with triggers + FK actions
 * suspended (the product's own immutability guards — issued RAMS, signed
 * acknowledgements, audit rows — rightly refuse deletes, so a cascade would be
 * blocked), therefore every dependent table is enumerated explicitly:
 *   1. every public table with an org_id column  → rows of the tagged orgs;
 *   2. every public table FK-referencing users   → rows of the tagged users
 *      (or the column is nulled where the FK is ON DELETE SET NULL);
 *   3. organisations, public.users, the auth.* rows of the tagged users;
 *   4. an ORPHAN SWEEP: any FK whose child rows now point at a deleted parent
 *      is cleaned — but only where that FK had ZERO orphans before the teardown,
 *      so pre-existing rows that are not ours are never touched.
 * Storage objects are removed first through the Storage API when
 * SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are available.
 */
async function teardown() {
  const before = readCounts();
  await removeStorageObjects();
  const out = psql(
    guardSql +
      `
\\set ON_ERROR_STOP on
begin;
create temp table lt_td_orgs on commit drop as select id from public.organizations where slug like 'lt-${tag}-%';
create temp table lt_td_users on commit drop as select id from auth.users where email like 'lt-${tag}-%@loadtest.crewflow.invalid';
create temp table lt_td_log (step text, tbl text, n bigint) on commit drop;

-- FK orphan baseline (before we delete anything).
create temp table lt_td_fk on commit drop as
select c.oid, c.conrelid::regclass::text as child, c.confrelid::regclass::text as parent,
       (select a.attname from pg_attribute a where a.attrelid = c.conrelid and a.attnum = c.conkey[1]) as child_col,
       (select a.attname from pg_attribute a where a.attrelid = c.confrelid and a.attnum = c.confkey[1]) as parent_col,
       0::bigint as orphans_before
from pg_constraint c
join pg_namespace n on n.oid = c.connamespace
where c.contype = 'f' and n.nspname = 'public' and array_length(c.conkey, 1) = 1
  and c.confrelid::regclass::text not like 'auth.%';

do $td$
declare r record; v bigint;
begin
  for r in select * from lt_td_fk loop
    execute format('select count(*) from %s c where c.%I is not null and not exists (select 1 from %s p where p.%I = c.%I)',
                   r.child, r.child_col, r.parent, r.parent_col, r.child_col) into v;
    update lt_td_fk set orphans_before = v where oid = r.oid;
  end loop;
end $td$;

set local session_replication_role = replica;

do $td$
declare r record; v bigint;
begin
  -- 1. org-scoped tables
  for r in
    select c.table_name from information_schema.columns c
    join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
    where c.table_schema = 'public' and c.column_name = 'org_id' and c.udt_name = 'uuid' and t.table_type = 'BASE TABLE'
  loop
    execute format('delete from public.%I where org_id in (select id from lt_td_orgs)', r.table_name);
    get diagnostics v = row_count;
    if v > 0 then insert into lt_td_log values ('org_id', r.table_name, v); end if;
  end loop;

  -- 2. user-referencing tables (any single-column FK to public.users or auth.users)
  for r in
    select c.conrelid::regclass::text as child, c.confdeltype,
           (select a.attname from pg_attribute a where a.attrelid = c.conrelid and a.attnum = c.conkey[1]) as col,
           (select a.attnotnull from pg_attribute a where a.attrelid = c.conrelid and a.attnum = c.conkey[1]) as notnull
    from pg_constraint c join pg_namespace n on n.oid = c.connamespace
    where c.contype = 'f' and n.nspname = 'public' and array_length(c.conkey, 1) = 1
      and c.confrelid in ('public.users'::regclass, 'auth.users'::regclass)
      and c.conrelid <> 'public.users'::regclass
  loop
    if r.confdeltype = 'n' and not r.notnull then
      execute format('update %s set %I = null where %I in (select id from lt_td_users)', r.child, r.col, r.col);
    else
      execute format('delete from %s where %I in (select id from lt_td_users)', r.child, r.col);
    end if;
    get diagnostics v = row_count;
    if v > 0 then insert into lt_td_log values ('user_fk:' || r.col, r.child, v); end if;
  end loop;

  delete from public.organizations where id in (select id from lt_td_orgs);
  get diagnostics v = row_count; insert into lt_td_log values ('root', 'organizations', v);
  delete from public.users where id in (select id from lt_td_users);
  get diagnostics v = row_count; insert into lt_td_log values ('root', 'public.users', v);

  -- 3. auth rows of the tagged users (replica mode = no cascades, so the
  --    session-children and the FK-less token/audit rows are removed explicitly)
  begin
    delete from auth.mfa_amr_claims where session_id in (select id from auth.sessions where user_id in (select id from lt_td_users));
    delete from auth.refresh_tokens where user_id in (select id::text from lt_td_users);
    get diagnostics v = row_count;
    if v > 0 then insert into lt_td_log values ('auth', 'auth.refresh_tokens', v); end if;
    delete from auth.audit_log_entries where payload->>'actor_id' in (select id::text from lt_td_users);
    get diagnostics v = row_count;
    if v > 0 then insert into lt_td_log values ('auth', 'auth.audit_log_entries', v); end if;
  exception when insufficient_privilege or undefined_table then
    insert into lt_td_log values ('auth:SKIPPED(no privilege)', 'auth.refresh_tokens/audit_log_entries', 0);
  end;
  for r in
    select c.conrelid::regclass::text as child,
           (select a.attname from pg_attribute a where a.attrelid = c.conrelid and a.attnum = c.conkey[1]) as col
    from pg_constraint c
    where c.contype = 'f' and c.confrelid = 'auth.users'::regclass
      and c.connamespace = 'auth'::regnamespace and array_length(c.conkey, 1) = 1
  loop
    begin
      execute format('delete from %s where %I in (select id from lt_td_users)', r.child, r.col);
      get diagnostics v = row_count;
      if v > 0 then insert into lt_td_log values ('auth', r.child, v); end if;
    exception when insufficient_privilege then
      insert into lt_td_log values ('auth:SKIPPED(no privilege)', r.child, 0);
    end;
  end loop;
  delete from auth.users where id in (select id from lt_td_users);
  get diagnostics v = row_count; insert into lt_td_log values ('root', 'auth.users', v);

  -- 4. durable rate-limit buckets keyed by a tagged identity
  if to_regclass('public.rate_limit_counters') is not null then
    delete from public.rate_limit_counters where key like '%lt-${tag}-%';
    get diagnostics v = row_count;
    if v > 0 then insert into lt_td_log values ('rate_limit', 'rate_limit_counters', v); end if;
  end if;

  -- 5. orphan sweep (only FKs that were clean before this teardown), to a fixpoint
  for i in 1..6 loop
    v := 0;
    for r in select * from lt_td_fk where orphans_before = 0 loop
      declare n bigint;
      begin
        execute format('delete from %s c where c.%I is not null and not exists (select 1 from %s p where p.%I = c.%I)',
                       r.child, r.child_col, r.parent, r.parent_col, r.child_col);
        get diagnostics n = row_count;
        if n > 0 then insert into lt_td_log values ('orphan_sweep', r.child || '.' || r.child_col, n); v := v + n; end if;
      end;
    end loop;
    exit when v = 0;
  end loop;
end $td$;

select coalesce(json_agg(json_build_object('step', step, 'table', tbl, 'rows', n) order by step, tbl), '[]'::json) from lt_td_log;
commit;
`,
    { quiet: true },
  );
  const log = JSON.parse(out.trim().split("\n").filter((l) => l.startsWith("[")).pop() ?? "[]");
  const after = readCounts();
  const residue = Object.entries(after).filter(([, c]) => Number(c) > 0);
  console.log(JSON.stringify({ teardown: tag, target: targetKind, before, deleted: log, after, clean: residue.length === 0 }, null, 2));
  if (residue.length > 0) {
    console.error(`[seed] TEARDOWN INCOMPLETE — residue: ${JSON.stringify(Object.fromEntries(residue))}`);
    process.exit(2);
  }
}

async function removeStorageObjects() {
  const url = process.env.LOAD_SUPABASE_URL ?? process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.LOAD_SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("[seed] no SUPABASE_URL / service-role key in env — skipping Storage API cleanup");
    return;
  }
  authoriseTarget(url, "Supabase URL");
  const rows = psql(
    guardSql +
      `select coalesce(json_agg(json_build_object('b', bucket_id, 'n', name)), '[]'::json) from storage.objects
       where split_part(name, '/', 1) in (select id::text from public.organizations where slug like 'lt-${tag}-%');`,
    { quiet: true },
  );
  const objects = JSON.parse(rows.trim().split("\n").pop());
  const byBucket = new Map();
  for (const o of objects) byBucket.set(o.b, [...(byBucket.get(o.b) ?? []), o.n]);
  let removed = 0;
  for (const [bucket, names] of byBucket) {
    for (let i = 0; i < names.length; i += 200) {
      const res = await fetch(`${url}/storage/v1/object/${bucket}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${key}`, apikey: key, "content-type": "application/json" },
        body: JSON.stringify({ prefixes: names.slice(i, i + 200) }),
      });
      if (!res.ok) console.error(`[seed] storage delete ${bucket} → HTTP ${res.status}`);
      else removed += names.slice(i, i + 200).length;
    }
  }
  console.error(`[seed] storage objects removed via API: ${removed}/${objects.length}`);
}

// ── expected counts (for --verify) ───────────────────────────────────────────
function expectedCounts(orgs) {
  const sum = (f) => orgs.reduce((a, o) => a + f(o), 0);
  return {
    organizations: orgs.length,
    memberships: sum((o) => 1 + o.n_admins + o.n_staff),
    customers: sum((o) => o.n_customers),
    jobs: sum((o) => o.n_jobs),
    quotes: sum((o) => o.n_quotes),
    invoices: sum((o) => o.n_invoices),
    job_documents: sum((o) => o.n_docs),
    risk_assessments: sum((o) => o.n_rams),
    leads: sum((o) => o.n_leads),
    finances: sum((o) => o.n_fin),
    auth_users: sum((o) => 1 + o.n_admins + o.n_staff) + int("hq", 2),
    public_users: sum((o) => 1 + o.n_admins + o.n_staff) + int("hq", 2),
  };
}

// ── main ─────────────────────────────────────────────────────────────────────
async function main() {
  if (args.teardown) return teardown();

  const orgs = buildOrgs();
  const expected = expectedCounts(orgs);

  if (args.verify) {
    const actual = readCounts();
    const rows = Object.keys(expected).map((k) => ({ table: k, expected: expected[k], actual: Number(actual[k] ?? 0) }));
    // Seeded-row floors: a load run legitimately ADDS quotes/invoices/jobs/leads.
    const bad = rows.filter((r) => r.actual < r.expected);
    console.log(JSON.stringify({ verify: tag, rows, derived: actual, ok: bad.length === 0 }, null, 2));
    process.exit(bad.length === 0 ? 0 : 2);
  }

  const password = process.env.LOAD_USER_PASSWORD ?? (targetKind === "local" ? LOCAL_DEFAULT_PASSWORD : null);
  if (!password) throw new Error("LOAD_USER_PASSWORD must be set for a non-local target (no default).");
  if (password.length < 12) throw new Error("LOAD_USER_PASSWORD must be at least 12 characters.");

  const cols = ["idx", "org_id", "slug", "name", "marker", "tier", "n_staff", "n_admins", "n_customers", "n_jobs", "n_quotes", "n_invoices", "n_invoiceable", "n_te", "n_docs", "n_rams", "n_leads", "n_fin"];
  const copyRows = orgs.map((o) => cols.map((c) => String(o[c]).replace(/[\t\n\\]/g, " ")).join("\t")).join("\n");
  const seedSql = readFileSync(resolve(HERE, "sql", "seed.sql"), "utf8");
  const t0 = Date.now();
  const script = `
${guardSql}
\\set ON_ERROR_STOP on
\\getenv pw LOAD_SEED_PW
select extensions.crypt(:'pw', extensions.gen_salt('bf', 10)) as pwhash \\gset
\\unset pw
\\set tag '${tag}'
\\set anchor '${anchor}'
\\set hq ${int("hq", 2)}
${args.fast ? "set session_replication_role = replica;" : ""}
create temp table lt_orgs (
  idx int primary key, org_id uuid, slug text, name text, marker text, tier text,
  n_staff int, n_admins int, n_customers int, n_jobs int, n_quotes int, n_invoices int,
  n_invoiceable int, n_te int, n_docs int, n_rams int, n_leads int, n_fin int
);
copy lt_orgs (${cols.join(", ")}) from stdin;
${copyRows}
\\.
${seedSql}
`;
  psql(script, { env: { LOAD_SEED_PW: password } });
  const seconds = (Date.now() - t0) / 1000;
  const actual = readCounts();

  const manifestPath = resolve(REPO, String(args.manifest ?? `load/k6/.manifest/${tag}.json`));
  mkdirSync(dirname(manifestPath), { recursive: true });
  const manifest = {
    tag,
    seed: seedN,
    anchor,
    target: targetKind,
    idScheme: "uuid = md5('<tag>:<kind>:<orgIdx>:<n>'); see load/k6/lib/ids.js",
    emailScheme: "lt-<tag>-o<orgIdx>-<role><n>@loadtest.crewflow.invalid ; HQ: lt-<tag>-hq<n>@…",
    hq: int("hq", 2),
    orgs: orgs.map((o) => ({
      idx: o.idx, slug: o.slug, marker: o.marker, tier: o.tier, staff: o.n_staff, admins: o.n_admins,
      customers: o.n_customers, jobs: o.n_jobs, quotes: o.n_quotes, invoiceable: o.n_invoiceable,
      rams: o.n_rams, leads: o.n_leads,
    })),
  };
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const total = Object.values(actual).reduce((a, c) => a + Number(c), 0);
  console.log(JSON.stringify({
    seeded: tag, target: targetKind, mode: args.fast ? "fast (triggers off)" : "triggers on",
    seconds: Number(seconds.toFixed(2)), rows: actual, totalRows: total,
    rowsPerSecond: Math.round(total / Math.max(seconds, 0.001)), manifest: manifestPath,
    users: expected.auth_users,
  }, null, 2));
}

main().catch((e) => {
  console.error(String(e?.message ?? e));
  process.exit(1);
});
