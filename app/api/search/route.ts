import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { sanitizeSearchTerm } from "@/lib/search/sanitize";
import {
  ilikeOrFilter,
  inIdsBranch,
  combineOr,
  CUSTOMER_SEARCH_COLUMNS,
  JOB_SEARCH_COLUMNS,
  LEAD_SEARCH_COLUMNS,
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
 *
 * All entity filtering is pushed into SQL (RLS-scoped via the user JWT) and the
 * free-text term is neutralised by the shared sanitizer before it reaches any
 * `.or()` / `ilike` pattern. Up to 8 hits per entity type are returned.
 *
 * Query waves exist only because of the id chaining: wave 1 is everything
 * independent (customers, staff, RAMS, permits) fired in parallel, wave 2 is
 * the entities keyed off matched customer ids, wave 3 is invoices keyed off
 * matched job/quote ids. Three round trips, each maximally parallel.
 */

type Hit = {
  type: "customer" | "job" | "quote" | "invoice" | "lead" | "staff" | "risk_assessment" | "permit";
  id: string;
  title: string;
  subtitle: string | null;
  href: string;
};

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
  const supabase = await createClient();

  const q = (req.nextUrl.searchParams.get("q") ?? "").trim();
  if (q.length < 2) {
    return NextResponse.json({ hits: [] satisfies Hit[] });
  }
  // Neutralise control + PostgREST structural/wildcard chars (% _ , ( ) *)
  // before building any filter — a crafted term like `x,email.ilike.*` would
  // otherwise inject extra OR branches or break the grammar. RLS keeps results
  // intra-org, but over-matching is still a defect. Shared with every search
  // path via lib/search (sanitizeSearchTerm + the filter builders).
  const safe = sanitizeSearchTerm(q);
  if (safe.length === 0) {
    return NextResponse.json({ hits: [] satisfies Hit[] });
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
    return NextResponse.json({ hits: [] satisfies Hit[] });
  }

  // risk_assessments + permits_to_work post-date the generated types → loose cast.
  const loose = supabase as unknown as {
    from: (t: string) => {
      select: (c: string) => {
        eq: (k: string, v: unknown) => {
          or: (f: string) => {
            limit: (n: number) => Promise<{ data: Array<Record<string, string | null>> | null }>;
          };
        };
      };
    };
  };

  const hits: Hit[] = [];

  // ── Wave 1 (parallel): everything that does NOT depend on another entity's
  //    ids — customers (name + structured address + legacy notes), staff
  //    memberships, RAMS and permits. Customer ids are collected up to
  //    CHAIN_LIMIT so dependent entities for an address-matched customer
  //    surface even when the customer isn't itself in the top hits.
  const [customersRes, membershipsRes, ramsRes, permitsRes] = await Promise.all([
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
  ]);

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

  // ── Wave 2 (parallel): jobs / quotes / leads keyed off their own columns +
  //    the matched customer ids.
  const jobOr = combineOr(ilikeOrFilter(q, JOB_SEARCH_COLUMNS), custIdBranch);
  const quoteOr = combineOr(`number.ilike.${like}`, custIdBranch);
  const leadOr = combineOr(ilikeOrFilter(q, LEAD_SEARCH_COLUMNS), custIdBranch);
  if (!jobOr || !quoteOr || !leadOr) {
    // Own-column branches are always present for a 2+ char term; narrows types.
    return NextResponse.json({ hits });
  }

  const [jobsRes, quotesRes, leadsRes] = await Promise.all([
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
  ]);

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

  // ── Wave 3: invoices — by number OR belonging to a matched job/quote, so an
  //    invoice is reachable through the customer's address (invoice has no
  //    customer_id; chain is invoice → job/quote → customer).
  const invoiceOr = combineOr(
    `number.ilike.${like}`,
    inIdsBranch(
      "job_id",
      jobs.map((j) => j.id),
    ),
    inIdsBranch(
      "quote_id",
      quotes.map((qt) => qt.id),
    ),
  );
  if (invoiceOr) {
    const { data: invoiceRows } = await supabase
      .from("invoices")
      .select("id, number, status, total")
      .eq("org_id", ctx.org.id)
      .or(invoiceOr)
      .limit(PER_TYPE);
    for (const inv of invoiceRows ?? []) {
      hits.push({
        type: "invoice",
        id: inv.id,
        title: inv.number,
        subtitle: `${inv.status} · £${Number(inv.total ?? 0).toFixed(2)}`,
        href: `/invoices/${inv.id}`,
      });
    }
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

  return NextResponse.json({ hits });
}
