import type { FeaturePage } from "./types";

/**
 * Feature / module pages. Each maps to a REAL CrewFlow capability seen in the
 * product (leads, quotes, jobs, rota, timesheets, invoices, payments,
 * profitability, expenses, payroll, tax, customer portal),
 * so nothing here overclaims. Each targets a distinct head keyword.
 */
export const FEATURES: FeaturePage[] = [
  {
    slug: "job-management-software",
    keyword: "construction job management software",
    secondaryKeywords: ["job management software for builders", "construction job tracking"],
    name: "Job management",
    navLabel: "Job management",
    title: "Construction Job Management Software",
    metaDescription:
      "Run every construction job from one screen — status, schedule, assigned crew, site photos and variations. CrewFlow keeps the whole job in one place. Book a demo.",
    eyebrow: "Jobs",
    h1: "Construction job management software that keeps the whole job in one place",
    intro:
      "Every job has a status, a scheduled date, a crew, a pile of site photos and — always — a variation no one wrote down. CrewFlow puts all of it on one screen, connected to the quote it came from and the invoice it turns into.\n\nNo more chasing the foreman for an update or hunting a phone for the photo that proves the extra work happened.",
    heroBullets: [
      "Job auto-created the moment a quote is accepted",
      "Status, schedule and assigned crew at a glance",
      "Site photos and documents attached to the job, not lost in WhatsApp",
      "Variations captured against the original job so nothing is done for free",
    ],
    problem: {
      heading: "Jobs live in five places at once",
      body: "The quote is in your email, the schedule is on a whiteboard, the photos are on three different phones, and the variation is a voice note you'll forget by Friday. When something goes wrong, you can't reconstruct what was agreed. CrewFlow makes the job the single record everything hangs off.",
    },
    sections: [
      {
        h2: "From accepted quote to finished job, without re-keying",
        body: "When a customer accepts a quote, CrewFlow creates the job automatically with the line items, value and customer already attached. You're never copying numbers between a quoting tool and a job tracker — the job knows where it came from.",
      },
      {
        h2: "Variations that actually get paid for",
        body: "Extra work is where construction margins quietly disappear. Log a variation against the job the moment it's agreed, with a value and a note, and it flows through to the invoice. The original quote stays intact so you can always see what changed and why.",
        bullets: [
          "Each variation has its own value and description",
          "Variations roll into the final invoice automatically",
          "The original scope is preserved for disputes",
        ],
      },
      {
        h2: "Site photos and documents on the job, for everyone",
        body: "Field staff attach photos and documents straight to the job from their phone. Back in the office, you see them against the right job instantly — proof of completion, before/after shots, delivery notes, sign-offs. One source of truth, not a group chat.",
      },
    ],
    outcomes: [
      { stat: "1", label: "screen per job", body: "Status, crew, schedule, photos, variations and value in one place." },
      { label: "Nothing done for free", body: "Variations captured the moment they happen and billed automatically." },
      { label: "Provable completion", body: "Photos and documents attached to the job, timestamped and searchable." },
    ],
    faqs: [
      { q: "Can I see all live jobs at once?", a: "Yes. The jobs view shows every active job with its status, scheduled date and assigned crew, so you always know what's on, what's late and who's where." },
      { q: "How are variations handled?", a: "Log a variation against the job with its own value and note. It's preserved separately from the original quote and rolls into the final invoice, so extra work always gets billed." },
      { q: "Do field staff need a separate app?", a: "No. Field staff get a mobile-first dashboard built for someone standing in a van — today's jobs, clock-in, and the ability to attach photos to the right job." },
      { q: "Does the job link to the quote and invoice?", a: "Yes — that's the point. A job is created from an accepted quote and becomes an invoice when the work is done, with the same customer, value and line items flowing through." },
    ],
    related: ["construction-crm", "quoting-software", "invoicing-software", "scheduling-software", "job-costing-software"],
    industries: ["builders", "electricians", "plumbers", "roofers"],
  },
  {
    slug: "construction-crm",
    keyword: "construction CRM",
    secondaryKeywords: ["builder CRM", "CRM for construction companies", "contractor CRM"],
    name: "CRM & leads",
    navLabel: "CRM",
    title: "Construction CRM Software",
    metaDescription:
      "A construction CRM built for how builders actually win work. Capture every enquiry, see your pipeline value, and turn leads into quotes and jobs. Book a demo.",
    eyebrow: "Leads & customers",
    h1: "A construction CRM that turns enquiries into won work",
    intro:
      "Most construction \"CRMs\" are generic sales tools bent to fit. CrewFlow's is built around how builders actually win jobs: an enquiry comes in, you quote it, you win it, you deliver it — and every step is connected.\n\nEvery lead is captured with its source, the service wanted and an expected value, so your pipeline forecast is real, not a guess.",
    heroBullets: [
      "Every enquiry captured with source, service and expected value",
      "Pipeline value on the dashboard so nothing slips",
      "Customer history — every quote, job, invoice and payment in one record",
      "Leads convert to quotes and jobs without re-typing anything",
    ],
    problem: {
      heading: "The lead you forgot is the job you lost",
      body: "An enquiry comes in while you're up a ladder. By the time you're down, it's gone — and so is the £8,000 job. Without a single place to capture and chase enquiries, the ones that don't shout loudest fall through. CrewFlow catches every one and reminds you to act.",
    },
    sections: [
      {
        h2: "Capture every enquiry the moment it lands",
        body: "Phone, form, referral or repeat customer — every enquiry becomes a lead with a source, the service they want and an expected value. You can see at a glance what's worth chasing first and where your work is actually coming from.",
      },
      {
        h2: "A pipeline forecast you can trust",
        body: "Because every lead has an expected value and stage, your dashboard shows the real shape of the pipeline — how much work is in play, what's likely to close and where the gaps are. Bid the right jobs instead of taking whatever comes.",
      },
      {
        h2: "One customer record for the whole relationship",
        body: "Open a customer and see everything: every enquiry, every quote, every job, every invoice and every payment. When Mrs Patel calls about the extension you did two years ago, you have the full history in front of you before she's finished her sentence.",
      },
    ],
    outcomes: [
      { label: "No lost enquiries", body: "Every lead captured and chased, not just the ones that shout loudest." },
      { stat: "£0", label: "guesswork in the pipeline", body: "Real expected values, not a number you made up for the bank." },
      { label: "Full customer history", body: "Every interaction in one record, ready when the phone rings." },
    ],
    faqs: [
      { q: "Is this a proper CRM or just a contact list?", a: "A proper CRM — but built for construction. Leads have sources, services and values; they move through stages; they convert into quotes and jobs. It's the operations layer of your business, not a Rolodex." },
      { q: "Can I see where my work comes from?", a: "Yes. Because every lead is tagged with a source, you can see which channels actually produce paying jobs and stop wasting money on the ones that don't." },
      { q: "Does it replace my spreadsheet of customers?", a: "Completely — and then some. Import your existing customers in minutes, and from then on every quote, job, invoice and payment attaches to the right customer automatically." },
    ],
    related: ["quoting-software", "job-management-software", "customer-portal"],
    industries: ["builders", "electricians", "plumbers"],
  },
  {
    slug: "quoting-software",
    keyword: "construction quoting software",
    secondaryKeywords: ["construction estimating software", "builder quoting software", "construction quotes"],
    name: "Quotes & estimates",
    navLabel: "Quoting",
    title: "Construction Quoting & Estimating Software",
    metaDescription:
      "Build line-item construction quotes with full VAT, send them as branded PDFs, and let customers accept online. CrewFlow turns accepted quotes into jobs. Book a demo.",
    eyebrow: "Quotes",
    h1: "Construction quoting software that wins the job and starts the work",
    intro:
      "A quote is the most important document your business sends — and the one most likely to be late, wrong or forgotten. CrewFlow lets you build proper line-item quotes with full VAT, send them as branded PDFs, and have the customer accept online.\n\nThe moment they accept, the job is created. No re-keying, no gap between winning the work and starting it.",
    heroBullets: [
      "Line-item quotes with full VAT, sent as branded PDFs",
      "Customers accept online through the portal",
      "Multi-stage approval gating for larger jobs",
      "Accepted quote becomes a job automatically",
    ],
    problem: {
      heading: "The quote you sent late is the job they gave someone else",
      body: "Quoting is where work is won and lost. A quote sent three days late, a number that doesn't include VAT, a follow-up that never happened — each one costs a job. CrewFlow makes quoting fast enough to do the same day and accurate enough to bill from.",
    },
    sections: [
      {
        h2: "Proper line-item quotes, not a number in a text",
        body: "Build quotes from line items — labour, materials, plant — with quantities, rates and full VAT calculated for you. The customer gets a clear, branded PDF that looks like a company that knows what it's doing, not a figure scribbled on the back of a job sheet.",
      },
      {
        h2: "Customers accept online, you get notified",
        body: "Send the quote and the customer can accept it in the portal. You know the moment it's accepted — and so does the system, which creates the job and carries the line items straight through. The loop from quote to work closes itself.",
      },
      {
        h2: "Approval gating for the big ones",
        body: "On larger jobs, mistakes are expensive. Multi-stage approval means a quote over a threshold gets a second set of eyes before it goes out, so the £40,000 quote isn't sent with a missing zero.",
      },
    ],
    outcomes: [
      { stat: "Same day", label: "quotes out the door", body: "Fast enough to send while you're still the company they're thinking about." },
      { label: "Bill from the quote", body: "Line items flow into the job and the invoice — quote once, use it three times." },
      { label: "Fewer costly errors", body: "Full VAT calculated and approval gating on big jobs." },
    ],
    faqs: [
      { q: "Can customers accept quotes online?", a: "Yes. Quotes are sent as branded PDFs and customers can accept through the customer portal. The moment they accept, CrewFlow creates the job automatically." },
      { q: "Does it handle VAT correctly?", a: "Yes. Quotes are built from line items with VAT calculated for you, so the figure the customer sees is the figure you can bill — no manual VAT maths." },
      { q: "What about large jobs that need sign-off?", a: "CrewFlow supports multi-stage approval gating, so quotes above a threshold you set need approval before they go out. It's a guardrail against expensive mistakes on big bids." },
      { q: "Is this estimating software too?", a: "It covers the quoting-and-estimating job that most construction SMEs need: line-item build-ups with labour, materials and margin. It's built for builders sending real quotes, not quantity surveyors doing formal BoQ takeoffs." },
    ],
    related: ["construction-crm", "job-management-software", "invoicing-software", "customer-portal", "job-costing-software"],
    industries: ["builders", "electricians", "plumbers", "roofers", "joiners"],
  },
  {
    slug: "invoicing-software",
    keyword: "construction invoicing software",
    secondaryKeywords: ["invoicing software for builders", "construction invoice software UK"],
    name: "Invoicing",
    navLabel: "Invoicing",
    title: "Construction Invoicing Software",
    metaDescription:
      "HMRC-compliant construction invoices with sequential numbering and automatic reminders at day 3, 7, 14 and 21. Get paid faster without the chasing. Book a demo.",
    eyebrow: "Invoices",
    h1: "Construction invoicing software that chases the money for you",
    intro:
      "Getting the work done is the easy part. Getting paid is where construction businesses bleed time and cash. CrewFlow issues HMRC-compliant invoices the moment a job is finished and chases them automatically until they're paid.\n\nNo more Sunday-night spreadsheet, no more wondering which invoices are overdue.",
    heroBullets: [
      "HMRC-compliant sequential numbering",
      "Automatic reminders at day 3, 7, 14 and 21",
      "Invoice raised straight from the finished job",
      "See exactly what's outstanding, always",
    ],
    problem: {
      heading: "Unpaid invoices are an interest-free loan to your customer",
      body: "Every overdue invoice is your money sitting in someone else's account. Most builders are too busy to chase consistently, so debts drift to 30, 60, 90 days. CrewFlow's automatic reminders do the chasing — politely, relentlessly — so cash comes in without you lifting a finger.",
    },
    sections: [
      {
        h2: "Invoice the moment the job is done",
        body: "The job already knows the customer, the line items and any variations. Turning it into an invoice is a click — no re-typing, no missed extras. The invoice goes out as a clean, branded PDF with HMRC-compliant sequential numbering and a full audit trail.",
      },
      {
        h2: "Reminders that chase so you don't have to",
        body: "CrewFlow sends payment reminders automatically at day 3, 7, 14 and 21. The customer who 'forgot' gets a nudge before it becomes a problem. Owners who switch this on consistently report materially more invoices paid on time.",
        bullets: [
          "Automatic escalation at 3, 7, 14 and 21 days",
          "Polite, professional wording that protects the relationship",
          "Stops the moment the invoice is marked paid",
        ],
      },
      {
        h2: "Always know what you're owed",
        body: "One number, always current: total outstanding. Drill in to see which invoices, which customers and how overdue. No spreadsheet, no surprises at quarter end.",
      },
    ],
    outcomes: [
      { stat: "22%", label: "more invoices paid on time", body: "Automatic day 3, 7, 14 and 21 reminders mean fewer overdue debts." },
      { label: "Zero chasing admin", body: "The system does the follow-up; you do the work." },
      { label: "HMRC-ready", body: "Sequential numbering and an audit trail on every invoice." },
    ],
    faqs: [
      { q: "Are the invoices HMRC-compliant?", a: "Yes. Invoices use sequential numbering with the required fields and a full audit trail of who changed what and when — exactly what HMRC expects." },
      { q: "How do the automatic reminders work?", a: "Once an invoice is sent, CrewFlow emails the customer reminders at day 3, 7, 14 and 21 if it's still unpaid. Reminders stop automatically the moment you mark it paid." },
      { q: "Can I raise an invoice from a job?", a: "Yes — that's the fast path. The job already has the customer, line items and variations, so creating the invoice is a click rather than a re-type." },
      { q: "Does CrewFlow take a cut of my invoices?", a: "No. CrewFlow doesn't process payments, so there's no card-processor skim and no per-invoice fee. You keep 100% of every invoice; CrewFlow just tracks whether it's been paid." },
    ],
    related: ["job-management-software", "payments-reconciliation", "quoting-software", "tax-software", "job-costing-software"],
    industries: ["builders", "plumbers", "electricians"],
  },
  {
    slug: "scheduling-software",
    keyword: "construction scheduling software",
    secondaryKeywords: ["construction rota software", "crew scheduling software", "construction staff scheduling"],
    name: "Scheduling & rota",
    navLabel: "Scheduling",
    title: "Construction Scheduling & Rota Software",
    metaDescription:
      "Plan the week, tie shifts to jobs, and see clashes before they happen. CrewFlow's construction rota links scheduling to jobs, leave and clock-in. Book a demo.",
    eyebrow: "Rota",
    h1: "Construction scheduling software that stops two crews turning up to one job",
    intro:
      "A double-booked crew is a day's wages paid for someone sitting in a van. CrewFlow's rota lets you plan the week, tie every shift to a job, and see clashes before they cost you.\n\nApproved leave blocks the rota automatically, and shifts connect to clock-in — so the schedule and reality stay in sync.",
    heroBullets: [
      "Plan the week and tie shifts to specific jobs",
      "See clashes and double-bookings before they happen",
      "Approved leave blocks the rota automatically",
      "Shifts connect to clock-in and timesheets",
    ],
    problem: {
      heading: "The whiteboard doesn't scale past one van",
      body: "A whiteboard or a group chat works until you've got three crews and a dozen live jobs. Then someone's double-booked, someone's on leave you forgot about, and a customer's waiting for a team that's across town. CrewFlow turns scheduling into something you can actually see and trust.",
    },
    sections: [
      {
        h2: "Plan the week against real jobs",
        body: "Build the rota by assigning crew to the jobs that need them. Because shifts are tied to jobs, you're not scheduling people into a void — you can see exactly who is on what, and which jobs still need bodies.",
      },
      {
        h2: "Clashes you catch before the customer does",
        body: "Assign someone who's already booked or on approved leave and CrewFlow shows the conflict immediately. Reassign in a couple of clicks. The double-booking that used to cost a day's wages never makes it out of the office.",
      },
      {
        h2: "Leave and clock-in that keep the rota honest",
        body: "Approved leave blocks the rota so you can't accidentally schedule someone who's off. And because shifts connect to clock-in, the plan and the actual hours worked line up — which is what makes payroll and job costing accurate.",
      },
    ],
    outcomes: [
      { label: "No double-bookings", body: "Clashes flagged before you assign, not after the van's left." },
      { label: "Leave-aware", body: "Approved time off blocks the rota automatically." },
      { label: "Plan meets reality", body: "Shifts tie to clock-in, so hours and schedule stay in sync." },
    ],
    faqs: [
      { q: "Can I tie shifts to specific jobs?", a: "Yes. The rota is built around jobs, so every shift is assigned to the work it's for. You can see which jobs are covered and which still need crew." },
      { q: "What happens with staff leave?", a: "Approved leave blocks the rota automatically, so you can't schedule someone who's booked off. It removes a whole class of avoidable scheduling mistakes." },
      { q: "Does scheduling connect to timesheets?", a: "Yes. Shifts connect to clock-in, so the planned rota and the actual hours worked stay aligned — which feeds straight into payroll and per-job costing." },
    ],
    related: ["timesheet-software", "job-management-software", "payroll-software", "construction-crm"],
    industries: ["builders", "electricians", "roofers", "groundworks"],
  },
  {
    slug: "timesheet-software",
    keyword: "construction timesheet software",
    secondaryKeywords: ["timesheet app for construction", "clock in app for builders", "construction time tracking"],
    name: "Timesheets",
    navLabel: "Timesheets",
    title: "Construction Timesheet Software",
    metaDescription:
      "GPS-stamped clock-in built for site. CrewFlow turns real hours into accurate payroll and true per-job labour cost — no paper timesheets, no guesswork. Book a demo.",
    eyebrow: "Timesheets",
    h1: "Construction timesheet software your crew will actually use",
    intro:
      "Paper timesheets are always late, always rounded up, and never tell you the true labour cost of a job. CrewFlow gives field staff a mobile-first clock-in with GPS stamping, built for someone standing on site — not a CFO at a desk.\n\nReal hours flow straight into payroll and per-job costing, so you finally know what each job actually cost in labour.",
    heroBullets: [
      "Mobile-first, GPS-stamped clock-in",
      "Built for field staff, big tap targets, works on any phone",
      "Hours flow into payroll automatically",
      "Real labour cost on every job",
    ],
    problem: {
      heading: "If you don't know your labour cost, you don't know your margin",
      body: "Labour is the biggest variable cost on most jobs, and paper timesheets hide it. Rounded-up hours, forgotten half-days and 'I think it was about three days' make true margin impossible. CrewFlow captures real hours at source so your costing is honest.",
    },
    sections: [
      {
        h2: "Clock-in built for the van, not the boardroom",
        body: "The staff dashboard is mobile-first with big tap targets and a GPS-stamped clock-in. Field staff see today's jobs, clock on and off, and get on with the work. No app-store faff, no training — if they can use a phone, they can use this.",
      },
      {
        h2: "Real hours, not rounded guesses",
        body: "Because clock-in is tied to jobs and shifts, the hours you pay for are the hours that were actually worked, on the actual job. That's the difference between a payroll run you trust and one you argue about every week.",
      },
      {
        h2: "Labour cost that makes job costing real",
        body: "Clocked hours flow into per-job profitability, so the margin you see reflects real labour, not an estimate. Suddenly you know which jobs to bid again and which to walk away from.",
      },
    ],
    outcomes: [
      { label: "Real labour cost", body: "Actual clocked hours on every job, not rounded guesses." },
      { label: "Payroll that adds up", body: "Hours flow straight into the pay run — no re-keying paper." },
      { stat: "GPS", label: "stamped clock-in", body: "Know the hours were logged on site, not from the sofa." },
    ],
    faqs: [
      { q: "Do staff need to install anything?", a: "No. The staff dashboard is a mobile-first web experience — open it on any phone and clock in. No app store, no setup, built for someone on site." },
      { q: "Is clock-in GPS-stamped?", a: "Yes. Clock-in is GPS-stamped so you know the hours were logged on site, which removes a whole category of timesheet disputes." },
      { q: "How do timesheets feed payroll?", a: "Clocked hours flow straight into the payroll run, so you're not re-keying paper timesheets and the pay run reflects real hours worked." },
      { q: "Do hours show up in job costing?", a: "Yes. Real clocked hours become real labour cost on each job, which is what makes per-job profitability accurate instead of an estimate." },
    ],
    related: ["scheduling-software", "payroll-software", "job-costing-software", "job-management-software"],
    industries: ["builders", "groundworks", "roofers", "electricians"],
  },
  {
    slug: "payroll-software",
    keyword: "construction payroll software",
    secondaryKeywords: ["payroll software for builders", "construction payroll UK", "subcontractor payroll"],
    name: "Payroll",
    navLabel: "Payroll",
    title: "Construction Payroll Software",
    metaDescription:
      "Run weekly or monthly construction payroll from real clocked hours. Gross, PAYE, NI and net, with payslip PDFs and CSV export. Built for UK construction. Book a demo.",
    eyebrow: "Payroll",
    h1: "Construction payroll software that runs from real hours",
    intro:
      "Construction payroll is weekly, it's messy, and it's full of people the generic tools don't handle well. CrewFlow runs payroll from the hours your crew actually clocked, calculates gross, PAYE, NI and net, and produces payslip PDFs that look the part.\n\nWeekly or monthly, CSV export for your accountant, and no re-keying paper timesheets into a separate system.",
    heroBullets: [
      "Weekly or monthly pay runs",
      "Gross, PAYE estimate, NI and net pay",
      "Per-staff payslip PDFs",
      "CSV export for your accountant",
    ],
    problem: {
      heading: "Payroll built for offices doesn't fit a building site",
      body: "Most payroll tools assume salaried staff paid monthly. Construction is weekly, hourly, and full of variation — different rates, different hours, every week. Doing it in a spreadsheet is slow and error-prone; doing it in office software is square-peg-round-hole. CrewFlow is built for how site pay actually works.",
    },
    sections: [
      {
        h2: "Pay from the hours that were actually worked",
        body: "Because timesheets and payroll are the same system, the pay run starts from real clocked hours — not a number someone typed off a paper sheet. Weekly or monthly, the hours are already there, tied to staff and jobs.",
      },
      {
        h2: "Gross to net, calculated for you",
        body: "CrewFlow works out gross pay, a PAYE estimate, National Insurance and net pay for each person. You get a clear pay run you can check and a payslip PDF for every member of staff that looks professional, not like a spreadsheet printout.",
      },
      {
        h2: "Hands off cleanly to your accountant",
        body: "Export the pay run as CSV for your accountant or bookkeeper. CrewFlow is the operations layer that captures the hours and runs the numbers; your accountant stays in the loop with a clean export rather than a shoebox of timesheets.",
      },
    ],
    outcomes: [
      { label: "Weekly without the dread", body: "Pay run starts from real hours, so Friday isn't a write-off." },
      { label: "Proper payslips", body: "Per-staff payslip PDFs that look the part." },
      { label: "Accountant-ready", body: "CSV export so month-end is a hand-off, not a rebuild." },
    ],
    faqs: [
      { q: "Does CrewFlow do weekly payroll?", a: "Yes. You can run payroll weekly or monthly — built for construction, where weekly hourly pay is the norm rather than the exception." },
      { q: "Does it calculate PAYE and NI?", a: "CrewFlow calculates gross pay, a PAYE estimate, National Insurance and net pay for each person, and produces a payslip PDF. For final filing your accountant uses the CSV export." },
      { q: "Where do the hours come from?", a: "Straight from clocked timesheets. Because time tracking and payroll are one system, you're never re-keying paper timesheets into separate payroll software." },
      { q: "Can my accountant get the data?", a: "Yes. Every pay run exports to CSV, so handing off to your accountant or bookkeeper is a clean export rather than a manual rebuild." },
    ],
    related: ["timesheet-software", "scheduling-software", "tax-software", "job-costing-software"],
    industries: ["builders", "groundworks", "electricians"],
  },
  {
    slug: "job-costing-software",
    keyword: "construction job costing software",
    secondaryKeywords: ["construction profitability software", "job profitability tracking", "construction margin tracking"],
    name: "Job costing & profit",
    navLabel: "Job costing",
    title: "Construction Job Costing Software",
    metaDescription:
      "See the true margin on every construction job — revenue minus materials minus real clocked labour. Know which jobs to bid again and which to walk from. Book a demo.",
    eyebrow: "Profitability",
    h1: "Construction job costing software that shows your real margin",
    intro:
      "Most builders find out a job lost money long after it's finished — if they ever find out at all. CrewFlow shows the true margin on every job: revenue minus materials minus real labour from clocked hours, updated as the job runs.\n\nGreen, amber and red bands tell you at a glance which jobs to bid again and which to never touch.",
    heroBullets: [
      "Per-job revenue minus costs minus real clocked labour",
      "Green / amber / red margin bands",
      "Updated as hours are clocked and materials logged",
      "Know which jobs and customers actually make money",
    ],
    problem: {
      heading: "You can't fix a margin you can't see",
      body: "If you're quoting the next job off gut feel because you don't actually know what the last one made, you're guessing with your livelihood. CrewFlow makes margin visible per job, so your next quote is informed by what really happened on the last one.",
    },
    sections: [
      {
        h2: "True cost, not estimated cost",
        body: "Job costing is only as good as its inputs. Because CrewFlow has the real clocked labour and the logged materials, the margin it shows is real — not a percentage you assumed when you quoted. That's the difference between costing and wishful thinking.",
      },
      {
        h2: "Margin you can see at a glance",
        body: "Every job carries a margin band — green, amber or red. Scan the list and instantly see which jobs are healthy and which are quietly losing money. No spreadsheet archaeology required.",
      },
      {
        h2: "Bid the next job from the truth",
        body: "When you can see that loft conversions make 34% and a certain type of job consistently bleeds, you bid differently. Job costing turns every finished job into intelligence for the next quote.",
      },
    ],
    outcomes: [
      { label: "Real margin per job", body: "Revenue minus materials minus actual clocked labour." },
      { stat: "RAG", label: "bands at a glance", body: "Green, amber, red — spot the loss-makers instantly." },
      { label: "Smarter bids", body: "Quote the next job knowing what the last one really made." },
    ],
    faqs: [
      { q: "How is margin calculated?", a: "Per job: revenue minus material costs minus real labour from clocked hours. Because the labour is actual clocked time, the margin is real rather than an estimate." },
      { q: "Does it update as the job runs?", a: "Yes. As hours are clocked and materials are logged, the job's margin updates — so you're not waiting until the job's finished to find out it lost money." },
      { q: "How do the colour bands work?", a: "Each job shows a green, amber or red margin band so you can scan a list of jobs and instantly see which are healthy and which need attention." },
    ],
    related: ["timesheet-software", "invoicing-software", "quoting-software", "expense-tracking", "tax-software"],
    industries: ["builders", "groundworks", "roofers"],
  },
  {
    slug: "expense-tracking",
    keyword: "construction expense tracking software",
    secondaryKeywords: ["construction expense app", "receipt tracking for builders", "materials cost tracking"],
    name: "Expenses",
    navLabel: "Expenses",
    title: "Construction Expense Tracking Software",
    metaDescription:
      "Capture materials, plant and receipts against the job they belong to, so costs land in job costing and nothing is lost before the accountant needs it. Book a demo.",
    eyebrow: "Expenses",
    h1: "Construction expense tracking that ties every cost to a job",
    intro:
      "A receipt in a glovebox is a cost you'll never recover and a margin you'll never know. CrewFlow captures expenses — materials, plant, fuel, subcontractors — against the job they belong to, so costs land where they matter: in job costing and in front of your accountant.",
    heroBullets: [
      "Log expenses against the specific job",
      "Materials and plant flow into job costing",
      "Nothing lost before the accountant needs it",
      "A real picture of what each job costs to run",
    ],
    problem: {
      heading: "Lost receipts are lost margin and lost tax relief",
      body: "Every receipt that doesn't make it into the system is a cost you can't attribute to a job and an expense you can't claim against tax. Multiply that across a year of glovebox receipts and it's real money. CrewFlow makes logging a cost quick enough that it actually happens.",
    },
    sections: [
      {
        h2: "Costs land on the job, automatically in your numbers",
        body: "Log a cost against the job it's for and it immediately becomes part of that job's costing. No month-end reconciliation guessing which receipt belonged to which job — the attribution happens when the cost is logged.",
      },
      {
        h2: "The other half of every margin",
        body: "Margin is revenue minus cost, and expenses are the cost side. Captured properly, they turn job costing from a rough estimate into a real number — and make sure you're claiming everything you're entitled to at tax time.",
      },
    ],
    outcomes: [
      { label: "Costs on the right job", body: "Attributed when logged, not guessed at month-end." },
      { label: "Nothing lost", body: "Receipts captured before they vanish into a glovebox." },
      { label: "True job cost", body: "The cost side of margin, captured properly." },
    ],
    faqs: [
      { q: "Can I log a cost against a specific job?", a: "Yes — that's the whole point. Every expense attaches to the job it belongs to, so it flows into that job's costing and your margin reflects real costs." },
      { q: "Does this help at tax time?", a: "Yes. Costs captured against jobs are costs you can account for and claim, rather than receipts lost in a van. It makes the hand-off to your accountant far cleaner." },
    ],
    related: ["job-costing-software", "invoicing-software", "tax-software", "payroll-software"],
    industries: ["builders", "groundworks", "roofers"],
  },
  {
    slug: "tax-software",
    keyword: "construction tax software",
    secondaryKeywords: ["VAT software for construction", "construction accounting software UK", "PAYE software builders"],
    name: "VAT & tax",
    navLabel: "Tax & VAT",
    title: "Construction Tax & VAT Software",
    metaDescription:
      "Keep VAT, PAYE, NI and Corporation Tax visible all year, not just at deadline. CrewFlow shows what's due and hands your accountant a clean quarterly PDF. Book a demo.",
    eyebrow: "Tax",
    h1: "Construction tax software that kills the deadline panic",
    intro:
      "Tax in construction is relentless: VAT every quarter, PAYE and NI every month, Corporation Tax once a year. CrewFlow keeps all of it visible as you go, so the figure on the dashboard is the figure you owe — not a number you scramble to reconstruct the weekend before it's due.\n\nWhen the deadline comes, your accountant gets a clean quarterly PDF instead of a shoebox.",
    heroBullets: [
      "VAT due, visible every quarter",
      "PAYE and NI tracked every month",
      "Corporation Tax for the year",
      "A quarterly PDF your accountant will thank you for",
    ],
    problem: {
      heading: "The deadline panic is a data problem",
      body: "The reason VAT weekend is hell is that the numbers live in five places and you're reconciling them under pressure. When invoicing, payroll and expenses are one system, the tax figure is just there — current, all year. The panic disappears because the data was never scattered.",
    },
    sections: [
      {
        h2: "Tax that's a side effect of doing the work",
        body: "Because your invoices, payroll and expenses already live in CrewFlow, the VAT, PAYE and Corporation Tax positions fall out of the data automatically. You're not doing tax as a separate, dreaded task — it's a running total you can see whenever you want.",
      },
      {
        h2: "A clean hand-off to your accountant",
        body: "At quarter end, CrewFlow produces a PDF your accountant can work from directly. They get clean numbers; you get a ten-minute call instead of a lost weekend. CrewFlow runs the operations; your accountant does the filing — with far less friction between you.",
      },
    ],
    outcomes: [
      { label: "No deadline scramble", body: "The figure's on the dashboard all year, not reconstructed under pressure." },
      { label: "Accountant-ready", body: "A clean quarterly PDF instead of a shoebox of receipts." },
      { label: "All three taxes", body: "VAT, PAYE/NI and Corporation Tax, tracked as you go." },
    ],
    faqs: [
      { q: "Which taxes does CrewFlow track?", a: "VAT each quarter, PAYE and National Insurance each month, and Corporation Tax for the year — the full UK construction tax calendar, visible as you go." },
      { q: "Does this replace my accountant?", a: "No, and it's not meant to. CrewFlow is the operations layer that keeps your tax position current and produces clean figures; your accountant does the filing. It makes their job easier and their bill lower." },
      { q: "What does my accountant actually get?", a: "A clean quarterly PDF they can work from directly, instead of reconciling scattered spreadsheets and receipts. It turns quarter-end into a short conversation." },
    ],
    related: ["invoicing-software", "payroll-software", "expense-tracking", "job-costing-software"],
    industries: ["builders", "electricians", "plumbers"],
  },
  {
    slug: "customer-portal",
    keyword: "construction customer portal",
    secondaryKeywords: ["client portal for builders", "construction client portal software"],
    name: "Customer portal",
    navLabel: "Customer portal",
    title: "Construction Customer Portal",
    metaDescription:
      "Give customers a clean portal to see quotes, accept them online, view jobs and check invoices — so you look professional and field fewer 'any update?' calls. Book a demo.",
    eyebrow: "Customer portal",
    h1: "A customer portal that makes a small firm look like a big one",
    intro:
      "Customers don't want to chase you for an update, and you don't want to take the call. CrewFlow gives each customer a clean portal where they can see their quotes, accept them online, view their jobs and check invoices.\n\nIt makes a two-van outfit look as buttoned-up as a national contractor — and cuts the 'any update?' calls to near zero.",
    heroBullets: [
      "Customers view and accept quotes online",
      "See job progress without calling you",
      "Check invoices and what's paid",
      "You control exactly what each customer sees",
    ],
    problem: {
      heading: "Looking professional wins the next job",
      body: "When a customer's choosing between you and another firm, the one that feels organised wins. A portal where they can see their quote, accept it and track the job signals a company that has its act together — which is worth more than any amount of marketing.",
    },
    sections: [
      {
        h2: "Self-service that saves you the call",
        body: "Most customer calls are 'did you get my acceptance?', 'when are you coming?' and 'have you sent the invoice?'. The portal answers all three without your phone ringing. Customers feel informed; you keep your day.",
      },
      {
        h2: "You decide what they see",
        body: "The portal exposes only what you choose — quotes, job status, invoices — and nothing else. It's professional and transparent without giving away anything you'd rather keep internal.",
      },
    ],
    outcomes: [
      { label: "Fewer chase calls", body: "Customers self-serve quotes, job status and invoices." },
      { label: "Look the part", body: "A two-van firm that feels like a national contractor." },
      { label: "You're in control", body: "Expose exactly what you want, nothing more." },
    ],
    faqs: [
      { q: "What can customers do in the portal?", a: "View and accept quotes, see the progress of their jobs, and check invoices and what's been paid — without having to call you for an update." },
      { q: "Do customers need an account or app?", a: "The portal is accessed through a secure link, so customers get a clean, professional experience without installing anything or managing yet another password." },
      { q: "Can I control what customers see?", a: "Yes. You decide what the portal exposes — quotes, job status, invoices — so it's transparent where you want it to be and private where you don't." },
    ],
    related: ["quoting-software", "construction-crm", "invoicing-software", "job-management-software"],
    industries: ["builders", "joiners", "roofers"],
  },
  {
    slug: "payments-reconciliation",
    keyword: "construction payment reconciliation software",
    secondaryKeywords: ["bank reconciliation for builders", "match payments to invoices", "construction bank CSV matching"],
    name: "Payment tracking",
    navLabel: "Payment tracking",
    title: "Construction Payment Reconciliation Software",
    metaDescription:
      "Upload your bank CSV and CrewFlow auto-matches payments to invoices by amount, reference and customer — reconcile in one click, keep 100% of every invoice. Book a demo.",
    eyebrow: "Payments",
    h1: "Construction payment reconciliation without the card-processor skim",
    intro:
      "UK construction runs on bank transfer, not card machines — so why pay a processor to skim every invoice? CrewFlow tracks payments instead of processing them. Upload your bank CSV and it auto-matches payments to invoices by amount, reference and customer name.\n\nConfirm in one click. Keep 100% of every invoice. No gateway fee, no monthly card charge.",
    heroBullets: [
      "Upload your bank CSV, payments auto-match to invoices",
      "Matched by amount, reference and customer name",
      "Confirm reconciliation in one click",
      "No payment processor, no per-invoice skim",
    ],
    problem: {
      heading: "Reconciliation is the admin no one wants to do",
      body: "Matching what landed in the bank to which invoice it paid is fiddly, manual and easy to put off — until you've no idea who's actually paid. CrewFlow does the matching for you from your bank CSV, so reconciliation is a one-click confirm instead of an afternoon with two windows open.",
    },
    sections: [
      {
        h2: "Your bank statement, matched to your invoices",
        body: "Export the CSV from your bank, upload it, and CrewFlow lines up each payment against the invoice it settles — using the amount, the reference and the customer name. The obvious matches are done for you; you just confirm.",
      },
      {
        h2: "Keep every penny of every invoice",
        body: "Because CrewFlow tracks bank-transfer payments rather than processing card payments, there's no processor taking a percentage and no monthly gateway fee. On a year of invoices, that's real money that stays in your business.",
      },
      {
        h2: "Always know who's actually paid",
        body: "Once payments are matched, your outstanding total is real — not a guess. Reminders stop on paid invoices automatically, so you never chase someone who's already settled up.",
      },
    ],
    outcomes: [
      { stat: "1 click", label: "to reconcile", body: "Auto-matched from your bank CSV — confirm and move on." },
      { stat: "£0", label: "processing fees", body: "Track bank transfers; no card-processor skim, no gateway fee." },
      { label: "Real outstanding total", body: "Know exactly who's paid and who hasn't." },
    ],
    faqs: [
      { q: "How does payment matching work?", a: "Upload your bank statement as a CSV and CrewFlow auto-matches each payment to the right invoice using the amount, reference and customer name. You confirm the matches in one click." },
      { q: "Does CrewFlow process card payments?", a: "No — and that's deliberate. UK construction runs on bank transfer, so CrewFlow tracks payments rather than processing them. There's no processor skim and no monthly gateway fee, so you keep 100% of every invoice." },
      { q: "What happens to reminders when a payment is matched?", a: "Automatic payment reminders stop the moment an invoice is matched as paid, so you never chase a customer who's already settled." },
    ],
    related: ["invoicing-software", "job-costing-software", "tax-software", "construction-crm"],
    industries: ["builders", "plumbers", "electricians"],
  },
];

export const FEATURE_BY_SLUG = new Map(FEATURES.map((f) => [f.slug, f]));

export function getFeature(slug: string): FeaturePage | undefined {
  return FEATURE_BY_SLUG.get(slug);
}
