import Link from "next/link";
import type { ReactNode } from "react";
import { Badge, StatTile, Table, THead, TBody, TR, TH, TD, cn } from "@/components/ui";
import { formatGbp } from "@/lib/money";
import { formatDateUK } from "@/lib/time/format";
import {
  LATENESS_BAND_LABEL,
  MIN_RATED_SAMPLE,
  SETTLEMENT_BAND_LABEL,
  formatRate,
  isRated,
  sampleCaveat,
  type DeliveryRecord,
  type DeliveryReliability,
  type PriceBehaviour,
  type Ratio,
  type SettlementSpeed,
} from "@/lib/suppliers/performance";

/**
 * Supplier performance — the presentation layer, shared by the supplier detail
 * panel, the per-supplier record and the comparison view.
 *
 * Server components throughout: no client JS, no interactivity to add. Every
 * figure arrives pre-computed from lib/suppliers/performance.ts; nothing here
 * derives a number, so a rendering change cannot alter a metric.
 *
 * ── COLOUR IS NOT A GRADE ──────────────────────────────────────────────────
 * The one design rule worth writing down. An AGGREGATE figure is rendered in
 * the inert neutral tone, ALWAYS — a red "late rate" tile would require a
 * threshold at which lateness becomes bad, and inventing that threshold is
 * exactly the letter-grading Phase 9 forbids, just spelled in Tailwind. The
 * operator decides what 18% means for the job they are buying for.
 *
 * Tone therefore appears in exactly two places, neither of which grades a
 * supplier:
 *   1. On an INDIVIDUAL delivery's verdict, where the badge reports that one
 *      record's own fact ("8+ days late") rather than a judgement about the
 *      company. The band is the band; naming it is not an opinion.
 *   2. On the SAMPLE-SIZE caveat, which is a statement about OUR data being
 *      too thin, not about their performance.
 *
 * Every `<Badge>` names its state in words, so colour is never the only signal.
 */

// ---------------------------------------------------------------------------
// Small shared pieces
// ---------------------------------------------------------------------------

/**
 * The section card. `padded={false}` is for a card whose body is a full-bleed
 * `<Table>` — the table brings its own cell padding and must reach the card's
 * edges, so the card drops its own rather than fighting it with `!p-0`.
 */
function Card({
  children,
  className,
  padded = true,
}: {
  children: ReactNode;
  className?: string;
  padded?: boolean;
}) {
  return (
    <section
      className={cn(
        "overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm",
        padded && "p-4",
        className,
      )}
    >
      {children}
    </section>
  );
}

function SectionHead({
  title,
  blurb,
  action,
}: {
  title: string;
  blurb: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
        <p className="mt-1 max-w-2xl text-xs leading-relaxed text-slate-500">{blurb}</p>
      </div>
      {action}
    </div>
  );
}

/**
 * The sample-size warning. Rendered wherever a ratio failed to earn a rate, so
 * the reason a percentage is missing is never left to the reader to infer.
 */
export function SampleNote({ r }: { r: Ratio }) {
  const note = sampleCaveat(r);
  if (!note) return null;
  return (
    <p className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-600">
      <Badge tone="amber">Too few to rate</Badge>
      <span>{note}</span>
    </p>
  );
}

/**
 * A ratio as a tile. The VALUE is the honest string from `formatRate`, which
 * degrades to "1 of 2 — too few to rate" on its own rather than relying on this
 * component to remember, and the sample size is in the hint either way.
 */
function RatioTile({
  label,
  r,
  hint,
  href,
}: {
  label: string;
  r: Ratio;
  hint: string;
  href?: string;
}) {
  return (
    <StatTile
      label={label}
      value={
        isRated(r) ? (
          `${r.pct}%`
        ) : (
          <span className="text-base font-semibold text-slate-600">{formatRate(r)}</span>
        )
      }
      hint={isRated(r) ? `${r.count} of ${r.n} · ${hint}` : hint}
      href={href}
    />
  );
}

/** A count as a tile. Always neutral — see the colour rule in the header. */
function CountTile({
  label,
  value,
  hint,
  href,
}: {
  label: string;
  value: number | string;
  hint: string;
  href?: string;
}) {
  return <StatTile label={label} value={value} hint={hint} href={href} />;
}

/** A row of counts that would be noise as tiles. */
function Facts({ items }: { items: Array<{ k: string; v: ReactNode; h?: string }> }) {
  return (
    <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
      {items.map((f) => (
        <div key={f.k}>
          <dt className="text-xs font-medium text-slate-500">{f.k}</dt>
          <dd className="text-base font-semibold tabular-nums text-slate-900">{f.v}</dd>
          {f.h ? <dd className="text-[11px] leading-tight text-slate-500">{f.h}</dd> : null}
        </div>
      ))}
    </dl>
  );
}

// ---------------------------------------------------------------------------
// How this is measured — the formulas, on the page, always
// ---------------------------------------------------------------------------

/**
 * Every definition, visible to the operator on the surface itself.
 *
 * Not a tooltip and not a docs link: a metric whose definition lives somewhere
 * else is a metric the reader will guess at. `<details>` keeps it out of the way
 * without hiding it behind a network request or client JS.
 */
export function HowMeasured() {
  return (
    <details className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm">
      <summary className="cursor-pointer font-semibold text-slate-900">
        How every figure on this page is worked out
      </summary>
      <div className="mt-3 space-y-3 text-xs leading-relaxed text-slate-600">
        <p className="font-medium text-slate-700">
          These are counts of things that happened. Nothing here is a forecast, a score or an
          opinion, and no figure is weighted against another.
        </p>
        <dl className="space-y-2">
          <div>
            <dt className="font-semibold text-slate-800">A delivery</dt>
            <dd>
              One <span className="font-medium">posted</span> goods received note against one of
              this supplier&rsquo;s purchase orders. Voided notes count for nothing at all — voiding
              with a reason is how a mis-keyed delivery is corrected, so counting one would mark a
              supplier down for our own paperwork. Draft notes have not happened yet.
            </dd>
          </div>
          <div>
            <dt className="font-semibold text-slate-800">Late</dt>
            <dd>
              The delivery date is after the <span className="font-medium">expected date</span> on
              the order. Both are plain calendar dates. Orders with no expected date are counted
              separately and are neither late nor on time — there was no promise to miss.
            </dd>
          </div>
          <div>
            <dt className="font-semibold text-slate-800">Split delivery</dt>
            <dd>An order that took more than one posted delivery to arrive.</dd>
          </div>
          <div>
            <dt className="font-semibold text-slate-800">Ended short</dt>
            <dd>
              An order <span className="font-medium">cancelled</span> while lines were still
              outstanding. An order that is merely part-received stays under &ldquo;still
              arriving&rdquo; and is <span className="font-medium">not</span> counted against the
              supplier — the next lorry may be booked for tomorrow.
            </dd>
          </div>
          <div>
            <dt className="font-semibold text-slate-800">Invoiced over the order</dt>
            <dd>
              The bills attached to an order add up to more, including VAT, than the order
              committed. Part-billed orders are not counted as under-charging: the rest of the
              invoice may not have arrived. Bills with no order attached cannot be compared to
              anything and are excluded.
            </dd>
          </div>
          <div>
            <dt className="font-semibold text-slate-800">How quickly we settle</dt>
            <dd>
              Days from the date on their invoice to the payment that finished settling it. This
              measures <span className="font-medium">us, not them</span>, and it is deliberately not
              called &ldquo;paid on time&rdquo;: no agreed payment term is stored anywhere in
              CrewFlow, so there is no deadline to be on time for.
            </dd>
          </div>
          <div>
            <dt className="font-semibold text-slate-800">
              Why some percentages are missing
            </dt>
            <dd>
              A rate is only shown once there are at least {MIN_RATED_SAMPLE} comparable records.
              Below that you get the raw counts instead. One late delivery out of one is not a
              &ldquo;100% late&rdquo; supplier, and printing it as one would be misleading even
              though the arithmetic is right.
            </dd>
          </div>
        </dl>
      </div>
    </details>
  );
}

// ---------------------------------------------------------------------------
// Delivery reliability
// ---------------------------------------------------------------------------

export function DeliverySection({
  d,
  ordersHref,
}: {
  d: DeliveryReliability;
  ordersHref: string;
}) {
  /**
   * The bands in their natural order, and DELIBERATELY all one neutral tone.
   *
   * An amber/amber/red scale here was the first thing written and then removed:
   * it is a severity ramp applied to an AGGREGATE, which is the letter-grading
   * this feature must not do. The band labels already carry the severity in
   * words ("8+ days late" is self-evidently worse than "1–3 days late") and the
   * counts carry the weight, so the colour added nothing except a verdict this
   * page has no standing to reach.
   */
  const bands = ["days1to3", "days4to7", "days8plus"] as const;

  return (
    <Card>
      <SectionHead
        title="Delivery reliability"
        blurb="Posted deliveries against this supplier's orders, compared with the expected date on the order."
        action={
          <Link
            href={ordersHref}
            className="inline-flex min-h-[44px] items-center justify-center rounded-md border border-slate-300 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            View orders
          </Link>
        }
      />

      {d.deliveries === 0 ? (
        <p className="mt-3 text-sm text-slate-500">
          No posted deliveries yet, so there is no delivery record to report.
          {d.excluded.draft > 0
            ? ` ${d.excluded.draft} draft note${d.excluded.draft === 1 ? "" : "s"} not yet posted.`
            : ""}
        </p>
      ) : (
        <>
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <CountTile label="Deliveries" value={d.deliveries} hint="posted notes" />
            <RatioTile label="Late" r={d.punctuality} hint="of those with an expected date" />
            <CountTile label="On time" value={d.onTime} hint="on or before the expected date" />
            <RatioTile label="Split deliveries" r={d.splitDeliveries} hint="orders needing 2+ drops" />
          </div>

          <SampleNote r={d.punctuality} />

          {d.punctuality.count > 0 ? (
            <div className="mt-4">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                When late, how late
              </h3>
              <ul className="mt-2 flex flex-wrap gap-2">
                {bands
                  .filter((b) => d.lateBands[b] > 0)
                  .map((b) => (
                    <li key={b}>
                      <Badge tone="slate">
                        {d.lateBands[b]} × {LATENESS_BAND_LABEL[b]}
                      </Badge>
                    </li>
                  ))}
              </ul>
            </div>
          ) : null}

          <Facts
            items={[
              {
                k: "Orders delivered",
                v: d.ordersDelivered,
                h: "with at least one delivery",
              },
              { k: "Fully received", v: d.ordersComplete, h: "every line arrived" },
              { k: "Still arriving", v: d.ordersInProgress, h: "part received, not counted" },
              { k: "Ended short", v: d.ordersEndedShort, h: "cancelled part-delivered" },
              {
                k: "No expected date",
                v: d.deliveriesWithoutPromisedDate,
                h: "cannot be judged",
              },
              {
                k: "Voided notes",
                v: d.excluded.voided,
                h: "excluded from every figure",
              },
            ]}
          />

          {d.deliveriesWithoutPromisedDate > 0 ? (
            <p className="mt-3 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
              {d.deliveriesWithoutPromisedDate} of {d.deliveries} deliveries arrived against an
              order with no expected date, so they are outside the late/on-time figures entirely.
              Setting an expected date when you raise an order is what makes this measurable.
            </p>
          ) : null}
        </>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// The evidence — every counted delivery, clickable
// ---------------------------------------------------------------------------

const VERDICT: Record<
  DeliveryRecord["verdict"],
  { label: string; tone: "emerald" | "amber" | "slate" }
> = {
  on_time: { label: "On time", tone: "emerald" },
  late: { label: "Late", tone: "amber" },
  unjudgeable: { label: "No expected date", tone: "slate" },
};

/**
 * How many evidence rows are rendered at once. A busy merchant can have
 * hundreds of deliveries and the read caps allow thousands, so the table is
 * bounded — but the HEADING then has to stop claiming to show every one of
 * them, which is why the count and the cap are both stated rather than the list
 * being silently truncated. The figures above are always computed over the FULL
 * set; only this listing is limited.
 */
const EVIDENCE_ROWS = 100;

/**
 * The rows the counts were computed from.
 *
 * This is what makes the section above auditable rather than something to be
 * believed: the operator can check any figure against the paperwork, one
 * delivery at a time, and every row links to the order it arrived against.
 */
export function DeliveryEvidence({ records }: { records: DeliveryRecord[] }) {
  if (records.length === 0) return null;
  const shown = records.slice(0, EVIDENCE_ROWS);
  const capped = records.length > shown.length;
  return (
    <Card padded={false}>
      <div className="p-4">
        <SectionHead
          title={
            capped
              ? `Deliveries — most recent ${shown.length} of ${records.length}`
              : `Every counted delivery (${records.length})`
          }
          blurb={
            capped
              ? `The records the figures above are counted from. The figures use all ${records.length}; this list shows the most recent ${shown.length}. Each row links to the order it arrived against.`
              : "The records the figures above are counted from. Each row links to the order it arrived against, so any number on this page can be checked against the paperwork."
          }
        />
      </div>
      <div>
        <Table>
          <THead>
            <TR hover={false}>
              <TH>Order</TH>
              <TH hideBelow="sm">Delivery note</TH>
              <TH>Expected</TH>
              <TH>Arrived</TH>
              <TH>Verdict</TH>
            </TR>
          </THead>
          <TBody>
            {shown.map((r) => {
              const v = VERDICT[r.verdict];
              const label =
                r.verdict === "late" && r.band ? LATENESS_BAND_LABEL[r.band] : v.label;
              return (
                <TR key={r.grnId}>
                  <TD>
                    <Link
                      href={`/purchase-orders/${r.purchaseOrderId}`}
                      className="font-medium text-slate-900 underline decoration-slate-300 underline-offset-2 hover:decoration-slate-900"
                    >
                      {r.poNumber?.trim() || "Order"}
                    </Link>
                  </TD>
                  <TD muted hideBelow="sm">
                    {r.grnNumber?.trim() || "—"}
                  </TD>
                  <TD muted>{r.promised ? formatDateUK(r.promised) : "—"}</TD>
                  <TD muted>{r.delivered ? formatDateUK(r.delivered) : "—"}</TD>
                  <TD>
                    <Badge tone={v.tone}>{label}</Badge>
                  </TD>
                </TR>
              );
            })}
          </TBody>
        </Table>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Price behaviour
// ---------------------------------------------------------------------------

export function PriceSection({ p, billsHref }: { p: PriceBehaviour; billsHref: string }) {
  return (
    <Card>
      <SectionHead
        title="What they invoice against what we ordered"
        blurb="Bills attached to a purchase order, compared with the order's committed total including VAT."
        action={
          <Link
            href={billsHref}
            className="inline-flex min-h-[44px] items-center justify-center rounded-md border border-slate-300 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            View bills
          </Link>
        }
      />

      {p.overBilled.n === 0 ? (
        <p className="mt-3 text-sm text-slate-500">
          No bills are attached to one of this supplier&rsquo;s orders yet, so there is nothing to
          compare an invoice against.
          {p.billsWithoutOrder > 0
            ? ` ${p.billsWithoutOrder} bill${p.billsWithoutOrder === 1 ? "" : "s"} recorded without an order.`
            : ""}
        </p>
      ) : (
        <>
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <RatioTile
              label="Invoiced over the order"
              r={p.overBilled}
              hint="of orders with a bill attached"
            />
            <CountTile
              label="Total over-invoiced"
              value={formatGbp(p.overBilledExcess)}
              hint="sum of the excess, inc VAT"
            />
            <CountTile
              label="Within the order"
              value={p.atOrUnderOrder}
              hint="invoiced up to the committed total"
            />
          </div>

          <SampleNote r={p.overBilled} />

          <Facts
            items={[
              {
                k: "Part-billed orders",
                v: p.partBilledOrders,
                h: "not a discount — invoice may be outstanding",
              },
              {
                k: "Bills with no order",
                v: p.billsWithoutOrder,
                h: "nothing to compare against",
              },
            ]}
          />
        </>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Settlement speed — ours, not theirs
// ---------------------------------------------------------------------------

export function SettlementSection({ s }: { s: SettlementSpeed }) {
  const bands = Object.keys(SETTLEMENT_BAND_LABEL) as Array<keyof SettlementSpeed["bands"]>;
  return (
    <Card>
      <SectionHead
        title="How quickly we settle their bills"
        blurb="Days from the date on their invoice to the payment that finished settling it. This is a measure of our own behaviour, not theirs."
      />
      <p className="mt-2 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
        Deliberately not shown as &ldquo;paid on time&rdquo;. CrewFlow stores no agreed payment term
        for a supplier bill, so there is no due date to be early or late against — only the elapsed
        days below, which are a fact.
      </p>

      {s.n === 0 ? (
        <p className="mt-3 text-sm text-slate-500">
          No bill has been fully settled yet, so there is nothing to time.
          {s.unsettledBills > 0
            ? ` ${s.unsettledBills} bill${s.unsettledBills === 1 ? "" : "s"} still outstanding.`
            : ""}
        </p>
      ) : (
        <>
          <div className="mt-3">
            <Table>
              <THead>
                <TR hover={false}>
                  <TH>Settled within</TH>
                  <TH numeric>Bills</TH>
                </TR>
              </THead>
              <TBody>
                {bands.map((b) => (
                  <TR key={b}>
                    <TD>{SETTLEMENT_BAND_LABEL[b]}</TD>
                    <TD numeric muted>
                      {s.bands[b]}
                    </TD>
                  </TR>
                ))}
                <TR hover={false} className="bg-slate-50 font-medium">
                  <TD>Bills counted</TD>
                  <TD numeric>{s.n}</TD>
                </TR>
              </TBody>
            </Table>
          </div>
          <Facts
            items={[
              { k: "Still outstanding", v: s.unsettledBills, h: "not yet fully settled" },
              {
                k: "No invoice date",
                v: s.excludedNoBillDate,
                h: "settled but not measurable",
              },
            ]}
          />
        </>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// What is deliberately absent
// ---------------------------------------------------------------------------

/**
 * The missing metric, named.
 *
 * Quality — defects attributable to a supplier — is the obvious fourth axis and
 * it is NOT here. Saying so on the surface matters: an operator who assumes a
 * clean delivery record means clean workmanship has been misled by the page's
 * silence, and would go on to make a buying decision on it.
 */
export function NotMeasuredSection() {
  return (
    <Card className="border-slate-300 bg-slate-50">
      <h2 className="text-sm font-semibold text-slate-900">What this page does not measure</h2>
      <div className="mt-2 space-y-2 text-xs leading-relaxed text-slate-600">
        <p>
          <span className="font-semibold text-slate-800">Workmanship and defects.</span> CrewFlow
          records snags against a <span className="font-medium">job</span>, with a free-text trade
          and the person assigned to fix them &mdash; who is normally one of your own. Nothing links
          a snag to the supplier or subcontractor whose work caused it, so any quality figure here
          would have to be guessed at from the trade name. A guess that says
          &ldquo;electrical&rdquo; would blame every electrical supplier at once, including for your
          own team&rsquo;s defects, so we show nothing rather than something wrong.
        </p>
        <p>
          <span className="font-semibold text-slate-800">A single supplier score.</span> There is
          no overall mark, star rating or grade, and that is deliberate. Delivery punctuality,
          invoice accuracy and how fast we pay are counted over different things and measure
          different parties; combining them into one number would mean deciding how many late
          deliveries equal one over-invoiced order, and nothing in your data knows that. The figures
          are shown side by side so you can weigh them for the job in front of you.
        </p>
      </div>
    </Card>
  );
}
