import type { LocationPage } from "./types";

/**
 * Location pages → /construction-software/[slug].
 *
 * Location pages are the highest thin-content risk in programmatic SEO, so:
 *   (1) this is a curated set of REAL UK construction hubs, not 200 spun towns;
 *   (2) each carries genuinely non-swappable local context — regional market
 *       character plus a TRUE, verifiable local factor where one exists
 *       (Scotland's building-warrant system, Wales's devolved building regs,
 *       NI cross-border trade, London's ULEZ, city Clean Air Zones). No
 *       fabricated statistics, no invented local proof, no overclaimed feature;
 *   (3) Belfast / Northern Ireland are weighted as the home market.
 * Scaling guidance + guardrails live in docs/seo/10-programmatic-seo.md.
 */
export const LOCATIONS: LocationPage[] = [
  {
    slug: "belfast",
    location: "Belfast",
    region: "Northern Ireland",
    keyword: "construction software Belfast",
    title: "Construction Software in Belfast",
    metaDescription:
      "CrewFlow is construction software built in Belfast for UK construction companies — quotes, jobs, payroll, invoices and tax in one place. Book a local demo.",
    eyebrow: "Belfast",
    h1: "Construction software built in Belfast, for construction companies everywhere",
    intro:
      "CrewFlow is built in Belfast, by people who know the local trade — the operating system construction companies use to run quotes, jobs, crews, invoices, payroll and tax in one place.\n\nFor Belfast firms that means software made on your doorstep, not a faceless overseas vendor, that speaks UK tax and understands how a real building business runs.",
    localContext:
      "Belfast's construction scene runs from residential refurb and extensions to commercial fit-out, carried by a deep base of owner-run trade SMEs across Greater Belfast. Being built here means we know that market first-hand — and because we're local, a demo is a genuine conversation about your business, not a call-centre script.",
    faqs: [
      { q: "Is CrewFlow a local Belfast company?", a: "Yes. CrewFlow is built in Belfast, Northern Ireland, for UK construction companies. Being local means we understand the trade here and you're not dealing with a faceless overseas vendor." },
      { q: "Can Belfast builders get a demo?", a: "Yes. Book a demo and we'll walk through your existing numbers and show what your dashboard would look like — we're on your doorstep." },
    ],
    related: ["northern-ireland", "lisburn", "newry"],
  },
  {
    slug: "northern-ireland",
    location: "Northern Ireland",
    region: "Northern Ireland",
    keyword: "construction software Northern Ireland",
    title: "Construction Software in Northern Ireland",
    metaDescription:
      "CrewFlow is construction software built in Northern Ireland — one system for quotes, jobs, payroll, invoices and tax. Made locally for NI construction firms. Book a demo.",
    eyebrow: "Northern Ireland",
    h1: "Construction software made in Northern Ireland for NI construction firms",
    intro:
      "CrewFlow is built in Northern Ireland for construction companies across the province — one operating system for leads, quotes, jobs, rota, timesheets, invoices, payments, payroll and tax.\n\nLocal software for local firms, that speaks UK tax and understands how NI construction businesses actually run.",
    localContext:
      "Northern Ireland's construction sector is built on owner-run SMEs — builders, electricians, plumbers, groundworks and fit-out firms across Belfast, Derry/Londonderry, Newry, Lisburn and the wider province. Many also take work across the border into the Republic, so keeping each job's costs, invoices and paperwork straight in one place matters more here than most.",
    faqs: [
      { q: "Is CrewFlow built in Northern Ireland?", a: "Yes — CrewFlow is built in Belfast for UK construction companies, with Northern Ireland firms as our home market." },
      { q: "Does it handle UK tax for NI businesses?", a: "Yes. VAT, PAYE, NI and Corporation Tax are tracked as you go, built for how UK and NI construction businesses are taxed." },
      { q: "We take work across the border — does that matter?", a: "CrewFlow keeps every job's costs, quotes and invoices in one place whichever side of the border the work is on, with the figures ready for your accountant to handle the VAT treatment." },
    ],
    related: ["belfast", "lisburn", "newry"],
  },
  {
    slug: "lisburn",
    location: "Lisburn",
    region: "Northern Ireland",
    keyword: "construction software Lisburn",
    title: "Construction Software in Lisburn",
    metaDescription:
      "CrewFlow is construction software for Lisburn firms — quotes, jobs, payroll, invoices and tax in one place. Built locally in Northern Ireland. Book a demo.",
    eyebrow: "Lisburn",
    h1: "Construction software for Lisburn builders and trades",
    intro:
      "CrewFlow gives Lisburn construction firms one system for the whole business — from the first enquiry to the final invoice and the tax that follows. Built just up the road in Belfast, it's local software that understands the trade.",
    localContext:
      "Lisburn sits inside the Belfast travel-to-work area, with a strong base of building, electrical, plumbing and groundworks firms working across the city and the surrounding towns. CrewFlow is built minutes away for exactly these firms — close enough that support is a local conversation, not a ticket in a queue.",
    faqs: [
      { q: "Is CrewFlow suitable for Lisburn trade businesses?", a: "Yes. From sole traders to growing firms, CrewFlow brings quoting, jobs, scheduling, invoicing, payroll and tax into one local, UK-built system." },
    ],
    related: ["belfast", "northern-ireland", "newry"],
  },
  {
    slug: "newry",
    location: "Newry",
    region: "Northern Ireland",
    keyword: "construction software Newry",
    title: "Construction Software in Newry",
    metaDescription:
      "CrewFlow is construction software for Newry firms — one system for quotes, jobs, payroll, invoices and tax. Built locally in Northern Ireland. Book a demo.",
    eyebrow: "Newry",
    h1: "Construction software for Newry builders and contractors",
    intro:
      "CrewFlow gives Newry construction businesses one operating system for leads, quotes, jobs, crews, invoices, payroll and tax. Built in Belfast, it's local software that understands a border-region building business.",
    localContext:
      "Newry sits on the border, and many firms here work on both sides of it — general builders, groundworks and trade contractors serving Northern Ireland and the Republic. That makes keeping every job's costs, invoices and paperwork in one clear place especially valuable, whichever side of the border the work is on.",
    faqs: [
      { q: "Can Newry construction firms use CrewFlow?", a: "Yes. CrewFlow is built for UK construction SMEs and made in Northern Ireland, so Newry firms get local, UK-tax-native software for the whole business." },
      { q: "Does CrewFlow suit firms working across the border?", a: "Yes — every job's costs, quotes and invoices live in one place regardless of which side of the border the work is on. CrewFlow keeps the figures straight; your accountant handles the VAT treatment." },
    ],
    related: ["belfast", "northern-ireland", "lisburn"],
  },
  {
    slug: "london",
    location: "London",
    region: "England",
    keyword: "construction software London",
    title: "Construction Software in London",
    metaDescription:
      "CrewFlow is construction software for London firms — quotes, jobs, payroll, invoices and tax in one place. Built for UK construction. Book a demo.",
    eyebrow: "London",
    h1: "Construction software for London builders and contractors",
    intro:
      "London construction firms juggle high job volumes, tight margins and demanding clients. CrewFlow brings the whole business into one system — leads, quotes, jobs, crews, invoices, payroll and tax — so a busy firm can see exactly what's on and where the money is.",
    localContext:
      "London's construction market is vast and varied — high-end residential refurb, basement digs, commercial fit-out and one of the country's densest populations of subcontractors and trade SMEs. With the ULEZ now covering every borough, running older vans is one more cost pressure on already-tight margins — another reason to see true, job-by-job profitability in one place rather than across five disconnected tools.",
    faqs: [
      { q: "Is CrewFlow suitable for London construction firms?", a: "Yes. CrewFlow is built for UK construction SMEs, and London firms benefit from having quoting, jobs, payroll, invoicing and tax in one system rather than juggling separate apps." },
      { q: "Does CrewFlow handle the volume of a busy London firm?", a: "Yes. CrewFlow is built to keep multiple live jobs, crews and invoices in one place, with automatic invoice chasing to keep cash moving on tight London margins." },
    ],
    related: ["manchester", "birmingham", "bristol"],
  },
  {
    slug: "manchester",
    location: "Manchester",
    region: "England",
    keyword: "construction software Manchester",
    title: "Construction Software in Manchester",
    metaDescription:
      "CrewFlow is construction software for Manchester firms — one system for quotes, jobs, payroll, invoices and tax. Built for UK construction. Book a demo.",
    eyebrow: "Manchester",
    h1: "Construction software for Manchester builders and trades",
    intro:
      "Manchester's construction boom means more work and more admin. CrewFlow gives Greater Manchester firms one operating system for the whole business — quote faster, schedule crews, track real margins and get paid, with payroll and tax built in.",
    localContext:
      "Greater Manchester is one of the UK's most active construction economies, from city-centre high-rise residential and regeneration to a dense network of trade subcontractors across the ten boroughs. CrewFlow helps those SMEs keep a high volume of live jobs moving from one place, so nothing slips between the site and the office.",
    faqs: [
      { q: "Can Manchester firms get a CrewFlow demo?", a: "Yes. Book a demo and we'll show how CrewFlow brings quoting, jobs, payroll, invoicing and tax into one system for your Greater Manchester jobs." },
    ],
    related: ["leeds", "sheffield"],
  },
  {
    slug: "birmingham",
    location: "Birmingham",
    region: "England",
    keyword: "construction software Birmingham",
    title: "Construction Software in Birmingham",
    metaDescription:
      "CrewFlow is construction software for Birmingham firms — quotes, jobs, payroll, invoices and tax in one place. Built for UK construction. Book a demo.",
    eyebrow: "Birmingham",
    h1: "Construction software for Birmingham builders and contractors",
    intro:
      "Birmingham and the wider West Midlands are a construction heartland. CrewFlow gives firms there one operating system for leads, quotes, jobs, crews, invoices, payroll and tax — so the admin stops eating into the work.",
    localContext:
      "The West Midlands has a deep base of construction SMEs and subcontractors serving major regeneration, residential and commercial work. Birmingham's Clean Air Zone also charges non-compliant vans in the city centre, so keeping a tight grip on vehicle and job costs matters — and that's exactly the picture CrewFlow puts in one place.",
    faqs: [
      { q: "Is CrewFlow right for a Birmingham construction business?", a: "Yes. CrewFlow is built for UK construction SMEs, giving Birmingham firms quoting, jobs, payroll, invoicing and tax in a single system." },
    ],
    related: ["london", "leeds", "bristol"],
  },
  {
    slug: "glasgow",
    location: "Glasgow",
    region: "Scotland",
    keyword: "construction software Glasgow",
    title: "Construction Software in Glasgow",
    metaDescription:
      "CrewFlow is construction software for Glasgow firms — one system for quotes, jobs, payroll, invoices and tax. Built for UK construction. Book a demo.",
    eyebrow: "Glasgow",
    h1: "Construction software for Glasgow builders and trades",
    intro:
      "Glasgow construction firms get the whole business in one place with CrewFlow — quotes, jobs, crews, invoices, payroll and tax — built for UK construction and the way Scottish firms work.",
    localContext:
      "Glasgow and the west of Scotland span residential refurb, commercial work and a large population of trade SMEs. Building work in Scotland runs on the building-warrant system rather than England's building control, and warranted jobs carry their own drawings, conditions and completion certificates — CrewFlow keeps that site paperwork, the RAMS and the certificates in one place against the job they belong to.",
    faqs: [
      { q: "Does CrewFlow work for Scottish construction firms?", a: "Yes. CrewFlow is built for UK construction companies, including Scotland, with UK VAT, PAYE and Corporation Tax handled as you go." },
      { q: "Does CrewFlow submit building warrants?", a: "No — building warrants go through your local authority. But CrewFlow keeps the drawings, site paperwork and certificates for the job together, so nothing is lost when your building-standards team needs it." },
    ],
    related: ["edinburgh", "manchester", "newcastle"],
  },
  {
    slug: "edinburgh",
    location: "Edinburgh",
    region: "Scotland",
    keyword: "construction software Edinburgh",
    title: "Construction Software in Edinburgh",
    metaDescription:
      "CrewFlow is construction software for Edinburgh firms — quotes, jobs, payroll, invoices and tax in one place. Built for UK construction. Book a demo.",
    eyebrow: "Edinburgh",
    h1: "Construction software for Edinburgh builders and contractors",
    intro:
      "Edinburgh's mix of heritage refurb and new development keeps construction firms busy. CrewFlow gives them one operating system for quotes, jobs, crews, invoices, payroll and tax — so the office keeps pace with the site.",
    localContext:
      "Edinburgh construction spans listed-building and heritage refurbishment, high-end residential and commercial fit-out. As across Scotland, work runs on the building-warrant system, and heritage jobs in particular carry extra drawings, conditions and certificates — CrewFlow keeps all of that site paperwork in one place against the job, so nothing goes missing between visits.",
    faqs: [
      { q: "Can Edinburgh firms use CrewFlow?", a: "Yes. CrewFlow is built for UK construction SMEs, giving Edinburgh firms quoting, jobs, payroll, invoicing and tax in one UK-native system." },
      { q: "Does CrewFlow suit heritage and listed-building work?", a: "Yes. Jobs with extra conditions, drawings and certificates keep all their paperwork in one place in CrewFlow, so the records for a listed or warranted job stay together." },
    ],
    related: ["glasgow", "london", "newcastle"],
  },
  {
    slug: "leeds",
    location: "Leeds",
    region: "England",
    keyword: "construction software Leeds",
    title: "Construction Software in Leeds",
    metaDescription:
      "CrewFlow is construction software for Leeds firms — one system for quotes, jobs, payroll, invoices and tax. Built for UK construction. Book a demo.",
    eyebrow: "Leeds",
    h1: "Construction software for Leeds builders and trades",
    intro:
      "Leeds and West Yorkshire firms use CrewFlow to run the whole business from one screen — quotes, jobs, crews, invoices, payroll and tax. Less admin, more visibility, and cash that keeps moving thanks to automatic invoice chasing.",
    localContext:
      "Leeds anchors a busy West Yorkshire construction economy — South Bank regeneration, commercial development and a strong residential and subcontractor base. CrewFlow gives those firms one operating system so a growing book of jobs doesn't turn into a drawer of disconnected apps.",
    faqs: [
      { q: "Is CrewFlow suitable for Leeds construction businesses?", a: "Yes. CrewFlow is built for UK construction SMEs, bringing quoting, jobs, payroll, invoicing and tax together for Leeds and West Yorkshire firms." },
    ],
    related: ["manchester", "sheffield"],
  },
  {
    slug: "bristol",
    location: "Bristol",
    region: "England",
    keyword: "construction software Bristol",
    title: "Construction Software in Bristol",
    metaDescription:
      "CrewFlow is construction software for Bristol firms — quotes, jobs, payroll, invoices and tax in one place. Built for UK construction. Book a demo.",
    eyebrow: "Bristol",
    h1: "Construction software for Bristol builders and contractors",
    intro:
      "Bristol and the South West keep construction firms busy across refurb, new build and commercial work. CrewFlow brings the whole business into one operating system — quotes, jobs, crews, invoices, payroll and tax — so owners spend less time on admin and more on the work.",
    localContext:
      "Bristol's construction market leans into sustainable and retrofit new build alongside residential refurb and commercial development across the South West. The city's Clean Air Zone charges older commercial vehicles in the centre, so keeping vehicle and job costs in one clear view helps protect margins — which is exactly what CrewFlow is for.",
    faqs: [
      { q: "Can Bristol firms get a demo of CrewFlow?", a: "Yes. Book a demo and we'll show how CrewFlow brings the whole business — quotes, jobs, payroll, invoicing and tax — into one system for your Bristol firm." },
    ],
    related: ["london", "cardiff", "birmingham"],
  },
  {
    slug: "cardiff",
    location: "Cardiff",
    region: "Wales",
    keyword: "construction software Cardiff",
    title: "Construction Software in Cardiff",
    metaDescription:
      "CrewFlow is construction software for Cardiff firms — one system for quotes, jobs, payroll, invoices and tax. Built for UK construction. Book a demo.",
    eyebrow: "Cardiff",
    h1: "Construction software for Cardiff builders and trades",
    intro:
      "Cardiff and South Wales construction firms use CrewFlow to run leads, quotes, jobs, crews, invoices, payroll and tax from one place — built for UK construction and how Welsh firms work.",
    localContext:
      "Cardiff and the South Wales valleys have a strong base of builders, trades and contractors across residential and commercial work. Building regulations are devolved in Wales and differ in places from England's, so CrewFlow keeps the site paperwork, RAMS and certificates for each job in one place — ready for whatever your building-control body needs.",
    faqs: [
      { q: "Does CrewFlow work for Welsh construction firms?", a: "Yes. CrewFlow is built for UK construction companies, including Wales, with UK VAT, PAYE and Corporation Tax handled as you go." },
      { q: "Building regs are devolved in Wales — does CrewFlow cope?", a: "Yes. CrewFlow isn't a building-control submission tool, but it keeps every job's drawings, site records, RAMS and certificates together, so the paperwork is ready whichever body signs the work off." },
    ],
    related: ["bristol", "london", "birmingham"],
  },
  {
    slug: "newcastle",
    location: "Newcastle",
    region: "England",
    keyword: "construction software Newcastle",
    title: "Construction Software in Newcastle",
    metaDescription:
      "CrewFlow is construction software for Newcastle and North East firms — one system for quotes, jobs, payroll, invoices and tax. Built for UK construction. Book a demo.",
    eyebrow: "Newcastle",
    h1: "Construction software for Newcastle builders and trades",
    intro:
      "Newcastle and the North East have a hard-working construction base, and CrewFlow gives those firms one operating system for the whole business — quotes, jobs, crews, invoices, payroll and tax. Less admin, clearer margins, faster cash.",
    localContext:
      "The North East runs on regeneration, riverside development along the Tyne and a strong network of trade SMEs across Tyne and Wear. CrewFlow brings that whole operation into one place, so owners spend less time chasing paper between the site and the office.",
    faqs: [
      { q: "Is CrewFlow suitable for North East construction firms?", a: "Yes. CrewFlow is built for UK construction SMEs, giving Newcastle and North East firms quoting, jobs, payroll, invoicing and tax in one system." },
    ],
    related: ["leeds", "glasgow", "sheffield"],
  },
  {
    slug: "sheffield",
    location: "Sheffield",
    region: "England",
    keyword: "construction software Sheffield",
    title: "Construction Software in Sheffield",
    metaDescription:
      "CrewFlow is construction software for Sheffield firms — one system for quotes, jobs, payroll, invoices and tax. Built for UK construction. Book a demo.",
    eyebrow: "Sheffield",
    h1: "Construction software for Sheffield builders and contractors",
    intro:
      "Sheffield and South Yorkshire construction firms use CrewFlow to run the whole business from one screen — quotes, jobs, crews, invoices, payroll and tax. Built for UK construction, it keeps the site and the office in sync.",
    localContext:
      "Sheffield anchors a South Yorkshire construction economy shaped by post-industrial regeneration, university and commercial development and a strong trade-contractor base. CrewFlow gives those SMEs one operating system instead of juggling separate tools for quoting, jobs, invoicing and payroll.",
    faqs: [
      { q: "Can Sheffield firms get a CrewFlow demo?", a: "Yes. Book a demo and we'll show how CrewFlow brings quoting, jobs, payroll, invoicing and tax into one system for your Sheffield firm." },
    ],
    related: ["leeds", "manchester", "newcastle"],
  },
];

export const LOCATION_BY_SLUG = new Map(LOCATIONS.map((l) => [l.slug, l]));

export function getLocation(slug: string): LocationPage | undefined {
  return LOCATION_BY_SLUG.get(slug);
}
