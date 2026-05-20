import Link from "next/link";
import {
  BookDemoButton,
  BookDemoModal,
} from "./(public)/_book-demo-modal";

/**
 * Landing page.
 *
 * Primary CTA: Book demo (opens the BookDemoModal). Secondary CTA:
 * See CrewFlow in action (scrolls to the feature grid). Everything
 * routes through the modal — no mailto links, no waitlist form.
 */
export default function HomePage() {
  return (
    <main className="flex min-h-screen flex-col bg-white">
      <header className="border-b border-slate-200/70 bg-white/95 backdrop-blur">
        <div className="container flex items-center justify-between py-4">
          <Link href="/" className="flex items-center gap-2">
            <Logo />
            <span className="text-lg font-semibold tracking-tight text-slate-900">
              CrewFlow
            </span>
          </Link>
          <nav className="flex items-center gap-2 sm:gap-4">
            <a
              href="#features"
              className="hidden text-sm font-medium text-slate-700 hover:text-slate-900 sm:inline"
            >
              Features
            </a>
            <Link
              href="/login"
              className="text-sm font-medium text-slate-700 hover:text-slate-900"
            >
              Sign in
            </Link>
            <BookDemoButton size="sm">Book demo</BookDemoButton>
          </nav>
        </div>
      </header>

      {/* Hero */}
      <section className="relative overflow-hidden border-b border-slate-200 bg-gradient-to-b from-slate-50 via-white to-white">
        <div className="container py-20 sm:py-28">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-amber-700">
            For UK construction companies
          </p>
          <h1 className="mt-5 max-w-4xl text-4xl font-bold leading-[1.1] tracking-tight text-slate-900 sm:text-6xl">
            Win more jobs. Cut admin. Know exactly where your money goes.
          </h1>
          <p className="mt-6 max-w-2xl text-lg leading-relaxed text-slate-600 sm:text-xl">
            Everything your construction company needs to run from winning jobs to tracking profit in one place.
          </p>
          <div className="mt-10 flex flex-wrap items-center gap-3">
            <BookDemoButton size="lg">Book demo</BookDemoButton>
            <a
              href="#features"
              className="rounded-md border border-slate-300 bg-white px-6 py-3 text-base font-semibold text-slate-700 shadow-sm transition hover:bg-slate-50"
            >
              See CrewFlow in action
            </a>
          </div>
          <p className="mt-6 text-sm text-slate-500">
            HMRC-compliant invoicing. Bank-transfer payments. Full data migration from your current setup.
          </p>

          {/* Hero stat strip */}
          <div className="mt-14 grid grid-cols-2 gap-6 border-t border-slate-200 pt-10 sm:grid-cols-4">
            <Stat label="Modules" value="11" />
            <Stat label="Tax estimates" value="VAT · Corp · PAYE" />
            <Stat label="Field-ready" value="Mobile first" />
            <Stat label="Migration" value="CSV + Excel" />
          </div>
        </div>
      </section>

      {/* Feature grid */}
      <section id="features" className="container py-20 sm:py-24">
        <div className="max-w-2xl">
          <h2 className="text-3xl font-bold tracking-tight text-slate-900 sm:text-4xl">
            One system. Every part of the business.
          </h2>
          <p className="mt-4 text-lg text-slate-600">
            Most construction software does one thing. CrewFlow does the
            whole loop — from the first phone call to the corporation-tax
            estimate at year end.
          </p>
        </div>

        <div className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          <FeatureCard
            number="01"
            title="Leads"
            body="Capture every enquiry. Source, service, urgency, expected value. Pipeline forecast on the dashboard so you know what&apos;s coming."
          />
          <FeatureCard
            number="02"
            title="Quotes"
            body="Build line-item quotes with VAT, send a branded PDF, customer accepts via portal. Multi-stage approval gating before anything goes out."
          />
          <FeatureCard
            number="03"
            title="Jobs"
            body="Status tracking, photos from the site, customer link, scheduled date, assigned staff. Variation orders captured against the same job."
          />
          <FeatureCard
            number="04"
            title="Staff"
            body="Profiles, hourly pay, employment type, emergency contact. Staff get their own mobile dashboard — your operating system is theirs too."
          />
          <FeatureCard
            number="05"
            title="Rota"
            body="Plan the week. Tie shifts to jobs. Approved leave auto-blocks rota + clock-in so nobody&apos;s double-booked or paid for time off."
          />
          <FeatureCard
            number="06"
            title="Invoices"
            body="HMRC-compliant sequential invoicing. Automatic reminders at day 3 / 7 / 14 / 21. Send via email, download PDF, customer pays by bank transfer."
          />
          <FeatureCard
            number="07"
            title="Payments tracking"
            body="No payment processor. Upload your bank CSV; CrewFlow auto-matches incoming money to invoices by amount + reference + customer. You confirm in one click."
          />
          <FeatureCard
            number="08"
            title="Profitability"
            body="Per-job revenue minus costs minus real labour from staff hours. Green / amber / red margin bands. See which jobs make money before bidding the next one."
          />
          <FeatureCard
            number="09"
            title="Tax"
            body="VAT every quarter, Corporation Tax for the year, PAYE + NI every month. Quarterly audit PDF for your accountant. Estimates, not advice — but always up to date."
          />
          <FeatureCard
            number="10"
            title="Migration OS"
            body="Upload your existing customers, invoices, finances and staff as CSV or Excel. CrewFlow detects, deduplicates, previews, you approve. Rollback in one click if it goes sideways."
          />
          <FeatureCard
            number="11"
            title="AI throughout"
            body="Lead summarisation, weekly activity digests, anomaly flags on the dashboard. AI assists everywhere — never the only thing in the loop."
          />
        </div>
      </section>

      {/* Why-CrewFlow strip */}
      <section className="border-y border-slate-200 bg-slate-50">
        <div className="container py-16">
          <h2 className="text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">
            Built for the way construction companies actually run.
          </h2>
          <div className="mt-8 grid gap-6 md:grid-cols-3">
            <Point
              title="No bank gateway, no fees"
              body="UK trades get paid by bank transfer. CrewFlow tracks the money, doesn&apos;t skim it."
            />
            <Point
              title="Field staff first"
              body="Big tap targets, GPS-stamped clock-in, mobile rota — designed for someone in a transit van, not a CFO."
            />
            <Point
              title="Owner gets the truth"
              body="Real labour cost, real margins, real PAYE owed. No exports to a spreadsheet to find out where the money went."
            />
          </div>
        </div>
      </section>

      {/* Book demo */}
      <section id="book-demo" className="container py-20 sm:py-24">
        <div className="mx-auto max-w-2xl rounded-2xl border border-slate-200 bg-white p-8 shadow-sm sm:p-10">
          <h2 className="text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">
            See it on your own data.
          </h2>
          <p className="mt-3 text-base text-slate-600">
            30 minutes on a call. We will walk through your numbers so you see exactly what CrewFlow would change.
          </p>
          <div className="mt-6 flex flex-wrap gap-3">
            <BookDemoButton size="lg">Book demo</BookDemoButton>
            <a
              href="#features"
              className="rounded-md border border-slate-300 bg-white px-6 py-3 text-base font-semibold text-slate-700 shadow-sm transition hover:bg-slate-50"
            >
              See CrewFlow in action
            </a>
          </div>
        </div>
      </section>

      <footer className="border-t border-slate-200">
        <div className="container flex flex-wrap items-center justify-between gap-4 py-8 text-sm text-slate-500">
          <span>CrewFlow · Belfast, Northern Ireland · hello@crewflow.uk</span>
          <span>© 2026 CrewFlow. Built in Belfast.</span>
        </div>
      </footer>

      <BookDemoModal />
    </main>
  );
}

function Logo() {
  return (
    <svg
      width="32"
      height="32"
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
    >
      <rect width="32" height="32" rx="8" fill="#0F172A" />
      <path
        d="M8 11h16M8 16h12M8 21h8"
        stroke="#fbbf24"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
        {label}
      </div>
      <div className="mt-1 text-lg font-bold text-slate-900">{value}</div>
    </div>
  );
}

function FeatureCard({
  number,
  title,
  body,
}: {
  number: string;
  title: string;
  body: string;
}) {
  return (
    <div className="group relative overflow-hidden rounded-xl border border-slate-200 bg-white p-6 shadow-sm transition hover:shadow-md">
      <div className="text-xs font-semibold uppercase tracking-wide text-amber-700">
        {number}
      </div>
      <h3 className="mt-2 text-xl font-semibold text-slate-900">{title}</h3>
      <p className="mt-2 text-sm leading-relaxed text-slate-600">{body}</p>
    </div>
  );
}

function Point({ title, body }: { title: string; body: string }) {
  return (
    <div>
      <h3 className="text-base font-semibold text-slate-900">{title}</h3>
      <p className="mt-2 text-sm leading-relaxed text-slate-600">{body}</p>
    </div>
  );
}
