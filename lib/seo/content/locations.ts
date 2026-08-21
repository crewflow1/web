import type { LocationPage } from "./types";

/**
 * Location pages → /construction-software/[slug].
 *
 * Location pages are the highest thin-content risk in programmatic SEO, so:
 *   (1) this is a curated set of REAL UK construction hubs, not 200 spun towns;
 *   (2) each has genuine, qualitative local context (no fabricated statistics);
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
      "CrewFlow is built in Belfast, by people who know the local trade. It's the operating system for construction companies — quotes, jobs, crews, invoices, payroll and tax in one place.\n\nFor Belfast firms, that means software made on your doorstep that understands UK tax, UK invoicing and how a real building business runs.",
    localContext:
      "Belfast's construction scene runs from residential refurb and extensions to commercial fit-out and a deep base of trade SMEs across Greater Belfast. CrewFlow is built here for exactly those businesses — small and growing construction firms that want one system instead of a drawer of apps.",
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
      "CrewFlow is built in Northern Ireland for construction companies across the province. It brings leads, quotes, jobs, rota, timesheets, invoices, payments, payroll and tax into one operating system.\n\nLocal software for local firms — that speaks UK tax and understands how NI construction businesses actually run.",
    localContext:
      "Northern Ireland's construction sector is built on owner-run SMEs — builders, electricians, plumbers, groundworks and fit-out firms across Belfast, Derry/Londonderry, Newry, Lisburn and the wider province. CrewFlow is made here for exactly those businesses.",
    faqs: [
      { q: "Is CrewFlow built in Northern Ireland?", a: "Yes — CrewFlow is built in Belfast for UK construction companies, with Northern Ireland firms as our home market." },
      { q: "Does it handle UK tax for NI businesses?", a: "Yes. VAT, PAYE, NI and Corporation Tax are tracked as you go, built for how UK and NI construction businesses are taxed." },
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
      "Lisburn and the surrounding area have a strong base of building, electrical, plumbing and groundworks firms serving both residential and commercial work across the Belfast travel-to-work area. CrewFlow is built nearby, for exactly these businesses.",
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
      "CrewFlow gives Newry construction businesses one operating system for leads, quotes, jobs, crews, invoices, payroll and tax. Built in Northern Ireland, it's local software that speaks UK tax and understands how a building business runs.",
    localContext:
      "Newry sits at the heart of a busy border-region construction economy, with general builders, groundworks and trade contractors serving both sides of the area. CrewFlow is built in NI for exactly this kind of owner-run firm.",
    faqs: [
      { q: "Can Newry construction firms use CrewFlow?", a: "Yes. CrewFlow is built for UK construction SMEs and made in Northern Ireland, so Newry firms get local, UK-tax-native software for the whole business." },
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
      "London construction firms juggle high job volumes, tight margins and demanding clients. CrewFlow brings the whole business into one system — leads, quotes, jobs, crews, invoices, payroll and tax — so a busy London firm can see exactly what's going on and where the money is.",
    localContext:
      "London's construction market is vast and varied — from high-end residential refurb and basement digs to commercial fit-out and a huge population of subcontractors and trade SMEs. CrewFlow gives those firms one operating system instead of five disconnected tools.",
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
      "Greater Manchester has one of the UK's most active construction economies, from city-centre development to residential refurb and a dense network of trade subcontractors. CrewFlow helps those SMEs run the operation from one place.",
    faqs: [
      { q: "Can Manchester firms get a CrewFlow demo?", a: "Yes. Book a demo and we'll show how CrewFlow brings quoting, jobs, payroll, invoicing and tax into one system for your Manchester firm." },
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
      "The West Midlands has a deep base of construction SMEs and subcontractors serving major regeneration, residential and commercial work. CrewFlow brings the whole operation into one place for those owner-run firms.",
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
      "Glasgow construction firms get the whole business in one place with CrewFlow — quotes, jobs, crews, invoices, payroll and tax. Built for UK construction, it handles the operations and the money side so owners can focus on the work.",
    localContext:
      "Glasgow and the west of Scotland have a strong construction base spanning residential refurb, commercial work and a large population of trade SMEs. CrewFlow gives those firms one operating system for the lot.",
    faqs: [
      { q: "Does CrewFlow work for Scottish construction firms?", a: "Yes. CrewFlow is built for UK construction companies, including Scotland, with UK VAT, PAYE and Corporation Tax handled as you go." },
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
      "Edinburgh's mix of heritage refurb and new development keeps construction firms busy. CrewFlow gives them one operating system for quotes, jobs, crews, invoices, payroll and tax — so the office side keeps pace with the site.",
    localContext:
      "Edinburgh construction spans listed-building and heritage refurbishment, high-end residential and commercial fit-out, supported by a network of specialist trade SMEs. CrewFlow brings the whole operation into one place.",
    faqs: [
      { q: "Can Edinburgh firms use CrewFlow?", a: "Yes. CrewFlow is built for UK construction SMEs, giving Edinburgh firms quoting, jobs, payroll, invoicing and tax in one UK-native system." },
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
      "Leeds anchors a busy West Yorkshire construction economy, with residential, commercial and a strong subcontractor base. CrewFlow gives those SMEs one operating system instead of disconnected tools.",
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
      "Bristol's construction market spans residential refurb, sustainable new build and commercial development, with a healthy base of trade SMEs across the South West. CrewFlow gives those firms one system for the whole operation.",
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
      "Cardiff and South Wales construction firms use CrewFlow to run leads, quotes, jobs, crews, invoices, payroll and tax from one place. Built for UK construction, it keeps the operations and the money in sync.",
    localContext:
      "Cardiff and the South Wales valleys have a strong construction base of builders, trades and contractors serving residential and commercial work. CrewFlow brings the whole operation into one UK-native system.",
    faqs: [
      { q: "Does CrewFlow work for Welsh construction firms?", a: "Yes. CrewFlow is built for UK construction companies, including Wales, with UK VAT, PAYE and Corporation Tax handled as you go." },
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
      "The North East construction economy spans residential refurb, regeneration and commercial work, with a strong network of trade SMEs across Tyne and Wear. CrewFlow brings the whole operation into one UK-native system.",
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
      "Sheffield anchors a busy South Yorkshire construction economy of builders, trades and contractors across residential and commercial work. CrewFlow gives those SMEs one operating system instead of disconnected tools.",
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
