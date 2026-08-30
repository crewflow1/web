import { type NextRequest } from "next/server";
import * as respond from "@/lib/api/respond";
import { createClient } from "@/lib/supabase/server";
import type { SupabaseReadError } from "@/lib/supabase/read-failure";
import { requireOrgContext, isManagementRole } from "@/server/auth/session";
import { sanitizeSearchTerm } from "@/lib/search/sanitize";
import { matchScore } from "@/lib/search/rank";
import {
  ilikeOrFilter,
  inIdsBranch,
  combineOr,
  CUSTOMER_SEARCH_COLUMNS,
  JOB_SEARCH_COLUMNS,
  LEAD_SEARCH_COLUMNS,
  JOB_DOCUMENT_SEARCH_COLUMNS,
  SNAG_SEARCH_COLUMNS,
  PURCHASE_ORDER_SEARCH_COLUMNS,
  SITE_REPORT_SEARCH_COLUMNS,
} from "@/lib/search/filters";
import {
  resolveJobAddress,
  customerToAddress,
  formatAddressOneLine,
} from "@/lib/address";

export const runtime = "nodejs";

/**
 * Global search — Cmd/K palette backend.
 *
 *   GET /api/search?q=<term>
 *
 * Address-first. A tradesperson searches by address far more than by name, so
 * the term is matched in SQL across:
 *   - customers: name/email/phone + the structured address columns (line1/2,
 *     city, county, postcode) — see CUSTOMER_SEARCH_COLUMNS — plus the legacy
 *     free-text `notes` column that addresses used to live in.
 *   - jobs: the site-address override columns, PLUS any job whose linked
 *     customer matched (a job with no site override inherits the customer
 *     address). Resolved via customer-id chaining, not a JS scan of a capped
 *     page — the previous implementation fetched 80 jobs then filtered in
 *     memory, which silently dropped matches past row 80.
 *   - quotes: by number, PLUS quotes belonging to a matched customer.
 *   - leads: own columns (service/source/postcode/contact) PLUS leads linked to
 *     a matched customer.
 *   - invoices: by number, PLUS invoices belonging to a matched job or quote —
 *     so an invoice is discoverable through the customer's address even though
 *     invoices carry no customer_id (the chain is invoice → job/quote →
 *     customer).
 *   - staff: bounded membership fetch + in-memory name/email match (unchanged;
 *     non-address, intentionally out of the address-first scope).
 *   - RAMS + permits-to-work: reference number + title (unchanged; non-address,
 *     and both tables post-date the generated types so they go through a loose
 *     cast — still the RLS-scoped tenant client, never service-role).
 *   - job_documents: title + external reference, PLUS any document on a matched
 *     job (document → job → customer/address). RLS is the visibility boundary —
 *     a non-admin only ever sees `staff`-visibility docs, an admin also sees
 *     `private` ones, exactly as on the job page (the same tenant client).
 *   - snags: title / description / location / trade, PLUS snags on a matched job.
 *   - purchase_orders: number / supplier reference / notes, PLUS POs on a matched
 *     job (a PO reachable through the job's customer address).
 *   - site_reports: title / report number, PLUS reports on a matched job OR a
 *     matched customer (site_reports carry both job_id and customer_id).
 *
 * "Everything searchable" completion — the remaining registers, same pattern
 * (RLS tenant client, org-pinned, sanitized `.or(ilike)`, PER_TYPE cap, loud
 * fail):
 *   - suppliers: name/email/phone/category → /suppliers/[id]. Management-only.
 *   - finances (Costs): category/notes, PLUS entries on a matched job →
 *     /finances. Management-only. MONEY-SAFETY: no amount/vat/total column is
 *     selected and no monetary value ever appears in a hit title/subtitle —
 *     only description + date.
 *   - blueprints (Drawings): drawing number/title, PLUS drawings on a matched
 *     job → /jobs/[jobId]/blueprints (job_id is NOT NULL on blueprints).
 *   - assets + fleet vehicles: name/internal ref/serial/registration (reg
 *     plate). A matched asset that has a `fleet_vehicles` 1:1 profile surfaces
 *     as a VEHICLE hit (→ /fleet/vehicles/[assetId]); otherwise as an ASSET hit
 *     (→ /assets/[id]). Both management-only (Operations area).
 *   - toolbox_talks: topic/presenter, PLUS talks on a matched job → /toolbox/[id].
 *   - site_diary_entries: work summary, PLUS entries on a matched job → /diary/[id].
 *   - support_tickets: subject → /support/[id].
 *   - staff_qualifications: title/card reference → /staff/[userId] (the person
 *     the card belongs to). Management-only, matching the admin-gated /staff nav.
 *
 * PHOTOS & attachments — `tenant_attachments` rows targeting a JOB (photos,
 * scans, uploads) ARE searched by their `filename` and surface via the parent
 * job (→ /jobs/[targetId]) — attachments have no standalone detail route.
 * Attachments on OTHER targets (customers/quotes/invoices/suppliers/
 * memberships/leads) stay deliberately unsearched: each of those targets is
 * either a management-only surface (so a filename hit would leak Sales/Money
 * existence to staff through a member-labelled hit type) or has no clean
 * detail mapping (memberships), and every one of those parents is already
 * discoverable by its own searched columns. Photos with no meaningful
 * filename still surface through their parent entity, as before.
 *
 * All entity filtering is pushed into SQL (RLS-scoped via the user JWT) and the
 * free-text term is neutralised by the shared sanitizer before it reaches any
 * `.or()` / `ilike` pattern. Up to 8 hits per entity type are returned.
 *
 * Query waves exist only because of the id chaining: wave 1 is everything
 * independent (customers, staff, RAMS, permits, suppliers, assets, support
 * tickets, staff qualifications, job attachments) fired in parallel, wave 2 is
 * the entities keyed off matched customer/asset ids (jobs, quotes, leads,
 * fleet-vehicle profiles), wave 3 is everything keyed off matched
 * job/quote/customer ids (invoices, job documents, snags, purchase orders,
 * site reports, finances, blueprints, toolbox talks, diary entries) fired in
 * parallel. Three round trips, each maximally parallel.
 */

type Hit = {
  type:
    | "customer"
    | "job"
    | "quote"
    | "invoice"
    | "lead"
    | "staff"
    | "risk_assessment"
    | "permit"
    | "job_document"
    | "snag"
    | "purchase_order"
    | "site_report"
    | "supplier"
    | "finance"
    | "blueprint"
    | "asset"
    | "vehicle"
    | "toolbox_talk"
    | "diary_entry"
    | "support_ticket"
    | "staff_qualification"
    | "attachment";
  id: string;
  title: string;
  subtitle: string | null;
  href: string;
};

/**
 * Hit types that belong to the Sales/Money/Operations/People-admin areas
 * (owner/admin only). A staff Cmd+K result set excludes these, matching the
 * nav + page/API role boundary EXACTLY (app/(app)/_nav/nav-model.ts):
 *   - Sales (ADMIN_ROLES):      customer, quote, lead
 *   - Money (ADMIN_ROLES):      invoice, finance (Costs)
 *   - Operations (ADMIN_ROLES): purchase_order, supplier, asset, vehicle
 *   - People → Staff (ADMIN_ROLES): staff_qualification (links to /staff/[id])
 * Member-visible families mirror the ALL_ROLES nav children: blueprints
 * (Drawings), toolbox talks, site diary, snagging, support, jobs, documents,
 * site reports, RAMS/permits, job attachments.
 */
const MANAGEMENT_ONLY_SEARCH_TYPES = new Set<Hit["type"]>([
  "customer",
  "quote",
  "invoice",
  "lead",
  "purchase_order",
  "supplier",
  "finance",
  "asset",
  "vehicle",
  "staff_qualification",
]);

/**
 * Tie-break priority for the merged result sort. The first 12 values are
 * BYTE-IDENTICAL to TYPE_PRIORITY in lib/search/rank.ts (whose SearchHit union
 * is a closed set this route has outgrown); the new families rank after them.
 * The comparator below reuses the exported matchScore, so ranking behaviour
 * for the original families is exactly sortHitsByMatch's.
 */
const TYPE_PRIORITY: Record<Hit["type"], number> = {
  customer: 0,
  invoice: 1,
  quote: 2,
  job: 3,
  purchase_order: 4,
  site_report: 5,
  job_document: 6,
  risk_assessment: 7,
  permit: 8,
  snag: 9,
  lead: 10,
  staff: 11,
  supplier: 12,
  asset: 13,
  vehicle: 14,
  blueprint: 15,
  toolbox_talk: 16,
  diary_entry: 17,
  support_ticket: 18,
  finance: 19,
  staff_qualification: 20,
  attachment: 21,
};

/** sortHitsByMatch's exact algorithm over the widened Hit union: exact/prefix/
 * substring title match first (matchScore), type priority breaking ties;
 * Array.sort is stable so equal hits keep their wave order. */
function sortHits(hs: Hit[], q: string): Hit[] {
  return [...hs].sort((a, b) => {
    const sa = matchScore(a.title, q);
    const sb = matchScore(b.title, q);
    if (sa !== sb) return sa - sb;
    return TYPE_PRIORITY[a.type] - TYPE_PRIORITY[b.type];
  });
}

/** Supplier own columns (org-scoped register; email is citext). */
const SUPPLIER_SEARCH_COLUMNS = ["name", "email", "phone", "category"] as const;
/** Asset own columns — the identifiers a user actually types: name, the firm's
 * internal ref, the serial number and the registration (reg plate). */
const ASSET_SEARCH_COLUMNS = [
  "name",
  "asset_ref",
  "serial_number",
  "registration",
] as const;
/** Finances (Costs) own columns. TEXT ONLY — never a money column. */
const FINANCE_SEARCH_COLUMNS = ["category", "notes"] as const;
/** Blueprint own columns: the sheet number as issued + its title. */
const BLUEPRINT_SEARCH_COLUMNS = ["drawing_number", "title"] as const;
/** Toolbox talk own columns: the safety topic + who delivered it. */
const TOOLBOX_SEARCH_COLUMNS = ["topic", "presenter"] as const;
/** Site diary own columns: what was done that day. */
const DIARY_SEARCH_COLUMNS = ["work_summary"] as const;
/** Staff qualification own columns: the human name + card/cert number. */
const QUALIFICATION_SEARCH_COLUMNS = ["title", "reference_no"] as const;

/** Hits surfaced per entity type. */
const PER_TYPE = 8;
/** Parents fetched purely to chain ids into dependent queries (kept > PER_TYPE
 * so an invoice on a customer's 9th job, etc., still surfaces). */
const CHAIN_LIMIT = 50;

// Minimal shape we read off an embedded `customer:customers(...)` relation.
// supabase-js types embedded relations awkwardly (sometimes as an array), so
// we read through a narrow cast — consistent with the rest of this route.
type EmbeddedCustomer = {
  name?: string | null;
  address_line1?: string | null;
  address_line2?: string | null;
  city?: string | null;
  county?: string | null;
  postcode?: string | null;
  country?: string | null;
} | null;

export async function GET(req: NextRequest) {
  // The command palette is mounted in the app shell, so it is the single most
  // reachable list surface in the product. RLS is the OUTER boundary, not the
  // scope — `current_org_ids()` admits EVERY org the viewer belongs to — so
  // every read below is pinned to the ACTIVE org. Without the pins a dual-org
  // member's search returned the other company's customers, jobs, quotes,
  // leads, invoices, RAMS, permits and staff, each linking into a detail page
  // that (since #456/#459/#463) correctly 404s.
  const { ctx } = await requireOrgContext();

  // Cmd+K must not surface Sales/Money entities to a non-management member — the
  // same boundary the nav + page/API guards enforce. A `staff` result set keeps
  // the operational/field entities (jobs, documents, snags, site reports, RAMS,
  // permits) and drops customers/quotes/invoices/leads/POs. RLS already scopes to
  // the org; this scopes to the role. Filtering the merged hits at the return
  // points closes the leak without restructuring the query waves.
  const canSeeMoney = isManagementRole(ctx.membership.role);
  const roleVisible = (hs: Hit[]): Hit[] =>
    canSeeMoney ? hs : hs.filter((h) => !MANAGEMENT_ONLY_SEARCH_TYPES.has(h.type));
  const supabase = await createClient();

  const q = (req.nextUrl.searchParams.get("q") ?? "").trim();
  if (q.length < 2) {
    return respond.json({ hits: [] satisfies Hit[] });
  }
  // Neutralise control + PostgREST structural/wildcard chars (% _ , ( ) *)
  // before building any filter — a crafted term like `x,email.ilike.*` would
  // otherwise inject extra OR branches or break the grammar. RLS keeps results
  // intra-org, but over-matching is still a defect. Shared with every search
  // path via lib/search (sanitizeSearchTerm + the filter builders).
  const safe = sanitizeSearchTerm(q);
  if (safe.length === 0) {
    return respond.json({ hits: [] satisfies Hit[] });
  }
  const like = `%${safe}%`;

  // Customers match on name/email/phone + every structured address column
  // (CUSTOMER_SEARCH_COLUMNS) — plus `notes`, the legacy free-text field where
  // addresses were stashed before the structured columns existed. `notes` is
  // kept as its own OR-branch rather than added to the shared column set: it is
  // not an address column, and dropping it would make anything the previous
  // route could find unfindable.
  const custOr = combineOr(
    ilikeOrFilter(q, CUSTOMER_SEARCH_COLUMNS),
    `notes.ilike.${like}`,
  );
  if (!custOr) {
    // safe.length > 0 guarantees a non-null filter; this only narrows the type.
    return respond.json({ hits: [] satisfies Hit[] });
  }

  // Tables that post-date the generated types → loose cast. `eq` chains so a
  // read can stack the org pin with a second structural pin (the attachments
  // read pins target_table = 'jobs' as well as org_id).
  type LooseResult = Promise<{
    data: Array<Record<string, string | null>> | null;
    error: SupabaseReadError | null;
  }>;
  type LooseFilter = {
    eq: (k: string, v: unknown) => LooseFilter;
    or: (f: string) => { limit: (n: number) => LooseResult };
  };
  const loose = supabase as unknown as {
    from: (t: string) => { select: (c: string) => LooseFilter };
  };
  /** A dependent read whose id chain is empty contributes nothing (never a
   * match-everything filter) — same shape as a successful empty read. */
  const NO_ROWS: LooseResult = Promise.resolve({ data: [], error: null });

  const hits: Hit[] = [];

  // ── Wave 1 (parallel): everything that does NOT depend on another entity's
  //    ids — customers (name + structured address + legacy notes), staff
  //    memberships, RAMS, permits, suppliers, assets, support tickets, staff
  //    qualifications and job attachments. Customer ids are collected up to
  //    CHAIN_LIMIT so dependent entities for an address-matched customer
  //    surface even when the customer isn't itself in the top hits; asset ids
  //    likewise chain into the wave-2 fleet-vehicle profile lookup.
  const [
    customersRes,
    membershipsRes,
    ramsRes,
    permitsRes,
    suppliersRes,
    assetsRes,
    ticketsRes,
    qualificationsRes,
    attachmentsRes,
  ] = await Promise.all([
    supabase
      .from("customers")
      .select(
        "id, name, email, phone, address_line1, address_line2, city, county, postcode",
      )
      .eq("org_id", ctx.org.id)
      .or(custOr)
      .limit(CHAIN_LIMIT),
    supabase
      .from("memberships")
      .select("user_id, role, user:users ( id, full_name, email )")
      .eq("org_id", ctx.org.id)
      .limit(40),
    // RA number (reference) + RAMS title.
    loose.from("risk_assessments").select("id, reference, title, status").eq("org_id", ctx.org.id).or(`reference.ilike.${like},title.ilike.${like}`).limit(PER_TYPE),
    // Permit number (reference) + title.
    loose.from("permits_to_work").select("id, reference, title, status").eq("org_id", ctx.org.id).or(`reference.ilike.${like},title.ilike.${like}`).limit(PER_TYPE),
    // Suppliers: name / email / phone / category. Management-only hit type.
    loose.from("suppliers").select("id, name, email, phone, category").eq("org_id", ctx.org.id).or(ilikeOrFilter(q, SUPPLIER_SEARCH_COLUMNS) ?? "").limit(PER_TYPE),
    // Assets: the identifiers a user types (name / internal ref / serial / reg
    // plate). Fetched to CHAIN_LIMIT because the wave-2 fleet_vehicles lookup
    // splits these into vehicle vs plain-asset hits — a matched van must not
    // vanish just because eight other assets matched first.
    loose.from("assets").select("id, name, asset_ref, serial_number, registration, category, status").eq("org_id", ctx.org.id).or(ilikeOrFilter(q, ASSET_SEARCH_COLUMNS) ?? "").limit(CHAIN_LIMIT),
    // Support tickets: subject. RLS scopes to the org; the /support surface is
    // member-visible (Help → Support, ALL_ROLES).
    loose.from("support_tickets").select("id, ticket_number, subject, status").eq("org_id", ctx.org.id).or(`subject.ilike.${like}`).limit(PER_TYPE),
    // Staff qualifications: card title + certificate number → the person's
    // profile. Management-only (matches the admin-gated /staff nav).
    loose.from("staff_qualifications").select("id, user_id, title, reference_no, qualification_type").eq("org_id", ctx.org.id).or(ilikeOrFilter(q, QUALIFICATION_SEARCH_COLUMNS) ?? "").limit(PER_TYPE),
    // Job attachments (photos/scans/uploads) by filename — JOB targets only
    // (see the header PHOTOS note for why other targets stay unsearched).
    loose.from("tenant_attachments").select("id, target_id, filename").eq("org_id", ctx.org.id).eq("target_table", "jobs").or(`filename.ilike.${like}`).limit(PER_TYPE),
  ]);

  // A failed wave must 500, never degrade to "no results for that domain" —
  // silently dropping customers/staff/RAMS/permits from the palette is the
  // silent-empty-state lie this route exists to avoid.
  const wave1Error =
    customersRes.error ??
    membershipsRes.error ??
    ramsRes.error ??
    permitsRes.error ??
    suppliersRes.error ??
    assetsRes.error ??
    ticketsRes.error ??
    qualificationsRes.error ??
    attachmentsRes.error;
  if (wave1Error) {
    console.error("[search] wave 1 read failed", wave1Error);
    return respond.error(500, "query_failed");
  }

  const customers = customersRes.data ?? [];
  const customerIds = customers.map((c) => c.id);
  const custIdBranch = inIdsBranch("customer_id", customerIds);

  for (const c of customers.slice(0, PER_TYPE)) {
    const addr = formatAddressOneLine(customerToAddress(c));
    hits.push({
      type: "customer",
      id: c.id,
      title: c.name,
      subtitle: addr || c.email || c.phone || null,
      href: `/customers/${c.id}`,
    });
  }

  for (const s of (suppliersRes.data ?? []).slice(0, PER_TYPE)) {
    hits.push({
      type: "supplier",
      id: String(s.id),
      title: s.name ?? "Supplier",
      subtitle: [s.category, s.email ?? s.phone].filter(Boolean).join(" · ") || null,
      href: `/suppliers/${s.id}`,
    });
  }
  for (const t of ticketsRes.data ?? []) {
    hits.push({
      type: "support_ticket",
      id: String(t.id),
      title: t.subject ?? "Support ticket",
      subtitle: `Ticket${t.ticket_number ? ` #${t.ticket_number}` : ""}${t.status ? ` · ${String(t.status).replace(/_/g, " ")}` : ""}`,
      href: `/support/${t.id}`,
    });
  }
  for (const ql of qualificationsRes.data ?? []) {
    hits.push({
      type: "staff_qualification",
      id: String(ql.id),
      title: ql.title ?? "Qualification",
      subtitle: `Qualification${ql.reference_no ? ` · ${ql.reference_no}` : ""}`,
      // No standalone route — a qualification lives on the person's profile.
      href: `/staff/${ql.user_id}`,
    });
  }
  for (const a of attachmentsRes.data ?? []) {
    hits.push({
      type: "attachment",
      id: String(a.id),
      title: a.filename ?? "Attachment",
      subtitle: "File · on job",
      // Attachments have no standalone detail route — open the parent job.
      href: `/jobs/${a.target_id}`,
    });
  }

  // ── Wave 2 (parallel): jobs / quotes / leads keyed off their own columns +
  //    the matched customer ids, PLUS the fleet-vehicle profile lookup for the
  //    matched assets (a vehicle is an asset with a 1:1 fleet_vehicles row —
  //    the profile decides whether an asset hit renders as a VEHICLE).
  const jobOr = combineOr(ilikeOrFilter(q, JOB_SEARCH_COLUMNS), custIdBranch);
  const quoteOr = combineOr(`number.ilike.${like}`, custIdBranch);
  const leadOr = combineOr(ilikeOrFilter(q, LEAD_SEARCH_COLUMNS), custIdBranch);
  if (!jobOr || !quoteOr || !leadOr) {
    // Own-column branches are always present for a 2+ char term; narrows types.
    return respond.json({ hits: sortHits(roleVisible(hits), q) });
  }

  const assets = assetsRes.data ?? [];
  const assetIdBranch = inIdsBranch(
    "asset_id",
    assets.map((a) => a.id),
  );

  const [jobsRes, quotesRes, leadsRes, vehicleProfilesRes] = await Promise.all([
    supabase
      .from("jobs")
      .select(
        "id, status, scheduled_date, site_address_line1, site_address_line2, site_city, site_county, site_postcode, site_country, customer:customers ( name, address_line1, address_line2, city, county, postcode, country )",
      )
      .eq("org_id", ctx.org.id)
      .or(jobOr)
      .order("created_at", { ascending: false })
      .limit(CHAIN_LIMIT),
    supabase
      .from("quotes")
      .select("id, number, status, customer:customers ( name )")
      .eq("org_id", ctx.org.id)
      .or(quoteOr)
      .limit(CHAIN_LIMIT),
    supabase
      .from("leads")
      .select("id, service, source, postcode, customer:customers ( name )")
      .eq("org_id", ctx.org.id)
      .or(leadOr)
      .limit(PER_TYPE),
    // Which matched assets are vehicles? 1:1 profile keyed on asset_id, still
    // org-pinned. No matched assets → no read at all (empty chain contributes
    // nothing, never a match-everything filter).
    assetIdBranch
      ? loose
          .from("fleet_vehicles")
          .select("asset_id, vehicle_class, operational_status")
          .eq("org_id", ctx.org.id)
          .or(assetIdBranch)
          .limit(CHAIN_LIMIT)
      : NO_ROWS,
  ]);

  const wave2Error =
    jobsRes.error ?? quotesRes.error ?? leadsRes.error ?? vehicleProfilesRes.error;
  if (wave2Error) {
    console.error("[search] wave 2 read failed", wave2Error);
    return respond.error(500, "query_failed");
  }

  const jobs = jobsRes.data ?? [];
  const quotes = quotesRes.data ?? [];
  const leads = leadsRes.data ?? [];

  for (const j of jobs.slice(0, PER_TYPE)) {
    const cust = j.customer as EmbeddedCustomer;
    const name = cust?.name ?? "";
    const addr = formatAddressOneLine(resolveJobAddress(j, cust));
    hits.push({
      type: "job",
      id: j.id,
      title: `Job · ${name || j.id.slice(0, 8)}`,
      subtitle:
        addr ||
        `${j.status}${j.scheduled_date ? ` · ${j.scheduled_date}` : ""}`,
      href: `/jobs/${j.id}`,
    });
  }
  for (const qt of quotes.slice(0, PER_TYPE)) {
    const name = (qt.customer as EmbeddedCustomer)?.name ?? "";
    hits.push({
      type: "quote",
      id: qt.id,
      title: qt.number,
      subtitle: `${qt.status}${name ? ` · ${name}` : ""}`,
      href: `/quotes/${qt.id}`,
    });
  }
  for (const l of leads.slice(0, PER_TYPE)) {
    const name = (l.customer as EmbeddedCustomer)?.name ?? "";
    const sub = [l.source, l.postcode].filter(Boolean).join(" · ");
    hits.push({
      type: "lead",
      id: l.id,
      title: `${l.service ?? "Lead"} · ${name || l.id.slice(0, 8)}`,
      subtitle: sub || null,
      href: `/leads/${l.id}`,
    });
  }

  // Assets split by fleet profile: a profiled asset is a VEHICLE (reg plate →
  // the vehicle workspace), the rest are plain ASSET hits. Each side keeps the
  // PER_TYPE cap.
  const vehicleAssetIds = new Set(
    (vehicleProfilesRes.data ?? []).map((v) => String(v.asset_id)),
  );
  let assetCount = 0;
  let vehicleCount = 0;
  for (const a of assets) {
    const isVehicle = vehicleAssetIds.has(String(a.id));
    if (isVehicle) {
      if (vehicleCount >= PER_TYPE) continue;
      vehicleCount += 1;
    } else {
      if (assetCount >= PER_TYPE) continue;
      assetCount += 1;
    }
    const ident = [a.registration, a.asset_ref, a.serial_number]
      .filter(Boolean)
      .join(" · ");
    hits.push({
      type: isVehicle ? "vehicle" : "asset",
      id: String(a.id),
      title: a.name ?? (isVehicle ? "Vehicle" : "Asset"),
      subtitle:
        [isVehicle ? "Vehicle" : a.category || "Asset", ident]
          .filter(Boolean)
          .join(" · ") || null,
      href: isVehicle ? `/fleet/vehicles/${a.id}` : `/assets/${a.id}`,
    });
  }

  // ── Wave 3 (parallel): everything keyed off the ids matched above, PLUS each
  //    entity's own searchable columns. All are RLS-scoped tenant reads,
  //    org-pinned to the ACTIVE org and bounded to PER_TYPE rows.
  //      - invoices        → by number OR on a matched job/quote (invoice has no
  //                          customer_id; chain is invoice → job/quote → customer).
  //      - job_documents   → title/external ref OR on a matched job.
  //      - snags           → title/description/location/trade OR on a matched job.
  //      - purchase_orders → number/supplier ref/notes OR on a matched job.
  //      - site_reports    → title/report number OR on a matched job OR customer.
  //    The last four post-date the generated Supabase types, so they go through
  //    the same `loose` cast the RAMS/permits reads use — still the RLS-scoped
  //    tenant client, never service-role.
  const jobIdBranch = inIdsBranch(
    "job_id",
    jobs.map((j) => j.id),
  );
  const invoiceOr = combineOr(
    `number.ilike.${like}`,
    jobIdBranch,
    inIdsBranch(
      "quote_id",
      quotes.map((qt) => qt.id),
    ),
  );
  const jobDocOr = combineOr(ilikeOrFilter(q, JOB_DOCUMENT_SEARCH_COLUMNS), jobIdBranch);
  const snagOr = combineOr(ilikeOrFilter(q, SNAG_SEARCH_COLUMNS), jobIdBranch);
  const poOr = combineOr(ilikeOrFilter(q, PURCHASE_ORDER_SEARCH_COLUMNS), jobIdBranch);
  const siteReportOr = combineOr(
    ilikeOrFilter(q, SITE_REPORT_SEARCH_COLUMNS),
    jobIdBranch,
    custIdBranch,
  );
  const financeOr = combineOr(ilikeOrFilter(q, FINANCE_SEARCH_COLUMNS), jobIdBranch);
  const blueprintOr = combineOr(ilikeOrFilter(q, BLUEPRINT_SEARCH_COLUMNS), jobIdBranch);
  const toolboxOr = combineOr(ilikeOrFilter(q, TOOLBOX_SEARCH_COLUMNS), jobIdBranch);
  const diaryOr = combineOr(ilikeOrFilter(q, DIARY_SEARCH_COLUMNS), jobIdBranch);
  // Every branch above carries at least its own-column ILIKE (present for a 2+
  // char term), so none is null; the `?? ""` narrows the type without ever
  // being reached.
  const [
    invoicesRes,
    jobDocsRes,
    snagsRes,
    posRes,
    siteReportsRes,
    financesRes,
    blueprintsRes,
    toolboxRes,
    diaryRes,
  ] = await Promise.all([
    supabase
      .from("invoices")
      .select("id, number, status, total")
      .eq("org_id", ctx.org.id)
      .or(invoiceOr ?? "")
      .limit(PER_TYPE),
    loose
      .from("job_documents")
      .select("id, job_id, title, doc_type, status")
      .eq("org_id", ctx.org.id)
      .or(jobDocOr ?? "")
      .limit(PER_TYPE),
    loose
      .from("snags")
      .select("id, title, status, priority, job_id")
      .eq("org_id", ctx.org.id)
      .or(snagOr ?? "")
      .limit(PER_TYPE),
    loose
      .from("purchase_orders")
      .select("id, number, status, supplier_reference")
      .eq("org_id", ctx.org.id)
      .or(poOr ?? "")
      .limit(PER_TYPE),
    loose
      .from("site_reports")
      .select("id, title, report_number, status")
      .eq("org_id", ctx.org.id)
      .or(siteReportOr ?? "")
      .limit(PER_TYPE),
    // Costs (finances): MONEY-SAFETY — no amount / vat / total column is
    // selected; the hit carries description + date only.
    loose
      .from("finances")
      .select("id, category, notes, created_at, job_id")
      .eq("org_id", ctx.org.id)
      .or(financeOr ?? "")
      .limit(PER_TYPE),
    loose
      .from("blueprints")
      .select("id, job_id, drawing_number, title, status, discipline")
      .eq("org_id", ctx.org.id)
      .or(blueprintOr ?? "")
      .limit(PER_TYPE),
    loose
      .from("toolbox_talks")
      .select("id, topic, presenter, talk_date, job_id")
      .eq("org_id", ctx.org.id)
      .or(toolboxOr ?? "")
      .limit(PER_TYPE),
    loose
      .from("site_diary_entries")
      .select("id, entry_date, work_summary, job_id")
      .eq("org_id", ctx.org.id)
      .or(diaryOr ?? "")
      .limit(PER_TYPE),
  ]);

  const wave3Error =
    invoicesRes.error ??
    jobDocsRes.error ??
    snagsRes.error ??
    posRes.error ??
    siteReportsRes.error ??
    financesRes.error ??
    blueprintsRes.error ??
    toolboxRes.error ??
    diaryRes.error;
  if (wave3Error) {
    console.error("[search] wave 3 read failed", wave3Error);
    return respond.error(500, "query_failed");
  }

  for (const inv of invoicesRes.data ?? []) {
    hits.push({
      type: "invoice",
      id: inv.id,
      title: inv.number,
      subtitle: `${inv.status} · £${Number(inv.total ?? 0).toFixed(2)}`,
      href: `/invoices/${inv.id}`,
    });
  }
  for (const d of jobDocsRes.data ?? []) {
    hits.push({
      type: "job_document",
      id: String(d.id),
      title: d.title ?? "Document",
      subtitle: `Document${d.doc_type ? ` · ${d.doc_type}` : ""}${d.status ? ` · ${d.status}` : ""}`,
      // Documents have no standalone route — they live on their job.
      href: d.job_id ? `/jobs/${d.job_id}` : "/documents",
    });
  }
  for (const s of snagsRes.data ?? []) {
    hits.push({
      type: "snag",
      id: String(s.id),
      title: s.title ?? "Snag",
      subtitle: `Snag${s.status ? ` · ${s.status}` : ""}${s.priority ? ` · ${s.priority}` : ""}`,
      href: `/snags/${s.id}`,
    });
  }
  for (const po of posRes.data ?? []) {
    hits.push({
      type: "purchase_order",
      id: String(po.id),
      title: po.number ?? "Purchase order",
      subtitle: `PO · ${po.status ?? ""}${po.supplier_reference ? ` · ${po.supplier_reference}` : ""}`.trim(),
      href: `/purchase-orders/${po.id}`,
    });
  }
  for (const sr of siteReportsRes.data ?? []) {
    hits.push({
      type: "site_report",
      id: String(sr.id),
      title: sr.title ?? "Site report",
      subtitle: `Report${sr.report_number ? ` · ${sr.report_number}` : ""}${sr.status ? ` · ${sr.status}` : ""}`,
      href: `/site-reports/${sr.id}`,
    });
  }
  for (const f of financesRes.data ?? []) {
    // MONEY-SAFETY: description + date only — never an amount in the label.
    const day = f.created_at ? String(f.created_at).slice(0, 10) : null;
    hits.push({
      type: "finance",
      id: String(f.id),
      title: f.category ? `Cost · ${f.category}` : "Cost entry",
      subtitle:
        [day, f.notes ? String(f.notes).slice(0, 60) : null]
          .filter(Boolean)
          .join(" · ") || null,
      // Costs have no standalone detail route — the register is the surface.
      href: "/finances",
    });
  }
  for (const b of blueprintsRes.data ?? []) {
    hits.push({
      type: "blueprint",
      id: String(b.id),
      title: b.drawing_number ? `${b.drawing_number} · ${b.title ?? ""}`.trim() : (b.title ?? "Drawing"),
      subtitle: `Drawing${b.discipline ? ` · ${b.discipline}` : ""}${b.status ? ` · ${String(b.status).replace(/_/g, " ")}` : ""}`,
      // Drawings live in the job's drawing register (job_id is NOT NULL).
      href: `/jobs/${b.job_id}/blueprints`,
    });
  }
  for (const tt of toolboxRes.data ?? []) {
    hits.push({
      type: "toolbox_talk",
      id: String(tt.id),
      title: tt.topic ?? "Toolbox talk",
      subtitle: `Toolbox talk${tt.talk_date ? ` · ${tt.talk_date}` : ""}${tt.presenter ? ` · ${tt.presenter}` : ""}`,
      href: `/toolbox/${tt.id}`,
    });
  }
  for (const de of diaryRes.data ?? []) {
    hits.push({
      type: "diary_entry",
      id: String(de.id),
      title: `Site diary · ${de.entry_date ?? String(de.id).slice(0, 8)}`,
      subtitle: de.work_summary ? String(de.work_summary).slice(0, 80) : null,
      href: `/diary/${de.id}`,
    });
  }

  // ── Staff (unchanged): bounded membership fetch + in-memory name/email match.
  const qLower = q.toLowerCase();
  for (const m of membershipsRes.data ?? []) {
    const u = (m as { user?: { id: string; full_name: string | null; email: string } | null }).user;
    if (!u) continue;
    const name = (u.full_name ?? "").toLowerCase();
    const email = (u.email ?? "").toLowerCase();
    if (name.includes(qLower) || email.includes(qLower)) {
      hits.push({
        type: "staff",
        id: u.id,
        title: u.full_name ?? u.email,
        subtitle: `${m.role}${name ? ` · ${u.email}` : ""}`,
        href: `/staff/${u.id}`,
      });
      if (hits.filter((h) => h.type === "staff").length >= PER_TYPE) break;
    }
  }
  for (const r of ramsRes.data ?? []) {
    hits.push({
      type: "risk_assessment",
      id: String(r.id),
      title: r.reference ?? r.title ?? "RAMS",
      subtitle: `RAMS · ${r.status}${r.reference ? ` · ${r.title}` : ""}`,
      href: `/health-safety/${r.id}`,
    });
  }
  for (const p of permitsRes.data ?? []) {
    hits.push({
      type: "permit",
      id: String(p.id),
      title: p.reference ?? p.title ?? "Permit",
      subtitle: `Permit · ${p.status}${p.reference ? ` · ${p.title}` : ""}`,
      href: `/health-safety/permits/${p.id}`,
    });
  }

  // Relevance ranking. The waves above group hits by the round trip that found
  // them (a SQL-chaining artifact, not a ranking); re-sort the merged set so an
  // exact/prefix title match on the user's term wins regardless of which wave or
  // entity type surfaced it, with type priority breaking ties. Array.sort is
  // stable, so within an equal score+priority the original wave order stands.
  // (sortHits IS sortHitsByMatch's algorithm — see TYPE_PRIORITY above.)
  return respond.json({ hits: sortHits(roleVisible(hits), q) });
}
