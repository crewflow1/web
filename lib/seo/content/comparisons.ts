import type { ComparisonPage } from "./types";

/**
 * Competitor comparison pages.
 *
 * Written to be HONEST, not just promotional, each includes a genuine
 * "where {competitor} is the better fit" section. That earns trust, satisfies
 * the search intent of someone genuinely comparing, and is exactly what
 * outranks thin "we win at everything" pages.
 *
 * Competitor cells describe publicly-known POSITIONING (enterprise vs SME,
 * origin, pricing model), not unverifiable per-feature claims. The template
 * surfaces `lastReviewed` with a "check their site for the latest" note.
 */

const REVIEWED = "2026-06-16";

export const COMPARISONS: ComparisonPage[] = [
  {
    slug: "crewflow-vs-procore",
    keyword: "Procore alternative UK",
    secondaryKeywords: ["CrewFlow vs Procore", "Procore for small builders"],
    competitor: {
      name: "Procore",
      oneLiner: "An enterprise construction management platform used by large general contractors and owners.",
      bestFor: "Large GCs and main contractors running complex, multi-stakeholder commercial projects.",
      origin: "United States",
    },
    title: "CrewFlow vs Procore",
    metaDescription:
      "Procore is enterprise construction software for large contractors. CrewFlow is the operating system for UK construction SMEs. Here's an honest comparison.",
    eyebrow: "Comparison",
    h1: "CrewFlow vs Procore: which fits a UK construction SME?",
    intro:
      "Procore is one of the biggest names in construction software, and it's built for big construction. If you're a UK SME running quotes, jobs, crews and invoices, the honest question isn't 'which is better', it's 'which is built for you'.",
    positioning:
      "Procore is an enterprise platform priced and designed for large general contractors managing complex commercial projects with many stakeholders. CrewFlow is the operating system for UK construction companies running roughly 1 to 30 people who want one tool for the whole business, from the first enquiry to the tax figures your accountant files.",
    rows: [
      { feature: "Built for", crewflow: "UK construction SMEs (1 to 30 staff)", competitor: "Large enterprise contractors" },
      { feature: "UK tax (VAT, PAYE, Corp Tax)", crewflow: "Built in", competitor: "Not a UK tax tool" },
      { feature: "Payroll from clocked hours", crewflow: "Included", competitor: "Not the focus" },
      { feature: "Per-job profitability", crewflow: "From real clocked labour", competitor: "Enterprise cost controls" },
      { feature: "Pricing", crewflow: "Transparent: £1,000 setup + £500/mo", competitor: "Enterprise quote" },
      { feature: "Time to go live", crewflow: "Days", competitor: "Weeks to months, often with onboarding services" },
    ],
    whereCompetitorWins: [
      "Large commercial projects with many subcontractors, RFIs, submittals and drawings management.",
      "Enterprises that need deep project controls, BIM workflows and a large app marketplace.",
      "Main contractors who need a platform their own subcontractors and clients will log into.",
    ],
    whereCrewflowWins: [
      "UK SMEs who want one system for leads, quotes, jobs, staff, invoices, payroll and tax.",
      "Owners who want transparent pricing, not an enterprise sales process.",
      "Teams who need to be live in days, not after a multi-week implementation.",
      "Businesses that want UK VAT, PAYE and Corporation Tax figures tracked natively.",
    ],
    verdict:
      "If you're a large contractor running complex commercial jobs, Procore is built for that world. If you're a UK construction SME who wants the whole business in one place without enterprise pricing or implementation, CrewFlow is built for you.",
    faqs: [
      { q: "Is CrewFlow a Procore alternative?", a: "For UK construction SMEs, yes. Procore targets large enterprise contractors; CrewFlow targets smaller UK construction companies who want one affordable system covering operations, finance, payroll and tax." },
      { q: "Is CrewFlow cheaper than Procore?", a: "CrewFlow has transparent pricing (£1,000 setup + £500/mo) aimed at SMEs, whereas Procore uses enterprise quote-based pricing. For a small UK firm, CrewFlow is built to be the affordable, complete option." },
      { q: "Can CrewFlow handle UK tax where Procore can't?", a: "Yes. CrewFlow tracks VAT, PAYE, NI and Corporation Tax natively for UK construction, which a US-origin enterprise platform like Procore isn't built to do." },
    ],
    related: ["crewflow-vs-buildertrend", "crewflow-vs-jobber", "crewflow-vs-simpro"],
    lastReviewed: REVIEWED,
  },
  {
    slug: "crewflow-vs-buildertrend",
    keyword: "Buildertrend alternative UK",
    secondaryKeywords: ["CrewFlow vs Buildertrend", "Buildertrend UK"],
    competitor: {
      name: "Buildertrend",
      oneLiner: "A US-origin construction project management platform popular with home builders and remodelers.",
      bestFor: "Residential home builders and remodelers, particularly in the US market.",
      origin: "United States",
    },
    title: "CrewFlow vs Buildertrend",
    metaDescription:
      "Buildertrend is built for US home builders and remodelers. CrewFlow is the operating system for UK construction companies, with UK tax built in. Compare.",
    eyebrow: "Comparison",
    h1: "CrewFlow vs Buildertrend: built for the UK, or built for the US?",
    intro:
      "Buildertrend is a capable project-management platform with deep roots in the US residential building market. The question for a UK firm is whether a US-shaped tool fits how you actually run, and get taxed, over here.",
    positioning:
      "Buildertrend focuses on residential construction project management and client communication, with its centre of gravity in the US market. CrewFlow is purpose-built for UK construction: it covers the same operational ground and adds UK-native finance, payroll and tax that a US platform isn't designed for.",
    rows: [
      { feature: "Primary market", crewflow: "United Kingdom", competitor: "United States" },
      { feature: "UK VAT, PAYE & Corp Tax", crewflow: "Built in", competitor: "Not built for UK tax" },
      { feature: "Payroll", crewflow: "Weekly/monthly, from clocked hours", competitor: "Not the focus in the UK" },
      { feature: "Bank-transfer payment tracking", crewflow: "Built in (UK works on bank transfer)", competitor: "Card-processor oriented" },
      { feature: "Per-job profitability", crewflow: "From real clocked labour", competitor: "Project budgeting" },
      { feature: "Pricing", crewflow: "£1,000 setup + £500/mo, transparent", competitor: "Tiered subscription (USD)" },
    ],
    whereCompetitorWins: [
      "US home builders and remodelers who want a mature, US-centric project and client-comms platform.",
      "Firms that want extensive selections/change-order workflows tuned to US residential building.",
      "Teams already embedded in the US construction software ecosystem.",
    ],
    whereCrewflowWins: [
      "UK firms that need VAT, PAYE and Corporation Tax figures tracked natively.",
      "Businesses that run on bank transfer and don't want card-processing baked into the model.",
      "Owners who want payroll and per-job profitability in the same system as jobs and invoices.",
      "Anyone who prefers transparent GBP pricing over USD tiers.",
    ],
    verdict:
      "Buildertrend is a strong choice for US residential builders. For a UK construction company that wants one system speaking UK tax, UK payroll and UK payment habits, CrewFlow is the native fit.",
    faqs: [
      { q: "Does Buildertrend work in the UK?", a: "It can be used in the UK, but it's designed around the US residential construction market and isn't built for UK VAT, PAYE or Corporation Tax. CrewFlow is purpose-built for UK construction." },
      { q: "What does CrewFlow add over Buildertrend for a UK firm?", a: "UK-native finance: VAT, PAYE and Corporation Tax tracking, weekly payroll from clocked hours, bank-transfer payment matching, and per-job profitability, all in the same system as your jobs and invoices." },
    ],
    related: ["crewflow-vs-procore", "crewflow-vs-jobber", "crewflow-vs-tradify"],
    lastReviewed: REVIEWED,
  },
  {
    slug: "crewflow-vs-jobber",
    keyword: "Jobber alternative UK",
    secondaryKeywords: ["CrewFlow vs Jobber", "Jobber for construction"],
    competitor: {
      name: "Jobber",
      oneLiner: "A well-known field-service management tool for home-service businesses.",
      bestFor: "Home-service trades (cleaning, landscaping, HVAC service) focused on scheduling and invoicing.",
      origin: "Canada",
    },
    title: "CrewFlow vs Jobber",
    metaDescription:
      "Jobber is great for home-service scheduling and invoicing. CrewFlow is a UK construction operating system with job costing, payroll and tax built in. Compare honestly.",
    eyebrow: "Comparison",
    h1: "CrewFlow vs Jobber: field-service tool or construction operating system?",
    intro:
      "Jobber is a polished, popular tool for home-service businesses, booking jobs, scheduling and invoicing. Construction shares some of that, but a building firm also lives or dies on job costing, payroll and UK tax, which is where the two diverge.",
    positioning:
      "Jobber is built for field-service businesses and excels at the schedule-job-invoice loop. CrewFlow is built specifically for UK construction and adds the things a building business needs beyond field service: per-job profitability from clocked labour, weekly payroll, and UK VAT/PAYE/Corporation Tax.",
    rows: [
      { feature: "Built for", crewflow: "UK construction companies", competitor: "Home-service businesses" },
      { feature: "Per-job profitability", crewflow: "From real clocked labour", competitor: "Not a core focus" },
      { feature: "UK payroll (PAYE, NI)", crewflow: "Built in", competitor: "Not included" },
      { feature: "VAT & Corporation Tax", crewflow: "Built in", competitor: "Not a tax tool" },
      { feature: "Variations on jobs", crewflow: "Captured and billed", competitor: "Service-job oriented" },
      { feature: "Market", crewflow: "United Kingdom", competitor: "North American" },
    ],
    whereCompetitorWins: [
      "Home-service businesses (landscaping, cleaning, appliance service) that want a slick scheduling-and-invoicing app.",
      "Solo operators and small service teams who don't need construction job costing or UK payroll.",
      "Businesses already happy in the North American field-service ecosystem.",
    ],
    whereCrewflowWins: [
      "Construction firms that need true per-job margin from real clocked labour.",
      "Anyone who wants weekly UK payroll in the same system as timesheets.",
      "UK businesses that need VAT, PAYE and Corporation Tax figures tracked natively.",
      "Builders who quote line-item jobs, capture variations and bill from them.",
    ],
    verdict:
      "If you run a home-service business and want clean scheduling and invoicing, Jobber is excellent. If you run UK construction and need job costing, payroll and tax in one place, that's exactly what CrewFlow is built for.",
    faqs: [
      { q: "Can I use Jobber for construction?", a: "You can, for the scheduling-and-invoicing part. But Jobber is built for home-service businesses, so you'd still need separate tools for per-job profitability, UK payroll and tax, which CrewFlow brings into one system." },
      { q: "What does CrewFlow do that Jobber doesn't?", a: "Construction-specific job costing from clocked labour, weekly UK payroll, VAT/PAYE/Corporation Tax tracking, and line-item quoting with variations billed through to invoices." },
    ],
    related: ["crewflow-vs-tradify", "crewflow-vs-servicem8", "crewflow-vs-procore"],
    lastReviewed: REVIEWED,
  },
  {
    slug: "crewflow-vs-tradify",
    keyword: "Tradify alternative",
    secondaryKeywords: ["CrewFlow vs Tradify", "Tradify for construction"],
    competitor: {
      name: "Tradify",
      oneLiner: "A job-management app for trade businesses, covering quoting, scheduling and invoicing.",
      bestFor: "Small trade businesses wanting a straightforward quote-schedule-invoice workflow.",
      origin: "New Zealand",
    },
    title: "CrewFlow vs Tradify",
    metaDescription:
      "Tradify handles quoting, scheduling and invoicing for small trades. CrewFlow goes further, payroll, profitability and UK tax in one construction operating system. Compare.",
    eyebrow: "Comparison",
    h1: "CrewFlow vs Tradify: job-management app or full operating system?",
    intro:
      "Tradify is a tidy job-management app that a lot of small trades like, quote, schedule, invoice, done. CrewFlow covers that same loop and keeps going into the parts of a construction business that usually still live in spreadsheets: payroll, profitability and tax.",
    positioning:
      "Tradify focuses on the core job-management workflow for trade businesses. CrewFlow is a broader operating system for UK construction, the same quote-job-invoice loop, plus weekly payroll from clocked hours, per-job profitability, bank-payment matching and UK tax, so fewer things end up back in a spreadsheet.",
    rows: [
      { feature: "Quote, schedule, invoice", crewflow: "Yes", competitor: "Yes" },
      { feature: "Per-job profitability", crewflow: "From real clocked labour", competitor: "Limited" },
      { feature: "UK payroll", crewflow: "Built in", competitor: "Not included" },
      { feature: "VAT & Corporation Tax", crewflow: "Built in", competitor: "Not a tax tool" },
      { feature: "Bank-transfer reconciliation", crewflow: "Auto-match from CSV", competitor: "Not a core focus" },
      { feature: "Scope", crewflow: "Whole-business operating system", competitor: "Job management" },
    ],
    whereCompetitorWins: [
      "Very small trade businesses that only want the core quote-schedule-invoice loop, simply.",
      "Sole traders who don't run payroll and don't need job costing.",
      "Teams that want the lightest possible tool and handle finance entirely with their accountant.",
    ],
    whereCrewflowWins: [
      "Firms with staff who need weekly payroll tied to clocked hours.",
      "Owners who want real per-job margin, not just invoices out the door.",
      "Businesses that want bank-transfer payments matched automatically.",
      "Anyone who wants VAT, PAYE and Corporation Tax visible all year.",
    ],
    verdict:
      "If you want a light job-management app and nothing more, Tradify does that well. If you want the whole construction business, operations, payroll, profitability and tax, in one system, CrewFlow is the broader fit.",
    faqs: [
      { q: "Is CrewFlow a Tradify alternative?", a: "Yes, and a broader one. CrewFlow covers the same quote-schedule-invoice workflow, then adds payroll, per-job profitability, bank reconciliation and UK tax that Tradify doesn't focus on." },
      { q: "Do I need CrewFlow if Tradify works for me?", a: "If you're a sole trader who only needs quoting and invoicing, Tradify may be enough. Once you've got staff to pay, margins to track and tax to stay on top of, CrewFlow brings all of that into one place." },
    ],
    related: ["crewflow-vs-jobber", "crewflow-vs-powered-now", "crewflow-vs-servicem8"],
    lastReviewed: REVIEWED,
  },
  {
    slug: "crewflow-vs-simpro",
    keyword: "Simpro alternative UK",
    secondaryKeywords: ["CrewFlow vs Simpro", "Simpro for small builders"],
    competitor: {
      name: "Simpro",
      oneLiner: "A field-service and project platform aimed at larger trade and maintenance contractors.",
      bestFor: "Larger field-service and maintenance contractors with complex workflows.",
      origin: "Australia",
    },
    title: "CrewFlow vs Simpro",
    metaDescription:
      "Simpro is powerful but heavy, aimed at larger trade contractors. CrewFlow is the faster-to-live operating system for UK construction SMEs. An honest comparison.",
    eyebrow: "Comparison",
    h1: "CrewFlow vs Simpro: power you'll use, or power you'll pay for?",
    intro:
      "Simpro is a deep, capable platform, and with depth comes complexity and a longer road to value. For a UK construction SME, the question is whether you need that much machinery, or a system you can be live on in days.",
    positioning:
      "Simpro targets larger field-service and maintenance contractors that need extensive, configurable workflows. CrewFlow targets UK construction SMEs that want the essential operating system, leads to tax, without a heavy implementation or features they'll never switch on.",
    rows: [
      { feature: "Built for", crewflow: "UK construction SMEs", competitor: "Larger field-service contractors" },
      { feature: "Time to go live", crewflow: "Days", competitor: "Longer implementation" },
      { feature: "UK tax (VAT, PAYE, Corp Tax)", crewflow: "Built in", competitor: "Not the focus" },
      { feature: "Per-job profitability", crewflow: "From real clocked labour", competitor: "Strong but complex" },
      { feature: "Learning curve", crewflow: "Designed for owners on site", competitor: "Steeper, configuration-heavy" },
      { feature: "Pricing", crewflow: "Transparent £1,000 + £500/mo", competitor: "Quote-based, scales with complexity" },
    ],
    whereCompetitorWins: [
      "Larger maintenance and field-service contractors with complex, high-volume workflows.",
      "Businesses that need deep configurability and have the time to implement it.",
      "Operations with dedicated admin staff to run a heavier system.",
    ],
    whereCrewflowWins: [
      "SMEs that want to be live in days, not after a long implementation.",
      "Owners who run the business from site and need something usable on a phone.",
      "UK firms wanting native VAT, PAYE and Corporation Tax.",
      "Teams that value transparent pricing over a complexity-scaled quote.",
    ],
    verdict:
      "Simpro suits larger contractors who need deep, configurable workflows and have the resource to run them. CrewFlow suits UK construction SMEs who want the essential operating system, live fast, without the weight.",
    faqs: [
      { q: "Is Simpro overkill for a small builder?", a: "It can be. Simpro is built for larger, complex field-service operations, which means more configuration and a longer road to value. CrewFlow gives a UK SME the essentials, leads to tax, and gets you live in days." },
      { q: "Does CrewFlow handle UK tax better than Simpro?", a: "CrewFlow is UK-native: VAT, PAYE, NI and Corporation Tax are built in for construction. Simpro's focus is field-service workflow rather than UK tax." },
    ],
    related: ["crewflow-vs-procore", "crewflow-vs-jobber", "crewflow-vs-servicem8"],
    lastReviewed: REVIEWED,
  },
  {
    slug: "crewflow-vs-servicem8",
    keyword: "ServiceM8 alternative",
    secondaryKeywords: ["CrewFlow vs ServiceM8", "ServiceM8 for construction"],
    competitor: {
      name: "ServiceM8",
      oneLiner: "A small-business field-service app, popular with micro trade businesses and strong on iOS.",
      bestFor: "Micro field-service businesses, especially Apple-device users wanting a light job app.",
      origin: "Australia",
    },
    title: "CrewFlow vs ServiceM8",
    metaDescription:
      "ServiceM8 is a light field-service app for micro trades. CrewFlow is a full UK construction operating system with payroll, profitability and tax. Compare honestly.",
    eyebrow: "Comparison",
    h1: "CrewFlow vs ServiceM8: light job app or whole-business system?",
    intro:
      "ServiceM8 is a neat, lightweight app a lot of micro trade businesses run their day on. CrewFlow is a heavier-duty proposition: a whole operating system for a construction business with staff, margins and UK tax to manage.",
    positioning:
      "ServiceM8 is built for very small field-service operators and is well known for its iOS experience. CrewFlow is built for UK construction companies that need more than a job app, payroll, per-job profitability, bank reconciliation and UK tax in one place, on any device.",
    rows: [
      { feature: "Built for", crewflow: "UK construction companies", competitor: "Micro field-service businesses" },
      { feature: "Device", crewflow: "Any phone or computer (web)", competitor: "Strong iOS focus" },
      { feature: "UK payroll", crewflow: "Built in", competitor: "Not included" },
      { feature: "Per-job profitability", crewflow: "From real clocked labour", competitor: "Limited" },
      { feature: "VAT & Corporation Tax", crewflow: "Built in", competitor: "Not a tax tool" },
      { feature: "Scope", crewflow: "Operating system", competitor: "Light job management" },
    ],
    whereCompetitorWins: [
      "Sole traders and micro businesses who want the lightest possible job app.",
      "Apple-device users who value ServiceM8's iOS experience specifically.",
      "Operators who don't run payroll and keep finance entirely with an accountant.",
    ],
    whereCrewflowWins: [
      "Construction firms with staff to pay and margins to manage.",
      "Teams on mixed devices who need a consistent web experience.",
      "UK businesses that want VAT, PAYE and Corporation Tax built in.",
      "Owners who want profitability and payroll in the same place as jobs.",
    ],
    verdict:
      "ServiceM8 is great if you're a micro operator who wants a light, iOS-first job app. CrewFlow is for construction businesses that have outgrown 'just a job app' and need the whole operation in one system.",
    faqs: [
      { q: "Is CrewFlow heavier than ServiceM8?", a: "It does more. ServiceM8 is a light job app for micro businesses; CrewFlow is a full operating system for construction firms with staff, payroll, profitability and UK tax to manage." },
      { q: "Does CrewFlow work on Android and desktop?", a: "Yes. CrewFlow is web-based and works on any phone or computer, where ServiceM8 has a strong iOS focus." },
    ],
    related: ["crewflow-vs-tradify", "crewflow-vs-jobber", "crewflow-vs-powered-now"],
    lastReviewed: REVIEWED,
  },
  {
    slug: "crewflow-vs-buildxact",
    keyword: "Buildxact alternative",
    secondaryKeywords: ["CrewFlow vs Buildxact", "Buildxact estimating"],
    competitor: {
      name: "Buildxact",
      oneLiner: "Estimating and job-management software with a strong takeoff and estimating focus for residential builders.",
      bestFor: "Residential builders who want detailed digital takeoff and estimating.",
      origin: "Australia",
    },
    title: "CrewFlow vs Buildxact",
    metaDescription:
      "Buildxact shines at takeoff and estimating. CrewFlow is the broader UK construction operating system, quoting, jobs, payroll, profitability and tax. Compare.",
    eyebrow: "Comparison",
    h1: "CrewFlow vs Buildxact: estimating depth or whole-business breadth?",
    intro:
      "Buildxact has a reputation for serious estimating and takeoff, measuring off plans, building detailed estimates. CrewFlow takes a different shape: line-item quoting that's fast for everyday jobs, plus the rest of the business around it.",
    positioning:
      "Buildxact leans into detailed estimating and takeoff for residential builders. CrewFlow covers practical line-item quoting and then extends across the whole business, jobs, staff, payroll, profitability, bank reconciliation and UK tax, rather than going deep on takeoff alone.",
    rows: [
      { feature: "Digital takeoff from plans", crewflow: "Practical line-item quoting", competitor: "Detailed takeoff focus" },
      { feature: "Whole-business scope", crewflow: "Leads to tax, one system", competitor: "Estimating + job management" },
      { feature: "UK payroll", crewflow: "Built in", competitor: "Not included" },
      { feature: "Per-job profitability", crewflow: "From real clocked labour", competitor: "Estimate vs actual" },
      { feature: "VAT & Corporation Tax", crewflow: "Built in", competitor: "Not a UK tax tool" },
      { feature: "Market", crewflow: "United Kingdom", competitor: "Australia / US / UK" },
    ],
    whereCompetitorWins: [
      "Builders who need detailed digital takeoff and measuring directly off plans.",
      "Estimating-heavy workflows where the estimate is the centre of the business.",
      "Firms that want the deepest possible estimating toolset specifically.",
    ],
    whereCrewflowWins: [
      "Firms that want fast everyday quoting plus the whole business around it.",
      "Teams who need payroll and per-job profitability, not just estimates.",
      "UK businesses that want VAT, PAYE and Corporation Tax built in.",
      "Owners who want one system from first enquiry to tax return.",
    ],
    verdict:
      "If detailed takeoff and estimating is the heart of your business, Buildxact is built for that. If you want practical quoting plus payroll, profitability, payments and UK tax in one operating system, CrewFlow is the broader fit.",
    faqs: [
      { q: "Does CrewFlow do estimating like Buildxact?", a: "CrewFlow does practical line-item quoting and estimating for everyday construction jobs. Buildxact goes deeper specifically on digital takeoff from plans. CrewFlow's strength is covering the whole business, not just the estimate." },
      { q: "Which is better for a UK builder?", a: "If your business revolves around detailed takeoff, Buildxact is strong. If you want quoting plus jobs, payroll, profitability and UK tax in one place, CrewFlow is purpose-built for UK construction." },
    ],
    related: ["crewflow-vs-tradify", "crewflow-vs-procore", "crewflow-vs-buildertrend"],
    lastReviewed: REVIEWED,
  },
  {
    slug: "crewflow-vs-powered-now",
    keyword: "Powered Now alternative",
    secondaryKeywords: ["CrewFlow vs Powered Now", "Powered Now for construction"],
    competitor: {
      name: "Powered Now",
      oneLiner: "A UK invoicing and job-management app for tradespeople and small field businesses.",
      bestFor: "UK sole traders and small trades wanting mobile invoicing and quotes.",
      origin: "United Kingdom",
    },
    title: "CrewFlow vs Powered Now",
    metaDescription:
      "Powered Now is a handy UK trades app for quotes and invoices. CrewFlow is a full UK construction operating system, payroll, profitability and tax included. Compare.",
    eyebrow: "Comparison",
    h1: "CrewFlow vs Powered Now: trades app or construction operating system?",
    intro:
      "Powered Now is a popular UK app for tradespeople who want quotes and invoices from their phone. CrewFlow is a bigger commitment for a bigger need: running an entire construction business, staff and finances included, from one system.",
    positioning:
      "Powered Now serves UK sole traders and small trades who mainly want mobile quoting and invoicing. CrewFlow serves UK construction companies that need the full operating system, CRM, jobs, rota, timesheets, payroll, profitability, payments and tax, as the business grows past one or two people.",
    rows: [
      { feature: "Quotes & invoices", crewflow: "Yes", competitor: "Yes" },
      { feature: "Both UK-built", crewflow: "Yes", competitor: "Yes" },
      { feature: "UK payroll from timesheets", crewflow: "Built in", competitor: "Not the focus" },
      { feature: "Per-job profitability", crewflow: "From real clocked labour", competitor: "Limited" },
      { feature: "Rota & scheduling", crewflow: "Tied to jobs and clock-in", competitor: "Lighter scheduling" },
      { feature: "Scope", crewflow: "Whole-business operating system", competitor: "Trades quoting/invoicing" },
    ],
    whereCompetitorWins: [
      "UK sole traders who mainly need quotes and invoices on their phone.",
      "Very small trades that don't run payroll or track per-job margin.",
      "Anyone wanting the lightest UK trades app to get started fast.",
    ],
    whereCrewflowWins: [
      "Growing firms with staff who need rota, timesheets and weekly payroll.",
      "Owners who want real per-job profitability, not just invoices.",
      "Businesses that want VAT, PAYE and Corporation Tax visible all year.",
      "Teams wanting one operating system instead of an app plus spreadsheets.",
    ],
    verdict:
      "Both are UK-built, which is a real advantage over US tools. Powered Now is great for a sole trader who wants mobile quotes and invoices. CrewFlow is for the construction firm that's outgrown that and needs the whole operation in one place.",
    faqs: [
      { q: "Are CrewFlow and Powered Now both UK-built?", a: "Yes, both are UK products, which matters for VAT, invoicing conventions and support. The difference is scope: Powered Now focuses on quotes and invoices; CrewFlow is a full construction operating system." },
      { q: "When should I move from Powered Now to CrewFlow?", a: "Typically when you take on staff and start needing rota, timesheets, weekly payroll and real per-job profitability, the point where a quoting-and-invoicing app stops being enough." },
    ],
    related: ["crewflow-vs-tradify", "crewflow-vs-servicem8", "crewflow-vs-jobber"],
    lastReviewed: REVIEWED,
  },
];

export const COMPARISON_BY_SLUG = new Map(COMPARISONS.map((c) => [c.slug, c]));

export function getComparison(slug: string): ComparisonPage | undefined {
  return COMPARISON_BY_SLUG.get(slug);
}
