import Link from "next/link";
import Image from "next/image";
import fs from "node:fs";
import path from "node:path";
import type { ReactNode } from "react";
import { BookDemoModal } from "./(public)/_book-demo-modal";
import { BookDemoCta } from "./_marketing/cta";
import { MotionProvider, Reveal, CountUp } from "./_marketing/motion";
import "./_marketing/marketing.css";

/**
 * CrewFlow marketing homepage — premium dark theme.
 *
 * SAFETY / CONTRACTS PRESERVED:
 * - Demo funnel: <BookDemoCta> dispatches the exact `crewflow:open-book-demo`
 *   event the unchanged <BookDemoModal> listens for → /api/demo untouched.
 * - "Start setup" / "Sign in" → /login (unchanged route).
 * - Hero screenshot drop-in: drop a 2:1 image at public/landing/hero-dashboard.*
 *   and it replaces the CSS dashboard automatically (no code change).
 * - All styling is scoped under `.mkt-page` (see marketing.css); nothing leaks
 *   into the app/dashboard/auth/portal routes.
 */

const HERO_CANDIDATES = [
  "/landing/hero-dashboard.webp",
  "/landing/hero-dashboard.png",
  "/landing/hero-dashboard.jpg",
] as const;

function resolveHeroImage(): string | null {
  for (const rel of HERO_CANDIDATES) {
    try {
      const full = path.join(process.cwd(), "public", rel);
      if (fs.existsSync(full)) return rel;
    } catch {
      // ignore fs errors in restricted runtimes
    }
  }
  return null;
}

const HERO_IMAGE_SRC: string | null = resolveHeroImage();

/* -------------------------------------------------------------------------- */
/* Icons (hand-rolled, currentColor, sized by prop or scoped CSS)             */
/* -------------------------------------------------------------------------- */

function Svg({ size = 18, children }: { size?: number; children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {children}
    </svg>
  );
}

type IconProps = { size?: number };

const IconDashboard = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="3" width="7" height="9" />
    <rect x="14" y="3" width="7" height="5" />
    <rect x="14" y="12" width="7" height="9" />
    <rect x="3" y="16" width="7" height="5" />
  </Svg>
);
const IconPhone = (p: IconProps) => (
  <Svg {...p}>
    <path d="M22 16.92v3a2 2 0 0 1-2.18 2A19.79 19.79 0 0 1 3.08 5 2 2 0 0 1 5 3h3" />
  </Svg>
);
const IconPhoneMissed = (p: IconProps) => (
  <Svg {...p}>
    <path d="M22 16.92v3a2 2 0 0 1-2.18 2A19.79 19.79 0 0 1 3.08 5 2 2 0 0 1 5 3h3" />
    <line x1="2" y1="2" x2="22" y2="22" />
  </Svg>
);
const IconFile = (p: IconProps) => (
  <Svg {...p}>
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <path d="M14 2v6h6" />
  </Svg>
);
const IconFileLines = (p: IconProps) => (
  <Svg {...p}>
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <path d="M14 2v6h6" />
    <line x1="12" y1="18" x2="12" y2="12" />
    <line x1="9" y1="15" x2="15" y2="15" />
  </Svg>
);
const IconJobs = (p: IconProps) => (
  <Svg {...p}>
    <rect x="2" y="7" width="20" height="14" rx="2" />
    <path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2" />
  </Svg>
);
const IconUsers = (p: IconProps) => (
  <Svg {...p}>
    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
    <circle cx="9" cy="7" r="4" />
    <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
  </Svg>
);
const IconPound = (p: IconProps) => (
  <Svg {...p}>
    <line x1="12" y1="1" x2="12" y2="23" />
    <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
  </Svg>
);
const IconMessage = (p: IconProps) => (
  <Svg {...p}>
    <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8z" />
  </Svg>
);
const IconTruck = (p: IconProps) => (
  <Svg {...p}>
    <rect x="1" y="3" width="15" height="13" />
    <path d="M16 8h4l3 3v5h-7z" />
    <circle cx="5.5" cy="18.5" r="2.5" />
    <circle cx="18.5" cy="18.5" r="2.5" />
  </Svg>
);
const IconClock = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="10" />
    <polyline points="12 6 12 12 16 14" />
  </Svg>
);
const IconTrendingUp = (p: IconProps) => (
  <Svg {...p}>
    <polyline points="23 6 13.5 15.5 8.5 10.5 1 18" />
    <polyline points="17 6 23 6 23 12" />
  </Svg>
);
const IconTrendingDown = (p: IconProps) => (
  <Svg {...p}>
    <polyline points="23 18 13.5 8.5 8.5 13.5 1 6" />
    <polyline points="17 18 23 18 23 12" />
  </Svg>
);
const IconXCircle = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="10" />
    <line x1="15" y1="9" x2="9" y2="15" />
    <line x1="9" y1="9" x2="15" y2="15" />
  </Svg>
);
const IconCheckCircle = (p: IconProps) => (
  <Svg {...p}>
    <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
    <polyline points="22 4 12 14.01 9 11.01" />
  </Svg>
);
const IconArrowRight = (p: IconProps) => (
  <Svg {...p}>
    <line x1="5" y1="12" x2="19" y2="12" />
    <polyline points="12 5 19 12 12 19" />
  </Svg>
);
const IconCheck = (p: IconProps) => (
  <Svg {...p}>
    <polyline points="20 6 9 17 4 12" />
  </Svg>
);
const IconAlert = (p: IconProps) => (
  <Svg {...p}>
    <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
    <line x1="12" y1="9" x2="12" y2="13" />
    <line x1="12" y1="17" x2="12.01" y2="17" />
  </Svg>
);
const IconLock = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="11" width="18" height="11" rx="2" />
    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
  </Svg>
);
const IconShield = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
  </Svg>
);
const IconSheet = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <line x1="3" y1="9" x2="21" y2="9" />
    <line x1="3" y1="15" x2="21" y2="15" />
    <line x1="9" y1="3" x2="9" y2="21" />
    <line x1="15" y1="3" x2="15" y2="21" />
  </Svg>
);

function Logo() {
  return (
    <span className="mkt-logo">
      <svg width="20" height="20" viewBox="0 0 32 32" fill="none" aria-hidden>
        <path d="M8 11h16" stroke="#fbbf24" strokeWidth="2.5" strokeLinecap="round" />
        <path d="M8 16h12" stroke="#fbbf24" strokeWidth="2.5" strokeLinecap="round" />
        <path d="M8 21h8" stroke="#fbbf24" strokeWidth="2.5" strokeLinecap="round" />
      </svg>
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* Content data (copy held as JS strings → no JSX-entity escaping needed)      */
/* -------------------------------------------------------------------------- */

const PAIN = [
  {
    icon: <IconPhoneMissed />,
    title: "Missed call up the scaffold",
    body: "A new enquiry rings while you’re on the tools. By the time you ring back, they’ve booked someone else.",
  },
  {
    icon: <IconMessage />,
    title: "Quote lost in WhatsApp",
    body: "“Did we ever send the Doyle quote?” Three apps and a notepad later, nobody’s quite sure.",
  },
  {
    icon: <IconTruck />,
    title: "Two lads, one van",
    body: "Double-booked again. One job sits idle while you sort who’s meant to be where.",
  },
  {
    icon: <IconPound />,
    title: "Invoice paid 40 days late",
    body: "The job finished weeks ago. The invoice is still sitting in a drafts folder somewhere.",
  },
  {
    icon: <IconFileLines />,
    title: "VAT due Monday",
    body: "The deadline’s looming and the books are a shoebox of receipts and bank screenshots.",
  },
  {
    icon: <IconClock />,
    title: "£9,500 retention nobody’s chasing",
    body: "Money you’ve already earned, held back on jobs you finished months ago — and forgotten.",
  },
];

const SUNDAY_NOTIS = [
  {
    tone: "mkt-rd",
    icon: <IconPhoneMissed />,
    app: "Phone",
    time: "now",
    msg: "3 missed calls — new enquiry, Ballymena",
  },
  {
    tone: "mkt-gn",
    icon: <IconMessage />,
    app: "Messages",
    time: "8:32pm",
    msg: "“Any chance of a price for the extension?”",
  },
  {
    tone: "mkt-gd",
    icon: <IconFile />,
    app: "Reminder",
    time: "7:00pm",
    msg: "2 quotes still not sent — Doyle, Quinn",
  },
  {
    tone: "mkt-bl",
    icon: <IconSheet />,
    app: "Payroll.xlsx",
    time: "Fri",
    msg: "Hours still to enter before the bank run",
  },
  {
    tone: "mkt-rd",
    icon: <IconFileLines />,
    app: "HMRC",
    time: "2 days",
    msg: "VAT return due — £6,820 to confirm",
  },
];

const BEFORE = [
  "Quotes in WhatsApp, jobs on a whiteboard, money in your head",
  "No idea which jobs actually made money",
  "Friday nights doing payroll by hand",
  "VAT worked out in a panic, every quarter",
  "Cashflow is a feeling, not a number",
];

const AFTER = [
  "Every lead, quote and job in one place",
  "Live margin on every job, as costs land",
  "Payroll run from clocked hours in minutes",
  "VAT and PAYE totals ready when you are",
  "Cashflow you can see weeks ahead",
];

const OS_ITEMS = [
  {
    on: true,
    icon: <IconFile />,
    title: "Quotes & estimates",
    body: "Build priced quotes with materials and labour, send, and track when they’re opened.",
  },
  {
    on: false,
    icon: <IconPhone />,
    title: "Leads & enquiries",
    body: "Every call, form and referral captured — so nothing slips while you’re on site.",
  },
  {
    on: false,
    icon: <IconJobs />,
    title: "Jobs & scheduling",
    body: "Turn a won quote into a job, assign the crew, track stages and variations.",
  },
  {
    on: false,
    icon: <IconUsers />,
    title: "Staff & rota",
    body: "Who’s where, this week and next — with clashes flagged before they happen.",
  },
  {
    on: false,
    icon: <IconPound />,
    title: "Invoices & payments",
    body: "Invoice from the job, take card payment, and chase the late ones automatically.",
  },
  {
    on: false,
    icon: <IconTrendingUp />,
    title: "Profitability & tax",
    body: "Live margin per job, plus VAT and PAYE totals ready for the books.",
  },
];

const MONEY_KPIS = [
  { k: "Outstanding", value: 42180, prefix: "£", suffix: "", tone: "mkt-gd", sub: "across 6 invoices" },
  { k: "Cash in · this month", value: 18400, prefix: "£", suffix: "", tone: "mkt-em", sub: "↑ 12% on last month" },
  { k: "Retention held", value: 9500, prefix: "£", suffix: "", tone: "", sub: "£2,500 due to release" },
  { k: "Net margin", value: 31, prefix: "", suffix: "%", tone: "mkt-em", sub: "across active jobs" },
  { k: "Materials · MTD", value: 14200, prefix: "£", suffix: "", tone: "", sub: "logged to jobs" },
  { k: "VAT due", value: 6820, prefix: "£", suffix: "", tone: "mkt-gd", sub: "quarter to date" },
  { k: "PAYE & NI", value: 3140, prefix: "£", suffix: "", tone: "", sub: "this month" },
  { k: "Overdue", value: 7250, prefix: "£", suffix: "", tone: "mkt-rd", sub: "2 invoices · chasing" },
];

const PROFIT_ROWS = [
  { job: "Loft — Patel", quoted: "£25,980", costs: "£16,900", margin: "35%", pill: "mkt-pill-em" },
  { job: "Extension — Doyle", quoted: "£38,200", costs: "£27,500", margin: "28%", pill: "mkt-pill-em" },
  { job: "Refurb — Newry", quoted: "£12,400", costs: "£10,900", margin: "12%", pill: "mkt-pill-red" },
  { job: "Patio — Quinn", quoted: "£6,400", costs: "£4,100", margin: "36%", pill: "mkt-pill-em" },
];

const CASHFLOW = [
  { m: "Jan", h: 46, em: false },
  { m: "Feb", h: 58, em: false },
  { m: "Mar", h: 52, em: false },
  { m: "Apr", h: 70, em: false },
  { m: "May", h: 64, em: false },
  { m: "Jun", h: 88, em: true },
];

const AI_ROWS = [
  {
    icon: <IconFile size={16} />,
    tone: "",
    title: "Patel quote unopened for 4 days",
    body: "QUO-1042 · £25,980 — worth a follow-up call.",
    act: "Remind",
  },
  {
    icon: <IconPound size={16} />,
    tone: "mkt-rd",
    title: "INV-088 is 21 days overdue",
    body: "£4,200 · M. Hughes — second reminder ready to send.",
    act: "Chase",
  },
  {
    icon: <IconTrendingDown size={16} />,
    tone: "mkt-rd",
    title: "Newry job margin below 15%",
    body: "Costs are running ahead of the quote — take a look before it slips further.",
    act: "Review",
  },
  {
    icon: <IconClock size={16} />,
    tone: "",
    title: "£2,500 retention due to release",
    body: "Defects period ended on the Hughes refurb — invoice it.",
    act: "Invoice",
  },
];

const PORTAL_FEATS = [
  {
    icon: <IconCheck />,
    title: "Approve quotes online",
    body: "Customers accept and sign off in a click — no chasing paperwork.",
  },
  {
    icon: <IconJobs />,
    title: "See job progress",
    body: "Live stages so they know exactly where things stand.",
  },
  {
    icon: <IconPound />,
    title: "Pay invoices by card",
    body: "One tap to pay — money lands faster, with less chasing.",
  },
];

const QUOTES = [
  {
    av: "JM",
    body: "First time I’ve actually known which jobs make money and which don’t. Changed how I price.",
    name: "James M.",
    role: "Groundworks · Belfast",
  },
  {
    av: "SK",
    body: "Payroll used to eat my Friday night. Now it’s clocked hours in, payslips out, done.",
    name: "Sinead K.",
    role: "Joinery & fit-out · Lisburn",
  },
  {
    av: "RH",
    body: "Quotes go out the same day now. We’re winning work we’d have lost to a slow reply.",
    name: "Rob H.",
    role: "Extensions & renovations · Newry",
  },
];

/* -------------------------------------------------------------------------- */
/* Page                                                                        */
/* -------------------------------------------------------------------------- */

export default function HomePage() {
  return (
    <div className="mkt-page marketing-root">
      {/* No-JS / pre-hydration safety: framer-motion sets inline opacity:0 on
          reveals; if scripts never run, force them visible. */}
      <noscript>
        <style
          dangerouslySetInnerHTML={{
            __html: ".mkt-reveal{opacity:1!important;transform:none!important}",
          }}
        />
      </noscript>
      <div className="mkt-top-hair" />
      <MotionProvider>
        <SiteHeader />
        <main>
          <Hero />
          <Pain />
          <SundayNight />
          <Transformation />
          <ProductOS />
          <Money />
          <PayrollStaff />
          <AiWatch />
          <Portal />
          <Proof />
          <FinalCta />
        </main>
        <SiteFooter />
      </MotionProvider>
      {/* Unchanged demo funnel — listens for crewflow:open-book-demo */}
      <BookDemoModal />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Header                                                                      */
/* -------------------------------------------------------------------------- */

function SiteHeader() {
  return (
    <header className="mkt-nav">
      <div className="mkt-wrap mkt-nav-row">
        <Link href="/" className="mkt-brand" aria-label="CrewFlow home">
          <Logo />
          CrewFlow
        </Link>
        <nav className="mkt-nav-links" aria-label="Primary">
          <a href="#features">Product</a>
          <a href="#roi">Money</a>
          <a href="#payroll">Payroll</a>
          <a href="#proof">Customers</a>
          <a href="#faq">Pricing</a>
        </nav>
        <div className="mkt-nav-cta">
          <Link href="/login" className="mkt-nav-signin">
            Sign in
          </Link>
          <BookDemoCta className="mkt-btn mkt-btn-gold mkt-btn-sm">
            Book a demo
          </BookDemoCta>
        </div>
      </div>
    </header>
  );
}

/* -------------------------------------------------------------------------- */
/* Hero                                                                        */
/* -------------------------------------------------------------------------- */

function Hero() {
  return (
    <section className="mkt-hero">
      <div className="mkt-wrap">
        <Reveal>
          <span className="mkt-eyebrow">
            Built in the UK · for construction companies
          </span>
          <h1>
            <span className="mkt-hero-grad">
              Run your whole construction business
            </span>
            <br />
            <span className="mkt-hero-accent">from one place.</span>
          </h1>
          <p className="mkt-lead">
            Quotes, jobs, staff, invoices, payroll and VAT — in one system built
            for builders. Win more work, cut the admin, and know exactly where
            your money is.
          </p>
          <div className="mkt-hero-cta">
            <BookDemoCta className="mkt-btn mkt-btn-gold">Book a demo</BookDemoCta>
            <a href="#how-it-works" className="mkt-btn mkt-btn-ghost">
              See how it works
              <IconArrowRight size={16} />
            </a>
          </div>
          <div className="mkt-hero-trust">
            <span>
              <i className="mkt-dot" /> VAT &amp; PAYE ready
            </span>
            <span>
              <i className="mkt-dot" /> Your data stays yours
            </span>
            <span>
              <i className="mkt-dot" /> Set up in days, not months
            </span>
          </div>
        </Reveal>
        <Reveal delay={0.15}>
          <HeroDashboard />
        </Reveal>
      </div>
    </section>
  );
}

function HeroDashboard() {
  if (HERO_IMAGE_SRC) {
    return (
      <div className="mkt-glasswrap">
        <Image
          src={HERO_IMAGE_SRC}
          alt="CrewFlow dashboard — pipeline, cash in, outstanding and active jobs."
          width={1600}
          height={1000}
          priority
          className="mkt-hero-img"
        />
      </div>
    );
  }
  return (
    <div className="mkt-glasswrap">
      <div className="mkt-app">
        <div className="mkt-app-bar">
          <div className="mkt-traffic">
            <i />
            <i />
            <i />
          </div>
          <div className="mkt-app-title">CrewFlow · Dashboard</div>
          <div className="mkt-app-search">Search jobs, quotes, customers…</div>
        </div>
        <div className="mkt-app-body">
          <aside className="mkt-app-side">
            <div className="mkt-side-item mkt-active">
              <IconDashboard />
              Dashboard
            </div>
            <div className="mkt-side-item">
              <IconPhone />
              Leads
            </div>
            <div className="mkt-side-item">
              <IconFile />
              Quotes
            </div>
            <div className="mkt-side-item">
              <IconJobs />
              Jobs
            </div>
            <div className="mkt-side-item">
              <IconUsers />
              Staff
            </div>
            <div className="mkt-side-item">
              <IconPound />
              Money
            </div>
          </aside>
          <main className="mkt-app-main">
            <div className="mkt-pipe">
              <div className="mkt-pipe-step">
                <div className="mkt-n">
                  <CountUp value={12} />
                </div>
                <div className="mkt-l">Leads</div>
                <div className="mkt-pipe-line" />
              </div>
              <div className="mkt-pipe-step">
                <div className="mkt-n">
                  <CountUp value={8} />
                </div>
                <div className="mkt-l">Quotes</div>
                <div className="mkt-pipe-line" />
              </div>
              <div className="mkt-pipe-step">
                <div className="mkt-n">
                  <CountUp value={5} />
                </div>
                <div className="mkt-l">Jobs</div>
                <div className="mkt-pipe-line" />
              </div>
              <div className="mkt-pipe-step">
                <div className="mkt-n">
                  <CountUp value={6} />
                </div>
                <div className="mkt-l">Invoiced</div>
                <div className="mkt-pipe-line" />
              </div>
              <div className="mkt-pipe-step mkt-paid">
                <div className="mkt-n">
                  <CountUp value={19} />
                </div>
                <div className="mkt-l">Paid</div>
              </div>
            </div>
            <div className="mkt-kpi-row">
              <div className="mkt-kpi">
                <div className="mkt-k">Outstanding</div>
                <div className="mkt-v">
                  <CountUp value={42180} prefix="£" />
                </div>
              </div>
              <div className="mkt-kpi">
                <div className="mkt-k">Cash in · this month</div>
                <div className="mkt-v mkt-em">
                  <CountUp value={18400} prefix="£" />
                  <span className="mkt-chg">↑ 12%</span>
                </div>
              </div>
              <div className="mkt-kpi">
                <div className="mkt-k">Net margin</div>
                <div className="mkt-v">
                  <CountUp value={31} suffix="%" />
                </div>
              </div>
            </div>
            <table className="mkt-tbl">
              <thead>
                <tr>
                  <th>Job</th>
                  <th>Customer</th>
                  <th>Status</th>
                  <th style={{ textAlign: "right" }}>Value</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>Loft conversion</td>
                  <td>R. Patel · Lisburn</td>
                  <td>
                    <span className="mkt-pill mkt-pill-gold">In progress</span>
                  </td>
                  <td style={{ textAlign: "right" }}>£24,500</td>
                </tr>
                <tr>
                  <td>Rear extension</td>
                  <td>S. Doyle · Belfast</td>
                  <td>
                    <span className="mkt-pill mkt-pill-blue">Quoted</span>
                  </td>
                  <td style={{ textAlign: "right" }}>£38,200</td>
                </tr>
                <tr>
                  <td>Bathroom refit</td>
                  <td>M. Hughes · Newry</td>
                  <td>
                    <span className="mkt-pill mkt-pill-em">Paid</span>
                  </td>
                  <td style={{ textAlign: "right" }}>£9,750</td>
                </tr>
                <tr>
                  <td>Driveway &amp; patio</td>
                  <td>T. Quinn · Ballymena</td>
                  <td>
                    <span className="mkt-pill mkt-pill-grey">Scheduled</span>
                  </td>
                  <td style={{ textAlign: "right" }}>£6,400</td>
                </tr>
              </tbody>
            </table>
          </main>
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Pain                                                                        */
/* -------------------------------------------------------------------------- */

function Pain() {
  return (
    <section id="pain" className="mkt-section">
      <div className="mkt-wrap">
        <Reveal>
          <div className="mkt-section-head">
            <span className="mkt-eyebrow">The day-to-day</span>
            <h2>You didn&apos;t start a building firm to drown in admin.</h2>
            <p className="mkt-lead">
              The work gets done on site. The money gets lost between the van,
              the kitchen table and seven different apps.
            </p>
          </div>
        </Reveal>
        <div className="mkt-pain-grid">
          {PAIN.map((c, i) => (
            <Reveal key={c.title} delay={i * 0.05}>
              <div className="mkt-pain-card">
                <div className="mkt-ic">{c.icon}</div>
                <h4>{c.title}</h4>
                <p>{c.body}</p>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Sunday Night (emotional climax)                                             */
/* -------------------------------------------------------------------------- */

function SundayNight() {
  return (
    <section id="sunday" className="mkt-section mkt-sunday">
      <div className="mkt-wrap">
        <div className="mkt-sunday-grid">
          <Reveal className="mkt-sunday-copy">
            <span className="mkt-eyebrow">Sunday · 9:47pm</span>
            <h2>
              You didn&apos;t start a construction company to spend Sunday night
              doing admin.
            </h2>
            <p className="mkt-lead">
              Every missed call, unsent quote and half-finished spreadsheet —
              still waiting for you, on the one night you wanted off.
            </p>
            <div className="mkt-sunday-turn">
              <IconCheckCircle size={20} />
              <span>
                <b>That&apos;s the bit CrewFlow takes off your plate.</b> The
                follow-ups, the chasing and the sums run in the background — so
                Sunday night can go back to being Sunday night.
              </span>
            </div>
          </Reveal>
          <Reveal delay={0.15}>
            <div className="mkt-phone-wrap">
              <div className="mkt-phone">
                <div className="mkt-phone-screen">
                  <div className="mkt-phone-notch" />
                  <div className="mkt-phone-time">21:47</div>
                  <div className="mkt-phone-date">Sunday</div>
                  <div className="mkt-noti-list">
                    {SUNDAY_NOTIS.map((n, i) => (
                      <div className="mkt-noti" key={i}>
                        <div className={`mkt-noti-ic ${n.tone}`}>{n.icon}</div>
                        <div className="mkt-noti-body">
                          <div className="mkt-noti-top">
                            {n.app}
                            <span className="mkt-noti-time">{n.time}</span>
                          </div>
                          <div className="mkt-noti-msg">{n.msg}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </Reveal>
        </div>
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Transformation (before / after)                                            */
/* -------------------------------------------------------------------------- */

function Transformation() {
  return (
    <section id="how-it-works" className="mkt-section">
      <div className="mkt-wrap">
        <Reveal>
          <div className="mkt-section-head mkt-center">
            <span className="mkt-eyebrow">The shift</span>
            <h2>From scattered and guessing — to one clear system.</h2>
          </div>
        </Reveal>
        <Reveal>
          <div className="mkt-ba">
            <div className="mkt-ba-col mkt-ba-before">
              <div className="mkt-ba-tag">Before CrewFlow</div>
              {BEFORE.map((t) => (
                <div className="mkt-ba-li" key={t}>
                  <span style={{ display: "contents", color: "var(--mkt-faint)" }}>
                    <IconXCircle />
                  </span>
                  <span>{t}</span>
                </div>
              ))}
            </div>
            <div className="mkt-ba-mid">
              <div className="mkt-ba-arrow">
                <IconArrowRight />
              </div>
            </div>
            <div className="mkt-ba-col mkt-ba-after">
              <div className="mkt-ba-tag">With CrewFlow</div>
              {AFTER.map((t) => (
                <div className="mkt-ba-li" key={t}>
                  <span
                    style={{ display: "contents", color: "var(--mkt-emerald-2)" }}
                  >
                    <IconCheckCircle />
                  </span>
                  <span>{t}</span>
                </div>
              ))}
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Product OS                                                                  */
/* -------------------------------------------------------------------------- */

function ProductOS() {
  return (
    <section id="features" className="mkt-section">
      <div className="mkt-wrap">
        <Reveal>
          <div className="mkt-section-head">
            <span className="mkt-eyebrow">The product</span>
            <h2>One system. Every part of the job.</h2>
            <p className="mkt-lead">
              From the first enquiry to the final payment, every step lives in
              CrewFlow — and they all talk to each other.
            </p>
          </div>
        </Reveal>
        <div className="mkt-os">
          <Reveal className="mkt-os-list">
            {OS_ITEMS.map((it) => (
              <div
                className={`mkt-os-item${it.on ? " mkt-on" : ""}`}
                key={it.title}
              >
                <div className="mkt-os-ic">{it.icon}</div>
                <div>
                  <h4>{it.title}</h4>
                  <p>{it.body}</p>
                </div>
              </div>
            ))}
          </Reveal>
          <Reveal delay={0.1}>
            <div className="mkt-os-panel">
              <div className="mkt-app-bar">
                <div className="mkt-traffic">
                  <i />
                  <i />
                  <i />
                </div>
                <div className="mkt-app-title">Quote · QUO-1042 · R. Patel</div>
              </div>
              <div className="mkt-os-panel-body">
                <div className="mkt-quote-head">
                  <div>
                    <div className="mkt-t">Loft conversion — Lisburn</div>
                    <div className="mkt-s">Quote QUO-1042 · valid 30 days</div>
                  </div>
                  <span className="mkt-pill mkt-pill-blue">Sent · opened 2×</span>
                </div>
                <div className="mkt-qline">
                  <span>Labour — 18 days @ crew rate</span>
                  <span>£10,800</span>
                </div>
                <div className="mkt-qline">
                  <span>Materials — timber, insulation, plaster</span>
                  <span>£7,420</span>
                </div>
                <div className="mkt-qline">
                  <span>Velux &amp; glazing</span>
                  <span>£2,650</span>
                </div>
                <div className="mkt-qline">
                  <span>Skip hire &amp; waste</span>
                  <span>£780</span>
                </div>
                <div className="mkt-qtot">
                  <span>Subtotal</span>
                  <span>£21,650</span>
                </div>
                <div className="mkt-qline mkt-qline-vat">
                  <span>VAT @ 20%</span>
                  <span>£4,330</span>
                </div>
                <div className="mkt-qtot">
                  <span>Total</span>
                  <span className="mkt-em">£25,980</span>
                </div>
              </div>
            </div>
          </Reveal>
        </div>
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Money                                                                       */
/* -------------------------------------------------------------------------- */

function Money() {
  return (
    <section id="roi" className="mkt-section">
      <div className="mkt-wrap">
        <Reveal>
          <div className="mkt-section-head">
            <span className="mkt-eyebrow">The money</span>
            <h2>Know where every pound is, to the penny.</h2>
            <p className="mkt-lead">
              No more guessing at margins or hunting for the VAT figure. CrewFlow
              adds it up as the work happens.
            </p>
          </div>
        </Reveal>
        <Reveal>
          <div className="mkt-money-kpis">
            {MONEY_KPIS.map((m) => (
              <div className="mkt-mk" key={m.k}>
                <div className="mkt-k">{m.k}</div>
                <div className={`mkt-v ${m.tone}`.trim()}>
                  <CountUp value={m.value} prefix={m.prefix} suffix={m.suffix} />
                </div>
                <div className="mkt-sub">{m.sub}</div>
              </div>
            ))}
          </div>
        </Reveal>
        <Reveal>
          <div className="mkt-money-low">
            <div className="mkt-panel">
              <h4>
                Profit by job <span className="mkt-mut">live</span>
              </h4>
              <table className="mkt-tbl">
                <thead>
                  <tr>
                    <th>Job</th>
                    <th style={{ textAlign: "right" }}>Quoted</th>
                    <th style={{ textAlign: "right" }}>Costs</th>
                    <th style={{ textAlign: "right" }}>Margin</th>
                  </tr>
                </thead>
                <tbody>
                  {PROFIT_ROWS.map((r) => (
                    <tr key={r.job}>
                      <td>{r.job}</td>
                      <td style={{ textAlign: "right" }}>{r.quoted}</td>
                      <td style={{ textAlign: "right" }}>{r.costs}</td>
                      <td style={{ textAlign: "right" }}>
                        <span className={`mkt-pill ${r.pill}`}>{r.margin}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mkt-panel">
              <h4>Cash in · last 6 months</h4>
              <div className="mkt-bars">
                {CASHFLOW.map((b) => (
                  <div className={`mkt-bar${b.em ? " mkt-em" : ""}`} key={b.m}>
                    <i style={{ height: `${b.h}%` }} />
                    <span>{b.m}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Payroll & staff                                                            */
/* -------------------------------------------------------------------------- */

function PayrollStaff() {
  return (
    <section id="payroll" className="mkt-section">
      <div className="mkt-wrap">
        <Reveal>
          <div className="mkt-section-head">
            <span className="mkt-eyebrow">The team</span>
            <h2>Run the team and payroll without the Friday panic.</h2>
            <p className="mkt-lead">
              Plan the week, see clashes before they cost you, and turn clocked
              hours into payslips — without the spreadsheet gymnastics.
            </p>
          </div>
        </Reveal>
        <Reveal>
          <div className="mkt-pay">
            <div className="mkt-panel">
              <h4>
                This week&apos;s rota <span className="mkt-mut">Mon–Fri</span>
              </h4>
              <div className="mkt-rota">
                <div className="mkt-h" />
                <div className="mkt-h">Mon</div>
                <div className="mkt-h">Tue</div>
                <div className="mkt-h">Wed</div>
                <div className="mkt-h">Thu</div>
                <div className="mkt-h">Fri</div>

                <div className="mkt-who">Jamie M.</div>
                <div className="mkt-rcell mkt-gold">Loft · Lisburn</div>
                <div className="mkt-rcell mkt-gold">Loft · Lisburn</div>
                <div className="mkt-rcell">Refit · Newry</div>
                <div className="mkt-rcell">Refit · Newry</div>
                <div className="mkt-rcell mkt-off">Off</div>

                <div className="mkt-who">Conor B.</div>
                <div className="mkt-rcell">Extension</div>
                <div className="mkt-rcell mkt-clash">Extension + Patio</div>
                <div className="mkt-rcell">Extension</div>
                <div className="mkt-rcell">Extension</div>
                <div className="mkt-rcell">Extension</div>

                <div className="mkt-who">Sean O.</div>
                <div className="mkt-rcell mkt-off">Holiday</div>
                <div className="mkt-rcell mkt-off">Holiday</div>
                <div className="mkt-rcell mkt-gold">Patio · Ballymena</div>
                <div className="mkt-rcell mkt-gold">Patio · Ballymena</div>
                <div className="mkt-rcell">Snagging</div>
              </div>
              <div className="mkt-clash-flag">
                <IconAlert size={14} />
                Conor is double-booked Tuesday — Extension &amp; Patio
              </div>
            </div>
            <div className="mkt-panel mkt-payrun">
              <h4>
                Payroll run <span className="mkt-mut">week 24</span>
              </h4>
              <div className="mkt-pr-row">
                <span>Gross pay</span>
                <span>£8,420.00</span>
              </div>
              <div className="mkt-pr-row">
                <span>PAYE</span>
                <span>−£1,265.00</span>
              </div>
              <div className="mkt-pr-row">
                <span>National Insurance</span>
                <span>−£612.00</span>
              </div>
              <div className="mkt-pr-row">
                <span>Pension</span>
                <span>−£253.00</span>
              </div>
              <div className="mkt-pr-row mkt-net">
                <span>Net to pay · 6 staff</span>
                <span>£6,290.00</span>
              </div>
              {/* Decorative (illustrative product UI) — not an interactive CTA */}
              <span
                className="mkt-btn mkt-btn-gold mkt-btn-sm mkt-btn-block"
                aria-hidden
              >
                Approve &amp; generate payslips
              </span>
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* AI watch (demoted)                                                         */
/* -------------------------------------------------------------------------- */

function AiWatch() {
  return (
    <section id="watch" className="mkt-section">
      <div className="mkt-wrap">
        <Reveal>
          <div className="mkt-section-head mkt-center">
            <span className="mkt-eyebrow">Quietly in the background</span>
            <h2>It keeps an eye on the things that slip.</h2>
            <p className="mkt-lead">
              CrewFlow watches the numbers so you don&apos;t have to remember
              everything. It flags what needs a look — you make the call.
            </p>
          </div>
        </Reveal>
        <Reveal>
          <div className="mkt-ai">
            <div className="mkt-ai-panel">
              {AI_ROWS.map((r) => (
                <div className="mkt-ai-row" key={r.title}>
                  <div className={`mkt-ai-ic ${r.tone}`.trim()}>{r.icon}</div>
                  <div className="mkt-txt">
                    <b>{r.title}</b>
                    <p>{r.body}</p>
                  </div>
                  <div className="mkt-act">{r.act} →</div>
                </div>
              ))}
            </div>
            <p className="mkt-ai-foot">
              Assisted by AI. It flags things and drafts the follow-up — you
              always decide what&apos;s sent.
            </p>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Customer portal                                                            */
/* -------------------------------------------------------------------------- */

function Portal() {
  return (
    <section id="portal" className="mkt-section">
      <div className="mkt-wrap">
        <div className="mkt-portal">
          <Reveal>
            <span className="mkt-eyebrow">Your customers</span>
            <h2 style={{ marginTop: 18 }}>
              Give customers clarity, without more phone calls.
            </h2>
            <p className="mkt-lead" style={{ marginTop: 16 }}>
              They see the quote, where the job&apos;s up to, and what&apos;s left
              to pay — in one tidy link. You get fewer &ldquo;any update?&rdquo;
              texts.
            </p>
            <div className="mkt-portal-feats">
              {PORTAL_FEATS.map((f) => (
                <div className="mkt-pf" key={f.title}>
                  <div className="mkt-pf-ic">{f.icon}</div>
                  <div>
                    <h4>{f.title}</h4>
                    <p>{f.body}</p>
                  </div>
                </div>
              ))}
            </div>
          </Reveal>
          <Reveal delay={0.1}>
            <div className="mkt-portal-card">
              <div className="mkt-pc-head">
                <div className="mkt-t">Loft conversion — Lisburn</div>
                <span className="mkt-pill mkt-pill-gold">In progress</span>
              </div>
              <div className="mkt-pc-stage">
                <i className="mkt-on" />
                <i className="mkt-on" />
                <i className="mkt-on" />
                <i />
                <i />
              </div>
              <div className="mkt-pc-line">
                <span>Quote accepted</span>
                <span style={{ color: "var(--mkt-emerald-2)" }}>✓ Signed</span>
              </div>
              <div className="mkt-pc-line">
                <span>Deposit invoice</span>
                <span style={{ color: "var(--mkt-emerald-2)" }}>£5,196 paid</span>
              </div>
              <div className="mkt-pc-line">
                <span>First fix</span>
                <span style={{ color: "var(--mkt-emerald-2)" }}>✓ Complete</span>
              </div>
              <div className="mkt-pc-line">
                <span>Second fix</span>
                <span style={{ color: "var(--mkt-gold-2)" }}>In progress</span>
              </div>
              <div className="mkt-pc-line">
                <span>Final invoice</span>
                <span style={{ color: "var(--mkt-faint)" }}>
                  £10,392 · due on completion
                </span>
              </div>
              {/* Decorative (illustrative product UI) — not an interactive CTA */}
              <span
                className="mkt-btn mkt-btn-ghost mkt-btn-sm mkt-btn-block"
                aria-hidden
              >
                View documents &amp; photos
              </span>
            </div>
          </Reveal>
        </div>
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Proof / outcomes                                                           */
/* -------------------------------------------------------------------------- */

function Proof() {
  return (
    <section id="proof" className="mkt-section">
      <div className="mkt-wrap">
        <Reveal>
          <div className="mkt-section-head mkt-center">
            <span className="mkt-eyebrow">The outcome</span>
            <h2>Less admin. Faster payment. Nothing lost.</h2>
          </div>
        </Reveal>
        <Reveal>
          <div className="mkt-proof-stats">
            <div className="mkt-ps">
              <div className="mkt-v">
                <CountUp value={8} prefix="~" suffix=" hrs" />
              </div>
              <div className="mkt-l">a week off the admin, back on the tools</div>
            </div>
            <div className="mkt-ps">
              <div className="mkt-v">
                <CountUp value={22} suffix="%" />
              </div>
              <div className="mkt-l">fewer invoices going overdue</div>
            </div>
            <div className="mkt-ps">
              <div className="mkt-v">
                <CountUp value={0} prefix="£" />
              </div>
              <div className="mkt-l">quotes lost down the back of an app</div>
            </div>
          </div>
        </Reveal>
        <p className="mkt-disclaim">
          Illustrative outcomes based on typical construction workflows. Your
          results will vary.
        </p>
        <Reveal>
          <div className="mkt-quotes">
            {QUOTES.map((q) => (
              <div className="mkt-qc" key={q.name}>
                <span className="mkt-ex-tag">Example · early access</span>
                <p>{q.body}</p>
                <div className="mkt-who">
                  <div className="mkt-av">{q.av}</div>
                  <div>
                    <b>{q.name}</b>
                    <span>{q.role}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </Reveal>
        <div className="mkt-sec-strip">
          <span>
            <IconLock /> UK-hosted &amp; encrypted
          </span>
          <span>
            <IconShield /> Role-based access
          </span>
          <span>
            <IconCheck /> VAT &amp; PAYE ready
          </span>
          <span>
            <IconClock /> Your data stays yours
          </span>
        </div>
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Final CTA (pricing)                                                        */
/* -------------------------------------------------------------------------- */

function FinalCta() {
  return (
    <section id="faq" className="mkt-section mkt-final">
      <div className="mkt-wrap">
        <Reveal>
          <div className="mkt-final-card">
            <span className="mkt-eyebrow mkt-eyebrow-center">Get started</span>
            <h2>Ready to run your construction company from one place?</h2>
            <p className="mkt-lead">
              See CrewFlow on your own jobs and numbers. Book a 20-minute demo,
              or start setting up today.
            </p>
            <div className="mkt-final-cta">
              <BookDemoCta className="mkt-btn mkt-btn-gold">
                Book a demo
              </BookDemoCta>
              <Link href="/login" className="mkt-btn mkt-btn-ghost">
                Start setup
                <IconArrowRight size={16} />
              </Link>
            </div>
            <p className="mkt-final-note">
              £1,000 setup · £500/month · no long tie-in
            </p>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Footer                                                                      */
/* -------------------------------------------------------------------------- */

function SiteFooter() {
  return (
    <footer className="mkt-footer">
      <div className="mkt-wrap">
        <div className="mkt-foot-top">
          <div className="mkt-foot-brand">
            <span className="mkt-brand">
              <Logo />
              CrewFlow
            </span>
            <p>
              The operating system for UK construction companies. Built in
              Belfast.
            </p>
          </div>
          <div className="mkt-foot-cols">
            <div className="mkt-foot-col">
              <h5>Product</h5>
              <a href="#features">Quotes &amp; jobs</a>
              <a href="#roi">Money</a>
              <a href="#payroll">Payroll</a>
              <a href="#portal">Customer portal</a>
            </div>
            <div className="mkt-foot-col">
              <h5>Company</h5>
              <a href="#proof">Customers</a>
              <a href="#faq">Pricing</a>
              <Link href="/login">Sign in</Link>
              <BookDemoCta>Book a demo</BookDemoCta>
            </div>
            <div className="mkt-foot-col">
              <h5>Legal</h5>
              <Link href="/privacy">Privacy</Link>
              <Link href="/terms">Terms</Link>
              <a href="mailto:hello@crewflow.uk">hello@crewflow.uk</a>
            </div>
          </div>
        </div>
        <div className="mkt-foot-bot">
          <span>© CrewFlow. All rights reserved.</span>
          <span>VAT · PAYE · UK-hosted</span>
        </div>
      </div>
    </footer>
  );
}
