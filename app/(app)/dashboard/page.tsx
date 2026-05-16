import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";

/**
 * Owner dashboard.
 *
 * All numbers are derived from the org's actual rows (RLS-scoped via the
 * user-context Supabase client). No mock data.
 *
 * Query approach — we fetch the underlying rows once per entity and
 * compute aggregations in TypeScript. With <1000 rows per org per
 * entity (the MVP-target volume) this stays well under 100 ms and
 * keeps the code easy to follow. When any org crosses ~5000 rows on
 * jobs / invoices / finances, swap the per-section fetches for
 * dedicated SQL counts (`{ count: 'exact', head: true }`) or RPC views.
 *
 * Time windows:
 *   - "this week" = last 7 days rolling
 *   - "this month" = current calendar month
 *   - "this quarter" = current calendar quarter (Jan-Mar, Apr-Jun, ...)
 *
 * UK VAT note: many businesses use VAT staggers (March/June/September
 * or April/July/October) rather than calendar quarters. Calendar
 * quarter is the safe default; a per-org VAT-start-month setting is
 * a follow-up if owners ask.
 */

const GBP = new Intl.NumberFormat("en-GB", {
  style: "currency",
  currency: "GBP",
  minimumFractionDigits: 2,
});

function startOfMonthISO(now = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

function startOfQuarterISO(now = new Date()): string {
  const q = Math.floor(now.getUTCMonth() / 3);
  return new Date(Date.UTC(now.getUTCFullYear(), q * 3, 1)).toISOString();
}

function sevenDaysAgoISO(): string {
  const d = new Date();
  d.setDate(d.getDate() - 7);
  return d.toISOString();
}

const JOB_STATUSES = ["new", "in-progress", "completed", "blocked"] as const;
type JobStatus = (typeof JOB_STATUSES)[number];

const JOB_STATUS_STYLES: Record<JobStatus, string> = {
  new: "bg-blue-100 text-blue-700",
  "in-progress": "bg-amber-100 text-amber-700",
  completed: "bg-green-100 text-green-700",
  blocked: "bg-red-100 text-red-700",
};

const INVOICE_STATUS_STYLES: Record<string, string> = {
  draft: "bg-slate-100 text-slate-700",
  sent: "bg-blue-100 text-blue-700",
  paid: "bg-green-100 text-green-700",
  overdue: "bg-red-100 text-red-700",
};

export default async function DashboardPage() {
  const { user, ctx } = await requireOrgContext();
  const supabase = await createClient();

  const monthStart = startOfMonthISO();
  const quarterStart = startOfQuarterISO();
  const weekStart = sevenDaysAgoISO();

  // Fetch everything in parallel under RLS.
  const [jobsRes, invoicesRes, financesRes, leadsRes, membersRes, quotesRes] =
    await Promise.all([
      supabase
        .from("jobs")
        .select(
          "id, status, scheduled_date, photos, assigned_to, created_at, customer:customers ( id, name )",
        )
        .order("created_at", { ascending: false }),
      supabase
        .from("invoices")
        .select(
          "id, number, status, amount, vat_total, total, due_date, paid_at, created_at",
        )
        .order("created_at", { ascending: false }),
      supabase
        .from("finances")
        .select("id, amount, vat_total, created_at, category")
        .gte("created_at", quarterStart),
      supabase
        .from("leads")
        .select(
          "id, source, urgency, service, postcode, created_at, customer:customers ( id, name )",
        )
        .order("created_at", { ascending: false })
        .limit(5),
      supabase
        .from("memberships")
        .select("user_id, role, user:users ( id, full_name, email )"),
      supabase
        .from("quotes")
        .select("id, status, total, accepted_at, created_at"),
    ]);

  const jobs = jobsRes.data ?? [];
  const invoices = invoicesRes.data ?? [];
  const finances = financesRes.data ?? [];
  const leads = leadsRes.data ?? [];
  const members = membersRes.data ?? [];
  const quotes = quotesRes.data ?? [];

  // First-run state: the org has nothing yet. Show a welcome screen with CTAs.
  if (
    jobs.length === 0 &&
    invoices.length === 0 &&
    finances.length === 0 &&
    quotes.length === 0
  ) {
    return <FirstRun userEmail={user.email ?? ""} orgName={ctx.org.name} />;
  }

  // --- aggregations -------------------------------------------------------
  const jobsByStatus: Record<JobStatus, number> = {
    new: 0,
    "in-progress": 0,
    completed: 0,
    blocked: 0,
  };
  let jobsThisWeek = 0;
  let photosMissing = 0;
  for (const j of jobs) {
    if (JOB_STATUSES.includes(j.status as JobStatus)) {
      jobsByStatus[j.status as JobStatus]++;
    }
    if (j.scheduled_date && j.scheduled_date >= weekStart.slice(0, 10)) {
      jobsThisWeek++;
    }
    // Photos needed = active jobs (in-progress or completed) with no photos.
    if (
      (j.status === "in-progress" || j.status === "completed") &&
      (!j.photos || j.photos.length === 0)
    ) {
      photosMissing++;
    }
  }

  let revenueThisMonth = 0;
  let outstandingCount = 0;
  let outstandingTotal = 0;
  let outputVatQuarter = 0;
  for (const inv of invoices) {
    const total = Number(inv.total ?? 0);
    const vat = Number(inv.vat_total ?? 0);
    if (inv.status === "paid" && inv.paid_at && inv.paid_at >= monthStart) {
      revenueThisMonth += total;
    }
    if (inv.status === "sent" || inv.status === "overdue") {
      outstandingCount++;
      outstandingTotal += total;
    }
    if (inv.status === "paid" && inv.paid_at && inv.paid_at >= quarterStart) {
      outputVatQuarter += vat;
    }
  }

  let inputVatQuarter = 0;
  for (const f of finances) {
    inputVatQuarter += Number(f.vat_total ?? 0);
  }
  const netVatQuarter = outputVatQuarter - inputVatQuarter;

  // ---- quote analytics -------------------------------------------------
  let pendingQuoteCount = 0; // draft / sent / viewed
  let acceptedThisMonthCount = 0;
  let acceptedThisMonthValue = 0;
  let conversionDecided = 0; // accepted + declined
  let conversionAccepted = 0;
  let totalQuoteValue = 0;
  for (const q of quotes) {
    const total = Number(q.total ?? 0);
    totalQuoteValue += total;
    if (q.status === "draft" || q.status === "sent" || q.status === "viewed") {
      pendingQuoteCount++;
    }
    if (q.status === "accepted" || q.status === "declined") {
      conversionDecided++;
      if (q.status === "accepted") conversionAccepted++;
    }
    if (
      q.status === "accepted" &&
      q.accepted_at &&
      q.accepted_at >= monthStart
    ) {
      acceptedThisMonthCount++;
      acceptedThisMonthValue += total;
    }
  }
  const conversionPct =
    conversionDecided === 0
      ? null
      : Math.round((conversionAccepted / conversionDecided) * 100);
  const avgQuoteValue =
    quotes.length === 0 ? 0 : totalQuoteValue / quotes.length;

  // Recent jobs (top 5 from the full fetch).
  const recentJobs = jobs.slice(0, 5);
  const recentInvoices = invoices.slice(0, 5);

  // Staff workload — for each member, count assigned active + completed jobs.
  const staffWorkload = members.map((m) => {
    const userId = m.user?.id;
    if (!userId) return null;
    let active = 0;
    let done = 0;
    for (const j of jobs) {
      if (j.assigned_to !== userId) continue;
      if (j.status === "completed") done++;
      else active++;
    }
    return {
      id: userId,
      name: m.user?.full_name ?? m.user?.email ?? "—",
      role: m.role,
      active,
      done,
    };
  }).filter((s): s is NonNullable<typeof s> => s !== null);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-bold text-slate-900">Dashboard</h1>
        <p className="mt-1 text-sm text-slate-600">
          {ctx.org.name} — overview of your last week.
        </p>
      </header>

      {/* KPI row */}
      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi
          label="Jobs this week"
          value={jobsThisWeek.toString()}
          href="/jobs"
          sub={`${jobs.length} total`}
        />
        <Kpi
          label="Revenue this month"
          value={GBP.format(revenueThisMonth)}
          href="/invoices?status=paid"
          sub="from paid invoices"
        />
        <Kpi
          label="Outstanding"
          value={GBP.format(outstandingTotal)}
          href="/invoices?status=sent"
          sub={`${outstandingCount} ${outstandingCount === 1 ? "invoice" : "invoices"}`}
        />
        <Kpi
          label="VAT this quarter"
          value={GBP.format(netVatQuarter)}
          href="/finances"
          sub={`output ${GBP.format(outputVatQuarter)} − input ${GBP.format(inputVatQuarter)}`}
        />
      </section>

      {/* Quote analytics row */}
      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi
          label="Quote conversion"
          value={conversionPct === null ? "—" : `${conversionPct}%`}
          href="/quotes"
          sub={
            conversionDecided === 0
              ? "no decisions yet"
              : `${conversionAccepted}/${conversionDecided} accepted`
          }
        />
        <Kpi
          label="Pending quotes"
          value={pendingQuoteCount.toString()}
          href="/quotes?status=sent"
          sub="awaiting decision"
        />
        <Kpi
          label="Accepted this month"
          value={GBP.format(acceptedThisMonthValue)}
          href="/quotes?status=accepted"
          sub={`${acceptedThisMonthCount} ${acceptedThisMonthCount === 1 ? "quote" : "quotes"}`}
        />
        <Kpi
          label="Avg quote value"
          value={GBP.format(avgQuoteValue)}
          href="/quotes"
          sub={`across ${quotes.length} ${quotes.length === 1 ? "quote" : "quotes"}`}
        />
      </section>

      {/* Status + photos + staff */}
      <section className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        <Card title="Jobs by status" href="/jobs">
          <ul className="space-y-2">
            {JOB_STATUSES.map((s) => (
              <li key={s} className="flex items-center justify-between text-sm">
                <span
                  className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${JOB_STATUS_STYLES[s]}`}
                >
                  {s}
                </span>
                <span className="font-medium text-slate-900">
                  {jobsByStatus[s]}
                </span>
              </li>
            ))}
          </ul>
        </Card>

        <Card title="Photos missing" href="/jobs">
          <p className="text-3xl font-bold text-slate-900">{photosMissing}</p>
          <p className="mt-2 text-xs text-slate-500">
            In-progress or completed jobs with zero photos. Field staff should
            add before/during/after shots.
          </p>
        </Card>

        <Card title="Staff workload">
          {staffWorkload.length === 0 ? (
            <p className="text-sm text-slate-500">No team members yet.</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {staffWorkload.map((s) => (
                <li key={s.id} className="flex items-center justify-between">
                  <span className="truncate text-slate-700">{s.name}</span>
                  <span className="ml-3 shrink-0 text-xs text-slate-500">
                    <span className="font-medium text-slate-900">{s.active}</span> active ·{" "}
                    <span className="font-medium text-slate-900">{s.done}</span> done
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </section>

      {/* Recent activity */}
      <section className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        <Card title="Recent jobs" href="/jobs">
          {recentJobs.length === 0 ? (
            <p className="text-sm text-slate-500">No jobs yet.</p>
          ) : (
            <ul className="divide-y divide-slate-100 text-sm">
              {recentJobs.map((j) => (
                <li key={j.id} className="flex items-center justify-between py-1.5">
                  <Link
                    href={`/jobs/${j.id}`}
                    className="truncate text-slate-700 hover:text-slate-900"
                  >
                    {j.customer?.name ?? "—"}
                  </Link>
                  <span
                    className={`ml-3 shrink-0 inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${JOB_STATUS_STYLES[j.status as JobStatus] ?? "bg-slate-100 text-slate-700"}`}
                  >
                    {j.status}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Recent invoices" href="/invoices">
          {recentInvoices.length === 0 ? (
            <p className="text-sm text-slate-500">No invoices yet.</p>
          ) : (
            <ul className="divide-y divide-slate-100 text-sm">
              {recentInvoices.map((inv) => (
                <li key={inv.id} className="flex items-center justify-between py-1.5">
                  <Link
                    href={`/invoices/${inv.id}`}
                    className="truncate font-medium text-slate-700 hover:text-slate-900"
                  >
                    {inv.number}
                  </Link>
                  <div className="ml-3 flex shrink-0 items-center gap-2">
                    <span className="text-xs text-slate-500">
                      {GBP.format(Number(inv.total ?? 0))}
                    </span>
                    <span
                      className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${INVOICE_STATUS_STYLES[inv.status] ?? "bg-slate-100 text-slate-700"}`}
                    >
                      {inv.status}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Recent leads">
          {leads.length === 0 ? (
            <p className="text-sm text-slate-500">No leads yet.</p>
          ) : (
            <ul className="divide-y divide-slate-100 text-sm">
              {leads.map((l) => (
                <li key={l.id} className="flex items-center justify-between py-1.5">
                  <div className="min-w-0">
                    <div className="truncate text-slate-700">
                      {l.customer?.name ?? "—"}
                    </div>
                    <div className="truncate text-xs text-slate-500">
                      {l.service ?? "—"}
                    </div>
                  </div>
                  <span className="ml-3 shrink-0 text-xs font-medium text-slate-500">
                    {l.urgency ?? l.source}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </section>
    </div>
  );
}

function Kpi({
  label,
  value,
  sub,
  href,
}: {
  label: string;
  value: string;
  sub?: string;
  href?: string;
}) {
  const body = (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm transition hover:shadow-md">
      <div className="text-xs font-medium uppercase tracking-wide text-slate-500">
        {label}
      </div>
      <div className="mt-2 text-2xl font-bold text-slate-900">{value}</div>
      {sub ? (
        <div className="mt-1 text-xs text-slate-500 truncate">{sub}</div>
      ) : null}
    </div>
  );
  return href ? (
    <Link href={href} className="block">
      {body}
    </Link>
  ) : (
    body
  );
}

function Card({
  title,
  href,
  children,
}: {
  title: string;
  href?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
        {href ? (
          <Link
            href={href}
            className="text-xs font-medium text-slate-500 hover:text-slate-900"
          >
            View all →
          </Link>
        ) : null}
      </div>
      {children}
    </div>
  );
}

function FirstRun({ userEmail, orgName }: { userEmail: string; orgName: string }) {
  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <header>
        <h1 className="text-2xl font-bold text-slate-900">
          Welcome to CrewFlow, {orgName}
        </h1>
        <p className="mt-1 text-sm text-slate-600">
          Signed in as {userEmail}. Let&apos;s get the basics in so you can
          start running jobs.
        </p>
      </header>

      <ol className="space-y-3">
        <FirstRunStep
          n={1}
          title="Add your first customer"
          href="/customers/new"
          cta="Add customer"
        >
          Name, email, phone — that&apos;s enough to start. You can add jobs
          and invoices to them once they exist.
        </FirstRunStep>
        <FirstRunStep
          n={2}
          title="Create your first job"
          href="/jobs/new"
          cta="Create job"
        >
          Pick the customer, assign a staff member, set a status and date.
          Field staff can attach photos later.
        </FirstRunStep>
        <FirstRunStep
          n={3}
          title="Log your first expense"
          href="/finances/new"
          cta="Add finance entry"
        >
          Receipts, materials, fuel, labour. VAT is computed automatically.
        </FirstRunStep>
        <FirstRunStep
          n={4}
          title="Generate your first invoice"
          href="/invoices/new"
          cta="Generate invoice"
        >
          Once you have a quote, generate a sequential HMRC-compliant invoice
          straight from it.
        </FirstRunStep>
      </ol>
    </div>
  );
}

function FirstRunStep({
  n,
  title,
  children,
  href,
  cta,
}: {
  n: number;
  title: string;
  children: React.ReactNode;
  href: string;
  cta: string;
}) {
  return (
    <li className="flex items-start gap-4 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-900 text-sm font-semibold text-white">
        {n}
      </span>
      <div className="flex-1">
        <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
        <p className="mt-1 text-xs text-slate-600">{children}</p>
      </div>
      <Link
        href={href}
        className="shrink-0 rounded-md bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white shadow-sm transition hover:bg-slate-800"
      >
        {cta}
      </Link>
    </li>
  );
}
