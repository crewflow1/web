import type { Metadata } from "next";
import Link from "next/link";

import { Logo } from "@/components/ui/logo";
import { clashDisplay, satoshi } from "./_marketing/fonts";
import { MotionProvider, Reveal, CountUp } from "./_marketing/motion";
import { BookDemoCta } from "./_marketing/cta";
import { BookDemoModal } from "./(public)/_book-demo-modal";

import "./_marketing/marketing.css";

/**
 * CrewFlow marketing homepage — dark "Blueprint" theme.
 *
 * Server component (RSC) so the whole page is server-rendered for SEO and
 * speed; the only client islands are the motion primitives (<Reveal>),
 * the <BookDemoCta> buttons and the <BookDemoModal>. The funnel is
 * unchanged: every CTA dispatches the global `crewflow:open-book-demo`
 * event that the existing <BookDemoModal> (→ demo_requests action) listens
 * for. No mailto, no new endpoint.
 *
 * COPY DISCIPLINE: this page markets ONLY product behaviour that exists in
 * the codebase today. It deliberately does NOT claim call-answering /
 * missed-call capture, card payments, deposits / staged invoices, snagging,
 * live Xero/QuickBooks/Sage sync, a native app, or HMRC/MTD filing — none
 * of which are built. AI appears only as the verified "CrewFlow keeps
 * watch" layer (real retention/nudge signals), never as the brand.
 */

export const metadata: Metadata = {
  title: "CrewFlow. The operating system for UK construction companies.",
  description:
    "Win more jobs, cut the admin and know where every pound goes. Quotes, jobs, staff, payroll, VAT and invoices, all in one system built for UK builders.",
  alternates: { canonical: "/" },
};

/* Structured data (JSON-LD) for search engines: Organization + WebSite +
   SoftwareApplication. Static and server-rendered. Claims here are kept
   deliberately generic and true — no pricing/offer is asserted. */
const JSON_LD = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Organization",
      "@id": "https://crewflow.uk/#organization",
      name: "CrewFlow",
      url: "https://crewflow.uk",
      description: "The operating system for UK construction companies.",
      areaServed: "GB",
    },
    {
      "@type": "WebSite",
      "@id": "https://crewflow.uk/#website",
      url: "https://crewflow.uk",
      name: "CrewFlow",
      inLanguage: "en-GB",
      publisher: { "@id": "https://crewflow.uk/#organization" },
    },
    {
      "@type": "SoftwareApplication",
      name: "CrewFlow",
      applicationCategory: "BusinessApplication",
      operatingSystem: "Web",
      url: "https://crewflow.uk",
      description:
        "Quotes, jobs, staff, payroll, VAT and invoices in one system built for UK construction companies.",
    },
  ],
};

/* Browser chrome for the framed product shots. */
function Chrome({ url }: { url: string }) {
  return (
    <div className="mkt-bar">
      <span className="mkt-d" style={{ background: "#ff5f57" }} />
      <span className="mkt-d" style={{ background: "#febc2e" }} />
      <span className="mkt-d" style={{ background: "#28c840" }} />
      <span className="mkt-url">{url}</span>
    </div>
  );
}

/* CrewFlow brand mark: three descending bars on a navy tile. One logo
   across the whole product — geometry and colours match the favicon. */
/** Homepage mark — delegates to the shared design-system logo (one symbol). */
function LogoMark({ size = 30 }: { size?: number }) {
  return <Logo size={size} />;
}

const EM = "var(--emerald-2)";
const GO = "var(--gold-2)";
const RD = "var(--red)";

export default function HomePage() {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(JSON_LD) }}
      />
      <div
        className={`${clashDisplay.variable} ${satoshi.variable} mkt-page marketing-root`}
      >
        {/* No-JS / pre-hydration safety: framer renders reveal wrappers with
            inline opacity:0; force them visible if scripts never run. */}
        <noscript>
          <style>{`.mkt-reveal{opacity:1!important;transform:none!important;filter:none!important}`}</style>
        </noscript>

        <MotionProvider>
          {/* ===================== NAV ===================== */}
          <div className="mkt-hair" />
          <header className="mkt-nav">
            <div className="mkt-wrap mkt-navrow">
              <div className="mkt-brand">
                <span className="mkt-logo">
                  <LogoMark size={30} />
                </span>{" "}
                CrewFlow
              </div>
              <nav className="mkt-navlinks">
                <a href="#product">Product</a>
                <a href="#money">Money</a>
                <a href="#payroll">Payroll</a>
                <a href="#portal">Customers</a>
                <a href="#pricing">Pricing</a>
              </nav>
              <div className="mkt-navright">
                <Link className="mkt-signin" href="/login">
                  Sign in
                </Link>
                <BookDemoCta className="mkt-btn mkt-btn-gold mkt-btn-sm">
                  Book a demo
                </BookDemoCta>
              </div>
            </div>
          </header>

          {/* ===================== HERO ===================== */}
          <section className="mkt-wrap mkt-hero" id="hero">
            <Reveal className="mkt-center" y={18}>
              <span className="mkt-eyebrow">
                The operating system for UK construction
              </span>
              <h1>
                Run your whole construction business{" "}
                <span className="mkt-accent">from one place.</span>
              </h1>
              <p className="mkt-lead">
                Win more jobs, cut the admin, and know where every pound goes.
                Quotes, jobs, staff, payroll, VAT and invoices, all in one
                system built for builders.
              </p>
              <div className="mkt-hero-cta">
                <BookDemoCta className="mkt-btn mkt-btn-gold">
                  Book a demo
                </BookDemoCta>
                <a className="mkt-btn mkt-btn-ghost" href="#product">
                  See how it works →
                </a>
              </div>
              <div className="mkt-trust">
                <span>
                  <i className="mkt-dotg" /> VAT figures worked out for you
                </span>
                <span>
                  <i className="mkt-dotg" /> Built in the UK
                </span>
                <span>
                  <i className="mkt-dotg" /> Set up in days, not months
                </span>
              </div>
            </Reveal>

            {/* HERO PRODUCT: Dashboard */}
            <Reveal className="mkt-shotwrap" delay={0.1} y={30} blur={6}>
              <div className="mkt-shot">
                <Chrome url="app.crewflow.uk/dashboard" />
                <div className="mkt-app">
                  <aside className="mkt-side">
                    <div className="mkt-sb">
                      <span className="mkt-logo">
                        <LogoMark size={22} />
                      </span>{" "}
                      CrewFlow
                    </div>
                    <a className="mkt-on">
                      <span className="mkt-gi" /> Dashboard
                    </a>
                    <a>
                      <span className="mkt-gi" /> Leads
                    </a>
                    <a>
                      <span className="mkt-gi" /> Quotes
                    </a>
                    <a>
                      <span className="mkt-gi" /> Jobs
                    </a>
                    <a>
                      <span className="mkt-gi" /> Staff
                    </a>
                    <a>
                      <span className="mkt-gi" /> Payroll
                    </a>
                    <a>
                      <span className="mkt-gi" /> Invoices
                    </a>
                    <a>
                      <span className="mkt-gi" /> Reports
                    </a>
                    <a>
                      <span className="mkt-gi" /> Settings
                    </a>
                  </aside>
                  <div className="mkt-main">
                    <div className="mkt-apptop">
                      <div>
                        <div className="mkt-ttl">Good evening, Mark</div>
                        <div className="mkt-sub">
                          Here’s where the business stands this month
                        </div>
                      </div>
                      <div
                        style={{
                          display: "flex",
                          gap: 10,
                          alignItems: "center",
                        }}
                      >
                        <span className="mkt-search">Search jobs, quotes…</span>
                        <span className="mkt-av">MK</span>
                      </div>
                    </div>
                    <div className="mkt-kgrid">
                      <div className="mkt-kc">
                        <div className="mkt-v">
                          <CountUp value={12} duration={1.1} />
                        </div>
                        <div className="mkt-l">Leads</div>
                      </div>
                      <div className="mkt-kc">
                        <div className="mkt-v">
                          <CountUp value={8} duration={1.1} />
                        </div>
                        <div className="mkt-l">Quotes out</div>
                      </div>
                      <div className="mkt-kc">
                        <div className="mkt-v">
                          <CountUp value={5} duration={1.1} />
                        </div>
                        <div className="mkt-l">Live jobs</div>
                      </div>
                      <div className="mkt-kc">
                        <div className="mkt-v mkt-g">
                          <CountUp value={42180} prefix="£" duration={1.6} />
                        </div>
                        <div className="mkt-l">Outstanding</div>
                      </div>
                      <div className="mkt-kc">
                        <div className="mkt-v mkt-e">
                          <CountUp value={31} suffix="%" duration={1.4} />
                        </div>
                        <div className="mkt-l">Net margin</div>
                        <div className="mkt-dl">▲ 4% vs last mo</div>
                      </div>
                    </div>
                    <div className="mkt-cols2">
                      <div className="mkt-panel">
                        <h5>
                          Active jobs{" "}
                          <span className="mkt-pill mkt-p-em">5 on track</span>
                        </h5>
                        <table className="mkt-tbl">
                          <thead>
                            <tr>
                              <th>Job</th>
                              <th className="mkt-hidem">Stage</th>
                              <th>Value</th>
                              <th>Margin</th>
                            </tr>
                          </thead>
                          <tbody>
                            <tr>
                              <td>
                                Kitchen Extension{" "}
                                <span className="mkt-s">· Belfast</span>
                              </td>
                              <td className="mkt-hidem">
                                <span className="mkt-pill mkt-p-bl">
                                  In progress
                                </span>
                              </td>
                              <td className="mkt-mono">£34,500</td>
                              <td className="mkt-mono" style={{ color: EM }}>
                                38%
                              </td>
                            </tr>
                            <tr>
                              <td>
                                New Build{" "}
                                <span className="mkt-s">· Ballymena</span>
                              </td>
                              <td className="mkt-hidem">
                                <span className="mkt-pill mkt-p-bl">
                                  In progress
                                </span>
                              </td>
                              <td className="mkt-mono">£182,000</td>
                              <td className="mkt-mono" style={{ color: EM }}>
                                24%
                              </td>
                            </tr>
                            <tr>
                              <td>
                                Commercial Fit-Out{" "}
                                <span className="mkt-s">· Newry</span>
                              </td>
                              <td className="mkt-hidem">
                                <span className="mkt-pill mkt-p-em">
                                  Accepted
                                </span>
                              </td>
                              <td className="mkt-mono">£96,400</td>
                              <td className="mkt-mono" style={{ color: EM }}>
                                28%
                              </td>
                            </tr>
                            <tr>
                              <td>
                                Loft Conversion{" "}
                                <span className="mkt-s">· Lisburn</span>
                              </td>
                              <td className="mkt-hidem">
                                <span className="mkt-pill mkt-p-go">
                                  Quote sent
                                </span>
                              </td>
                              <td className="mkt-mono">£25,980</td>
                              <td className="mkt-mono" style={{ color: GO }}>
                                35%
                              </td>
                            </tr>
                          </tbody>
                        </table>
                      </div>
                      <div className="mkt-panel">
                        <h5>
                          Cash in{" "}
                          <span
                            className="mkt-s"
                            style={{ color: "var(--faint)" }}
                          >
                            last 7 mo
                          </span>
                        </h5>
                        <div className="mkt-bars">
                          <i style={{ height: "44%" }} />
                          <i style={{ height: "58%" }} />
                          <i style={{ height: "50%" }} />
                          <i className="mkt-e" style={{ height: "72%" }} />
                          <i style={{ height: "62%" }} />
                          <i className="mkt-e" style={{ height: "88%" }} />
                          <i style={{ height: "70%" }} />
                        </div>
                        <div
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            marginTop: 12,
                            fontSize: 12,
                          }}
                        >
                          <span
                            className="mkt-s"
                            style={{ color: "var(--faint)" }}
                          >
                            This month
                          </span>
                          <span
                            className="mkt-mono"
                            style={{ fontWeight: 700, color: EM }}
                          >
                            £18,400 ▲12%
                          </span>
                        </div>
                      </div>
                    </div>
                    <div className="mkt-panel" style={{ marginTop: 14 }}>
                      <h5>
                        CrewFlow is watching{" "}
                        <span className="mkt-pill mkt-p-go">4 need a look</span>
                      </h5>
                      <div className="mkt-tasks">
                        <div className="mkt-t">
                          <span
                            className="mkt-tdot"
                            style={{ background: "var(--gold)" }}
                          />
                          <div>
                            <b>Doyle quote unopened for 4 days.</b> QUO-1042 ·
                            £25,980. Worth a follow-up call.
                          </div>
                        </div>
                        <div className="mkt-t">
                          <span
                            className="mkt-tdot"
                            style={{ background: "var(--red)" }}
                          />
                          <div>
                            <b>INV-088 is 21 days overdue.</b> £4,200 · M.
                            Hughes. Second reminder ready to send.
                          </div>
                        </div>
                        <div className="mkt-t">
                          <span
                            className="mkt-tdot"
                            style={{ background: "var(--red)" }}
                          />
                          <div>
                            <b>VAT due Monday.</b> £6,820 set aside, figure
                            ready for your accountant.
                          </div>
                        </div>
                        <div className="mkt-t">
                          <span
                            className="mkt-tdot"
                            style={{ background: "#7fb2e6" }}
                          />
                          <div>
                            <b>Public liability cert expires in 21 days.</b>{" "}
                            Renew before it lapses.
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </Reveal>
          </section>

          {/* ===================== SUNDAY NIGHT (signature) ===================== */}
          <section className="mkt-section mkt-sunday" id="sunday">
            <div className="mkt-wrap">
              <Reveal className="mkt-center">
                <div style={{ maxWidth: 680, margin: "0 auto" }}>
                  <span className="mkt-eyebrow">Sunday · 21:47</span>
                  <h2>
                    You didn’t start a building firm to spend Sunday night doing
                    admin.
                  </h2>
                  <p className="mkt-lead" style={{ marginTop: 16 }}>
                    The missed calls, the “any update?” texts, the VAT deadline,
                    Friday’s wages. By the time you’ve made the list, you’ve lost
                    the evening. Here’s the same Sunday, with CrewFlow already on
                    it.
                  </p>
                </div>
              </Reveal>
              <Reveal className="mkt-sun-grid">
                <div className="mkt-phone">
                  <div className="mkt-notch" />
                  <div className="mkt-scr">
                    <div className="mkt-lk">
                      <div className="mkt-dy">Sunday</div>
                      <div className="mkt-tm">21:47</div>
                    </div>
                    <div className="mkt-noti">
                      <div className="mkt-i mkt-i-rd">✦</div>
                      <div style={{ flex: 1 }}>
                        <div className="mkt-ap">
                          <span>Website</span>
                          <span>now</span>
                        </div>
                        <div className="mkt-mn">
                          New enquiry · extension, Ballymena
                        </div>
                      </div>
                    </div>
                    <div className="mkt-noti">
                      <div className="mkt-i mkt-i-gn">✺</div>
                      <div style={{ flex: 1 }}>
                        <div className="mkt-ap">
                          <span>WhatsApp</span>
                          <span>21:32</span>
                        </div>
                        <div className="mkt-mn">
                          Dave: “Any update on our quote?”
                        </div>
                      </div>
                    </div>
                    <div className="mkt-noti">
                      <div className="mkt-i mkt-i-rd">!</div>
                      <div style={{ flex: 1 }}>
                        <div className="mkt-ap">
                          <span>HMRC</span>
                          <span>2 days</span>
                        </div>
                        <div className="mkt-mn">
                          VAT return due Monday · £6,820
                        </div>
                      </div>
                    </div>
                    <div className="mkt-noti">
                      <div className="mkt-i mkt-i-go">£</div>
                      <div style={{ flex: 1 }}>
                        <div className="mkt-ap">
                          <span>Payroll</span>
                          <span>Fri</span>
                        </div>
                        <div className="mkt-mn">6 staff to pay this week</div>
                      </div>
                    </div>
                  </div>
                </div>
                <div className="mkt-maps">
                  <div className="mkt-map">
                    <span className="mkt-from">New enquiry, Ballymena</span>
                    <span className="mkt-arr">→</span>
                    <span className="mkt-to">
                      <span className="mkt-tick">✓</span> Logged as a lead, and
                      it won’t be forgotten
                    </span>
                  </div>
                  <div className="mkt-map">
                    <span className="mkt-from">“Any update on our quote?”</span>
                    <span className="mkt-arr">→</span>
                    <span className="mkt-to">
                      <span className="mkt-tick">✓</span> Quote sent · you can
                      see it’s been viewed
                    </span>
                  </div>
                  <div className="mkt-map">
                    <span className="mkt-from">VAT due Monday</span>
                    <span className="mkt-arr">→</span>
                    <span className="mkt-to">
                      <span className="mkt-tick">✓</span> VAT figure ready ·
                      £6,820
                    </span>
                  </div>
                  <div className="mkt-map">
                    <span className="mkt-from">Payroll Friday</span>
                    <span className="mkt-arr">→</span>
                    <span className="mkt-to">
                      <span className="mkt-tick">✓</span> Pay run drafted · 6
                      staff
                    </span>
                  </div>
                </div>
              </Reveal>
              <Reveal className="mkt-relief" delay={0.1}>
                By Monday, it’s already in hand.
                <span className="mkt-sub">
                  The new enquiry’s logged, the quote’s been followed up, your
                  VAT figure is set aside and Friday’s pay run is drafted. You
                  just turn up and build.
                </span>
              </Reveal>
            </div>
          </section>

          {/* ===================== CREWFLOW IS WATCHING ===================== */}
          <section className="mkt-section mkt-bt" id="watching">
            <div className="mkt-wrap">
              <Reveal className="mkt-center">
                <div style={{ maxWidth: 700, margin: "0 auto" }}>
                  <span className="mkt-eyebrow">Always on</span>
                  <h2>While you’re on the tools, CrewFlow keeps watch.</h2>
                  <p className="mkt-lead" style={{ marginTop: 14 }}>
                    It doesn’t just store your information. It keeps an eye on
                    the things that quietly cost you money when they’re missed,
                    and flags them before they do.
                  </p>
                </div>
              </Reveal>
              <Reveal className="mkt-watch-grid">
                <div className="mkt-watch">
                  <div className="mkt-wh">
                    <span
                      className="mkt-wdot"
                      style={{ background: "var(--gold)" }}
                    />
                    <span className="mkt-wt">Quotes going cold</span>
                  </div>
                  <p className="mkt-wb">
                    A quote that’s sat unopened for days gets flagged, so you can
                    follow up while the job’s still warm.
                  </p>
                </div>
                <div className="mkt-watch">
                  <div className="mkt-wh">
                    <span className="mkt-wdot" style={{ background: RD }} />
                    <span className="mkt-wt">Invoices slipping overdue</span>
                  </div>
                  <p className="mkt-wb">
                    Reminders go out on day 3, 7, 14 and 21 on their own, so you
                    stop being the one who chases the money.
                  </p>
                </div>
                <div className="mkt-watch">
                  <div className="mkt-wh">
                    <span className="mkt-wdot" style={{ background: "#7fb2e6" }} />
                    <span className="mkt-wt">Double-booked staff</span>
                  </div>
                  <p className="mkt-wb">
                    Put someone on two jobs at once and CrewFlow catches the
                    clash before the week starts, not on Monday morning.
                  </p>
                </div>
                <div className="mkt-watch">
                  <div className="mkt-wh">
                    <span
                      className="mkt-wdot"
                      style={{ background: "var(--gold)" }}
                    />
                    <span className="mkt-wt">Certificates about to expire</span>
                  </div>
                  <p className="mkt-wb">
                    Insurance, qualifications and permits with an expiry date get
                    flagged before they lapse.
                  </p>
                </div>
                <div className="mkt-watch">
                  <div className="mkt-wh">
                    <span className="mkt-wdot" style={{ background: EM }} />
                    <span className="mkt-wt">Leads going quiet</span>
                  </div>
                  <p className="mkt-wb">
                    An enquiry no one’s followed up gets surfaced, so nothing
                    slips while you’re out on site.
                  </p>
                </div>
                <div className="mkt-watch">
                  <div className="mkt-wh">
                    <span className="mkt-wdot" style={{ background: "#7fb2e6" }} />
                    <span className="mkt-wt">Where the business stands</span>
                  </div>
                  <p className="mkt-wb">
                    A plain-English weekly summary and a company-health view, so
                    the important stuff is never out of sight.
                  </p>
                </div>
              </Reveal>
            </div>
          </section>

          {/* ===================== PRODUCT OS ===================== */}
          <section className="mkt-section mkt-bt" id="product">
            <div className="mkt-wrap">
              <Reveal className="mkt-center">
                <div style={{ maxWidth: 680, margin: "0 auto" }}>
                  <span className="mkt-eyebrow">The product</span>
                  <h2>One system. Every part of the job.</h2>
                  <p className="mkt-lead" style={{ marginTop: 14 }}>
                    From the first enquiry to the final payment, every step lives
                    in CrewFlow, and they all talk to each other.
                  </p>
                </div>
              </Reveal>

              {/* LEADS */}
              <div style={{ marginTop: 70 }}>
                <Reveal className="mkt-feat">
                  <div className="mkt-copy">
                    <span className="mkt-eyebrow">Leads</span>
                    <h3>Never lose another enquiry.</h3>
                    <p className="mkt-lead">
                      Every call, web form and referral lands in one place, so
                      nothing slips while you’re on site.
                    </p>
                    <div className="mkt-flist">
                      <div className="mkt-fi">
                        <span className="mkt-ic">✆</span>
                        <div>
                          <div className="mkt-tt">Every channel, one list</div>
                          <div className="mkt-bb">
                            Phone, website, WhatsApp and referrals. Every
                            enquiry lands in the same place.
                          </div>
                        </div>
                      </div>
                      <div className="mkt-fi">
                        <span className="mkt-ic">⚑</span>
                        <div>
                          <div className="mkt-tt">Chased, not forgotten</div>
                          <div className="mkt-bb">
                            CrewFlow nudges you when a lead’s gone quiet.
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                  <div className="mkt-shot">
                    <Chrome url="app.crewflow.uk/leads" />
                    <div className="mkt-main" style={{ padding: "16px 18px" }}>
                      <div className="mkt-apptop">
                        <div className="mkt-ttl">Leads</div>
                        <span className="mkt-pill mkt-p-go">12 open</span>
                      </div>
                      <table className="mkt-tbl">
                        <thead>
                          <tr>
                            <th>Name</th>
                            <th className="mkt-hidem">Source</th>
                            <th>Job</th>
                            <th>Status</th>
                          </tr>
                        </thead>
                        <tbody>
                          <tr>
                            <td>S. McGrath</td>
                            <td className="mkt-hidem">Web form</td>
                            <td>Kitchen ext · Belfast</td>
                            <td>
                              <span className="mkt-pill mkt-p-go">New</span>
                            </td>
                          </tr>
                          <tr>
                            <td>Murphy Developments</td>
                            <td className="mkt-hidem">Referral</td>
                            <td>New build · Ballymena</td>
                            <td>
                              <span className="mkt-pill mkt-p-bl">
                                Contacted
                              </span>
                            </td>
                          </tr>
                          <tr>
                            <td>T. Doyle</td>
                            <td className="mkt-hidem">Phone</td>
                            <td>Loft · Lisburn</td>
                            <td>
                              <span className="mkt-pill mkt-p-em">Quoted</span>
                            </td>
                          </tr>
                          <tr>
                            <td>R. Campbell</td>
                            <td className="mkt-hidem">WhatsApp</td>
                            <td>Garage conv · Antrim</td>
                            <td>
                              <span className="mkt-pill mkt-p-go">New</span>
                            </td>
                          </tr>
                          <tr>
                            <td>O’Neill Retail Ltd</td>
                            <td className="mkt-hidem">Referral</td>
                            <td>Fit-out · Newry</td>
                            <td>
                              <span className="mkt-pill mkt-p-em">Quoted</span>
                            </td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                  </div>
                </Reveal>
              </div>

              {/* QUOTES */}
              <div style={{ marginTop: 90 }}>
                <Reveal className="mkt-feat mkt-rev">
                  <div className="mkt-shot">
                    <Chrome url="app.crewflow.uk/quotes/QUO-1042" />
                    <div className="mkt-main" style={{ padding: "16px 18px" }}>
                      <div className="mkt-apptop">
                        <div>
                          <div className="mkt-ttl">
                            Loft Conversion · Lisburn
                          </div>
                          <div className="mkt-sub">QUO-1042 · valid 30 days</div>
                        </div>
                        <span className="mkt-pill mkt-p-bl">Sent · Viewed</span>
                      </div>
                      <div className="mkt-panel">
                        <table className="mkt-tbl">
                          <tbody>
                            <tr>
                              <td>Labour · 18 days @ crew rate</td>
                              <td
                                className="mkt-mono"
                                style={{ textAlign: "right" }}
                              >
                                £10,800
                              </td>
                            </tr>
                            <tr>
                              <td>Materials · timber, insulation, plaster</td>
                              <td
                                className="mkt-mono"
                                style={{ textAlign: "right" }}
                              >
                                £7,420
                              </td>
                            </tr>
                            <tr>
                              <td>Velux windows ×3 + fit</td>
                              <td
                                className="mkt-mono"
                                style={{ textAlign: "right" }}
                              >
                                £3,160
                              </td>
                            </tr>
                            <tr>
                              <td>Staircase + balustrade</td>
                              <td
                                className="mkt-mono"
                                style={{ textAlign: "right" }}
                              >
                                £2,940
                              </td>
                            </tr>
                            <tr>
                              <td>Building control + waste</td>
                              <td
                                className="mkt-mono"
                                style={{ textAlign: "right" }}
                              >
                                £1,660
                              </td>
                            </tr>
                          </tbody>
                        </table>
                        <div
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            alignItems: "center",
                            marginTop: 12,
                            paddingTop: 12,
                            borderTop: "1px solid var(--line)",
                          }}
                        >
                          <span
                            style={{ fontSize: 13, color: "var(--muted)" }}
                          >
                            Total inc. VAT
                          </span>
                          <span
                            className="mkt-mono"
                            style={{
                              fontFamily: "var(--font-display)",
                              fontWeight: 600,
                              fontSize: 26,
                              color: GO,
                            }}
                          >
                            £25,980
                          </span>
                        </div>
                      </div>
                      <div style={{ display: "flex", gap: 10, marginTop: 12 }}>
                        <span className="mkt-btn mkt-btn-gold mkt-btn-sm">
                          Approve &amp; sign
                        </span>
                        <span className="mkt-btn mkt-btn-ghost mkt-btn-sm">
                          Download PDF
                        </span>
                      </div>
                    </div>
                  </div>
                  <div className="mkt-copy">
                    <span className="mkt-eyebrow">Quotes</span>
                    <h3>Win more work with quotes that look the part.</h3>
                    <p className="mkt-lead">
                      Build a professional quote in minutes, send it, and see
                      when it’s opened. Then turn it into a job the second it’s
                      accepted.
                    </p>
                    <div className="mkt-flist">
                      <div className="mkt-fi">
                        <span className="mkt-ic">⌁</span>
                        <div>
                          <div className="mkt-tt">See when it’s read</div>
                          <div className="mkt-bb">
                            Know the moment a customer opens your quote.
                          </div>
                        </div>
                      </div>
                      <div className="mkt-fi">
                        <span className="mkt-ic">✓</span>
                        <div>
                          <div className="mkt-tt">Accepted online</div>
                          <div className="mkt-bb">
                            Customers sign off by name in a click. No chasing
                            paperwork.
                          </div>
                        </div>
                      </div>
                    </div>
                    <span className="mkt-mtag">
                      ↳ An accepted quote becomes a job in one step
                    </span>
                  </div>
                </Reveal>
              </div>

              {/* JOBS */}
              <div style={{ marginTop: 90 }}>
                <Reveal className="mkt-feat">
                  <div className="mkt-copy">
                    <span className="mkt-eyebrow">Jobs</span>
                    <h3>Every job, on track and on margin.</h3>
                    <p className="mkt-lead">
                      See live stages, costs against the quote, and who’s on
                      site, so a job never quietly slips into the red.
                    </p>
                    <div className="mkt-flist">
                      <div className="mkt-fi">
                        <span className="mkt-ic">◷</span>
                        <div>
                          <div className="mkt-tt">Stages &amp; schedule</div>
                          <div className="mkt-bb">
                            From first fix to final invoice, every stage tracked.
                          </div>
                        </div>
                      </div>
                      <div className="mkt-fi">
                        <span className="mkt-ic">£</span>
                        <div>
                          <div className="mkt-tt">Costs vs quote, live</div>
                          <div className="mkt-bb">
                            Labour, materials and subcontractor costs land
                            against the quote as you go.
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                  <div className="mkt-shot">
                    <Chrome url="app.crewflow.uk/jobs/new-build-ballymena" />
                    <div className="mkt-main" style={{ padding: "16px 18px" }}>
                      <div className="mkt-apptop">
                        <div>
                          <div className="mkt-ttl">New Build · Ballymena</div>
                          <div className="mkt-sub">
                            JOB-318 · Murphy Developments
                          </div>
                        </div>
                        <span className="mkt-pill mkt-p-bl">In progress</span>
                      </div>
                      <div
                        className="mkt-kgrid"
                        style={{ gridTemplateColumns: "repeat(3,1fr)" }}
                      >
                        <div className="mkt-kc">
                          <div className="mkt-v">£182,000</div>
                          <div className="mkt-l">Contract value</div>
                        </div>
                        <div className="mkt-kc">
                          <div className="mkt-v mkt-g">£138,400</div>
                          <div className="mkt-l">Costs to date</div>
                        </div>
                        <div className="mkt-kc">
                          <div className="mkt-v mkt-e">24%</div>
                          <div className="mkt-l">Margin</div>
                        </div>
                      </div>
                      <div className="mkt-panel" style={{ marginTop: 12 }}>
                        <h5>Stages</h5>
                        <table className="mkt-tbl">
                          <tbody>
                            <tr>
                              <td>Foundations &amp; groundworks</td>
                              <td>
                                <span className="mkt-pill mkt-p-em">
                                  Complete
                                </span>
                              </td>
                            </tr>
                            <tr>
                              <td>Frame &amp; roof</td>
                              <td>
                                <span className="mkt-pill mkt-p-em">
                                  Complete
                                </span>
                              </td>
                            </tr>
                            <tr>
                              <td>First fix</td>
                              <td>
                                <span className="mkt-pill mkt-p-bl">
                                  In progress
                                </span>
                              </td>
                            </tr>
                            <tr>
                              <td>Plastering &amp; second fix</td>
                              <td>
                                <span className="mkt-pill mkt-p-go">
                                  Scheduled
                                </span>
                              </td>
                            </tr>
                          </tbody>
                        </table>
                      </div>
                    </div>
                  </div>
                </Reveal>
              </div>
            </div>
          </section>

          {/* ===================== CONNECTED FLOW ===================== */}
          <section className="mkt-section mkt-bt" id="flow">
            <div className="mkt-wrap">
              <Reveal className="mkt-center">
                <div style={{ maxWidth: 700, margin: "0 auto" }}>
                  <span className="mkt-eyebrow">How it connects</span>
                  <h2>One job, from first enquiry to final profit.</h2>
                  <p className="mkt-lead" style={{ marginTop: 14 }}>
                    This is the Kitchen Extension in Belfast moving through every
                    stage. You enter things once; CrewFlow carries them all the
                    way to the bank.
                  </p>
                </div>
              </Reveal>
              <Reveal className="mkt-flow">
                <div className="mkt-flow-head">
                  <div>
                    <div className="mkt-job">Kitchen Extension · Belfast</div>
                    <div className="mkt-jobsub">
                      JOB-204 · for S. McGrath · contract £34,500
                    </div>
                  </div>
                  <span className="mkt-pill mkt-p-em">Paid in full</span>
                </div>
                <div className="mkt-flow-track">
                  <div className="mkt-step">
                    <div className="mkt-node">✆</div>
                    <div className="mkt-sl">Enquiry</div>
                    <div className="mkt-sv">Belfast</div>
                  </div>
                  <div className="mkt-step">
                    <div className="mkt-node">✎</div>
                    <div className="mkt-sl">Quote</div>
                    <div className="mkt-sv">£34,500</div>
                  </div>
                  <div className="mkt-step">
                    <div className="mkt-node">✓</div>
                    <div className="mkt-sl">Accepted</div>
                    <div className="mkt-sv">e-signed</div>
                  </div>
                  <div className="mkt-step">
                    <div className="mkt-node">◷</div>
                    <div className="mkt-sl">Job</div>
                    <div className="mkt-sv">scheduled</div>
                  </div>
                  <div className="mkt-step">
                    <div className="mkt-node">◍</div>
                    <div className="mkt-sl">Staff</div>
                    <div className="mkt-sv">4 assigned</div>
                  </div>
                  <div className="mkt-step">
                    <div className="mkt-node">▣</div>
                    <div className="mkt-sl">Completed</div>
                    <div className="mkt-sv">hours logged</div>
                  </div>
                  <div className="mkt-step">
                    <div className="mkt-node">▤</div>
                    <div className="mkt-sl">Invoice</div>
                    <div className="mkt-sv">£34,500</div>
                  </div>
                  <div className="mkt-step">
                    <div className="mkt-node">£</div>
                    <div className="mkt-sl">Paid</div>
                    <div className="mkt-sv">bank transfer</div>
                  </div>
                  <div className="mkt-step mkt-paid">
                    <div className="mkt-node">▲</div>
                    <div className="mkt-sl">Profit</div>
                    <div className="mkt-sv">£13,100</div>
                  </div>
                </div>
                <div className="mkt-flow-foot">
                  <span>
                    Every step flows into the next. One enquiry becomes a
                    tracked job, an invoice, and a clear{" "}
                    <b>£13,100 profit at 38% margin</b>. No re-typing, nothing
                    lost between the van and the office.
                  </span>
                </div>
              </Reveal>
            </div>
          </section>

          {/* ===================== PAYROLL ===================== */}
          <section className="mkt-section mkt-bt" id="payroll">
            <div className="mkt-wrap">
              <Reveal className="mkt-center">
                <div style={{ maxWidth: 680, margin: "0 auto" }}>
                  <span className="mkt-eyebrow">The team</span>
                  <h2>Run the team and payroll without the Friday panic.</h2>
                  <p className="mkt-lead" style={{ marginTop: 14 }}>
                    Plan the week, see clashes before they cost you, and turn
                    clocked hours into payslips, without the spreadsheet
                    gymnastics.
                  </p>
                </div>
              </Reveal>
              <Reveal className="mkt-shotwrap">
                <div className="mkt-shot">
                  <Chrome url="app.crewflow.uk/payroll" />
                  <div className="mkt-main">
                    <div className="mkt-apptop">
                      <div>
                        <div className="mkt-ttl">Pay run · week ending Fri</div>
                        <div className="mkt-sub">
                          6 staff · PAYE &amp; NI calculated
                        </div>
                      </div>
                      <span className="mkt-btn mkt-btn-gold mkt-btn-sm">
                        Approve pay run
                      </span>
                    </div>
                    <div
                      className="mkt-cols2"
                      style={{ gridTemplateColumns: "1.5fr 1fr" }}
                    >
                      <div className="mkt-panel">
                        <h5>This week</h5>
                        <table className="mkt-tbl">
                          <thead>
                            <tr>
                              <th>Staff</th>
                              <th>Role</th>
                              <th className="mkt-hidem">Hours</th>
                              <th>Gross</th>
                              <th>Net</th>
                            </tr>
                          </thead>
                          <tbody>
                            <tr>
                              <td>Conor D.</td>
                              <td className="mkt-s">Site lead</td>
                              <td className="mkt-hidem mkt-mono">42.5</td>
                              <td className="mkt-mono">£1,360</td>
                              <td className="mkt-mono">£1,142</td>
                            </tr>
                            <tr>
                              <td>Seán M.</td>
                              <td className="mkt-s">Joiner</td>
                              <td className="mkt-hidem mkt-mono">40.0</td>
                              <td className="mkt-mono">£1,200</td>
                              <td className="mkt-mono">£1,016</td>
                            </tr>
                            <tr>
                              <td>Liam K.</td>
                              <td className="mkt-s">Bricklayer</td>
                              <td className="mkt-hidem mkt-mono">38.0</td>
                              <td className="mkt-mono">£1,140</td>
                              <td className="mkt-mono">£968</td>
                            </tr>
                            <tr>
                              <td>Niall B.</td>
                              <td className="mkt-s">Groundworker</td>
                              <td className="mkt-hidem mkt-mono">40.0</td>
                              <td className="mkt-mono">£1,080</td>
                              <td className="mkt-mono">£918</td>
                            </tr>
                            <tr>
                              <td>Aidan R.</td>
                              <td className="mkt-s">Apprentice</td>
                              <td className="mkt-hidem mkt-mono">37.5</td>
                              <td className="mkt-mono">£640</td>
                              <td className="mkt-mono">£592</td>
                            </tr>
                            <tr>
                              <td>Declan F.</td>
                              <td className="mkt-s">Labourer</td>
                              <td className="mkt-hidem mkt-mono">40.0</td>
                              <td className="mkt-mono">£920</td>
                              <td className="mkt-mono">£654</td>
                            </tr>
                          </tbody>
                        </table>
                      </div>
                      <div className="mkt-panel">
                        <h5>Summary</h5>
                        <div
                          style={{
                            display: "flex",
                            flexDirection: "column",
                            gap: 12,
                            fontSize: 13,
                          }}
                        >
                          <div
                            style={{
                              display: "flex",
                              justifyContent: "space-between",
                            }}
                          >
                            <span className="mkt-s" style={{ color: "var(--muted)" }}>
                              Gross
                            </span>
                            <span className="mkt-mono">£6,340.00</span>
                          </div>
                          <div
                            style={{
                              display: "flex",
                              justifyContent: "space-between",
                            }}
                          >
                            <span className="mkt-s" style={{ color: "var(--muted)" }}>
                              PAYE
                            </span>
                            <span className="mkt-mono">£1,118.00</span>
                          </div>
                          <div
                            style={{
                              display: "flex",
                              justifyContent: "space-between",
                            }}
                          >
                            <span className="mkt-s" style={{ color: "var(--muted)" }}>
                              Employee NI
                            </span>
                            <span className="mkt-mono">£432.00</span>
                          </div>
                          <div
                            style={{
                              display: "flex",
                              justifyContent: "space-between",
                              paddingTop: 10,
                              borderTop: "1px solid var(--line)",
                            }}
                          >
                            <span style={{ fontWeight: 700 }}>Net to pay</span>
                            <span
                              className="mkt-mono"
                              style={{
                                fontFamily: "var(--font-display)",
                                fontWeight: 600,
                                fontSize: 22,
                                color: EM,
                              }}
                            >
                              £5,290
                            </span>
                          </div>
                        </div>
                        <div
                          className="mkt-panel"
                          style={{
                            marginTop: 12,
                            background: "rgba(242,128,138,.07)",
                            borderColor: "rgba(242,128,138,.25)",
                          }}
                        >
                          <div
                            style={{
                              fontSize: 12,
                              color: RD,
                              fontWeight: 600,
                            }}
                          >
                            ⚑ Conor double-booked Tuesday: Extension &amp;
                            Fit-Out
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </Reveal>
            </div>
          </section>

          {/* ===================== PORTAL ===================== */}
          <section className="mkt-section mkt-bt" id="portal">
            <div className="mkt-wrap">
              <Reveal className="mkt-feat">
                <div className="mkt-copy">
                  <span className="mkt-eyebrow">Your customers</span>
                  <h3>Give customers clarity, without more phone calls.</h3>
                  <p className="mkt-lead">
                    They see the quote, where the job’s up to, and what’s left to
                    pay, all in one tidy link. You’ll get far fewer “any update?”
                    texts.
                  </p>
                  <div className="mkt-flist">
                    <div className="mkt-fi">
                      <span className="mkt-ic">✓</span>
                      <div>
                        <div className="mkt-tt">Approve &amp; see what’s owed</div>
                        <div className="mkt-bb">
                          Sign off quotes online and see exactly what’s left to
                          pay.
                        </div>
                      </div>
                    </div>
                    <div className="mkt-fi">
                      <span className="mkt-ic">◉</span>
                      <div>
                        <div className="mkt-tt">Live job progress</div>
                        <div className="mkt-bb">
                          Stages and photos they can actually follow.
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
                <div className="mkt-shot">
                  <Chrome url="crewflow.uk/portal/belfast-kitchen" />
                  <div className="mkt-main" style={{ padding: "18px 20px" }}>
                    <div className="mkt-apptop">
                      <div>
                        <div className="mkt-ttl">
                          Kitchen Extension · Belfast
                        </div>
                        <div className="mkt-sub">For: S. McGrath</div>
                      </div>
                      <span className="mkt-pill mkt-p-bl">In progress</span>
                    </div>
                    <div className="mkt-panel">
                      <table className="mkt-tbl">
                        <tbody>
                          <tr>
                            <td>Quote accepted</td>
                            <td style={{ textAlign: "right" }}>
                              <span className="mkt-pill mkt-p-em">✓ Signed</span>
                            </td>
                          </tr>
                          <tr>
                            <td>First fix</td>
                            <td style={{ textAlign: "right" }}>
                              <span className="mkt-pill mkt-p-em">
                                ✓ Complete
                              </span>
                            </td>
                          </tr>
                          <tr>
                            <td>Second fix</td>
                            <td style={{ textAlign: "right" }}>
                              <span className="mkt-pill mkt-p-bl">
                                In progress
                              </span>
                            </td>
                          </tr>
                          <tr>
                            <td>Documents &amp; photos</td>
                            <td
                              className="mkt-mono"
                              style={{ textAlign: "right", color: EM }}
                            >
                              3 shared
                            </td>
                          </tr>
                          <tr>
                            <td>Final invoice</td>
                            <td
                              className="mkt-mono"
                              style={{
                                textAlign: "right",
                                color: "var(--faint)",
                              }}
                            >
                              £34,500 · on completion
                            </td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                    <div style={{ display: "flex", gap: 10, marginTop: 12 }}>
                      <span className="mkt-btn mkt-btn-gold mkt-btn-sm">
                        View documents &amp; photos
                      </span>
                      <span className="mkt-btn mkt-btn-ghost mkt-btn-sm">
                        Message the team
                      </span>
                    </div>
                    <div
                      style={{
                        marginTop: 10,
                        fontSize: 11,
                        color: "var(--faint)",
                      }}
                    >
                      Invoices are settled by bank transfer. No card fees.
                    </div>
                  </div>
                </div>
              </Reveal>
            </div>
          </section>

          {/* ===================== MONEY / REPORTS ===================== */}
          <section className="mkt-section mkt-bt" id="money">
            <div className="mkt-wrap">
              <Reveal className="mkt-center">
                <div style={{ maxWidth: 680, margin: "0 auto" }}>
                  <span className="mkt-eyebrow">The money</span>
                  <h2>Know where every pound goes, to the penny.</h2>
                  <p className="mkt-lead" style={{ marginTop: 14 }}>
                    Profit by job, cashflow, and your VAT and Corporation Tax
                    figures ready before HMRC asks. The reports an accountant
                    actually wants.
                  </p>
                </div>
              </Reveal>
              <Reveal className="mkt-shotwrap">
                <div className="mkt-shot">
                  <Chrome url="app.crewflow.uk/reports" />
                  <div className="mkt-main">
                    <div className="mkt-apptop">
                      <div>
                        <div className="mkt-ttl">Reports</div>
                        <div className="mkt-sub">This quarter · Apr–Jun</div>
                      </div>
                      <span className="mkt-search">Export PDF / CSV</span>
                    </div>
                    <div
                      className="mkt-kgrid"
                      style={{ gridTemplateColumns: "repeat(4,1fr)" }}
                    >
                      <div className="mkt-kc">
                        <div className="mkt-v mkt-g">£338,880</div>
                        <div className="mkt-l">Revenue (qtr)</div>
                      </div>
                      <div className="mkt-kc">
                        <div className="mkt-v mkt-e">29%</div>
                        <div className="mkt-l">Avg margin</div>
                      </div>
                      <div className="mkt-kc">
                        <div className="mkt-v">£42,180</div>
                        <div className="mkt-l">Outstanding</div>
                      </div>
                      <div className="mkt-kc">
                        <div className="mkt-v" style={{ color: RD }}>
                          £6,820
                        </div>
                        <div className="mkt-l">VAT due Mon</div>
                      </div>
                    </div>
                    <div className="mkt-cols2" style={{ marginTop: 12 }}>
                      <div className="mkt-panel">
                        <h5>Profit by job</h5>
                        <table className="mkt-tbl">
                          <thead>
                            <tr>
                              <th>Job</th>
                              <th>Quoted</th>
                              <th className="mkt-hidem">Costs</th>
                              <th>Margin</th>
                            </tr>
                          </thead>
                          <tbody>
                            <tr>
                              <td>Commercial Fit-Out · Newry</td>
                              <td className="mkt-mono">£96,400</td>
                              <td className="mkt-hidem mkt-mono">£69,400</td>
                              <td>
                                <span className="mkt-pill mkt-p-em">28%</span>
                              </td>
                            </tr>
                            <tr>
                              <td>Kitchen Extension · Belfast</td>
                              <td className="mkt-mono">£34,500</td>
                              <td className="mkt-hidem mkt-mono">£21,400</td>
                              <td>
                                <span className="mkt-pill mkt-p-em">38%</span>
                              </td>
                            </tr>
                            <tr>
                              <td>New Build · Ballymena</td>
                              <td className="mkt-mono">£182,000</td>
                              <td className="mkt-hidem mkt-mono">£138,400</td>
                              <td>
                                <span className="mkt-pill mkt-p-em">24%</span>
                              </td>
                            </tr>
                            <tr>
                              <td>Refurb · Newry</td>
                              <td className="mkt-mono">£12,400</td>
                              <td className="mkt-hidem mkt-mono">£10,900</td>
                              <td>
                                <span className="mkt-pill mkt-p-rd">12%</span>
                              </td>
                            </tr>
                          </tbody>
                        </table>
                      </div>
                      <div className="mkt-panel">
                        <h5>Revenue trend</h5>
                        <div className="mkt-bars">
                          <i style={{ height: "40%" }} />
                          <i style={{ height: "54%" }} />
                          <i style={{ height: "48%" }} />
                          <i className="mkt-e" style={{ height: "66%" }} />
                          <i style={{ height: "60%" }} />
                          <i className="mkt-e" style={{ height: "82%" }} />
                          <i className="mkt-e" style={{ height: "94%" }} />
                        </div>
                        <div
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            marginTop: 10,
                            fontSize: 11,
                            color: "var(--faint)",
                          }}
                        >
                          <span>Apr</span>
                          <span>Jun</span>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </Reveal>
            </div>
          </section>

          {/* ===================== INTEGRATIONS & TRUST ===================== */}
          <section className="mkt-section mkt-bt" id="trust">
            <div className="mkt-wrap">
              <Reveal className="mkt-center">
                <div style={{ maxWidth: 700, margin: "0 auto" }}>
                  <span className="mkt-eyebrow">Switching &amp; trust</span>
                  <h2>You’re not ripping anything out. You’re getting organised.</h2>
                  <p className="mkt-lead" style={{ marginTop: 14 }}>
                    Keep your accountant. Keep Xero. We move you across by hand
                    and slot CrewFlow in as the system that runs the day-to-day.
                  </p>
                </div>
              </Reveal>
              <Reveal className="mkt-trust-grid">
                <div className="mkt-tcard">
                  <h3>Moving over is done with you, not dumped on you.</h3>
                  <p className="mkt-lead">
                    Switching systems is the scary part, so we don’t leave you to
                    it. Your customers, jobs and finances are brought across,
                    checked, and shown to you in a preview before anything goes
                    live.
                  </p>
                  <div className="mkt-chips">
                    <span className="mkt-chip">
                      Sage <span className="mkt-cs">→ CrewFlow</span>
                    </span>
                    <span className="mkt-chip">
                      Xero <span className="mkt-cs">→ CrewFlow</span>
                    </span>
                    <span className="mkt-chip">
                      QuickBooks <span className="mkt-cs">→ CrewFlow</span>
                    </span>
                    <span className="mkt-chip">Buildertrend</span>
                    <span className="mkt-chip">CSV</span>
                    <span className="mkt-chip">Excel</span>
                    <span className="mkt-chip">PDF</span>
                    <span className="mkt-chip">ZIP</span>
                  </div>
                </div>
                <div className="mkt-tcard">
                  <h3>Works with the tools you already trust.</h3>
                  <div className="mkt-tlist" style={{ marginTop: 18 }}>
                    <div className="mkt-ti">
                      <span className="mkt-tick2">✓</span>
                      <div>
                        <div className="mkt-tt">Runs alongside Xero</div>
                        <div className="mkt-tb">
                          Keep your accountant exactly where they are.
                        </div>
                      </div>
                    </div>
                    <div className="mkt-ti">
                      <span className="mkt-tick2">✓</span>
                      <div>
                        <div className="mkt-tt">Clean exports to Xero &amp; Sage</div>
                        <div className="mkt-tb">
                          CSV your accountant can drop straight in.
                        </div>
                      </div>
                    </div>
                    <div className="mkt-ti">
                      <span className="mkt-tick2">✓</span>
                      <div>
                        <div className="mkt-tt">Tax figures, calculated as you go</div>
                        <div className="mkt-tb">
                          VAT and Corporation Tax worked out as you go, with a
                          VAT PDF to hand over.
                        </div>
                      </div>
                    </div>
                    <div className="mkt-ti">
                      <span className="mkt-tick2">✓</span>
                      <div>
                        <div className="mkt-tt">Built and supported in the UK</div>
                        <div className="mkt-tb">
                          Daily backups and your data kept secure.
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </Reveal>
              <Reveal>
                <p className="mkt-note">
                  CrewFlow isn’t an HMRC filing tool, and there’s no live sync to
                  set up or break. It keeps your numbers straight and hands them
                  over clean, so you and your accountant stay in control.
                </p>
              </Reveal>
            </div>
          </section>

          {/* ===================== PROOF (honest) ===================== */}
          <section className="mkt-section mkt-bt" id="proof">
            <div className="mkt-wrap mkt-center" style={{ maxWidth: 820 }}>
              <Reveal className="mkt-center">
                <span className="mkt-eyebrow">Why it works</span>
                <h2>Less admin. Faster payment. Nothing lost.</h2>
                <p className="mkt-lead" style={{ marginTop: 14 }}>
                  No invented numbers. Just the things CrewFlow does on every
                  job, without being asked.
                </p>
              </Reveal>
              <Reveal className="mkt-stats">
                <div className="mkt-stat">
                  <div className="mkt-v">3 · 7 · 14 · 21</div>
                  <div className="mkt-l">
                    The days overdue invoices get chased automatically, so you
                    stop having the awkward money conversation.
                  </div>
                </div>
                <div className="mkt-stat">
                  <div className="mkt-v">Every £</div>
                  <div className="mkt-l">
                    Labour, materials and subcontractor costs tracked against
                    each job’s quote, so you see margin as it moves.
                  </div>
                </div>
                <div className="mkt-stat">
                  <div className="mkt-v">One link</div>
                  <div className="mkt-l">
                    Quote, job progress and what’s left to pay. Your customer
                    sees it all, so the “any update?” texts stop.
                  </div>
                </div>
              </Reveal>
            </div>
          </section>

          {/* ===================== PRICING / FINAL CTA ===================== */}
          <section className="mkt-section mkt-center mkt-bt" id="pricing">
            <div className="mkt-wrap">
              <Reveal className="mkt-center">
                <span className="mkt-eyebrow">Get started</span>
                <h2>Ready to run your construction company from one place?</h2>
              </Reveal>
              <Reveal className="mkt-price" delay={0.06} y={26}>
                <div className="mkt-p1">
                  £500<span>/month</span>
                </div>
                <div className="mkt-setup">
                  + £1,000 one-time setup &amp; onboarding
                </div>
                <ul>
                  <li>Everything set up for you, with your data migrated across</li>
                  <li>
                    Quotes, jobs, payroll, VAT, invoices &amp; a customer portal
                  </li>
                  <li>UK-based onboarding and support</li>
                  <li>No per-seat fees, no surprises</li>
                </ul>
                <div>
                  <BookDemoCta className="mkt-btn mkt-btn-gold">
                    Book a demo
                  </BookDemoCta>
                </div>
              </Reveal>
            </div>
          </section>

          {/* ===================== FAQ ===================== */}
          <section className="mkt-section mkt-bt" id="faq">
            <div className="mkt-wrap">
              <Reveal className="mkt-center">
                <div style={{ maxWidth: 680, margin: "0 auto" }}>
                  <span className="mkt-eyebrow">FAQ</span>
                  <h2>Common questions.</h2>
                </div>
              </Reveal>
              <Reveal className="mkt-faq">
                {FAQ_ITEMS.map((item) => (
                  <details key={item.q}>
                    <summary>
                      {item.q}
                      <span className="mkt-plus" aria-hidden>
                        +
                      </span>
                    </summary>
                    <p>{item.a}</p>
                  </details>
                ))}
              </Reveal>
            </div>
          </section>

          {/* ===================== FOOTER ===================== */}
          <footer className="mkt-foot">
            <div className="mkt-wrap mkt-frow">
              <div className="mkt-brand" style={{ fontSize: 16 }}>
                <span className="mkt-logo">
                  <LogoMark size={22} />
                </span>{" "}
                CrewFlow
              </div>
              <div>
                The operating system for UK construction companies. Built in the
                UK.
              </div>
              <div style={{ display: "flex", gap: 18, flexWrap: "wrap" }}>
                <Link href="/features">Features</Link>
                <Link href="/compare">Compare</Link>
                <Link href="/industries">Industries</Link>
                <Link href="/pricing">Pricing</Link>
                <Link href="/blog">Blog</Link>
                <Link href="/construction-software">Locations</Link>
              </div>
              <div style={{ display: "flex", gap: 18 }}>
                <Link href="/privacy">Privacy</Link>
                <Link href="/terms">Terms</Link>
                <Link href="/login">Sign in</Link>
              </div>
            </div>
          </footer>
        </MotionProvider>
      </div>

      {/* Funnel modal — rendered OUTSIDE .mkt-page so the scoped marketing
          reset/theme can't bleed into it. Opens on crewflow:open-book-demo. */}
      <BookDemoModal />
    </>
  );
}

const FAQ_ITEMS: { q: string; a: string }[] = [
  {
    q: "How long does setup take?",
    a: "Most companies are live in 2–3 days. We import your existing customers, invoices and finances from a CSV or Excel export. Anything that needs review, you see in a preview before we commit, with one-click rollback if anything looks wrong.",
  },
  {
    q: "We already use Xero. Do we have to ditch it?",
    a: "No. Many of our customers run CrewFlow alongside Xero. CrewFlow is the operations layer for quotes, jobs, hours and invoices, while Xero stays the accountant’s tool. Your numbers export cleanly to Xero and Sage when it’s time to file.",
  },
  {
    q: "Does CrewFlow take card payments?",
    a: "No. UK construction runs on bank transfer, so CrewFlow tracks payments rather than processing them. You keep 100% of every invoice. No card-processor skim, no gateway fee. Match your bank transactions to invoices and reconcile in one place.",
  },
  {
    q: "My lads only have phones on site. Does that work?",
    a: "Yes. The staff view is mobile-first in the browser, with big tap targets, clock-in, today’s rota and expected take-home pay. Built for someone standing in a van, not a CFO at a desk.",
  },
  {
    q: "Is my data safe?",
    a: "Yes. Daily automated backups with point-in-time recovery and storage redundancy across multiple zones. Built and hosted to UK standards, with your data kept secure.",
  },
  {
    q: "What does it cost?",
    a: "£500 a month, plus a one-time £1,000 for setup and onboarding, where we migrate your data and get you live. No per-seat fees and no surprises. Book a demo and we’ll show you the system on your own numbers first.",
  },
  {
    q: "Can I leave whenever I want?",
    a: "Yes. Full data export to CSV any time. No lock-in and no early-termination fees. Your data is yours; we just take care of it while you use us.",
  },
];
