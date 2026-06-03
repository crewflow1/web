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
 *   - customers: name + the structured address columns (line1/2, city, county,
 *     postcode) — see CUSTOMER_SEARCH_COLUMNS.
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
 *
 * All entity filtering is pushed into SQL (RLS-scoped via the user JWT) and the
 * free-text term is neutralised by the shared sanitizer before it reaches any
 * `.or()` / `ilike` pattern. Up to 8 hits per entity type are returned.
 */

type Hit = {
  type: "customer" | "job" | "quote" | "invoice" | "lead" | "staff";
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
  await requireOrgContext();
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

  const custOr = ilikeOrFilter(q, CUSTOMER_SEARCH_COLUMNS);
  if (!custOr) {
    // safe.length > 0 guarantees a non-null filter; this only narrows the type.
    return NextResponse.json({ hits: [] satisfies Hit[] });
  }

  const hits: Hit[] = [];

  // ── Wave 1: customers (name + structured address). Collect ids (up to
  //    CHAIN_LIMIT) so dependent entities for an address-matched customer
  //    surface even when the customer isn't itself in the top hits.
  const { data: customerRows } = await supabase
    .from("customers")
    .select(
      "id, name, email, phone, address_line1, address_line2, city, county, postcode",
    )
    .or(custOr)
    .limit(CHAIN_LIMIT);
  const customers = customerRows ?? [];
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

  // ── Wave 2 (parallel): jobs / quotes / leads keyed off own columns + the
  //    matched customer ids, and staff (independent, unchanged).
  const jobOr = combineOr(ilikeOrFilter(q, JOB_SEARCH_COLUMNS), custIdBranch);
  const quoteOr = combineOr(`number.ilike.${like}`, custIdBranch);
  const leadOr = combineOr(ilikeOrFilter(q, LEAD_SEARCH_COLUMNS), custIdBranch);
  if (!jobOr || !quoteOr || !leadOr) {
    // Own-column branches are always present for a 2+ char term; narrows types.
    return NextResponse.json({ hits });
  }

  const [jobsRes, quotesRes, leadsRes, membershipsRes] = await Promise.all([
    supabase
      .from("jobs")
      .select(
        "id, status, scheduled_date, site_address_line1, site_address_line2, site_city, site_county, site_postcode, site_country, customer:customers ( name, address_line1, address_line2, city, county, postcode, country )",
      )
      .or(jobOr)
      .order("created_at", { ascending: false })
      .limit(CHAIN_LIMIT),
    supabase
      .from("quotes")
      .select("id, number, status, customer:customers ( name )")
      .or(quoteOr)
      .limit(CHAIN_LIMIT),
    supabase
      .from("leads")
      .select("id, service, source, postcode, customer:customers ( name )")
      .or(leadOr)
      .limit(PER_TYPE),
    supabase
      .from("memberships")
      .select("user_id, role, user:users ( id, full_name, email )")
      .limit(40),
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

  return NextResponse.json({ hits });
}
