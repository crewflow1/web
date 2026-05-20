import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";

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
  type: "customer" | "job" | "quote" | "invoice" | "lead" | "staff";
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
  const like = `%${q.replace(/[%_]/g, "")}%`;

  // Fire all queries in parallel under RLS.
  const [customers, jobs, quotes, invoices, leads, memberships] = await Promise.all([
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

  return NextResponse.json({ hits });
}
