import type { IndustryPage } from "./types";

/**
 * Trade / industry pages. Each frames CrewFlow for a specific trade with
 * genuinely trade-specific pain points and workflow — not a find-replace of
 * the trade name. featuredModules link into the real /features pages.
 */
export const INDUSTRIES: IndustryPage[] = [
  {
    slug: "builders",
    trade: "Builders",
    keyword: "software for builders UK",
    secondaryKeywords: ["builders software", "general builder software", "construction software for builders"],
    title: "Software for Builders",
    metaDescription:
      "CrewFlow is the all-in-one software for UK builders — quotes, jobs, crews, invoices, payroll and tax in one place. Run the whole build from one screen. Book a demo.",
    eyebrow: "For builders",
    h1: "Software for builders that runs the whole business, not just the job",
    intro:
      "General building is a juggling act: multiple jobs, multiple crews, materials on order, customers wanting updates, and a VAT bill you'd rather not think about. CrewFlow puts the whole lot in one place so a busy builder can actually see what's going on.\n\nFrom the first enquiry to the final invoice — and the tax that follows — it's one system instead of five apps and three spreadsheets.",
    painPoints: [
      "Quotes sent late or forgotten while you're on site",
      "No real idea which finished jobs actually made money",
      "Crews double-booked across overlapping jobs",
      "Invoices unpaid because no one's chasing them",
      "VAT and payroll done in a weekend panic",
    ],
    sections: [
      {
        h2: "One screen for every live job",
        body: "See every job, its status, the crew on it and the photos from site. Variations get captured the moment they're agreed, so the extra work you do actually makes it onto the invoice instead of disappearing into goodwill.",
      },
      {
        h2: "Know the margin before you bid the next one",
        body: "CrewFlow shows real per-job profit — revenue minus materials minus actual clocked labour. So when you quote the next extension, you're pricing from what the last one really made, not a number you hope works out.",
      },
    ],
    featuredModules: ["job-management-software", "quoting-software", "job-costing-software", "payroll-software", "invoicing-software"],
    faqs: [
      { q: "Is CrewFlow good for a small building firm?", a: "Yes — it's built for UK construction companies of roughly 1–30 people. A small builder gets quoting, jobs, crews, invoices, payroll and tax in one system rather than juggling separate apps." },
      { q: "Can it handle multiple jobs and crews at once?", a: "That's the point. CrewFlow shows every live job and ties crews to jobs through the rota, flagging clashes before two teams turn up to the same site." },
      { q: "Does it deal with VAT and payroll?", a: "Yes. VAT, PAYE, NI and Corporation Tax are tracked as you go, and weekly or monthly payroll runs from your crews' clocked hours." },
    ],
    related: ["electricians", "plumbers", "roofers", "groundworks"],
  },
  {
    slug: "electricians",
    trade: "Electricians",
    keyword: "software for electricians",
    secondaryKeywords: ["electrical contractor software", "electrician CRM", "electrical business software UK"],
    title: "Software for Electricians",
    metaDescription:
      "CrewFlow helps UK electricians quote faster, schedule jobs, capture variations and get paid — with payroll and tax built in. One system for the whole job. Book a demo.",
    eyebrow: "For electricians",
    h1: "Software for electricians that gets you paid faster and quoting smarter",
    intro:
      "Electrical work swings between quick call-outs and big rewire and contract jobs — and the admin for both lands on the same desk. CrewFlow lets electricians quote on the spot, schedule the team, capture every variation and chase every invoice automatically.\n\nWith payroll and tax in the same system, the office side stops eating your evenings.",
    painPoints: [
      "Small call-outs that never get invoiced",
      "Variations on bigger jobs done and never charged",
      "Engineers' hours guessed instead of tracked",
      "Certificates and job photos scattered across phones",
      "Payroll and CIS-era admin swallowing the weekend",
    ],
    sections: [
      {
        h2: "Quote on site, win it before you've left",
        body: "Build a line-item quote with full VAT and send it as a branded PDF before you're back in the van. The customer accepts online and the job's created automatically — so the rewire you quoted at 10am is on the schedule by lunch.",
      },
      {
        h2: "Track real engineer hours, cost every job properly",
        body: "GPS-stamped clock-in captures the hours your engineers actually work on each job. Those hours feed payroll and job costing, so you know which contracts make money and which to price higher next time.",
      },
    ],
    featuredModules: ["quoting-software", "scheduling-software", "timesheet-software", "invoicing-software", "job-costing-software"],
    faqs: [
      { q: "Can electricians send quotes from site?", a: "Yes. Build a line-item quote with VAT and send it as a branded PDF from your phone. The customer can accept online, which creates the job automatically." },
      { q: "Does it track engineer time on each job?", a: "Yes — GPS-stamped clock-in records real hours per job, which flows into both payroll and per-job profitability." },
      { q: "Will it help me get the small call-outs invoiced?", a: "Yes. Raising an invoice from a job is a click, and automatic reminders chase payment at day 3, 7, 14 and 21 — so the small jobs don't slip through unbilled." },
    ],
    related: ["plumbers", "heating-engineers", "builders"],
  },
  {
    slug: "plumbers",
    trade: "Plumbers",
    keyword: "plumbing software UK",
    secondaryKeywords: ["software for plumbers", "plumbing CRM", "plumber business software"],
    title: "Plumbing Software (UK)",
    metaDescription:
      "CrewFlow is plumbing software for UK firms — quote jobs, schedule engineers, track call-outs and get paid, with payroll and tax built in. One system. Book a demo.",
    eyebrow: "For plumbers",
    h1: "Plumbing software that turns call-outs into cash, not admin",
    intro:
      "Plumbing is call-outs, quotes, parts and emergencies — often all before lunch. CrewFlow gives plumbing firms one place to capture the job, schedule the engineer, track the hours and invoice the customer, with the money side handled automatically.\n\nNo more lost dockets, no more 'did we invoice that one?'.",
    painPoints: [
      "Emergency call-outs that never make it onto an invoice",
      "Parts and materials not costed to the job",
      "Engineers' hours rounded up or lost",
      "Customers chased for payment by you, personally, on a Sunday",
      "No clear picture of which work is actually profitable",
    ],
    sections: [
      {
        h2: "Capture the job before the next one comes in",
        body: "Log the enquiry, quote it, schedule the engineer — all in one place. The AI receptionist can even catch the calls you miss while you're under a sink, so a busy day doesn't mean lost work.",
      },
      {
        h2: "Parts, hours and margin, all on the job",
        body: "Materials get logged against the job, engineer hours come from clock-in, and CrewFlow shows you the real margin. Suddenly you know whether your call-out pricing actually covers your costs.",
      },
    ],
    featuredModules: ["construction-crm", "ai-receptionist", "scheduling-software", "invoicing-software", "expense-tracking"],
    faqs: [
      { q: "Is CrewFlow suitable for a plumbing business?", a: "Yes. It handles call-outs, quotes, scheduling, parts, timesheets, invoicing and tax in one system — built for UK trade businesses including plumbing firms." },
      { q: "Can it catch calls I miss on a job?", a: "Yes. The AI receptionist captures enquiries when you can't pick up and drops them into your pipeline as leads, so busy days don't cost you work." },
      { q: "Will it show me which jobs make money?", a: "Yes. With parts logged to the job and engineer hours from clock-in, CrewFlow shows real per-job margin so you can price call-outs properly." },
    ],
    related: ["heating-engineers", "electricians", "builders"],
  },
  {
    slug: "roofers",
    trade: "Roofers",
    keyword: "roofing software UK",
    secondaryKeywords: ["roofing business software", "software for roofers", "roofing CRM"],
    title: "Roofing Software (UK)",
    metaDescription:
      "CrewFlow is roofing software for UK firms — quote from the ground, schedule crews, capture site photos and variations, and get paid. Payroll and tax included. Book a demo.",
    eyebrow: "For roofers",
    h1: "Roofing software that captures every job, every variation, every photo",
    intro:
      "Roofing lives and dies on weather, access and 'while we're up here' extras. CrewFlow gives roofing firms one place to quote, schedule the crew around the forecast, capture the before-and-after photos that win the next job, and bill the variations that usually get done for free.",
    painPoints: [
      "'While we're up here' extras done and never charged",
      "Crews stood down by weather with no easy reschedule",
      "Before/after photos lost across different phones",
      "Big quotes sent with a missing line and eaten as cost",
      "Labour cost on a job that's anyone's guess",
    ],
    sections: [
      {
        h2: "Variations and photos that protect your margin",
        body: "Capture every extra against the job the moment it's agreed, with a value, so it's billed not absorbed. Attach the site photos to the same job — proof of completion for the customer and a portfolio for the next quote.",
      },
      {
        h2: "Schedule crews around the weather, not the whiteboard",
        body: "Tie shifts to jobs and reshuffle the week when the forecast turns. Approved leave and clashes show before you assign, so a rained-off Tuesday becomes a reschedule, not a write-off.",
      },
    ],
    featuredModules: ["quoting-software", "job-management-software", "scheduling-software", "job-costing-software", "invoicing-software"],
    faqs: [
      { q: "Can I capture variations on roofing jobs?", a: "Yes — log each extra against the job with its own value the moment it's agreed, so the 'while we're up here' work is billed rather than done for free." },
      { q: "Where do site photos go?", a: "Straight onto the job. Before/after photos from any phone attach to the right job, giving you proof of completion and a portfolio for future quotes." },
      { q: "Does it help when weather disrupts the schedule?", a: "Yes. The rota ties crews to jobs and flags clashes and leave, so reshuffling a rained-off week is a couple of clicks rather than a redo." },
    ],
    related: ["builders", "groundworks", "scaffolding"],
  },
  {
    slug: "joiners",
    trade: "Joiners & carpenters",
    keyword: "joinery software",
    secondaryKeywords: ["software for joiners", "carpentry business software", "joinery business software"],
    title: "Joinery & Carpentry Software",
    metaDescription:
      "CrewFlow is software for joiners and carpenters — quote bespoke work, manage jobs, track materials and labour, and get paid. With payroll and tax built in. Book a demo.",
    eyebrow: "For joiners & carpenters",
    h1: "Joinery software that prices bespoke work and protects your margin",
    intro:
      "Bespoke joinery is hard to price and easy to lose money on — every job is different, materials vary, and the hours always run over the estimate. CrewFlow helps joiners and carpenters quote properly, track materials and labour against each job, and see the real margin so the next quote is sharper.",
    painPoints: [
      "Bespoke jobs underquoted because every one is different",
      "Timber and materials not costed back to the job",
      "Workshop and fitting hours that run over, unnoticed",
      "Customers wanting updates on long lead-time jobs",
      "Margin you only discover after the job's done",
    ],
    sections: [
      {
        h2: "Quote bespoke work with confidence",
        body: "Build line-item quotes that account for materials, workshop time and fitting, with full VAT. Send a branded PDF that reflects the quality of your work, and let the customer accept online so the job starts clean.",
      },
      {
        h2: "Keep the customer informed on long jobs",
        body: "Bespoke work has lead times, and customers get nervous. The customer portal lets them see their quote, job status and invoices without calling you — so you look organised and keep your workshop time for work.",
      },
    ],
    featuredModules: ["quoting-software", "job-costing-software", "customer-portal", "expense-tracking", "invoicing-software"],
    faqs: [
      { q: "Can CrewFlow handle bespoke joinery quotes?", a: "Yes. Build detailed line-item quotes covering materials, workshop time and fitting with full VAT, then send them as branded PDFs the customer can accept online." },
      { q: "Will it show me the real margin on a job?", a: "Yes. With materials logged to the job and hours from clock-in, CrewFlow shows real per-job profit — so you can spot the bespoke jobs that quietly lose money." },
      { q: "How do I keep customers updated on long jobs?", a: "The customer portal lets customers check their quote, job status and invoices themselves, which cuts the 'any update?' calls on long lead-time work." },
    ],
    related: ["builders", "electricians", "plasterers"],
  },
  {
    slug: "groundworks",
    trade: "Groundworks",
    keyword: "groundworks software",
    secondaryKeywords: ["groundwork software", "groundworks management software", "civils software UK"],
    title: "Groundworks Software",
    metaDescription:
      "CrewFlow is groundworks software for UK firms — manage plant and crews, track labour and materials, capture variations and cost every job. Payroll and tax included. Book a demo.",
    eyebrow: "For groundworks",
    h1: "Groundworks software that tracks plant, labour and margin on every job",
    intro:
      "Groundworks is heavy on plant, labour and subcontractors, and thin on margin if you don't watch it. CrewFlow helps groundworks firms schedule crews and plant, capture day-works and variations, and cost every job from real clocked hours — so a tight-margin trade stays in the black.",
    painPoints: [
      "Day-works and variations not captured, so not paid for",
      "Plant and crews scheduled on a whiteboard that's always wrong",
      "Labour the biggest cost and the least tracked",
      "Margins squeezed with no clear view of where",
      "Payroll for a fluctuating site crew every week",
    ],
    sections: [
      {
        h2: "Capture day-works before they're forgotten",
        body: "On groundworks, the extras are the margin. Log day-works and variations against the job with a value the moment they happen, so what you actually did on site is what you actually bill.",
      },
      {
        h2: "Cost every job from real hours",
        body: "Crews clock in with GPS stamping, and those hours become real labour cost on the job. For a trade where labour is the biggest variable, that's the difference between knowing your margin and guessing it.",
      },
    ],
    featuredModules: ["job-management-software", "scheduling-software", "timesheet-software", "job-costing-software", "payroll-software"],
    faqs: [
      { q: "Does CrewFlow handle day-works and variations?", a: "Yes. Day-works and variations are captured against the job with their own value the moment they're agreed, so site extras get billed rather than absorbed." },
      { q: "Can it cost jobs from real labour?", a: "Yes. GPS-stamped clock-in records real crew hours per job, which feeds per-job profitability — essential for a labour-heavy, tight-margin trade." },
      { q: "Will it run weekly payroll for a site crew?", a: "Yes. Payroll runs weekly from clocked hours, which suits a fluctuating site crew far better than monthly office payroll tools." },
    ],
    related: ["builders", "roofers", "scaffolding"],
  },
  {
    slug: "plasterers",
    trade: "Plasterers",
    keyword: "plastering software",
    secondaryKeywords: ["software for plasterers", "plastering business software"],
    title: "Plastering Software",
    metaDescription:
      "CrewFlow helps plastering firms quote by the job, schedule the team, track materials and get paid — with payroll and tax built in. One simple system. Book a demo.",
    eyebrow: "For plasterers",
    h1: "Plastering software that keeps the jobs flowing and the invoices paid",
    intro:
      "Plastering is fast-turnover work — lots of jobs, quick quotes, materials by the bag. CrewFlow keeps plastering firms on top of the flow: quote quickly, schedule the team across jobs, track materials, and chase every invoice automatically so cash keeps moving.",
    painPoints: [
      "High job volume that's hard to keep track of",
      "Quick quotes done verbally and disputed later",
      "Materials not costed to the job",
      "Invoices unpaid because you're onto the next job",
      "No view of which jobs are actually worth it",
    ],
    sections: [
      {
        h2: "Quote quickly, but on the record",
        body: "Even fast jobs deserve a proper quote. Build one in moments, send a branded PDF, and have it accepted online — so there's no dispute later about what was agreed, and the job's logged the moment it's won.",
      },
      {
        h2: "Keep cash moving across a busy schedule",
        body: "With lots of jobs turning over, invoicing slips. CrewFlow raises invoices from finished jobs in a click and chases them automatically at day 3, 7, 14 and 21, so you're not the one ringing round for money.",
      },
    ],
    featuredModules: ["quoting-software", "scheduling-software", "invoicing-software", "expense-tracking"],
    faqs: [
      { q: "Is CrewFlow worth it for high-volume plastering work?", a: "Yes — high volume is exactly where things slip. Fast quoting, job scheduling and automatic invoice chasing keep a busy plastering firm on top of cash and customers." },
      { q: "Can I quote quickly but still have a record?", a: "Yes. Build a proper line-item quote in moments and send it as a branded PDF the customer accepts online, so there's a clear record of what was agreed." },
    ],
    related: ["joiners", "builders", "electricians"],
  },
  {
    slug: "landscapers",
    trade: "Landscapers",
    keyword: "landscaping software UK",
    secondaryKeywords: ["landscaping business software", "software for landscapers", "garden landscaping software"],
    title: "Landscaping Software (UK)",
    metaDescription:
      "CrewFlow is landscaping software for UK firms — quote designs and maintenance, schedule crews, track materials and labour, and get paid. Payroll and tax built in. Book a demo.",
    eyebrow: "For landscapers",
    h1: "Landscaping software for design-build and maintenance crews alike",
    intro:
      "Landscaping spans one-off design-build projects and recurring maintenance, and the admin for both piles up fast. CrewFlow helps landscaping firms quote projects, schedule crews across sites, track plants, materials and labour, and keep the cash flowing whether the work is a patio or a weekly cut.",
    painPoints: [
      "Project and maintenance work juggled in the same diary",
      "Materials and plants not costed back to the job",
      "Crews spread across multiple sites with no clear plan",
      "Seasonal cashflow with invoices left unchased",
      "Margins on design-build projects that are hard to pin down",
    ],
    sections: [
      {
        h2: "Quote projects, schedule the crews",
        body: "Build proper quotes for design-build work, and schedule crews across multiple sites with the rota. Clashes and leave show before you assign, so you're not sending two people to one garden and none to another.",
      },
      {
        h2: "Track the margin on every project",
        body: "Plants, materials and labour get costed to the job, so you can see the real margin on a landscaping project — not just the invoice total. Price the next design-build from what the last one actually made.",
      },
    ],
    featuredModules: ["quoting-software", "scheduling-software", "job-costing-software", "invoicing-software", "expense-tracking"],
    faqs: [
      { q: "Does CrewFlow suit both projects and maintenance?", a: "Yes. Quote and manage one-off design-build projects and schedule recurring maintenance crews in the same system, with profitability tracked on the project work." },
      { q: "Can I track materials and plants on a job?", a: "Yes. Materials, plants and labour are costed against the job, so you see real project margin rather than just the invoice total." },
    ],
    related: ["groundworks", "builders", "joiners"],
  },
  {
    slug: "scaffolding",
    trade: "Scaffolding",
    keyword: "scaffolding software",
    secondaryKeywords: ["scaffolding management software", "software for scaffolders", "scaffold hire software"],
    title: "Scaffolding Software",
    metaDescription:
      "CrewFlow is scaffolding software for UK firms — quote erect/dismantle and hire, schedule crews, track jobs and inspections, and get paid. Payroll and tax built in. Book a demo.",
    eyebrow: "For scaffolding",
    h1: "Scaffolding software that keeps erect, hire and dismantle in order",
    intro:
      "Scaffolding has a rhythm — quote, erect, hire period, inspect, dismantle — and money leaks at every handover if it's tracked on paper. CrewFlow gives scaffolding firms one place to quote the job, schedule crews to erect and strike, keep the paperwork on the job, and invoice the hire so nothing's forgotten.",
    painPoints: [
      "Hire periods that run on without being billed",
      "Erect and dismantle crews scheduled by guesswork",
      "Inspection records scattered and hard to find",
      "Variations to the scaffold not captured or charged",
      "Jobs closed out before everything's invoiced",
    ],
    sections: [
      {
        h2: "Quote and schedule the whole cycle",
        body: "Quote the erect, hire and dismantle as line items, and schedule the crews for each phase. Because shifts tie to the job, you can see what's going up, what's on hire and what's coming down across all your sites.",
      },
      {
        h2: "Keep the paperwork on the job",
        body: "Attach inspection records and site photos to the job, so the documentation that keeps you compliant and protects you in a dispute is exactly where it should be — not in a folder in the van.",
      },
    ],
    featuredModules: ["quoting-software", "scheduling-software", "job-management-software", "invoicing-software"],
    faqs: [
      { q: "Can CrewFlow track hire periods?", a: "Yes. Quote and invoice erect, hire and dismantle as line items on the job, so hire periods get billed rather than quietly running on for free." },
      { q: "Where do inspection records go?", a: "Onto the job, alongside site photos — so compliance documentation is attached to the right job and easy to find when you need it." },
    ],
    related: ["groundworks", "roofers", "builders"],
  },
  {
    slug: "heating-engineers",
    trade: "Heating & gas engineers",
    keyword: "software for heating engineers",
    secondaryKeywords: ["gas engineer software", "heating business software UK", "HVAC software for trades"],
    title: "Software for Heating & Gas Engineers",
    metaDescription:
      "CrewFlow helps heating and gas engineers manage call-outs, quote installs, schedule jobs and get paid — with payroll and tax built in. One system. Book a demo.",
    eyebrow: "For heating & gas engineers",
    h1: "Software for heating engineers that runs call-outs and installs alike",
    intro:
      "Heating and gas work mixes quick service call-outs with bigger boiler and system installs — different jobs, same overloaded admin. CrewFlow gives heating engineers one place to capture call-outs, quote installs, schedule the day and get paid, with the money and compliance paperwork kept in order.",
    painPoints: [
      "Service call-outs that don't get invoiced",
      "Install quotes that take too long to send",
      "Engineer time and parts not tracked to the job",
      "Customers chasing for updates and certificates",
      "Weekly payroll for engineers done by hand",
    ],
    sections: [
      {
        h2: "Capture call-outs, quote the installs",
        body: "Log service call-outs fast and build proper line-item quotes for installs with full VAT. The AI receptionist catches the calls you miss on a job, so a busy day of breakdowns doesn't cost you the next install.",
      },
      {
        h2: "Get paid and keep the records straight",
        body: "Invoice from the job in a click, with automatic reminders chasing payment. Job photos and documents attach to the job, so the paperwork a customer or compliance check needs is in one place.",
      },
    ],
    featuredModules: ["ai-receptionist", "quoting-software", "scheduling-software", "invoicing-software", "timesheet-software"],
    faqs: [
      { q: "Does CrewFlow work for gas and heating engineers?", a: "Yes. It handles the mix of quick service call-outs and bigger installs — capturing jobs, quoting, scheduling, tracking time and parts, and invoicing, with payroll and tax in the same system." },
      { q: "Can it catch call-outs I miss on a job?", a: "Yes. The AI receptionist captures enquiries when you can't answer and creates leads in your pipeline, so breakdown-heavy days don't cost you new work." },
    ],
    related: ["plumbers", "electricians", "builders"],
  },
];

export const INDUSTRY_BY_SLUG = new Map(INDUSTRIES.map((i) => [i.slug, i]));

export function getIndustry(slug: string): IndustryPage | undefined {
  return INDUSTRY_BY_SLUG.get(slug);
}
