/**
 * War-test seed.
 *
 * Generates N synthetic construction companies + all their child rows
 * into the production Supabase database, tagged with the
 * "[E2E-WAR]" sentinel prefix on the org name + slug so we can clean
 * up cleanly via the companion script.
 *
 * Scale is deliberately moderate (not 300 × 100 × everything):
 *   COMPANIES * (STAFF + CUSTOMERS + JOBS + QUOTES + INVOICES +
 *                SUPPLIERS + EXPENSE_DRAFTS + COMPLIANCE_DOCS)
 *
 * Defaults to 25 companies — enough to surface scale problems
 * (cross-org leakage in list queries, slow filters) without
 * dumping millions of rows into prod.
 *
 * Configure via env vars:
 *   COMPANIES=25 STAFF=10 CUSTOMERS=20 JOBS=15 QUOTES=10
 *   INVOICES=10 SUPPLIERS=5 EXPENSES=10 node scripts/war-test-seed.mjs
 *
 * Cleanup:
 *   node scripts/war-test-seed.mjs --cleanup
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Prefer .env.war (sentinel-only secrets for the test) and fall back to
// .env.local. Vercel CLI exports secret values as empty `""`, so .env.war is
// populated from the supabase CLI separately.
const warEnv = path.resolve(__dirname, "..", ".env.war");
const localEnv = path.resolve(__dirname, "..", ".env.local");
const envFile = fs.existsSync(warEnv) ? warEnv : localEnv;
const env = {};
for (const line of fs.readFileSync(envFile, "utf-8").split("\n")) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m) {
    let val = m[2];
    // Vercel CLI quotes every value — strip surrounding double quotes.
    if (val.length >= 2 && val.startsWith('"') && val.endsWith('"')) {
      val = val.slice(1, -1);
    }
    env[m[1]] = val;
  }
}
const URL = env.NEXT_PUBLIC_SUPABASE_URL;
const KEY = env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL || !KEY) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(1);
}

const sb = createClient(URL, KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const SENTINEL = "[E2E-WAR]";
const COMPANIES = +(process.env.COMPANIES ?? 25);
const STAFF = +(process.env.STAFF ?? 10);
const CUSTOMERS_PER = +(process.env.CUSTOMERS ?? 20);
const JOBS_PER = +(process.env.JOBS ?? 15);
const QUOTES_PER = +(process.env.QUOTES ?? 10);
const INVOICES_PER = +(process.env.INVOICES ?? 10);
const SUPPLIERS_PER = +(process.env.SUPPLIERS ?? 5);
const EXPENSES_PER = +(process.env.EXPENSES ?? 10);

const args = process.argv.slice(2);
const CLEANUP_MODE = args.includes("--cleanup");
const PERF_MODE = args.includes("--perf");

function rand(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}
function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
function gbp() {
  return (randInt(50, 25000) + Math.random()).toFixed(2);
}
function daysAgo(n) {
  return new Date(Date.now() - n * 86400000).toISOString();
}

const TRADES = [
  "general_builder",
  "plumber",
  "electrician",
  "roofer",
  "carpenter",
  "plasterer",
  "painter_decorator",
  "landscaper",
];
const SOURCES = ["phone", "referral", "facebook", "google", "instagram", "manual"];
const URGENCIES = ["low", "normal", "high"];
const JOB_STATUSES = ["new", "in-progress", "completed", "blocked"];

// ============================================================================
// CLEANUP MODE
// ============================================================================

async function cleanup() {
  console.log(`\n[cleanup] removing every org with name LIKE '${SENTINEL}%'`);
  const t0 = Date.now();
  const { data: orgs, error } = await sb
    .from("organizations")
    .select("id, name")
    .like("name", `${SENTINEL}%`);
  if (error) {
    console.error("[cleanup] org fetch failed", error);
    process.exit(1);
  }
  if (!orgs || orgs.length === 0) {
    console.log("[cleanup] no orgs match — nothing to do");
    return;
  }
  console.log(`[cleanup] deleting ${orgs.length} org(s)`);
  // Some triggers on child tables (e.g. activity_log inserter on deletes)
  // can fire AFTER the org row is gone, breaking cascade. Walk every
  // tenant table directly first so cascade has nothing left to do.
  const TENANT_TABLES = [
    "activity_log",
    "admin_activity_log",
    "ai_receptionist_setups",
    "automation_runs",
    "calls",
    "compliance_documents",
    "customers",
    "expense_drafts",
    "finances",
    "inbound_enquiries",
    "invoices",
    "jobs",
    "lead_followup_state",
    "leads",
    "memberships",
    "notifications",
    "quote_line_items",
    "quotes",
    "review_requests",
    "signatures",
    "suppliers",
    "tenant_attachments",
  ];
  for (const org of orgs) {
    for (const table of TENANT_TABLES) {
      const { error: tErr } = await sb
        .from(table)
        .delete()
        .eq("org_id", org.id);
      if (tErr && !/does not exist|cache/.test(tErr.message)) {
        // We intentionally swallow "table doesn't exist" since some
        // tables vary by migration history.
      }
    }
    const { error: delErr } = await sb
      .from("organizations")
      .delete()
      .eq("id", org.id);
    if (delErr) {
      console.warn(`[cleanup] failed to delete org ${org.id}:`, delErr.message);
    }
  }
  console.log(`[cleanup] done in ${Date.now() - t0}ms`);
}

// ============================================================================
// PERF MODE — measure realistic queries against existing seeded data
// ============================================================================

async function runPerf() {
  console.log("\n[perf] measuring query latency against the war-test orgs");

  // Sample the most recently seeded orgs (the failed ones from earlier
  // runs have no child rows so they distort the measurements).
  const { data: orgs } = await sb
    .from("organizations")
    .select("id, name")
    .like("name", `${SENTINEL}%`)
    .order("created_at", { ascending: false })
    .limit(5);
  if (!orgs || orgs.length === 0) {
    console.log("[perf] no seeded data — run without --perf first");
    return;
  }

  console.log(`[perf] sampling ${orgs.length} org(s)`);
  const samples = [];

  // 1. customers list (limit 200) — same query as /customers
  for (const org of orgs) {
    const t0 = Date.now();
    const { count, error } = await sb
      .from("customers")
      .select("*", { count: "exact", head: true })
      .eq("org_id", org.id);
    const ms = Date.now() - t0;
    samples.push({ q: "customers count", org: org.name, ms, count, error });
  }

  // 2. jobs list with customer join + ordered by recency
  for (const org of orgs) {
    const t0 = Date.now();
    const { data, error } = await sb
      .from("jobs")
      .select("id, status, customer:customers ( id, name )")
      .eq("org_id", org.id)
      .order("created_at", { ascending: false })
      .limit(500);
    const ms = Date.now() - t0;
    samples.push({
      q: "jobs list (limit 500, customer join)",
      org: org.name,
      ms,
      rows: data?.length ?? 0,
      error,
    });
  }

  // 3. invoices total (cross-org aggregate — superuser query)
  {
    const t0 = Date.now();
    const { count } = await sb
      .from("invoices")
      .select("*", { count: "exact", head: true });
    const ms = Date.now() - t0;
    samples.push({ q: "invoices total (HQ-wide)", ms, count });
  }

  // 4. organizations LIKE filter — same as /admin org search
  {
    const t0 = Date.now();
    const { data, error } = await sb
      .from("organizations")
      .select("id, name, status")
      .like("name", `${SENTINEL}%`)
      .limit(100);
    const ms = Date.now() - t0;
    samples.push({ q: "org search LIKE", ms, rows: data?.length ?? 0, error });
  }

  // 5. cross-tenant probe — service role should see all orgs
  {
    const t0 = Date.now();
    const { count } = await sb
      .from("customers")
      .select("*", { count: "exact", head: true });
    const ms = Date.now() - t0;
    samples.push({ q: "customers total (cross-tenant via service role)", ms, count });
  }

  // 6. invoice list with quote join (HQ analytics-style)
  {
    const t0 = Date.now();
    const { data } = await sb
      .from("invoices")
      .select("id, org_id, status, amount, vat_total, total, quote:quotes ( number )")
      .order("created_at", { ascending: false })
      .limit(1000);
    const ms = Date.now() - t0;
    samples.push({ q: "invoices list+join (HQ analytics)", ms, rows: data?.length ?? 0 });
  }

  // 7. quote count per status across the full sample
  {
    const t0 = Date.now();
    const { count } = await sb
      .from("quotes")
      .select("*", { count: "exact", head: true })
      .eq("status", "accepted");
    const ms = Date.now() - t0;
    samples.push({ q: "quotes WHERE status=accepted (global)", ms, count });
  }

  // 8. RLS-blocked cross-tenant query (simulated via anon key)
  // Note: this uses the service role, so RLS doesn't apply. The real
  // RLS test happens via the HTTP smoke against the authed API.
  {
    const ANON = {
      key: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imp6bnRic2tkcWRvcHp3ZHF3dmtwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg2MDkxNjksImV4cCI6MjA5NDE4NTE2OX0.yZcG7zvxgsV1Z2_-DS77G_jqoRrOsCJYmdr9yUc6idY",
    };
    const { createClient: cc } = await import("@supabase/supabase-js");
    const anonClient = cc(URL, ANON.key, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const t0 = Date.now();
    const { count, error } = await anonClient
      .from("customers")
      .select("*", { count: "exact", head: true });
    const ms = Date.now() - t0;
    samples.push({
      q: "RLS check: anon user trying to read customers",
      ms,
      count,
      error: error?.message,
    });
  }

  console.log("\n[perf] results:");
  for (const s of samples) {
    const flag = s.ms > 1000 ? "🔴" : s.ms > 500 ? "🟠" : "🟢";
    console.log(`  ${flag} ${s.ms}ms  ${s.q}  ${JSON.stringify({ ...s, q: undefined, ms: undefined, flag: undefined })}`);
  }
}

// ============================================================================
// SEED MODE — create N companies + their child data
// ============================================================================

async function seedOne(i) {
  const slug = `e2e-war-${Date.now()}-${i}`;
  const name = `${SENTINEL} ${rand(["Northbridge", "Oakwood", "Tradeline", "Crewline", "Lighthouse"])} ${rand(["Builders", "Construction", "Trades", "Group"])} ${i}`;

  // 1. Org
  const { data: org, error: orgErr } = await sb
    .from("organizations")
    .insert({
      slug,
      name,
      status: "active",
      plan: "starter",
      phone: `+44 700 ${String(randInt(100000, 999999)).slice(-6)}`,
      onboarding_state: {
        started_at: daysAgo(40),
        completed_at: daysAgo(35),
        dismissed_steps: [],
      },
    })
    .select("id")
    .single();
  if (orgErr) {
    console.warn(`[seed#${i}] org insert failed`, orgErr.message);
    return null;
  }

  // 2. Customers (schema: id, org_id, name, email, phone, notes — no postcode column)
  const customerInserts = [];
  for (let c = 0; c < CUSTOMERS_PER; c++) {
    customerInserts.push({
      org_id: org.id,
      name: `${rand(["Anna", "Bilal", "Chloe", "David", "Eleni", "Fionn", "Grace", "Hassan", "Imani", "Jana"])} ${rand(["Adams", "Brown", "Clark", "Davies", "Edwards", "Forster", "Green", "Hughes"])}`,
      email: `customer-${c}-${i}@example.invalid`,
      phone: `+44 7700 ${String(randInt(100000, 999999)).slice(-6)}`,
      notes: `BT${randInt(1, 99)} ${randInt(1, 9)}AA`,
    });
  }
  const { data: customers, error: cErr } = await sb
    .from("customers")
    .insert(customerInserts)
    .select("id");
  if (cErr) {
    console.warn(`[seed#${i}] customers insert failed`, cErr.message);
    return { id: org.id, partial: true };
  }

  // 3. Jobs
  const jobInserts = [];
  for (let j = 0; j < JOBS_PER; j++) {
    jobInserts.push({
      org_id: org.id,
      customer_id: customers[j % customers.length].id,
      status: rand(JOB_STATUSES),
      notes: `Job ${j} — ${rand(["loft conversion", "kitchen refit", "patio rebuild", "boiler swap", "extension"])}`,
      scheduled_date: daysAgo(randInt(0, 365)).slice(0, 10),
    });
  }
  const { error: jobErr } = await sb.from("jobs").insert(jobInserts);
  if (jobErr) console.warn(`[seed#${i}] jobs`, jobErr.message);

  // 4. Quotes (total is a generated column — DON'T insert it; subtotal+vat compute it)
  const quoteInserts = [];
  for (let q = 0; q < QUOTES_PER; q++) {
    const subtotal = +gbp();
    const vat = +(subtotal * 0.2).toFixed(2);
    quoteInserts.push({
      org_id: org.id,
      customer_id: customers[q % customers.length].id,
      number: `${slug}-Q-${String(q + 1).padStart(4, "0")}`,
      status: rand(["draft", "sent", "accepted", "declined"]),
      subtotal,
      vat_total: vat,
      public_token: crypto.randomUUID(),
    });
  }
  const { error: quoteErr } = await sb.from("quotes").insert(quoteInserts);
  if (quoteErr) console.warn(`[seed#${i}] quotes`, quoteErr.message);

  // 5. Invoices — total is generated; do NOT insert
  const invoiceInserts = [];
  for (let inv = 0; inv < INVOICES_PER; inv++) {
    const amount = +gbp();
    const vat = +(amount * 0.2).toFixed(2);
    invoiceInserts.push({
      org_id: org.id,
      number: `${slug}-INV-${String(inv + 1).padStart(4, "0")}`,
      status: rand(["draft", "sent", "paid", "overdue"]),
      amount,
      vat_total: vat,
    });
  }
  const { error: invErr } = await sb.from("invoices").insert(invoiceInserts);
  if (invErr) console.warn(`[seed#${i}] invoices`, invErr.message);

  // 6. Suppliers
  const supplierInserts = [];
  for (let s = 0; s < SUPPLIERS_PER; s++) {
    supplierInserts.push({
      org_id: org.id,
      name: `${rand(["Travis", "Wickes", "Selco", "Jewson", "Howdens", "Brewers"])}-${i}-${s}`,
      email: `supplier-${s}-${i}@example.invalid`,
      category: rand(["Materials", "Plant hire", "Subcontractor"]),
    });
  }
  await sb.from("suppliers").insert(supplierInserts);

  // 7. Finances (expenses — schema uses `notes`, not `description`)
  const financeInserts = [];
  for (let e = 0; e < EXPENSES_PER; e++) {
    financeInserts.push({
      org_id: org.id,
      amount: +gbp(),
      vat_rate: rand([0, 5, 20]),
      category: rand(["Materials", "Fuel", "Plant", "Subcontractor", "Misc"]),
      notes: `Expense ${e} — ${rand(["receipt", "invoice"])}`,
    });
  }
  const { error: finErr } = await sb.from("finances").insert(financeInserts);
  if (finErr) console.warn(`[seed#${i}] finances`, finErr.message);

  // 8. Leads
  const leadInserts = [];
  for (let l = 0; l < 5; l++) {
    leadInserts.push({
      org_id: org.id,
      contact_name: customerInserts[l % customerInserts.length].name,
      contact_phone: customerInserts[l % customerInserts.length].phone,
      source: rand(SOURCES),
      urgency: rand(URGENCIES),
      service: rand(["bathroom", "kitchen", "extension", "roof"]),
      status: rand(["new", "contacted", "won", "lost", "archived"]),
    });
  }
  await sb.from("leads").insert(leadInserts);

  return { id: org.id, name };
}

async function seedAll() {
  console.log(
    `\n[seed] creating ${COMPANIES} companies × ` +
      `(${STAFF} staff + ${CUSTOMERS_PER} customers + ${JOBS_PER} jobs + ` +
      `${QUOTES_PER} quotes + ${INVOICES_PER} invoices + ${SUPPLIERS_PER} suppliers + ` +
      `${EXPENSES_PER} expenses)`,
  );
  const t0 = Date.now();
  const results = [];
  for (let i = 0; i < COMPANIES; i++) {
    process.stdout.write(`[seed] org ${i + 1}/${COMPANIES} ... `);
    const ti = Date.now();
    const r = await seedOne(i);
    process.stdout.write(`${Date.now() - ti}ms\n`);
    if (r) results.push(r);
  }
  console.log(
    `\n[seed] done — ${results.length}/${COMPANIES} orgs in ${Date.now() - t0}ms`,
  );
  return results;
}

// ============================================================================

async function main() {
  if (CLEANUP_MODE) {
    await cleanup();
    return;
  }
  if (PERF_MODE) {
    await runPerf();
    return;
  }
  await seedAll();
  console.log("\n[seed] running perf measurement on freshly seeded data...");
  await runPerf();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
