import type { BlogPost } from "./types";

/**
 * Cornerstone blog posts / guides. Genuinely useful, link-worthy content
 * targeting informational keywords, the top of the funnel that links down
 * into the comparison and feature pages. Quality over quantity: a few strong
 * pillar articles beat fifty thin ones (and Google's helpful-content system
 * agrees).
 */
export const POSTS: BlogPost[] = [
  {
    slug: "best-construction-software-uk",
    keyword: "best construction software UK",
    title: "The Best Construction Software for UK Companies (2026)",
    metaDescription:
      "An honest guide to the best construction software for UK companies in 2026, what to look for, who each tool suits, and how to pick the right one for your firm.",
    h1: "The best construction software for UK companies in 2026",
    excerpt:
      "There's no single 'best' construction software, there's the best one for your business. Here's how to choose, and an honest look at the main options for UK firms.",
    datePublished: "2026-06-16",
    readMinutes: 9,
    category: "Buying guides",
    body: [
      { type: "p", text: "Search 'best construction software' and you'll get fifty listicles that rank whoever paid the most. This isn't one of those. We make CrewFlow, so we're not neutral, but the fastest way to lose your trust would be to pretend every other tool is rubbish. They're not. They're built for different businesses." },
      { type: "p", text: "So instead of a ranking, here's how to actually choose, and an honest read on who each of the main options suits best." },
      { type: "h2", text: "First, decide what 'software' you actually need" },
      { type: "p", text: "The biggest mistake UK construction firms make is buying a tool that solves one problem and discovering they now own five tools that don't talk to each other. Before you compare anything, get clear on which of these you need:" },
      { type: "ul", items: [
        "Winning work: capturing enquiries, quoting, following up (a construction CRM).",
        "Doing the work: jobs, scheduling, crews, site photos, variations (job management).",
        "The money: invoicing, payment tracking, per-job profitability.",
        "The people: timesheets, rota, payroll.",
        "The taxman: VAT, PAYE, Corporation Tax.",
      ] },
      { type: "p", text: "A sole trader might only need the first three. A growing firm with staff needs all five, and the more of them live in one system, the less time you lose copying numbers between apps." },
      { type: "h2", text: "The main options, honestly" },
      { type: "h3", text: "Enterprise platforms (Procore and similar)" },
      { type: "p", text: "Built for large general contractors running complex commercial projects. Powerful, but priced and designed for enterprise, usually overkill for an SME. If you're a 200-person main contractor, look here. If you're not, you'll pay for machinery you'll never switch on. (More detail: CrewFlow vs Procore.)" },
      { type: "h3", text: "US home-builder platforms (Buildertrend and similar)" },
      { type: "p", text: "Mature project-management and client-communication tools, but with their centre of gravity in the US residential market, which means they're not built for UK VAT, PAYE or Corporation Tax. Capable, but you'll be fitting a US-shaped tool to a UK business." },
      { type: "h3", text: "Field-service apps (Jobber, ServiceM8 and similar)" },
      { type: "p", text: "Excellent at the schedule-job-invoice loop for home-service businesses. If you're closer to field service than construction, lots of small call-outs, little job costing, no payroll, these are slick. Construction firms usually outgrow them once margins and payroll matter." },
      { type: "h3", text: "Trades job-management apps (Tradify, Powered Now and similar)" },
      { type: "p", text: "Light, friendly tools for quoting and invoicing, popular with sole traders and small trades. Powered Now has the advantage of being UK-built. Great to start with; many firms add spreadsheets for payroll and profitability as they grow." },
      { type: "h3", text: "Estimating-led tools (Buildxact and similar)" },
      { type: "p", text: "Strong if detailed takeoff and estimating is the heart of your business. Less focused on the whole-business operations around the estimate." },
      { type: "h3", text: "All-in-one UK operating systems (CrewFlow)" },
      { type: "p", text: "This is the category we built CrewFlow for: UK construction SMEs who want one system covering leads, quotes, jobs, rota, timesheets, invoices, payments, profitability, payroll and tax, instead of stitching five tools together. UK-native, transparent pricing, live in days." },
      { type: "h2", text: "How to make the final call" },
      { type: "ol", items: [
        "List the five needs above and tick the ones that apply to you today and in 12 months.",
        "Rule out anything not built for UK tax unless you're happy keeping tax entirely separate.",
        "Prefer one system over many, every integration is a thing that breaks.",
        "Insist on a demo using your own numbers, not a generic tour.",
        "Check how fast you can be live. Weeks of implementation is a cost too.",
      ] },
      { type: "p", text: "Whatever you choose, choose deliberately. The right construction software pays for itself in hours saved and invoices paid; the wrong one becomes another thing to log into." },
      { type: "cta", text: "Want to see what one system for the whole business looks like? Book a CrewFlow demo and we'll run it on your own numbers." },
    ],
    faqs: [
      { q: "What is the best construction software for a small UK firm?", a: "For a small UK firm that wants one system for the whole business, quotes, jobs, payroll, invoicing and tax, an all-in-one UK operating system like CrewFlow is usually the best fit. For sole traders who only need quoting and invoicing, a light trades app may be enough." },
      { q: "Do I need separate software for payroll and tax?", a: "Not necessarily. Some tools (like CrewFlow) include payroll from clocked hours and track VAT, PAYE and Corporation Tax in the same system, which avoids re-keying data between apps." },
      { q: "How much does construction software cost in the UK?", a: "It ranges from low monthly per-user app subscriptions to enterprise quote-based pricing. CrewFlow uses transparent pricing (£1,000 setup + £500/mo) aimed at SMEs who want everything in one place." },
    ],
    related: ["how-to-price-a-construction-job", "how-to-get-paid-faster-in-construction"],
    relatedFeatures: ["job-management-software", "construction-crm"],
  },
  {
    slug: "how-to-price-a-construction-job",
    keyword: "how to price a construction job",
    title: "How to Price a Construction Job (Without Losing Money)",
    metaDescription:
      "A practical guide to pricing construction jobs: how to build a quote from labour, materials and margin, account for VAT, and price the next job from real data.",
    h1: "How to price a construction job without losing money",
    excerpt:
      "Most builders lose money not on the jobs that go wrong, but on the ones they priced wrong from the start. Here's how to quote so the margin's actually there.",
    datePublished: "2026-06-16",
    readMinutes: 8,
    category: "How-to guides",
    body: [
      { type: "p", text: "The job that loses you money usually isn't the disaster, it's the ordinary one you priced on gut feel three weeks ago. Good pricing is boring and methodical, and it's the single biggest lever on whether your business makes money." },
      { type: "h2", text: "Start from cost, not from what you think they'll pay" },
      { type: "p", text: "Price up from your real costs, then add margin. Working backwards from 'what will they accept' is how you win jobs that aren't worth doing. There are three cost buckets:" },
      { type: "ul", items: [
        "Labour: the hours the job will take, at what each person actually costs you (including the on-costs, NI, holiday, not just the hourly rate).",
        "Materials: everything you'll buy in, with a sensible allowance for waste.",
        "Plant and other: hire, fuel, skips, subcontractors, anything job-specific.",
      ] },
      { type: "h3", text: "The number most people get wrong: labour" },
      { type: "p", text: "Labour is the biggest variable cost and the one people underestimate most. 'About three days' becomes five. The fix is to stop guessing and start measuring, track the real hours your crew spends on each job, so next time you're estimating from data, not optimism." },
      { type: "h2", text: "Add margin on purpose" },
      { type: "p", text: "Your margin isn't 'a bit on top'. Decide the percentage you need to run the business and make a profit, and add it deliberately. If you don't know your overheads, the van, the insurance, the phone, the hours you spend quoting, you can't know what margin you actually need." },
      { type: "h2", text: "Don't forget VAT (and get it right)" },
      { type: "p", text: "Quote with VAT handled properly so the figure the customer sees is the figure you can bill. Building quotes from line items with VAT calculated automatically removes a whole category of embarrassing corrections." },
      { type: "h2", text: "Send it fast and make it look the part" },
      { type: "p", text: "A quote sent the same day, as a clean branded PDF, wins work a scribbled figure sent next week doesn't. Speed and professionalism are part of the price, they signal a business that has its act together." },
      { type: "h2", text: "Then close the loop: price the next job from this one" },
      { type: "p", text: "Here's the part most firms skip. After the job, compare what it actually cost to what you quoted. Did the loft conversion really make 30%, or did labour run over and eat it? When you can see real per-job margin, every finished job makes your next quote sharper. That's how pricing compounds over time." },
      { type: "cta", text: "CrewFlow builds line-item quotes with VAT, then shows the real margin once the job's done, so your next quote is priced from what actually happened. Book a demo." },
    ],
    faqs: [
      { q: "What should a construction quote include?", a: "A proper construction quote breaks down labour, materials and plant as line items, applies VAT correctly, and adds your margin deliberately. Sending it as a clean branded PDF the customer can accept makes you look professional and creates a clear record of what was agreed." },
      { q: "How do I work out labour cost on a job?", a: "Use the real hours each person spends on the job multiplied by what they actually cost you (including on-costs like NI and holiday). Tracking real clocked hours rather than estimating is the single biggest improvement most firms can make to pricing accuracy." },
      { q: "How much margin should I add to a construction job?", a: "Enough to cover your overheads and make a profit, which means knowing your overheads first. There's no universal number, but pricing up from cost and adding a deliberate margin beats working backfrom what you hope the customer will pay." },
    ],
    related: ["best-construction-software-uk", "how-to-get-paid-faster-in-construction"],
    relatedFeatures: ["quoting-software", "job-costing-software", "timesheet-software"],
  },
  {
    slug: "how-to-get-paid-faster-in-construction",
    keyword: "how to get paid faster in construction",
    title: "How to Get Paid Faster in Construction",
    metaDescription:
      "Late payment is a construction epidemic. Here's a practical system for getting invoices paid faster, clear terms, fast invoicing, and relentless polite chasing.",
    h1: "How to get paid faster in construction",
    excerpt:
      "Every overdue invoice is an interest-free loan to your customer. Here's how to fix slow payment without becoming the firm that's always on the phone chasing.",
    datePublished: "2026-06-16",
    readMinutes: 7,
    category: "How-to guides",
    body: [
      { type: "p", text: "Late payment is the quiet killer of construction businesses. The work's done, the money's owed, and it's sitting in someone else's account while you cover wages and materials out of your own. Most of it is fixable with a system." },
      { type: "h2", text: "1. Set clear terms before you start" },
      { type: "p", text: "Payment terms agreed up front, on the quote, in writing, remove the 'I didn't realise' excuse. State when payment's due and what the stages are on bigger jobs. Ambiguity always works in the late payer's favour." },
      { type: "h2", text: "2. Invoice the moment the work is done" },
      { type: "p", text: "The clock only starts when you invoice, and every day you delay is a day added to when you get paid. Raising the invoice straight from the finished job, with the customer, line items and any variations already there, means it goes out same-day, not next-weekend." },
      { type: "h3", text: "Bill the variations" },
      { type: "p", text: "Extra work done and never charged is the most common way construction firms lose money. Capture every variation against the job the moment it's agreed, with a value, so it flows onto the invoice instead of into goodwill." },
      { type: "h2", text: "3. Chase relentlessly, but politely, and automatically" },
      { type: "p", text: "Most overdue invoices aren't refusals, they're 'forgot'. The firms that get paid fastest are the ones that follow up consistently. Doing that by hand is miserable and you won't keep it up. Automating reminders, a nudge at day 3, 7, 14 and 21, does the chasing for you, professionally, and stops the moment they pay." },
      { type: "ul", items: [
        "Day 3: a friendly 'just confirming you received this'.",
        "Day 7: a polite reminder it's due.",
        "Day 14: a firmer nudge.",
        "Day 21: escalation, before it becomes a real problem.",
      ] },
      { type: "h2", text: "4. Know exactly what you're owed, always" },
      { type: "p", text: "You can't chase what you can't see. One current number, total outstanding, broken down by customer and how overdue, turns 'I think a few invoices are late' into a list you can act on. No spreadsheet archaeology at quarter-end." },
      { type: "h2", text: "5. Make paying easy" },
      { type: "p", text: "UK construction runs on bank transfer. Put clear bank details on every invoice and a clean reference so the payment matches itself when it lands. The less friction between 'I should pay this' and 'paid', the faster the cash arrives." },
      { type: "p", text: "None of this is complicated. It's a system: clear terms, fast invoicing, automatic chasing, and a live view of what's owed. Run it consistently and the difference to your cashflow is immediate." },
      { type: "cta", text: "CrewFlow invoices straight from the job and chases payment automatically at day 3, 7, 14 and 21. Book a demo and see what it does to your outstanding total." },
    ],
    faqs: [
      { q: "Why do construction invoices get paid late?", a: "Usually a mix of unclear terms, slow invoicing, uncaptured variations, and inconsistent chasing, not outright refusal. Fixing the system (clear terms, same-day invoicing, automatic reminders) addresses most late payment." },
      { q: "How can I automate chasing unpaid invoices?", a: "Tools like CrewFlow send automatic payment reminders on a schedule (for example day 3, 7, 14 and 21) and stop as soon as the invoice is marked paid, so chasing happens consistently without you doing it by hand." },
      { q: "Should construction firms charge for late payment?", a: "UK businesses have a statutory right to claim interest on late commercial payments. Whether you enforce it is a commercial decision, but clear terms up front and consistent chasing usually prevent most lateness in the first place." },
    ],
    related: ["how-to-price-a-construction-job", "best-construction-software-uk"],
    relatedFeatures: ["invoicing-software", "payments-reconciliation"],
  },
  {
    slug: "cis-explained-for-subcontractors",
    keyword: "CIS explained",
    title: "The Construction Industry Scheme (CIS) Explained for Subcontractors",
    metaDescription:
      "A plain-English guide to the Construction Industry Scheme (CIS): who it applies to, how deductions work, and what contractors and subcontractors need to do.",
    h1: "The Construction Industry Scheme (CIS), explained",
    excerpt:
      "CIS confuses a lot of people in construction. Here's a plain-English overview of how the scheme works for contractors and subcontractors in the UK.",
    datePublished: "2026-06-16",
    readMinutes: 7,
    category: "Tax & compliance",
    body: [
      { type: "p", text: "The Construction Industry Scheme (CIS) is one of those bits of UK construction admin everyone has to deal with and few enjoy. This is a plain-English overview to help you understand how it works. It's general information, not tax advice, for your specific situation, talk to your accountant or check HMRC's guidance." },
      { type: "h2", text: "What is CIS?" },
      { type: "p", text: "CIS is an HMRC scheme under which contractors deduct money from subcontractors' payments and pass it to HMRC. Those deductions count towards the subcontractor's tax and National Insurance. It exists to reduce tax evasion in construction by collecting tax closer to source." },
      { type: "h2", text: "Who counts as a contractor and a subcontractor?" },
      { type: "ul", items: [
        "A contractor is a business that pays subcontractors for construction work (or spends a significant amount on construction as a business).",
        "A subcontractor is a business that carries out construction work for a contractor.",
        "Many businesses are both, they're paid by one firm as a subcontractor and pay others as a contractor.",
      ] },
      { type: "h2", text: "How do CIS deductions work?" },
      { type: "p", text: "When a contractor pays a registered subcontractor, they usually deduct a percentage from the labour element of the payment and send it to HMRC. The standard deduction rate is lower for subcontractors who are registered with CIS than for those who aren't, which is one big reason to register." },
      { type: "p", text: "Crucially, deductions normally apply to the labour part of an invoice, not materials. So separating labour and materials clearly on your invoices matters, it affects how much is deducted." },
      { type: "h2", text: "What contractors need to do" },
      { type: "ol", items: [
        "Register with HMRC as a contractor before taking on subcontractors.",
        "Verify subcontractors with HMRC to find the correct deduction rate.",
        "Make the right deduction and pay it to HMRC.",
        "Give subcontractors deduction statements and file monthly CIS returns.",
      ] },
      { type: "h2", text: "What subcontractors need to do" },
      { type: "ol", items: [
        "Register with HMRC as a CIS subcontractor (to get the lower deduction rate).",
        "Keep records of payments and deductions you've had taken.",
        "Reclaim or offset deductions through your tax return or, for limited companies, via payroll/CIS offsetting.",
      ] },
      { type: "h2", text: "Why clean records make CIS painless" },
      { type: "p", text: "Most CIS pain comes from messy records: invoices that don't split labour and materials, deduction statements that go missing, and a scramble at filing time. Keeping your invoicing clean and your payments tracked all year turns CIS from a monthly headache into a routine task, and makes your accountant's job (and bill) smaller." },
      { type: "p", text: "Note: CrewFlow keeps your invoicing, payments and tax records in order, which makes CIS admin and your accountant's job easier, but CIS filing itself is something you'll handle with HMRC and your accountant." },
      { type: "cta", text: "Keeping clean, all-year records is the foundation of painless CIS. See how CrewFlow keeps your invoicing, payments and tax in one place, book a demo." },
    ],
    faqs: [
      { q: "Who has to register for CIS?", a: "Contractors who pay subcontractors for construction work must register with HMRC before doing so. Subcontractors don't have to register, but registering gets them a lower deduction rate, so most do. This is general information, check HMRC guidance for your situation." },
      { q: "Are CIS deductions taken from materials?", a: "Generally CIS deductions apply to the labour element of a payment, not the cost of materials, which is why clearly separating labour and materials on invoices matters. Confirm specifics with your accountant or HMRC." },
      { q: "Does CrewFlow file CIS returns?", a: "CrewFlow keeps your invoicing, payments and tax records clean and in one place, which makes CIS admin much easier. The CIS filing itself is handled with HMRC and your accountant." },
    ],
    related: ["how-to-get-paid-faster-in-construction", "best-construction-software-uk"],
    relatedFeatures: ["invoicing-software", "tax-software"],
  },
];

export const POST_BY_SLUG = new Map(POSTS.map((p) => [p.slug, p]));

export function getPost(slug: string): BlogPost | undefined {
  return POST_BY_SLUG.get(slug);
}
