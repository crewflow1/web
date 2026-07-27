import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { sanitizeSearchTerm } from "@/lib/search/sanitize";

export const runtime = "nodejs";

/**
 * Global search — Cmd/K palette backend.
 *
 *   GET /api/search?q=<term>
 *
 * Searches across customers, jobs, quotes, invoices, leads, staff,
 * addresses (via customers.notes) and invoice numbers. Returns up to
 * 8 hits per entity type. RLS-scoped via the user JWT.
 */

type Hit = {
  type: "customer" | "job" | "quote" | "invoice" | "lead" | "staff" | "risk_assessment" | "permit";
  id: string;
  title: string;
  subtitle: string | null;
  href: string;
};

export async function GET(req: NextRequest) {
  await requireOrgContext();
  const supabase = await createClient();

  const q = (req.nextUrl.searchParams.get("q") ?? "").trim();
  if (q.length < 2) {
    return NextResponse.json({ hits: [] satisfies Hit[] });
  }
  // Neutralise control + PostgREST structural/wildcard chars (% _ , ( ) *)
  // before building the .or() filter — otherwise a crafted term like
  // `x,email.ilike.*` injects extra OR branches or breaks the filter grammar
  // (broadened matches / 400s). RLS keeps results intra-org, but the
  // over-matching is still a defect. Shared with the customers list via
  // lib/search/sanitize.ts (sanitizeSearchTerm).
  const safe = sanitizeSearchTerm(q);
  if (safe.length === 0) {
    return NextResponse.json({ hits: [] satisfies Hit[] });
  }
  const like = `%${safe}%`;

  // risk_assessments + permits_to_work post-date the generated types → loose cast.
  const loose = supabase as unknown as {
    from: (t: string) => { select: (c: string) => { or: (f: string) => { limit: (n: number) => Promise<{ data: Array<Record<string, string | null>> | null }> } } };
  };

  // Fire all queries in parallel under RLS.
  const [customers, jobs, quotes, invoices, leads, memberships, rams, permits] = await Promise.all([
    supabase
      .from("customers")
      .select("id, name, email, phone")
      .or(`name.ilike.${like},email.ilike.${like},phone.ilike.${like},notes.ilike.${like}`)
      .limit(8),
    supabase
      .from("jobs")
      .select("id, status, scheduled_date, customer:customers ( name )")
      .order("created_at", { ascending: false })
      .limit(80), // we'll filter client-side on customer name
    supabase
      .from("quotes")
      .select("id, number, status, customer:customers ( name )")
      .or(`number.ilike.${like}`)
      .limit(8),
    supabase
      .from("invoices")
      .select("id, number, status, total")
      .ilike("number", like)
      .limit(8),
    supabase
      .from("leads")
      .select("id, service, source, customer:customers ( name )")
      .or(`service.ilike.${like},source.ilike.${like}`)
      .limit(8),
    supabase
      .from("memberships")
      .select("user_id, role, user:users ( id, full_name, email )")
      .limit(40),
    // RA number (reference) + RAMS title.
    loose.from("risk_assessments").select("id, reference, title, status").or(`reference.ilike.${like},title.ilike.${like}`).limit(8),
    // Permit number (reference) + title.
    loose.from("permits_to_work").select("id, reference, title, status").or(`reference.ilike.${like},title.ilike.${like}`).limit(8),
  ]);

  const hits: Hit[] = [];

  for (const c of customers.data ?? []) {
    hits.push({
      type: "customer",
      id: c.id,
      title: c.name,
      subtitle: c.email ?? c.phone ?? null,
      href: `/customers/${c.id}`,
    });
  }
  // Jobs by customer name (no FTS on jobs themselves).
  for (const j of jobs.data ?? []) {
    const name = (j.customer as { name?: string } | null)?.name ?? "";
    if (name.toLowerCase().includes(q.toLowerCase())) {
      hits.push({
        type: "job",
        id: j.id,
        title: `Job · ${name || j.id.slice(0, 8)}`,
        subtitle: `${j.status}${j.scheduled_date ? ` · ${j.scheduled_date}` : ""}`,
        href: `/jobs/${j.id}`,
      });
      if (hits.filter((h) => h.type === "job").length >= 8) break;
    }
  }
  for (const q2 of quotes.data ?? []) {
    const name = (q2.customer as { name?: string } | null)?.name ?? "";
    hits.push({
      type: "quote",
      id: q2.id,
      title: q2.number,
      subtitle: `${q2.status}${name ? ` · ${name}` : ""}`,
      href: `/quotes/${q2.id}`,
    });
  }
  for (const inv of invoices.data ?? []) {
    hits.push({
      type: "invoice",
      id: inv.id,
      title: inv.number,
      subtitle: `${inv.status} · £${Number(inv.total ?? 0).toFixed(2)}`,
      href: `/invoices/${inv.id}`,
    });
  }
  for (const l of leads.data ?? []) {
    const name = (l.customer as { name?: string } | null)?.name ?? "";
    hits.push({
      type: "lead",
      id: l.id,
      title: `${l.service ?? "Lead"} · ${name || l.id.slice(0, 8)}`,
      subtitle: l.source,
      href: `/leads/${l.id}`,
    });
  }
  // Staff by full_name + email substring.
  const qLower = q.toLowerCase();
  for (const m of memberships.data ?? []) {
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
      if (hits.filter((h) => h.type === "staff").length >= 8) break;
    }
  }
  for (const r of rams.data ?? []) {
    hits.push({
      type: "risk_assessment",
      id: String(r.id),
      title: r.reference ?? r.title ?? "RAMS",
      subtitle: `RAMS · ${r.status}${r.reference ? ` · ${r.title}` : ""}`,
      href: `/health-safety/${r.id}`,
    });
  }
  for (const p of permits.data ?? []) {
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
