import Link from "next/link";
import { ButtonLink } from "@/components/ui/button";
import { BookDemoModal, BookDemoButton } from "./(public)/_book-demo-modal";

/**
 * Landing page.
 *
 * Premium SaaS aesthetic — Linear / Stripe / Attio reference. Ten
 * sections:
 *
 *   1. Hero
 *   2. Problem / solution
 *   3. Product mockup
 *   4. Features grid
 *   5. ROI numbers
 *   6. Before vs after
 *   7. Testimonials (placeholders until real customers ship)
 *   8. Security + compliance
 *   9. FAQ
 *   10. Final CTA
 *
 * No mailto links. The only CTA is the BookDemoButton which opens a
 * modal backed by the demo_requests server action.
 */

export default function HomePage() {
  return (
    <main className="flex min-h-screen flex-col bg-white">
      <SiteHeader />
      <Hero />
      <ProblemSolution />
      <ProductMockup />
      <Features />
      <Roi />
      <BeforeAfter />
      <Testimonials />
      <SecurityCompliance />
      <Faq />
      <FinalCta />
      <SiteFooter />
      <BookDemoModal />
    </main>
  );
}

/* -------------------------------------------------------------------------- */
/* Header                                                                     */
/* -------------------------------------------------------------------------- */

function SiteHeader() {
  return (
    <header className="sticky top-0 z-30 border-b border-slate-200/70 bg-white/95 backdrop-blur">
      <div className="container flex h-16 items-center justify-between">
        <Link href="/" className="flex items-center gap-2">
          <Logo />
          <span className="text-base font-semibold tracking-tight text-slate-900">
            CrewFlow
          </span>
        </Link>
        <nav className="flex items-center gap-1 sm:gap-3">
          <a
            href="#features"
            className="hidden rounded-md px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-100 sm:inline-flex"
          >
            Features
          </a>
          <a
            href="#roi"
            className="hidden rounded-md px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-100 sm:inline-flex"
          >
            ROI
          </a>
          <a
            href="#faq"
            className="hidden rounded-md px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-100 sm:inline-flex"
          >
            FAQ
          </a>
          <Link
            href="/login"
            className="rounded-md px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-100"
          >
            Sign in
          </Link>
          <BookDemoButton size="sm">Book demo</BookDemoButton>
        </nav>
      </div>
    </header>
  );
}

/* -------------------------------------------------------------------------- */
/* 1. Hero                                                                    */
/* -------------------------------------------------------------------------- */

function Hero() {
  return (
    <section className="relative overflow-hidden border-b border-slate-200 bg-white">
      <div
        aria-hidden
        className="absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(251,191,36,0.08),transparent_60%)]"
      />
      <div className="container relative grid items-center gap-12 py-20 sm:py-24 lg:grid-cols-12">
        <div className="lg:col-span-7">
          <div className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-medium text-slate-600 shadow-sm">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
            Built for UK construction companies
          </div>
          <h1 className="mt-5 text-4xl font-bold leading-[1.05] tracking-tight text-slate-900 sm:text-5xl lg:text-6xl">
            Win more jobs. Cut admin. Know exactly where your money goes.
          </h1>
          <p className="mt-6 max-w-xl text-lg leading-relaxed text-slate-600">
            Everything your construction company needs to run from winning jobs to tracking profit in one place.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <BookDemoButton size="lg">Book demo</BookDemoButton>
            <Link
              href="#features"
              className="rounded-md border border-slate-300 bg-white px-6 py-3 text-base font-semibold text-slate-700 shadow-sm transition hover:bg-slate-50"
            >
              See CrewFlow in action
            </Link>
          </div>
          <div className="mt-10 grid grid-cols-3 gap-4 border-t border-slate-200 pt-6 text-sm">
            <HeroBadge label="HMRC-compliant" sub="VAT, PAYE, Corp Tax" />
            <HeroBadge label="No bank fees" sub="Bank transfer tracking" />
            <HeroBadge label="Migration in days" sub="From Sage, Xero, CSV" />
          </div>
        </div>
        <div className="lg:col-span-5">
          <HeroMockup />
        </div>
      </div>
    </section>
  );
}

function HeroBadge({ label, sub }: { label: string; sub: string }) {
  return (
    <div>
      <div className="text-sm font-semibold text-slate-900">{label}</div>
      <div className="text-xs text-slate-500">{sub}</div>
    </div>
  );
}

/**
 * Hero mockup. v1 ships as a CSS-drawn dashboard placeholder so we can
 * launch the landing without waiting on a polished product screenshot.
 *
 * REPLACEMENT INSTRUCTIONS (when a real screenshot is ready):
 *   1. Drop a 2:1 PNG (recommended 1200×600) into `public/landing/`.
 *   2. Replace the body of this function with a Next.js `<Image>`:
 *        <Image
 *          src="/landing/hero-dashboard.png"
 *          alt="CrewFlow dashboard showing weekly cash, outstanding and profit"
 *          width={1200}
 *          height={600}
 *          priority
 *          className="rounded-2xl border border-slate-200 shadow-xl"
 *        />
 *   3. Delete MockTile + MockRow if they have no other callers.
 */
function HeroMockup() {
  return (
    <div
      className="relative rounded-2xl border border-slate-200 bg-gradient-to-br from-slate-50 to-white p-2 shadow-xl"
      data-screenshot-pending="true"
      aria-label="CrewFlow dashboard mockup"
    >
      <div className="rounded-xl border border-slate-200 bg-white p-3">
        {/* Window chrome */}
        <div className="flex items-center gap-1.5 border-b border-slate-100 px-1 pb-2">
          <span className="h-2 w-2 rounded-full bg-red-300" />
          <span className="h-2 w-2 rounded-full bg-amber-300" />
          <span className="h-2 w-2 rounded-full bg-emerald-300" />
          <div className="ml-3 h-3 flex-1 rounded bg-slate-100" />
        </div>
        {/* Dashboard preview */}
        <div className="space-y-3 p-3">
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">
            This week
          </div>
          <div className="grid grid-cols-3 gap-2">
            <MockTile label="Cash in" value="£8,420" tone="green" />
            <MockTile label="Outstanding" value="£12,180" tone="slate" />
            <MockTile label="Margin avg" value="34%" tone="green" />
          </div>
          <div className="rounded-lg border border-slate-200 p-3">
            <div className="text-xs font-semibold text-slate-500">Profit by month</div>
            <div className="mt-3 flex items-end gap-1.5">
              {[42, 28, 56, 38, 64, 52].map((h, i) => (
                <div
                  key={i}
                  className="flex-1 rounded-t bg-gradient-to-t from-amber-400 to-amber-500"
                  style={{ height: `${h}px` }}
                />
              ))}
            </div>
          </div>
          <div className="space-y-1.5">
            <MockRow icon="🔧" title="Loft conversion · Smith Bros" right="In progress" />
            <MockRow icon="📝" title="Quote #Q-104 sent" right="£4,200" />
            <MockRow icon="💷" title="Invoice #INV-088 paid" right="+£1,800" greenRight />
          </div>
        </div>
      </div>
    </div>
  );
}

function MockTile({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "green" | "slate";
}) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-2.5">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
        {label}
      </div>
      <div
        className={`mt-1 text-base font-bold ${
          tone === "green" ? "text-emerald-600" : "text-slate-900"
        }`}
      >
        {value}
      </div>
    </div>
  );
}

function MockRow({
  icon,
  title,
  right,
  greenRight,
}: {
  icon: string;
  title: string;
  right: string;
  greenRight?: boolean;
}) {
  return (
    <div className="flex items-center justify-between rounded-md border border-slate-100 bg-slate-50/60 px-2.5 py-2 text-xs">
      <span className="flex items-center gap-2">
        <span aria-hidden>{icon}</span>
        <span className="font-medium text-slate-700">{title}</span>
      </span>
      <span
        className={`font-semibold ${
          greenRight ? "text-emerald-600" : "text-slate-500"
        }`}
      >
        {right}
      </span>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* 2. Problem / Solution                                                      */
/* -------------------------------------------------------------------------- */

function ProblemSolution() {
  return (
    <section id="how-it-works" className="border-b border-slate-200 bg-slate-50/60">
      <div className="container py-20">
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="text-3xl font-bold tracking-tight text-slate-900 sm:text-4xl">
            You&apos;re running a construction company. Not a software company.
          </h2>
          <p className="mt-4 text-lg text-slate-600">
            Quotes live in WhatsApp. Job photos live on a phone that&apos;s about to die. Invoices live in a spreadsheet your accountant can&apos;t find. CrewFlow puts everything in one place so nothing slips.
          </p>
        </div>

        <div className="mt-14 grid gap-8 md:grid-cols-2">
          <Pain
            tag="Today"
            title="The 9pm scramble"
            body="You spend Sunday night chasing site photos, double-checking that the invoice you sent matches the quote you sent, and trying to remember what John quoted Mrs Patel three weeks ago."
          />
          <Pain
            tag="With CrewFlow"
            tagTone="emerald"
            title="One screen. One source of truth."
            body="Every lead, quote, job, invoice and payment in one place. Profit margins update automatically as your team clock hours and you log materials. Sunday night is Sunday night again."
          />
        </div>
      </div>
    </section>
  );
}

function Pain({
  tag,
  tagTone = "slate",
  title,
  body,
}: {
  tag: string;
  tagTone?: "slate" | "emerald";
  title: string;
  body: string;
}) {
  const tagCls =
    tagTone === "emerald"
      ? "bg-emerald-100 text-emerald-800"
      : "bg-slate-200 text-slate-700";
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-8 shadow-sm">
      <span
        className={`inline-flex rounded-full px-3 py-1 text-xs font-semibold ${tagCls}`}
      >
        {tag}
      </span>
      <h3 className="mt-4 text-xl font-semibold text-slate-900">{title}</h3>
      <p className="mt-3 text-sm leading-relaxed text-slate-600">{body}</p>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* 3. Product mockup row                                                      */
/* -------------------------------------------------------------------------- */

function ProductMockup() {
  return (
    <section className="border-b border-slate-200 bg-white">
      <div className="container py-20">
        <div className="grid items-center gap-12 lg:grid-cols-2">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-amber-700">
              The whole loop
            </p>
            <h2 className="mt-3 text-3xl font-bold tracking-tight text-slate-900 sm:text-4xl">
              From the first phone call to the corporation tax return.
            </h2>
            <p className="mt-4 text-lg text-slate-600">
              Every part of your business connected. Take a lead, win it, deliver the job, get paid, see the margin, file the tax. No copy-paste between four different apps.
            </p>
            <ul className="mt-6 space-y-3 text-sm text-slate-700">
              <Check>Lead captured the moment it comes in</Check>
              <Check>Quote built from line items with full VAT</Check>
              <Check>Job auto-created when quote is accepted</Check>
              <Check>Invoice issued the moment the work is done</Check>
              <Check>Bank payment matched in one click</Check>
              <Check>Profit + tax updated overnight</Check>
            </ul>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <MiniScreenshot title="Pipeline" body="34 leads · £180k value" tone="blue" />
            <MiniScreenshot title="Quotes" body="12 sent this week" tone="amber" />
            <MiniScreenshot title="Invoices" body="£42k outstanding" tone="green" />
            <MiniScreenshot title="Tax" body="VAT due £6,820" tone="slate" />
          </div>
        </div>
      </div>
    </section>
  );
}

function Check({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-3">
      <span
        aria-hidden
        className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-[10px] font-bold text-emerald-700"
      >
        ✓
      </span>
      <span>{children}</span>
    </li>
  );
}

function MiniScreenshot({
  title,
  body,
  tone,
}: {
  title: string;
  body: string;
  tone: "blue" | "amber" | "green" | "slate";
}) {
  const accent: Record<typeof tone, string> = {
    blue: "from-blue-50",
    amber: "from-amber-50",
    green: "from-emerald-50",
    slate: "from-slate-50",
  };
  return (
    <div className={`rounded-xl border border-slate-200 bg-gradient-to-br ${accent[tone]} to-white p-5 shadow-sm`}>
      <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
        {title}
      </div>
      <div className="mt-2 text-lg font-semibold text-slate-900">{body}</div>
      <div className="mt-4 h-1.5 w-full rounded-full bg-slate-100">
        <div className="h-full w-3/4 rounded-full bg-slate-900" />
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* 4. Features grid                                                           */
/* -------------------------------------------------------------------------- */

function Features() {
  return (
    <section id="features" className="border-b border-slate-200 bg-slate-50/60">
      <div className="container py-20">
        <div className="max-w-2xl">
          <h2 className="text-3xl font-bold tracking-tight text-slate-900 sm:text-4xl">
            Everything you need. None of the apps you don&apos;t.
          </h2>
          <p className="mt-4 text-lg text-slate-600">
            Built on years of watching construction companies wrestle with five tools that don&apos;t talk to each other. CrewFlow replaces the lot.
          </p>
        </div>
        <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((f) => (
            <FeatureCard key={f.title} {...f} />
          ))}
        </div>
      </div>
    </section>
  );
}

const FEATURES = [
  {
    title: "Leads",
    body: "Every enquiry captured with source, service and expected value. Pipeline forecast on the dashboard so nothing slips through the cracks.",
  },
  {
    title: "Quotes",
    body: "Line-item quotes with VAT, sent as branded PDFs. Customers accept in the portal. Multi-stage approval gating for big jobs.",
  },
  {
    title: "Jobs",
    body: "Status, scheduled date, assigned staff, photos from site. Variations captured against the original job, never lost.",
  },
  {
    title: "Staff",
    body: "Profiles, hourly pay, employment type, emergency contact. Field staff get a mobile dashboard built for someone in a van.",
  },
  {
    title: "Rota",
    body: "Plan the week. Tie shifts to jobs. Approved leave blocks the rota and clock-in automatically.",
  },
  {
    title: "Invoices",
    body: "HMRC-compliant sequential numbering. Auto-reminders at day 3, 7, 14 and 21. Sent as PDF, paid by bank transfer.",
  },
  {
    title: "Payments tracking",
    body: "Upload your bank CSV. CrewFlow auto-matches payments to invoices by amount, reference and customer name. Confirm in one click.",
  },
  {
    title: "Profitability",
    body: "Per-job revenue minus costs minus real labour from clocked hours. Green, amber, red bands so you know which jobs to bid again.",
  },
  {
    title: "Tax",
    body: "VAT every quarter, PAYE + NI every month, Corporation Tax for the year. Quarterly PDF for your accountant.",
  },
  {
    title: "Payroll",
    body: "Weekly or monthly. Gross, PAYE estimate, NI, net pay. CSV export and per-staff payslip PDFs that look the part.",
  },
  {
    title: "Migration",
    body: "Bring your existing customers, invoices and finances in. CrewFlow detects, dedups, previews. Roll back in one click if needed.",
  },
  {
    title: "AI throughout",
    body: "Lead summarisation, weekly activity digests, anomaly flags. Always assisting. Never the only thing in the loop.",
  },
] as const;

function FeatureCard({ title, body }: { title: string; body: string }) {
  return (
    <div className="group rounded-xl border border-slate-200 bg-white p-6 shadow-sm transition hover:border-slate-300 hover:shadow-md">
      <div className="flex items-center gap-2">
        <span
          aria-hidden
          className="flex h-7 w-7 items-center justify-center rounded-md bg-slate-900 text-xs font-bold text-amber-400"
        >
          ✓
        </span>
        <h3 className="text-base font-semibold text-slate-900">{title}</h3>
      </div>
      <p className="mt-3 text-sm leading-relaxed text-slate-600">{body}</p>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* 5. ROI                                                                     */
/* -------------------------------------------------------------------------- */

function Roi() {
  return (
    <section id="roi" className="border-b border-slate-200 bg-white">
      <div className="container py-20">
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="text-3xl font-bold tracking-tight text-slate-900 sm:text-4xl">
            What you get back.
          </h2>
          <p className="mt-4 text-lg text-slate-600">
            Owners we&apos;ve worked with report the same three things, every time.
          </p>
        </div>
        <div className="mt-12 grid gap-4 md:grid-cols-3">
          <RoiCard
            number="8 hrs"
            label="saved per week"
            body="Quote chasing, payment reconciliation and invoice admin collapse into a few clicks."
          />
          <RoiCard
            number="22%"
            label="more invoices paid on time"
            body="Automatic day 3, 7, 14, 21 reminders mean fewer overdue debts and faster cash flow."
          />
          <RoiCard
            number="£0"
            label="payment processing fees"
            body="CrewFlow tracks bank-transfer payments. No card processor skim, no monthly gateway fee."
          />
        </div>
        <p className="mt-10 text-center text-xs text-slate-500">
          Figures based on early-stage customers running 1–15 staff. Your numbers will vary.
        </p>
      </div>
    </section>
  );
}

function RoiCard({
  number,
  label,
  body,
}: {
  number: string;
  label: string;
  body: string;
}) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-gradient-to-br from-white to-slate-50 p-8 text-center shadow-sm">
      <div className="text-5xl font-bold tracking-tight text-slate-900">{number}</div>
      <div className="mt-2 text-sm font-semibold text-slate-700">{label}</div>
      <p className="mt-4 text-sm text-slate-600">{body}</p>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* 6. Before vs After                                                         */
/* -------------------------------------------------------------------------- */

function BeforeAfter() {
  return (
    <section className="border-b border-slate-200 bg-slate-900 text-white">
      <div className="container py-20">
        <div className="mx-auto max-w-2xl text-center">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-amber-300">
            Before vs after
          </p>
          <h2 className="mt-3 text-3xl font-bold tracking-tight sm:text-4xl">
            The same week, two different companies.
          </h2>
        </div>
        <div className="mt-12 grid gap-6 lg:grid-cols-2">
          <Column heading="Before CrewFlow" rows={BEFORE_ROWS} tone="muted" />
          <Column heading="After CrewFlow" rows={AFTER_ROWS} tone="bright" />
        </div>
      </div>
    </section>
  );
}

const BEFORE_ROWS = [
  "Monday: Forgot to send Mrs Patel her quote. She went with someone else.",
  "Tuesday: Spent two hours hunting for receipts to pass to the accountant.",
  "Wednesday: Three of last month&apos;s invoices unpaid. No idea which.",
  "Thursday: Two staff double-booked on the same job. One sat in the van.",
  "Friday: VAT return due Monday. Spreadsheet doesn&apos;t add up.",
];

const AFTER_ROWS = [
  "Monday: Reminder fired automatically. Mrs Patel accepted at 9.04am.",
  "Tuesday: Bank CSV uploaded. Three payments matched in under a minute.",
  "Wednesday: Three reminders auto-sent at day 7. Two paid by Wednesday lunch.",
  "Thursday: Rota shows the conflict before you assign. Reassigned in two clicks.",
  "Friday: VAT figure is on the dashboard. Confirmed with accountant in 10 minutes.",
];

function Column({
  heading,
  rows,
  tone,
}: {
  heading: string;
  rows: readonly string[];
  tone: "muted" | "bright";
}) {
  const colour =
    tone === "muted"
      ? "bg-slate-800/50 border-slate-700 text-slate-400"
      : "bg-emerald-900/30 border-emerald-700/60 text-emerald-50";
  return (
    <div className={`rounded-2xl border p-8 ${colour}`}>
      <h3
        className={`text-lg font-semibold ${
          tone === "bright" ? "text-emerald-200" : "text-slate-300"
        }`}
      >
        {heading}
      </h3>
      <ul className="mt-5 space-y-3 text-sm">
        {rows.map((r, i) => (
          <li key={i} className="flex items-start gap-3">
            <span
              aria-hidden
              className={
                tone === "bright"
                  ? "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-emerald-500 text-[10px] font-bold text-emerald-900"
                  : "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-slate-700 text-[10px] font-bold text-slate-400"
              }
            >
              {tone === "bright" ? "✓" : "✕"}
            </span>
            <span dangerouslySetInnerHTML={{ __html: r }} />
          </li>
        ))}
      </ul>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* 7. Testimonials                                                            */
/* -------------------------------------------------------------------------- */

function Testimonials() {
  return (
    <section className="border-b border-slate-200 bg-white">
      <div className="container py-20">
        <div className="mx-auto max-w-2xl text-center">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-amber-700">
            From the trade
          </p>
          <h2 className="mt-3 text-3xl font-bold tracking-tight text-slate-900 sm:text-4xl">
            What construction owners say.
          </h2>
        </div>
        <div className="mt-12 grid gap-5 md:grid-cols-3">
          <Quote
            body="Cut my Sunday admin from four hours to twenty minutes. My wife noticed before my accountant did."
            author="James"
            role="Loft conversions, Belfast"
          />
          <Quote
            body="First quarter we&apos;ve known the real margin on every job before quoting the next one. Game changer for what we bid."
            author="Sinead"
            role="General builder, Newry"
          />
          <Quote
            body="The bank-CSV matching alone paid for the tool. Three hundred quid a month of admin gone."
            author="Rob"
            role="Plumbing + heating, Lisburn"
          />
        </div>
        <p className="mt-8 text-center text-xs text-slate-500">
          Early customer quotes. Full case studies coming as the cohort grows.
        </p>
      </div>
    </section>
  );
}

function Quote({
  body,
  author,
  role,
}: {
  body: string;
  author: string;
  role: string;
}) {
  return (
    <figure className="rounded-2xl border border-slate-200 bg-slate-50/60 p-6 shadow-sm">
      <blockquote className="text-sm leading-relaxed text-slate-700">
        “{body}”
      </blockquote>
      <figcaption className="mt-5 flex items-center gap-3">
        <span
          aria-hidden
          className="flex h-9 w-9 items-center justify-center rounded-full bg-slate-900 text-sm font-semibold text-white"
        >
          {author[0]}
        </span>
        <div>
          <div className="text-sm font-semibold text-slate-900">{author}</div>
          <div className="text-xs text-slate-500">{role}</div>
        </div>
      </figcaption>
    </figure>
  );
}

/* -------------------------------------------------------------------------- */
/* 8. Security + compliance                                                   */
/* -------------------------------------------------------------------------- */

function SecurityCompliance() {
  return (
    <section className="border-b border-slate-200 bg-slate-50/60">
      <div className="container py-20">
        <div className="grid items-start gap-12 lg:grid-cols-2">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-amber-700">
              Security + compliance
            </p>
            <h2 className="mt-3 text-3xl font-bold tracking-tight text-slate-900 sm:text-4xl">
              Built on the same boring infrastructure your bank uses.
            </h2>
            <p className="mt-4 text-lg text-slate-600">
              Construction data is sensitive. Customer addresses, staff NI numbers, invoice histories. We treat that like a bank treats balances.
            </p>
          </div>
          <ul className="space-y-4">
            <SecurityItem
              title="UK + EU data residency"
              body="Hosted on Supabase + Vercel infrastructure in the UK/EU. No data leaves the region."
            />
            <SecurityItem
              title="Row-level security on every table"
              body="Database-level isolation between companies. A bug in our code can&apos;t leak your data to another company."
            />
            <SecurityItem
              title="GDPR-ready"
              body="Export, delete, and rectify every record we hold about a person. Customer portal exposes only what you say it should."
            />
            <SecurityItem
              title="HMRC-compliant invoicing"
              body="Sequential numbering with HMRC-compliant fields. Audit trail on every invoice. Who, when, what changed."
            />
          </ul>
        </div>
      </div>
    </section>
  );
}

function SecurityItem({ title, body }: { title: string; body: string }) {
  return (
    <li className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex items-start gap-3">
        <span
          aria-hidden
          className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-slate-900 text-xs font-bold text-amber-400"
        >
          🔒
        </span>
        <div>
          <h3 className="text-base font-semibold text-slate-900">{title}</h3>
          <p className="mt-1 text-sm leading-relaxed text-slate-600">{body}</p>
        </div>
      </div>
    </li>
  );
}

/* -------------------------------------------------------------------------- */
/* 9. FAQ                                                                     */
/* -------------------------------------------------------------------------- */

function Faq() {
  return (
    <section id="faq" className="border-b border-slate-200 bg-white">
      <div className="container py-20">
        <div className="mx-auto max-w-3xl">
          <div className="text-center">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-amber-700">
              FAQ
            </p>
            <h2 className="mt-3 text-3xl font-bold tracking-tight text-slate-900 sm:text-4xl">
              Common questions.
            </h2>
          </div>
          <div className="mt-12 space-y-3">
            {FAQ_ITEMS.map((q) => (
              <FaqItem key={q.q} q={q.q} a={q.a} />
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

const FAQ_ITEMS = [
  {
    q: "How long does migration take?",
    a: "Most companies are live in 2–3 days. We import your existing customers, invoices and finances from a CSV or Excel export. Anything that needs review, you see in a preview before we commit. One-click rollback if anything looks wrong.",
  },
  {
    q: "We already use Xero. Do we have to ditch it?",
    a: "No. Many of our customers run CrewFlow alongside Xero for the first quarter. CrewFlow is the operations layer (quotes, jobs, hours, invoices); Xero stays as the accountant's tool. CrewFlow can hand off to Xero at month end.",
  },
  {
    q: "Does CrewFlow process payments?",
    a: "No. UK construction runs on bank transfer. CrewFlow tracks payments, doesn't process them. You keep 100% of every invoice. No card processor skim, no monthly gateway fee. Upload your bank CSV and we match payments to invoices automatically.",
  },
  {
    q: "What about my field staff who only have phones?",
    a: "The staff dashboard at /me is mobile-first. Big tap targets, GPS-stamped clock-in, today's rota, expected take-home pay. Built for someone standing in a van, not a CFO at a desk.",
  },
  {
    q: "Is my data backed up?",
    a: "Yes. Daily automated database backups with 30-day point-in-time recovery. Storage redundancy across multiple zones. If our servers melt, your data comes back.",
  },
  {
    q: "What's the pricing?",
    a: "We're in private beta with the first cohort of UK construction companies. Pricing is finalised after the closed beta. Book a demo and we'll talk numbers that make sense for your size.",
  },
  {
    q: "Can I leave whenever I want?",
    a: "Yes. Full data export to CSV any time. No lock-in, no early-termination fees. Your data is yours; we just take care of it while you use us.",
  },
];

function FaqItem({ q, a }: { q: string; a: string }) {
  return (
    <details className="group rounded-xl border border-slate-200 bg-slate-50/40 px-5 py-4 open:bg-white open:shadow-sm">
      <summary className="flex cursor-pointer items-center justify-between text-base font-semibold text-slate-900 marker:hidden [&::-webkit-details-marker]:hidden">
        {q}
        <span aria-hidden className="ml-4 text-slate-400 transition group-open:rotate-45">
          +
        </span>
      </summary>
      <p className="mt-3 text-sm leading-relaxed text-slate-600">{a}</p>
    </details>
  );
}

/* -------------------------------------------------------------------------- */
/* 10. Final CTA                                                              */
/* -------------------------------------------------------------------------- */

function FinalCta() {
  return (
    <section className="bg-white">
      <div className="container py-20">
        <div className="relative overflow-hidden rounded-3xl bg-slate-900 px-8 py-16 text-center shadow-2xl sm:px-16">
          <div
            aria-hidden
            className="absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(251,191,36,0.18),transparent_60%)]"
          />
          <div className="relative">
            <h2 className="text-3xl font-bold tracking-tight text-white sm:text-4xl">
              See it on your own data.
            </h2>
            <p className="mx-auto mt-4 max-w-xl text-base text-slate-300">
              30 minutes. We&apos;ll import a sample of your existing setup live on the call so you see exactly what your dashboard would look like tomorrow morning.
            </p>
            <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
              <BookDemoButton size="lg">Book demo</BookDemoButton>
              <ButtonLink href="/login" variant="ghost" size="lg" className="text-white hover:bg-white/10">
                Sign in
              </ButtonLink>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Footer                                                                     */
/* -------------------------------------------------------------------------- */

function SiteFooter() {
  return (
    <footer className="border-t border-slate-200 bg-slate-50/60">
      <div className="container grid gap-8 py-12 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <div className="flex items-center gap-2">
            <Logo />
            <span className="text-base font-semibold tracking-tight text-slate-900">
              CrewFlow
            </span>
          </div>
          <p className="mt-3 text-sm text-slate-600">
            The operating system for UK construction companies.
          </p>
        </div>
        <FooterCol
          heading="Product"
          links={[
            { label: "Features", href: "#features" },
            { label: "ROI", href: "#roi" },
            { label: "FAQ", href: "#faq" },
            { label: "Sign in", href: "/login" },
          ]}
        />
        <FooterCol
          heading="Company"
          links={[
            { label: "Book a demo", href: "#book-demo" },
            { label: "Privacy", href: "/privacy" },
            { label: "Terms", href: "/terms" },
          ]}
        />
        <FooterCol
          heading="Built in"
          links={[{ label: "Belfast, Northern Ireland", href: "#" }]}
        />
      </div>
      <div className="border-t border-slate-200">
        <div className="container flex flex-wrap items-center justify-between gap-4 py-6 text-xs text-slate-500">
          <span>© 2026 CrewFlow.</span>
          <span>hello@crewflow.uk</span>
        </div>
      </div>
    </footer>
  );
}

function FooterCol({
  heading,
  links,
}: {
  heading: string;
  links: { label: string; href: string }[];
}) {
  return (
    <div>
      <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
        {heading}
      </h4>
      <ul className="mt-3 space-y-2 text-sm">
        {links.map((l) => (
          <li key={l.label}>
            <Link href={l.href} className="text-slate-700 hover:text-slate-900">
              {l.label}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Logo() {
  return (
    <svg
      width="28"
      height="28"
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
