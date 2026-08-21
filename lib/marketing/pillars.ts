/**
 * The six-pillar product model for the redesigned marketing site.
 *
 * Every capability listed here is LIVE and customer-usable today — checked
 * against the product-truth authority
 * (~/.claude/skills/crewflow-brand-design/references/product-truth.md).
 * NOTHING built-dark appears here: no generative AI, no telephony/receptionist,
 * no live accounting sync, no HMRC filing, no card payments, no public API.
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
    headline: "Turn enquiries into won jobs — without re-keying anything",
    summary:
      "Every lead, quote and customer in one pipeline, so nothing slips while you're on site and every quote can become a job in one step.",
    capabilities: [
      { name: "CRM & leads", note: "Every enquiry in one pipeline, tagged by source and value." },
      { name: "Quotes & estimates", note: "Line-item quotes with full VAT and a branded PDF." },
      { name: "Online acceptance", note: "Customers sign off by name — an accepted quote becomes a job." },
      { name: "Follow-ups", note: "Reminders so a quiet quote gets chased while the job's still warm." },
      { name: "Customer records", note: "Full history — quotes, jobs, invoices, payments — per customer." },
    ],
    shot: {
      src: "/product-shots/customers.png",
      alt: "The CrewFlow customer list for a construction company — customers with contact details and site postcodes across Yorkshire.",
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
      "Live job stages, costs against the quote, and a schedule that catches clashes before the week starts — with a portal that keeps your customer off the phone.",
    capabilities: [
      { name: "Job management", note: "Stages, costs-vs-quote and who's on site, per job." },
      { name: "Scheduling & calendar", note: "Plan the week; clashes flagged before they cost you." },
      { name: "Operations command centre", note: "One screen for what's on, late, or needs a look." },
      { name: "Variations & EoT", note: "Capture variations and extensions of time against the job." },
      { name: "Job documents & photos", note: "Attach site photos and files from a phone." },
      { name: "Customer portal", note: "Quotes, progress and what's left to pay — one tidy link." },
    ],
    shot: {
      src: "/product-shots/jobs.png",
      alt: "The CrewFlow jobs list — live jobs with status (new, in-progress, blocked, completed), customer, site address and scheduled dates.",
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
    headline: "RAMS, permits, diaries and drawings — audit-ready, in one place",
    summary:
      "The compliance layer that wins you bigger work: risk assessments, permits, toolbox talks, site diaries and versioned drawings, with worker sign-off you can prove.",
    capabilities: [
      { name: "RAMS", note: "Risk assessments scored on a 5×5 matrix, issued and revision-tracked." },
      { name: "Permits & toolbox talks", note: "Permit-to-work and toolbox talks with attendance and PDFs." },
      { name: "Worker H&S sign-off", note: "Site workers sign RAMS and permits by secure link — no login." },
      { name: "Site diaries & reports", note: "Daily diary and client-ready progress reports (PDF)." },
      { name: "Snags & quality (ITP)", note: "Snag lists and inspection & test plans with hold points." },
      { name: "Blueprint centre", note: "Drawing viewer with pins, markup, version compare and offline." },
    ],
    shot: {
      src: "/product-shots/health-safety.png",
      alt: "The CrewFlow health & safety register — issued RAMS with hazard counts and 5x5 risk ratings, and an alert for active jobs missing a current risk assessment.",
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
    headline: "Know where every pound is — to the penny, per job",
    summary:
      "Invoicing that chases itself, real per-job margin, and the UK-specific money work — CIS, retention, staged valuations, VAT and Corporation Tax — built in.",
    capabilities: [
      { name: "Invoicing", note: "Raise from a finished job; reminders go out on day 3, 7, 14, 21." },
      { name: "Staged valuations", note: "Interim valuations / applications for payment — certified, then turned into an invoice." },
      { name: "Retention & aged debt", note: "Track retention release and who owes what, when." },
      { name: "Job costing", note: "Revenue minus materials and clocked labour — real margin, live." },
      { name: "CIS & tax figures", note: "CIS deductions and statements; VAT and Corp Tax ready for your accountant." },
      { name: "POs & supplier bills", note: "Purchase orders with 3-way matching against deliveries and bills." },
    ],
    shot: {
      src: "/product-shots/cash.png",
      alt: "The CrewFlow cash position — collectable now, overdue, due this week and expected this month, with an honest note that it is not a live bank balance.",
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
    headline: "Your crew, vehicles and stock — organised and legal",
    summary:
      "Rota, timesheets and payroll for the team; MOT, insurance and inspections for the fleet; stock, suppliers and material requests for the stores.",
    capabilities: [
      { name: "Workforce", note: "Staff, rota, leave and timesheets with GPS clock-in." },
      { name: "Payroll", note: "Pay runs from clocked hours — PAYE/NI estimates, payslips, CSV export." },
      { name: "Fleet compliance", note: "MOT, tax, insurance and fuel — expiries flagged before they lapse." },
      { name: "Assets", note: "Register, inspections, service/calibration schedules and QR labels." },
      { name: "Stock & warehouses", note: "Stock items, locations and balances across the business." },
      { name: "Materials & suppliers", note: "Site material requests fulfilled from stock; supplier records." },
    ],
  },
  {
    slug: "automation",
    n: "06",
    label: "Automation & intelligence",
    eyebrow: "Automation & intelligence",
    headline: "The quiet work that happens without being asked",
    summary:
      "CrewFlow keeps watch on the things that quietly cost money when they're missed — and flags them before they do. Reliable, rule-based, and always yours to decide on.",
    capabilities: [
      { name: "Automatic reminders", note: "Overdue invoices, expiring certs and due inspections chased on their own." },
      { name: "Clash & risk signals", note: "Double-booked staff and cold quotes surfaced before they bite." },
      { name: "Company health", note: "Where the business stands, on one screen." },
      { name: "Reporting", note: "Profit, cashflow, utilisation and pipeline — on screen and as PDF/CSV." },
      { name: "Built-in workflows", note: "Event-driven rules that move work along without manual chasing." },
    ],
  },
];

export function pillarBySlug(slug: string): Pillar | undefined {
  return PILLARS.find((p) => p.slug === slug);
}
