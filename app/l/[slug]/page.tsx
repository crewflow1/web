import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { createAdminClient } from "@/lib/supabase/admin";
import { PublicLeadForm } from "./_form";

/**
 * Public per-company enquiry page — /l/[slug].
 *
 * UNAUTHENTICATED. Resolves the company from the slug server-side (no tenant
 * data beyond the public name is exposed) and renders the lead-capture form,
 * which posts to /api/public/lead. A prospective customer's enquiry lands in the
 * company's CRM (Sales → Leads). Dark-safe: reads only the org name.
 */

export const dynamic = "force-dynamic";

async function resolveOrg(slug: string): Promise<{ name: string } | null> {
  try {
    const admin = createAdminClient();
    const { data } = await admin
      .from("organizations")
      .select("name")
      .eq("slug", slug)
      .maybeSingle();
    return (data as { name: string } | null) ?? null;
  } catch {
    return null;
  }
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const org = await resolveOrg(slug);
  const title = org ? `Enquire — ${org.name}` : "Enquire";
  return { title, robots: { index: false, follow: false } };
}

export default async function PublicLeadPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const org = await resolveOrg(slug);
  if (!org) notFound();

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-xl flex-col gap-6 px-4 py-10">
      <header className="space-y-1">
        <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Get a quote</p>
        <h1 className="text-2xl font-bold text-slate-900">{org.name}</h1>
        <p className="text-sm text-slate-600">
          Tell us about your project and {org.name} will get back to you. It only takes a minute.
        </p>
      </header>
      <PublicLeadForm slug={slug} orgName={org.name} />
      <footer className="pt-2 text-center text-xs text-slate-400">Powered by CrewFlow</footer>
    </main>
  );
}
