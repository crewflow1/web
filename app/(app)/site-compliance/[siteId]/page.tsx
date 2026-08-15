import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { loadSiteForOrg, type SitesClient } from "@/server/services/sites";
import { formatSiteAddress, siteKindLabel, siteIdSchema } from "@/lib/sites/schema";
import { listStaffForOrg } from "@/app/(app)/jobs/_form-helpers";
import { Table, THead, TBody, TR, TH, TD } from "@/components/ui";
import { isInductionCurrent } from "@/lib/site-compliance/inductions";
import {
  listInductionsForSite,
  listVisitorsForSite,
  buildMusterRoll,
} from "../_data";
import { InductionForm, VisitorSignInForm, SignOutButton, type WorkerOption } from "../_forms";

export const dynamic = "force-dynamic";

type Params = Promise<{ siteId: string }>;
type SP = Promise<{ saved?: string; error?: string }>;

const SAVED: Record<string, string> = {
  inducted: "Induction recorded.",
  signed_in: "Visitor signed in.",
  signed_out: "Visitor signed out.",
};
const ERRORS: Record<string, string> = {
  not_on_site: "That visitor is not on site.",
  save_failed: "Something went wrong. Try again.",
  bad_id: "Invalid request.",
};

export async function generateMetadata({ params }: { params: Params }) {
  const { siteId } = await params;
  if (!siteIdSchema.safeParse(siteId).success) return { title: "Site compliance · CrewFlow" };
  const { ctx } = await requireOrgContext();
  const supabase = await createClient();
  const site = await loadSiteForOrg<{ name: string }>(
    supabase as unknown as SitesClient,
    ctx.org.id,
    siteId,
    "name",
  );
  return { title: `${site?.name ?? "Site"} compliance · CrewFlow` };
}

export default async function SiteComplianceDetail({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: SP;
}) {
  const { siteId } = await params;
  if (!siteIdSchema.safeParse(siteId).success) notFound();
  const { ctx } = await requireOrgContext();
  const sp = await searchParams;

  const supabase = await createClient();
  const site = await loadSiteForOrg<{ id: string; name: string; kind: string; active: boolean; address_line1: string | null; address_line2: string | null; city: string | null; county: string | null; postcode: string | null; country: string | null }>(
    supabase as unknown as SitesClient,
    ctx.org.id,
    siteId,
    "id, name, kind, active, address_line1, address_line2, city, county, postcode, country",
  );
  if (!site) notFound();

  const [inductions, visitors, muster, staff] = await Promise.all([
    listInductionsForSite(ctx.org.id, siteId),
    listVisitorsForSite(ctx.org.id, siteId),
    buildMusterRoll(ctx.org.id, siteId),
    listStaffForOrg(ctx.org.id).catch(() => [] as WorkerOption[]),
  ]);

  const now = new Date();
  const nameOf = new Map<string, string>();
  for (const s of staff) if (s?.id) nameOf.set(s.id, s.full_name ?? s.email);

  const onSite = visitors.filter((v) => v.signed_out_at == null);
  const address = formatSiteAddress(site);
  const saved = sp.saved ? SAVED[sp.saved] : null;
  const error = sp.error ? (ERRORS[sp.error] ?? "Something went wrong.") : null;

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
            <Link href="/site-compliance" className="hover:text-slate-700">
              Site compliance
            </Link>
          </p>
          <h1 className="mt-0.5 text-2xl font-bold text-slate-900">{site.name}</h1>
          <p className="mt-1 text-sm text-slate-600">
            {siteKindLabel(site.kind)}
            {address ? <> · {address}</> : null}
            {!site.active ? <span className="ml-2 text-amber-700">(retired)</span> : null}
          </p>
        </div>
      </header>

      {saved ? (
        <p className="rounded-md border border-emerald-200 bg-emerald-50 px-4 py-2.5 text-sm text-emerald-800">
          {saved}
        </p>
      ) : null}
      {error ? (
        <p className="rounded-md border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-800">
          {error}
        </p>
      ) : null}

      {/* ── Fire muster ─────────────────────────────────────────────────── */}
      <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold text-slate-900">
              Fire muster · on site now
              <span className="ml-2 rounded-full bg-slate-900 px-2 py-0.5 text-xs font-semibold text-white">
                {muster.presentCount}
              </span>
            </h2>
            <p className="mt-0.5 text-xs text-slate-500">
              Inducted workers currently clocked in, plus signed-in visitors. Generated{" "}
              {muster.generatedAt.slice(11, 16)} UTC.
            </p>
          </div>
          <div className="flex gap-2">
            <a
              href={`/api/site-compliance/${siteId}/muster/pdf`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex min-h-[36px] items-center rounded-md bg-slate-900 px-3 text-xs font-semibold text-white hover:bg-slate-800"
            >
              ⤓ Muster PDF
            </a>
            <a
              href={`/api/site-compliance/${siteId}/muster/csv`}
              className="inline-flex min-h-[36px] items-center rounded-md border border-slate-300 px-3 text-xs font-semibold text-slate-700 hover:bg-slate-50"
            >
              ⤓ CSV
            </a>
          </div>
        </div>
        {muster.presentCount === 0 ? (
          <p className="px-4 py-6 text-sm text-slate-500">
            Nobody is recorded on site right now. A worker appears here when they are inducted for this
            site and clocked in; a visitor appears when signed in.
          </p>
        ) : (
          <Table>
            <THead>
              <TR hover={false}>
                <TH>Name</TH>
                <TH>Type</TH>
                <TH hideBelow="md">Company</TH>
                <TH>On since</TH>
              </TR>
            </THead>
            <TBody>
              {muster.workers.map((w) => (
                <TR key={`w-${w.userId}`}>
                  <TD>{w.name}</TD>
                  <TD muted>Worker</TD>
                  <TD muted hideBelow="md">
                    {w.company ?? "—"}
                  </TD>
                  <TD muted>{w.clockedInAt.slice(11, 16)}</TD>
                </TR>
              ))}
              {muster.visitors.map((v) => (
                <TR key={`v-${v.id}`}>
                  <TD>{v.name}</TD>
                  <TD muted>Visitor</TD>
                  <TD muted hideBelow="md">
                    {v.company ?? "—"}
                  </TD>
                  <TD muted>{v.signedInAt.slice(11, 16)}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </section>

      {/* ── Inductions ──────────────────────────────────────────────────── */}
      <section className="grid gap-6 lg:grid-cols-5">
        <div className="lg:col-span-2">
          <h2 className="text-sm font-semibold text-slate-900">Record an induction</h2>
          <p className="mb-3 mt-0.5 text-xs text-slate-500">
            Gate a worker onto this site. Recorded once per worker per induction version.
          </p>
          <InductionForm siteId={siteId} workers={staff} />
        </div>
        <div className="lg:col-span-3">
          <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
            <h2 className="border-b border-slate-100 px-4 py-3 text-sm font-semibold text-slate-900">
              Inductions
              <span className="ml-2 text-xs font-normal text-slate-500">{inductions.length}</span>
            </h2>
            {inductions.length === 0 ? (
              <p className="px-4 py-6 text-sm text-slate-500">No inductions recorded for this site yet.</p>
            ) : (
              <Table>
                <THead>
                  <TR hover={false}>
                    <TH>Worker</TH>
                    <TH>Version</TH>
                    <TH hideBelow="md">Inducted</TH>
                    <TH>Status</TH>
                  </TR>
                </THead>
                <TBody>
                  {inductions.map((i) => {
                    const current = isInductionCurrent(i, now);
                    const who = i.user_id
                      ? nameOf.get(i.user_id) ?? i.signed_name
                      : `${i.person_name}${i.person_company ? ` · ${i.person_company}` : ""}`;
                    return (
                      <TR key={i.id}>
                        <TD>{who}</TD>
                        <TD muted className="font-mono text-xs">
                          {i.induction_version}
                        </TD>
                        <TD muted hideBelow="md">
                          {i.inducted_at.slice(0, 10)}
                        </TD>
                        <TD>
                          <span
                            className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                              current ? "bg-emerald-100 text-emerald-800" : "bg-amber-100 text-amber-800"
                            }`}
                          >
                            {current ? "Current" : "Expired"}
                          </span>
                        </TD>
                      </TR>
                    );
                  })}
                </TBody>
              </Table>
            )}
          </div>
        </div>
      </section>

      {/* ── Visitors ────────────────────────────────────────────────────── */}
      <section className="grid gap-6 lg:grid-cols-5">
        <div className="lg:col-span-2">
          <h2 className="text-sm font-semibold text-slate-900">Sign a visitor in</h2>
          <p className="mb-3 mt-0.5 text-xs text-slate-500">
            Record an arrival. Sign them out from the on-site list when they leave.
          </p>
          <VisitorSignInForm siteId={siteId} hosts={staff} />
        </div>
        <div className="lg:col-span-3 space-y-4">
          <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
            <h2 className="border-b border-slate-100 px-4 py-3 text-sm font-semibold text-slate-900">
              On site now
              <span className="ml-2 text-xs font-normal text-slate-500">{onSite.length}</span>
            </h2>
            {onSite.length === 0 ? (
              <p className="px-4 py-6 text-sm text-slate-500">No visitors are signed in.</p>
            ) : (
              <Table>
                <THead>
                  <TR hover={false}>
                    <TH>Visitor</TH>
                    <TH hideBelow="md">Company</TH>
                    <TH>In</TH>
                    <TH numeric>Sign out</TH>
                  </TR>
                </THead>
                <TBody>
                  {onSite.map((v) => (
                    <TR key={v.id}>
                      <TD>{v.visitor_name}</TD>
                      <TD muted hideBelow="md">
                        {v.company ?? "—"}
                      </TD>
                      <TD muted>{v.signed_in_at.slice(11, 16)}</TD>
                      <TD numeric>
                        <div className="flex justify-end">
                          <SignOutButton siteId={siteId} visitorId={v.id} />
                        </div>
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
