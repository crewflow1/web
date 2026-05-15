/**
 * QA seed script.
 *
 * Populates the org the CEO will see on sign-in with realistic demo data:
 *   - 2 member accounts (synthetic @example.invalid emails)
 *   - 10 customers
 *   - 6 leads
 *   - 10 jobs spread across statuses + assignees + dates
 *   - 4 quotes + line items (linked to leads, NOT jobs — preserves prod schema)
 *   - 3 invoices (via next_invoice_number RPC, mixed statuses)
 *   - 8 finance entries (mixed categories + VAT rates)
 *   - 6 placeholder photos uploaded to job-photos bucket
 *
 * Runs against PROD via SUPABASE_SERVICE_ROLE_KEY in .env.local.
 * Idempotent insertions where possible: customer/lead/job IDs are
 * generated fresh on each run (it APPENDS rather than dedups).
 *
 *   npm run db:seed:qa
 *
 * Configure the target org via SEED_ORG_ID env var, else defaults to
 * the org the app loads for the CEO.
 */

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

// ------ env -----------------------------------------------------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const envFile = path.resolve(__dirname, "..", ".env.local");
const env = {};
for (const line of fs.readFileSync(envFile, "utf-8").split("\n")) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m) env[m[1]] = m[2];
}
const URL = env.NEXT_PUBLIC_SUPABASE_URL;
const KEY = env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL || !KEY) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(1);
}

const ORG_ID = process.env.SEED_ORG_ID || "82448b20-16a8-40a0-873a-5a5840b48482";
const OWNER_USER_ID = "79fc4c30-9285-4c72-90d4-eda5ca586301";

const sb = createClient(URL, KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// ------ helpers -------------------------------------------------------------
function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}
function daysAhead(n) {
  return daysAgo(-n);
}
// Generate a tiny PNG placeholder so the gallery renders something visible.
// 100x100 grayscale, single fill byte. ~120 bytes.
function placeholderPng(grayValue = 0x80) {
  const W = 100;
  const H = 100;
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, "ascii");
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
    return Buffer.concat([len, typeBuf, data, crc]);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // colour type = grayscale
  // filter, compression, interlace all 0
  const rows = [];
  for (let y = 0; y < H; y++) {
    rows.push(Buffer.from([0])); // filter byte (none)
    rows.push(Buffer.alloc(W, grayValue));
  }
  const raw = Buffer.concat(rows);
  const idat = zlib.deflateSync(raw);
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}
function crc32(buf) {
  let c, table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// ------ 1. demo member users ------------------------------------------------
console.log(`Seeding org ${ORG_ID} ...`);

const MEMBERS = [
  { email: "sarah.demo@example.invalid", full_name: "Sarah Mitchell" },
  { email: "tom.demo@example.invalid", full_name: "Tom Reilly" },
];

const memberUserIds = [];
for (const m of MEMBERS) {
  // createUser is idempotent at the email level — if email already exists,
  // we re-use it by listing.
  let userId = null;
  const created = await sb.auth.admin.createUser({
    email: m.email,
    password: crypto.randomUUID(),
    email_confirm: true,
    user_metadata: { full_name: m.full_name },
  });
  if (created.error) {
    if (created.error.code === "email_exists") {
      // find existing
      const list = await sb.auth.admin.listUsers({ page: 1, perPage: 1000 });
      const existing = list.data.users.find((u) => u.email === m.email);
      userId = existing?.id;
    } else {
      throw created.error;
    }
  } else {
    userId = created.data.user.id;
  }
  if (!userId) throw new Error("Could not create or find " + m.email);

  // mirror to public.users (idempotent upsert)
  await sb.from("users").upsert({
    id: userId,
    email: m.email,
    full_name: m.full_name,
  });

  // ensure membership row (one per org)
  await sb.from("memberships").upsert(
    { org_id: ORG_ID, user_id: userId, role: "member" },
    { onConflict: "org_id,user_id", ignoreDuplicates: false },
  );

  memberUserIds.push(userId);
  console.log(`  member ${m.full_name} (${userId.slice(0, 8)})`);
}

const ALL_ASSIGNEES = [OWNER_USER_ID, ...memberUserIds];

// ------ 2. customers --------------------------------------------------------
const CUSTOMER_SEED = [
  { name: "Mrs. Joan Wilson", email: "joan.wilson@example.invalid", phone: "+44 7700 900111" },
  { name: "Birmingham City Council", email: "facilities@birmingham.example.invalid", phone: "+44 121 000 0000" },
  { name: "Sarah Thompson", email: "sthompson@example.invalid", phone: "+44 7700 900222" },
  { name: "John Greene", email: "jgreene@example.invalid", phone: "+44 7700 900333" },
  { name: "Mike Patel", email: "mike.patel@example.invalid", phone: "+44 7700 900444" },
  { name: "Davis Construction Ltd", email: "admin@davis-cons.example.invalid", phone: "+44 161 000 0000" },
  { name: "Mrs. Sana Akhtar", email: "sakhtar@example.invalid", phone: "+44 7700 900555" },
  { name: "The Riverside Pub", email: "manager@riverside.example.invalid", phone: "+44 1234 567890" },
  { name: "Mr. David Henderson", email: "dhenderson@example.invalid", phone: "+44 7700 900666" },
  { name: "Lloyd's Bakery", email: "owner@lloyds-bakery.example.invalid", phone: "+44 7700 900777" },
];
const customers = [];
for (const c of CUSTOMER_SEED) {
  const { data, error } = await sb
    .from("customers")
    .insert({ org_id: ORG_ID, ...c, notes: null })
    .select("id, name")
    .single();
  if (error) throw error;
  customers.push(data);
}
console.log(`  ${customers.length} customers`);

// ------ 3. leads ------------------------------------------------------------
const LEAD_SEED = [
  { customer: 0, source: "phone", urgency: "high", service: "Emergency leak repair", postcode: "BT15 1AA" },
  { customer: 4, source: "phone", urgency: "urgent", service: "Storm damage emergency", postcode: "M1 1AA" },
  { customer: 2, source: "web", urgency: "normal", service: "New build roof", postcode: "L1 1AB" },
  { customer: 6, source: "referral", urgency: "normal", service: "Chimney repair", postcode: "B1 1AA" },
  { customer: 7, source: "phone", urgency: "high", service: "Commercial flat roof refurb", postcode: "S1 1AA" },
  { customer: 9, source: "web", urgency: "high", service: "Storm damage", postcode: "LS1 1AA" },
];
const leads = [];
for (const l of LEAD_SEED) {
  const { data, error } = await sb
    .from("leads")
    .insert({
      org_id: ORG_ID,
      customer_id: customers[l.customer].id,
      source: l.source,
      status: "new",
      service: l.service,
      urgency: l.urgency,
      postcode: l.postcode,
      ai_summary: `${l.urgency.toUpperCase()} – ${l.service} for ${customers[l.customer].name}`,
    })
    .select("id, customer_id")
    .single();
  if (error) throw error;
  leads.push(data);
}
console.log(`  ${leads.length} leads`);

// ------ 4. jobs -------------------------------------------------------------
// Mix of statuses + scheduled dates + assignees
const JOB_SEED = [
  { customer: 0, status: "new",          when:  2, assignee: 0, notes: "Initial site visit — bring ladder + leak detector" },
  { customer: 4, status: "in-progress",  when: -1, assignee: 1, notes: "Tiles 60% replaced. Need 12 more box. Re-quote materials." },
  { customer: 7, status: "in-progress",  when: -3, assignee: 2, notes: "Customer requested gutter cleaning on top of original scope" },
  { customer: 1, status: "completed",    when: -7, assignee: 0, notes: "Quarterly inspection. All membrane sections in good shape. 2 minor sealant touch-ups completed." },
  { customer: 2, status: "new",          when:  5, assignee: 1, notes: null },
  { customer: 6, status: "completed",    when:-10, assignee: 2, notes: "Chimney pointed. Photos uploaded. Invoice sent." },
  { customer: 9, status: "in-progress",  when:  1, assignee: 0, notes: "Storm damage — temporary tarp installed. Full job scheduled for tomorrow." },
  { customer: 8, status: "blocked",      when:  3, assignee: 1, notes: "Awaiting materials delivery. Supplier delay – ETA Friday." },
  { customer: 3, status: "new",          when:  7, assignee: 2, notes: "Site survey only — extension architect to confirm scope" },
  { customer: 5, status: "completed",    when:-14, assignee: 0, notes: "Roof repair completed Q1. Customer paid in full." },
];
const jobs = [];
for (const j of JOB_SEED) {
  const { data, error } = await sb
    .from("jobs")
    .insert({
      org_id: ORG_ID,
      customer_id: customers[j.customer].id,
      assigned_to: ALL_ASSIGNEES[j.assignee],
      status: j.status,
      scheduled_date: j.when >= 0 ? daysAhead(j.when) : daysAgo(-j.when),
      notes: j.notes,
    })
    .select("id, customer_id")
    .single();
  if (error) throw error;
  jobs.push(data);
}
console.log(`  ${jobs.length} jobs`);

// ------ 5. quotes + line items ----------------------------------------------
const QUOTE_SEED = [
  { lead: 0, status: "sent", lines: [
    { description: "Emergency leak callout", qty: 1, unit_price: 95.00, vat_rate: 20 },
    { description: "Replacement tiles (10 box)", qty: 10, unit_price: 28.50, vat_rate: 20 },
    { description: "Labour — half day", qty: 4, unit_price: 45.00, vat_rate: 20 },
  ]},
  { lead: 2, status: "accepted", lines: [
    { description: "New build roof — labour (5 days)", qty: 5, unit_price: 420.00, vat_rate: 20 },
    { description: "Slate, supply only", qty: 200, unit_price: 4.80, vat_rate: 20 },
    { description: "Underlay + battens", qty: 1, unit_price: 480.00, vat_rate: 20 },
    { description: "Lead flashing", qty: 1, unit_price: 220.00, vat_rate: 20 },
  ]},
  { lead: 3, status: "draft", lines: [
    { description: "Chimney repointing", qty: 1, unit_price: 380.00, vat_rate: 20 },
    { description: "Pot replacement", qty: 1, unit_price: 145.00, vat_rate: 20 },
  ]},
  { lead: 4, status: "accepted", lines: [
    { description: "Commercial flat roof refurb — design fee", qty: 1, unit_price: 800.00, vat_rate: 20 },
    { description: "Membrane (250 m²)", qty: 250, unit_price: 18.00, vat_rate: 20 },
    { description: "Insulation upgrade", qty: 1, unit_price: 1450.00, vat_rate: 20 },
    { description: "Labour (3 weeks, 2 staff)", qty: 30, unit_price: 380.00, vat_rate: 20 },
  ]},
];
const quotes = [];
let quoteNumberCounter = 1;
for (const q of QUOTE_SEED) {
  const subtotal = q.lines.reduce((s, li) => s + li.qty * li.unit_price, 0);
  const vatTotal = q.lines.reduce((s, li) => s + li.qty * li.unit_price * (li.vat_rate / 100), 0);
  const total = subtotal + vatTotal;
  const number = `Q-2026-${String(quoteNumberCounter++).padStart(4, "0")}`;
  const { data: quote, error } = await sb
    .from("quotes")
    .insert({
      org_id: ORG_ID,
      lead_id: leads[q.lead].id,
      customer_id: leads[q.lead].customer_id,
      number,
      status: q.status,
      subtotal: subtotal.toFixed(2),
      vat_total: vatTotal.toFixed(2),
      total: total.toFixed(2),
      currency: "GBP",
      public_token: crypto.randomUUID(),
      sent_at: q.status === "sent" || q.status === "accepted" ? new Date(Date.now() - 3 * 86400000).toISOString() : null,
      accepted_at: q.status === "accepted" ? new Date(Date.now() - 1 * 86400000).toISOString() : null,
    })
    .select("id, number, status, subtotal, vat_total, total")
    .single();
  if (error) throw error;

  // line items
  let sort = 0;
  for (const li of q.lines) {
    const lineTotal = (li.qty * li.unit_price).toFixed(2);
    const { error: liErr } = await sb.from("quote_line_items").insert({
      org_id: ORG_ID,
      quote_id: quote.id,
      description: li.description,
      qty: li.qty,
      unit: "ea",
      unit_price: li.unit_price.toFixed(2),
      vat_rate: li.vat_rate,
      line_total: lineTotal,
      sort_order: sort++,
    });
    if (liErr) throw liErr;
  }
  quotes.push(quote);
}
console.log(`  ${quotes.length} quotes (+ line items)`);

// ------ 6. invoices ---------------------------------------------------------
const ACCEPTED_QUOTES = quotes.filter((q) => q.status === "accepted");
const invoices = [];
let invIdx = 0;
const invoiceStatuses = ["paid", "sent", "overdue"];
for (const q of ACCEPTED_QUOTES) {
  const { data: numRpc, error: numErr } = await sb.rpc("next_invoice_number", {
    target_org: ORG_ID,
  });
  if (numErr) throw numErr;
  const status = invoiceStatuses[invIdx % invoiceStatuses.length];
  const sentAt = new Date(Date.now() - 5 * 86400000).toISOString();
  const paidAt = status === "paid" ? new Date(Date.now() - 1 * 86400000).toISOString() : null;
  const { data: inv, error } = await sb
    .from("invoices")
    .insert({
      org_id: ORG_ID,
      quote_id: q.id,
      number: numRpc,
      amount: q.subtotal,
      vat_total: q.vat_total,
      status,
      due_date: daysAhead(14),
      sent_at: sentAt,
      paid_at: paidAt,
      notes: status === "paid" ? "Paid via BACS" : null,
    })
    .select("id, number, status, total")
    .single();
  if (error) throw error;
  invoices.push(inv);
  invIdx++;
}

// Plus one fresh draft invoice from a draft quote so the user can see all
// statuses in the list
const draftQuote = quotes.find((q) => q.status === "draft");
if (draftQuote) {
  const { data: numRpc } = await sb.rpc("next_invoice_number", { target_org: ORG_ID });
  const { data: inv, error } = await sb
    .from("invoices")
    .insert({
      org_id: ORG_ID,
      quote_id: draftQuote.id,
      number: numRpc,
      amount: draftQuote.subtotal,
      vat_total: draftQuote.vat_total,
      status: "draft",
      due_date: daysAhead(30),
    })
    .select("id, number, status, total")
    .single();
  if (error) throw error;
  invoices.push(inv);
}
console.log(`  ${invoices.length} invoices`);

// ------ 7. finances --------------------------------------------------------
const FINANCE_SEED = [
  { amount: 156.00, vat_rate: 20, category: "materials", notes: "Slate tiles — Wickes Birmingham", days_ago: 12 },
  { amount: 89.50,  vat_rate: 20, category: "fuel",      notes: "Diesel — fleet vans week 19", days_ago: 8 },
  { amount: 1450.00,vat_rate: 20, category: "subcontractor", notes: "Brickwork sub — D. Healey", days_ago: 6 },
  { amount: 42.30,  vat_rate: 5,  category: "office",    notes: "Domestic gas (workshop heating)", days_ago: 5 },
  { amount: 320.00, vat_rate: 20, category: "labor",     notes: "Casual labourer day rate × 2", days_ago: 4 },
  { amount: 78.00,  vat_rate: 0,  category: "misc",      notes: "Public transport — zero-rated", days_ago: 3 },
  { amount: 215.50, vat_rate: 20, category: "tools",     notes: "Replacement impact driver + bits", days_ago: 2 },
  { amount: 540.00, vat_rate: 20, category: "vehicle",   notes: "Van service + MOT", days_ago: 1 },
];
const finances = [];
for (let i = 0; i < FINANCE_SEED.length; i++) {
  const f = FINANCE_SEED[i];
  const linkedJob = i % 3 === 0 ? jobs[i % jobs.length].id : null;
  const { data, error } = await sb
    .from("finances")
    .insert({
      org_id: ORG_ID,
      job_id: linkedJob,
      amount: f.amount.toFixed(2),
      vat_rate: f.vat_rate,
      category: f.category,
      notes: f.notes,
      created_at: new Date(Date.now() - f.days_ago * 86400000).toISOString(),
    })
    .select("id, amount")
    .single();
  if (error) throw error;
  finances.push(data);
}
console.log(`  ${finances.length} finance entries`);

// ------ 8. job photos -------------------------------------------------------
// Upload 6 placeholder PNGs across 3 jobs to demonstrate the gallery.
const PHOTO_TARGETS = [
  { job: 1, count: 2, gray: 0x6f }, // in-progress
  { job: 3, count: 2, gray: 0x99 }, // completed
  { job: 5, count: 2, gray: 0x55 }, // completed
];
let photoCount = 0;
for (const t of PHOTO_TARGETS) {
  const job = jobs[t.job];
  const paths = [];
  for (let i = 0; i < t.count; i++) {
    const buf = placeholderPng(t.gray + i * 16);
    const objPath = `${ORG_ID}/${job.id}/${Date.now()}-${i}-demo.png`;
    const { error } = await sb.storage.from("job-photos").upload(objPath, buf, {
      contentType: "image/png",
      upsert: false,
    });
    if (error) throw error;
    paths.push(objPath);
    photoCount++;
  }
  // Append to jobs.photos directly (service role bypasses RLS)
  const { error: upErr } = await sb.from("jobs").update({ photos: paths }).eq("id", job.id);
  if (upErr) throw upErr;
}
console.log(`  ${photoCount} photos uploaded to job-photos`);

console.log();
console.log("Done.");
console.log(`Org: ${ORG_ID}`);
console.log(`Login: https://crewflow.uk/login as hello@crewflow.uk`);
console.log(`Members seeded:`);
for (let i = 0; i < MEMBERS.length; i++) {
  console.log(`  ${MEMBERS[i].full_name}  ${MEMBERS[i].email}  user_id=${memberUserIds[i]}`);
}
