/**
 * The six-pillar product model for the redesigned marketing site.
 *
 * Reconciled against the CURRENT product navigation (app/(app)/_components/
 * sidebar.tsx) and the routes behind it. Every capability listed here is LIVE
 * and reachable by a normal org user today.
 *
 * DELIBERATELY EXCLUDED because they ship dark / unconfigured (must NOT be
 * marketed as available): the weather forecast (no provider connected), AI
 * insights (null with no provider), the AI voice receptionist / call & message
 * auto-capture (no telephony provider — the Inbox itself is live for enquiries
 * and conversations, but nothing here claims the AI answers your phone), and
 * any generative "AI quote writer". Also honest by omission: no live two-way
 * accounting sync (CSV export only), no HMRC filing (figures only), no card
 * processing (payments are tracked, not taken).
 */

export type Capability = { name: string; note: string };

export type Pillar = {
  slug: string;
  n: string;
  label: string;
  eyebrow: string;
  headline: string;
  summary: string;
  capabilities: Capability[];
  /** Optional real product screenshot (light UI) for the pillar page frame. */
  shot?: { src: string; alt: string; screen: string; url: string; w: number; h: number };
};

export const PILLARS: Pillar[] = [
  {
    slug: "win-work",
    n: "01",
    label: "Win work",
    eyebrow: "Win work",
    headline: "Turn enquiries into won jobs, without re-keying anything",
    summary:
      "Every lead, quote and customer in one pipeline, so nothing slips while you're on site and every quote can become a job in one step.",
    capabilities: [
      { name: "CRM & leads", note: "Every enquiry in one pipeline, scored hot to cold so you chase the right work first." },
      { name: "Quotes & estimates", note: "Line-item quotes with full VAT and a branded PDF, out the door in minutes." },
      { name: "Price book", note: "Reusable rates, materials and labour so every quote is fast and consistent." },
      { name: "Online acceptance", note: "Customers sign off by name, and an accepted quote becomes a job in one step." },
      { name: "Customer records", note: "Full history per customer: quotes, jobs, invoices and payments." },
      { name: "Reviews", note: "Automated review-request emails once a job's signed off, to build your reputation." },
    ],
    shot: {
      src: "/product-shots/customers.png",
      alt: "The CrewFlow customer list for a construction company, customers with contact details and site postcodes across Yorkshire.",
      screen: "Customers",
      url: "app.crewflow.uk/customers",
      w: 1440,
      h: 600,
    },
  },
  {
    slug: "run-jobs",
    n: "02",
    label: "Run jobs",
    eyebrow: "Run jobs",
    headline: "Every job on track, on margin, and never in two places at once",
    summary:
      "Live job stages, costs against the quote, and a schedule that catches clashes before the week starts, with a portal that keeps your customer off the phone.",
    capabilities: [
      { name: "Job management", note: "Stages, costs-vs-quote and who's on site, per job." },
      { name: "Scheduling & calendar", note: "Plan the week; clashes flagged before they cost you." },
      { name: "Operations command centre", note: "One screen for what's on, late, or needs a look." },
      { name: "Programme & critical path", note: "Critical-path scheduling with per-task float, dependencies and baseline revisions." },
      { name: "Variations, delays & EoT", note: "Capture variations, log delays and build the extension-of-time record against the job." },
      { name: "Drawings & documents", note: "Versioned drawings with pins and markup, plus every job document in one place." },
      { name: "Customer portal", note: "Quotes, progress and what's left to pay, on one tidy link." },
    ],
    shot: {
      src: "/product-shots/jobs.png",
      alt: "The CrewFlow jobs list, live jobs with status (new, in-progress, blocked, completed), customer, site address and scheduled dates.",
      screen: "Jobs",
      url: "app.crewflow.uk/jobs",
      w: 1440,
      h: 640,
    },
  },
  {
    slug: "site-safety",
    n: "03",
    label: "Site & safety",
    eyebrow: "Site & safety",
    headline: "RAMS, permits, diaries and sign-off, audit-ready, in one place",
    summary:
      "The compliance layer that wins you bigger work: risk assessments, permits, toolbox talks, site diaries and inductions, with worker sign-off you can prove.",
    capabilities: [
      { name: "RAMS", note: "Risk assessments scored on a 5×5 matrix, issued and revision-tracked." },
      { name: "Permits & toolbox talks", note: "Permit-to-work and toolbox talks with attendance and PDFs." },
      { name: "Worker sign-off", note: "Site workers sign RAMS and permits by secure link, no login needed." },
      { name: "Site diaries & reports", note: "Daily diary and client-ready progress reports as PDF." },
      { name: "Snagging & quality (ITP)", note: "Snag lists and inspection & test plans with hold points and NCRs." },
      { name: "Completion certificates", note: "Auto-numbered practical-completion certificates, issued and published to the customer portal." },
      { name: "Inductions & muster", note: "Induct operatives, sign visitors in and out, and pull a live fire-muster roll." },
    ],
    shot: {
      src: "/product-shots/health-safety.png",
      alt: "The CrewFlow health & safety register, issued RAMS with hazard counts and 5x5 risk ratings, and an alert for active jobs missing a current risk assessment.",
      screen: "Health & safety",
      url: "app.crewflow.uk/health-safety",
      w: 1440,
      h: 720,
    },
  },
  {
    slug: "money",
    n: "04",
    label: "Money",
    eyebrow: "Money",
    headline: "Know where every pound is, to the penny, per job",
    summary:
      "Invoicing that chases itself, real per-job margin, and the UK-specific money work, CIS, retention, staged valuations, VAT and Corporation Tax, built in.",
    capabilities: [
      { name: "Cash position", note: "Money in and money out, and exactly where you net out, on one screen." },
      { name: "Invoicing", note: "Raise from a finished job; reminders chase on day 3, 7, 14 and 21." },
      { name: "Valuations & applications", note: "Interim valuations and applications for payment, certified, then turned into an invoice." },
      { name: "Retention & aged debt", note: "Track retention release and who owes what, when." },
      { name: "Expenses", note: "Capture receipts and costs from the field, against the job they belong to." },
      { name: "Job costing", note: "Revenue minus materials and clocked labour: real margin, live." },
      { name: "POs & supplier bills", note: "Purchase orders with 3-way matching against deliveries and bills." },
      { name: "CIS & tax figures", note: "CIS deductions and statements; VAT and Corporation Tax figures ready for your accountant." },
    ],
    shot: {
      src: "/product-shots/cash.png",
      alt: "The CrewFlow cash position, collectable now, overdue, due this week and expected this month, with an honest note that it is not a live bank balance.",
      screen: "Cash position",
      url: "app.crewflow.uk/cash",
      w: 1440,
      h: 726,
    },
  },
  {
    slug: "people-assets",
    n: "05",
    label: "People & assets",
    eyebrow: "People & assets",
    headline: "Your crew, plant and stock, organised and legal",
    summary:
      "Rota, timesheets and payroll for the team; MOT, insurance and inspections for the fleet; stock, materials and your own yards for the stores.",
    capabilities: [
      { name: "Workforce", note: "Staff, rota, leave and timesheets with GPS clock-in." },
      { name: "Payroll", note: "Pay runs from clocked hours, PAYE/NI estimates, payslips and CSV export." },
      { name: "Fleet", note: "MOT, tax, insurance and inspections, with expiries flagged before they lapse." },
      { name: "Assets & maintenance", note: "Plant register, inspections, service and calibration schedules, QR labels." },
      { name: "Stock & warehouses", note: "Stock items, locations and balances across the business." },
      { name: "Materials & suppliers", note: "Site material requests fulfilled from stock, with supplier records." },
      { name: "Sites & yards", note: "Your own depots, yards and lock-ups, the reference data behind the estate." },
      { name: "Compliance library", note: "Company insurance, certificates and expiries, all in one place." },
    ],
  },
  {
    slug: "automation",
    n: "06",
    label: "Connect & automate",
    eyebrow: "Connect & automate",
    headline: "The quiet work that happens without being asked",
    summary:
      "One inbox for every enquiry, clean export to your accountant, and the reminders and rules that keep the business moving without manual chasing.",
    capabilities: [
      { name: "Inbox", note: "One shared place for every enquiry and conversation, so nothing gets missed." },
      { name: "Automatic reminders", note: "Overdue invoices, expiring certs and due inspections chased on their own." },
      { name: "Clash & risk signals", note: "Double-booked staff and cold quotes surfaced before they bite." },
      { name: "Reporting & company health", note: "Profit, cashflow, utilisation and pipeline, on screen and as PDF or CSV." },
      { name: "Accounting export", note: "Clean CSV export to Xero and Sage when it's time to file." },
      { name: "Built-in workflows", note: "Event-driven rules that move work along without manual chasing." },
    ],
  },
];

export function pillarBySlug(slug: string): Pillar | undefined {
  return PILLARS.find((p) => p.slug === slug);
}
