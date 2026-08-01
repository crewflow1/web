import Link from "next/link";
import { redirect } from "next/navigation";
import { requireOrgContext } from "@/server/auth/session";
import { buildAgedLedgers } from "@/server/services/aged-ledgers";
import {
  AGEING_BUCKETS,
  AGEING_BUCKET_LABEL,
  type AgeingLedger,
} from "@/lib/commercial/ageing";
import { formatGbp } from "@/lib/money";
import { formatDateShortUK } from "@/lib/time/format";
import { Badge, StatTile, Table, THead, TBody, TR, TH, TD } from "@/components/ui";
import { EmptyState } from "../../_components/empty-state";

export const dynamic = "force-dynamic";

export const metadata = { title: "Aged debtors & creditors · CrewFlow" };

/**
 * /reports/ageing — AGED DEBTORS and AGED CREDITORS.
 *
 * The two listings every accountant asks for at month end, and the two a builder
 * needs before deciding who to chase and who to pay. Both compose the existing
 * money authorities; neither re-derives a balance (see
 * server/services/aged-ledgers.ts for the reconciliation identities that tie the
 * debtors total to the /cash figure).
 *
 * Both sides now age from a DUE DATE, and the page says so on the face of it:
 * debtors from the invoice due date, creditors from the bill date plus the
 * supplier's payment terms (migration 20261088). Where a supplier has no recorded
 * terms the page DISCLOSES the 30-day assumption in words rather than presenting
 * it as an agreed deadline — the honesty rule aged creditors was built around.
 *
 * Read-only. Staff are redirected — this is the company's whole debtor and
 * creditor book.
 */

/**
 * All five bucket columns collapse together below `md`, never partially.
 *
 * A five-column money matrix cannot be read at 375px, and showing SOME of the
 * columns is worse than showing none: the visible ones no longer add up to the
 * Total beside them, and a reader has no way to know a column is missing. So the
 * phone layout is name + total, with the full breakdown as one wrapped line —
 * every figure still present, nothing implied by omission.
 */
const BUCKET_HIDE = "md" as const;

/** The complete bucket breakdown as one line, for the collapsed layout. */
function BucketBreakdown({
  buckets,
  className,
}: {
  buckets: Record<(typeof AGEING_BUCKETS)[number], number>;
  className?: string;
}) {
  const parts = AGEING_BUCKETS.filter((b) => buckets[b] > 0).map(
    (b) => `${AGEING_BUCKET_LABEL[b]} ${formatGbp(buckets[b])}`,
  );
  if (parts.length === 0) return null;
  return <span className={className}>{parts.join(" · ")}</span>;
}

function AgeingTable({
  ledger,
  partyLabel,
  dateLabel,
}: {
  ledger: AgeingLedger;
  partyLabel: string;
  dateLabel: string;
}) {
  const t = ledger.totals;
  return (
    <Table>
      <THead>
        <TR hover={false}>
          <TH>{partyLabel}</TH>
          {AGEING_BUCKETS.map((b) => (
            <TH key={b} numeric hideBelow={BUCKET_HIDE}>
              {AGEING_BUCKET_LABEL[b]}
            </TH>
          ))}
          <TH numeric>Total</TH>
        </TR>
      </THead>
      <TBody>
        {ledger.rows.map((row) => (
          <TR key={row.partyId || "unattributed"}>
            <TD>
              <span className="font-medium text-slate-900">{row.partyName}</span>
              <span className="block text-xs text-slate-500">
                {row.itemCount} {row.itemCount === 1 ? "item" : "items"}
                {row.oldestAgeDays != null && row.oldestAgeDays > 0
                  ? ` · oldest ${row.oldestAgeDays}d`
                  : ""}
              </span>
              <BucketBreakdown
                buckets={row.buckets}
                className="mt-0.5 block text-xs text-slate-500 md:hidden"
              />
            </TD>
            {AGEING_BUCKETS.map((b) => (
              <TD
                key={b}
                numeric
                hideBelow={BUCKET_HIDE}
                className={
                  b === "d91_plus" && row.buckets[b] > 0 ? "font-medium text-red-700" : undefined
                }
              >
                {row.buckets[b] > 0 ? formatGbp(row.buckets[b]) : "—"}
              </TD>
            ))}
            <TD numeric className="font-semibold text-slate-900">
              {formatGbp(row.total)}
            </TD>
          </TR>
        ))}
        <TR hover={false} className="bg-slate-50 font-semibold">
          <TD>
            Total
            <span className="block text-xs font-normal text-slate-500">
              aged from the {dateLabel}
            </span>
            <BucketBreakdown
              buckets={t.buckets}
              className="mt-0.5 block text-xs font-normal text-slate-600 md:hidden"
            />
          </TD>
          {AGEING_BUCKETS.map((b) => (
            <TD key={b} numeric hideBelow={BUCKET_HIDE} className="text-slate-900">
              {formatGbp(t.buckets[b])}
            </TD>
          ))}
          <TD numeric className="text-slate-900">
            {formatGbp(t.total)}
          </TD>
        </TR>
      </TBody>
    </Table>
  );
}

/** The oldest handful of items on one side — what to actually pick up the phone about. */
function OldestList({ ledger, emptyText }: { ledger: AgeingLedger; emptyText: string }) {
  const items = ledger.rows
    .flatMap((r) => r.items.map((i) => ({ ...i, party: r.partyName })))
    .filter((i) => i.ageDays != null && i.ageDays > 0)
    .sort((a, b) => (b.ageDays ?? 0) - (a.ageDays ?? 0) || b.amount - a.amount || a.id.localeCompare(b.id))
    .slice(0, 8);

  if (items.length === 0) return <p className="p-4 text-sm text-slate-500">{emptyText}</p>;

  return (
    <ul className="divide-y divide-slate-100">
      {items.map((i) => (
        <li key={i.id}>
          <Link href={i.href} className="flex items-center justify-between gap-3 p-3 hover:bg-slate-50">
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium text-slate-900">
                {i.party}
                {i.reference ? ` · ${i.reference}` : ""}
              </span>
              <span className="block text-xs text-slate-500">
                {i.dateIso ? formatDateShortUK(`${i.dateIso}T00:00:00Z`) : "no date"} ·{" "}
                {i.ageDays}
                {" days"}
              </span>
            </span>
            <span className="shrink-0 text-sm font-semibold tabular-nums text-slate-900">
              {formatGbp(i.amount)}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

export default async function AgeingReportPage() {
  const { ctx } = await requireOrgContext();
  if (ctx.membership.role === "staff") redirect("/me");

  const { debtors, creditors, creditorsVisible, asAtIso, loadError } = await buildAgedLedgers(
    ctx.org.id,
    ctx.membership.role,
  );

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <div className="flex items-center gap-2 text-sm text-slate-500">
          <Link href="/reports" className="hover:text-slate-900">
            Reports
          </Link>
          <span aria-hidden>/</span>
          <span className="text-slate-900">Aged debtors &amp; creditors</span>
        </div>
        <h1 className="text-2xl font-bold text-slate-900">Aged debtors &amp; creditors</h1>
        <p className="max-w-3xl text-sm text-slate-600">
          Who owes you, who you owe, and how long it has been.{" "}
          <span className="whitespace-nowrap">As at {formatDateShortUK(`${asAtIso}T00:00:00Z`)}.</span>{" "}
          Columns count whole days past the ageing date and include their upper bound — exactly 30
          days late sits in <em>1&ndash;30 days</em>, and money due today is <em>current</em>.
        </p>
      </header>

      {loadError ? (
        <div
          role="alert"
          className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900"
        >
          We couldn&rsquo;t load the whole ledger just now, so the figures below may be incomplete.
          Please refresh rather than trusting a low total.
        </div>
      ) : null}

      <section aria-label="Ageing summary" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile
          label="Owed to you"
          value={formatGbp(debtors.totals.total)}
          hint={`${debtors.totals.partyCount} ${debtors.totals.partyCount === 1 ? "customer" : "customers"}`}
        />
        <StatTile
          label="Of that, overdue"
          value={formatGbp(debtors.totals.pastDue)}
          tone={debtors.totals.pastDue > 0 ? "red" : "slate"}
          hint="past the invoice due date"
        />
        <StatTile
          label="You owe"
          value={creditorsVisible ? formatGbp(creditors.totals.total) : "—"}
          hint={
            creditorsVisible
              ? `${creditors.totals.partyCount} ${creditors.totals.partyCount === 1 ? "supplier" : "suppliers"}`
              : "owners and admins only"
          }
        />
        {/* The 90+ BUCKET TOTAL, not "the oldest debt" — a tile that says one and
            shows the other is how a report loses an operator's trust. */}
        <StatTile
          label="Supplier debt 90+ days"
          value={creditorsVisible ? formatGbp(creditors.totals.buckets.d91_plus) : "—"}
          tone={creditorsVisible && creditors.totals.buckets.d91_plus > 0 ? "amber" : "slate"}
          hint="more than 90 days past due"
        />
      </section>

      {/* ── Aged debtors ───────────────────────────────────────────────────── */}
      <section
        aria-labelledby="debtors-heading"
        className="rounded-xl border border-slate-200 bg-white shadow-sm"
      >
        <div className="border-b border-slate-100 p-4">
          <h2 id="debtors-heading" className="text-sm font-semibold text-slate-900">
            Aged debtors by customer
          </h2>
          <p className="mt-0.5 text-xs text-slate-500">
            Aged from each invoice&rsquo;s <strong>due date</strong> — the deadline actually missed,
            not the date it was raised. Balances come from the payment ledger, so a part-paid
            invoice shows only what is still owed. This total is the same figure{" "}
            <Link href="/cash" className="underline hover:text-slate-900">
              Get paid
            </Link>{" "}
            reports as owed.
            {debtors.totals.undated > 0 ? (
              <>
                {" "}
                <strong>{formatGbp(debtors.totals.undated)}</strong> has no due date at all and sits
                in <em>current</em> — it can never be called overdue until a date is set.
              </>
            ) : null}
          </p>
        </div>
        {debtors.rows.length === 0 ? (
          <div className="p-4">
            <EmptyState
              title="Nothing outstanding"
              body="Every issued invoice has been settled. New invoices appear here as soon as they're sent."
              primary={{ href: "/invoices", label: "Go to invoices" }}
            />
          </div>
        ) : (
          <AgeingTable ledger={debtors} partyLabel="Customer" dateLabel="invoice due date" />
        )}
      </section>

      <section
        aria-labelledby="oldest-debt-heading"
        className="rounded-xl border border-slate-200 bg-white shadow-sm"
      >
        <h2
          id="oldest-debt-heading"
          className="border-b border-slate-100 p-3 text-sm font-semibold text-slate-900"
        >
          Oldest overdue invoices
        </h2>
        <OldestList ledger={debtors} emptyText="Nothing is past its due date." />
      </section>

      {/* ── Aged creditors ─────────────────────────────────────────────────── */}
      <section
        aria-labelledby="creditors-heading"
        className="rounded-xl border border-slate-200 bg-white shadow-sm"
      >
        <div className="border-b border-slate-100 p-4">
          <h2 id="creditors-heading" className="text-sm font-semibold text-slate-900">
            Aged creditors by supplier
          </h2>
          <p className="mt-0.5 text-xs text-slate-500">
            Aged from each bill&rsquo;s <strong>due date</strong> — the bill date plus the
            supplier&rsquo;s payment terms. Where a supplier has no terms recorded, these columns{" "}
            <strong>assume 30 days</strong>; set a supplier&rsquo;s terms on their page to age
            their bills exactly. Amounts are VAT-inclusive (that is what a supplier is paid) and net
            off every payment allocated to the bill; voided payments settle nothing. Bills not
            linked to a supplier are excluded — they can&rsquo;t be aged against an account.
          </p>
        </div>
        {!creditorsVisible ? (
          <div className="p-4">
            <Badge tone="slate">Restricted</Badge>
            <p className="mt-2 text-sm text-slate-600">
              The supplier payment ledger is limited to owners and admins, so aged creditors
              can&rsquo;t be shown for your role. It is withheld rather than estimated: without the
              payment records every bill would look entirely unpaid and the figure would be wrong,
              not merely incomplete.
            </p>
          </div>
        ) : creditors.rows.length === 0 ? (
          <div className="p-4">
            <EmptyState
              title="Nothing owed to suppliers"
              body="Every supplier bill on record has been settled in full."
              primary={{ href: "/suppliers", label: "Go to suppliers" }}
            />
          </div>
        ) : (
          <AgeingTable ledger={creditors} partyLabel="Supplier" dateLabel="bill due date" />
        )}
      </section>

      {creditorsVisible && creditors.rows.length > 0 ? (
        <section
          aria-labelledby="oldest-bills-heading"
          className="rounded-xl border border-slate-200 bg-white shadow-sm"
        >
          <h2
            id="oldest-bills-heading"
            className="border-b border-slate-100 p-3 text-sm font-semibold text-slate-900"
          >
            Oldest unpaid bills
          </h2>
          <OldestList ledger={creditors} emptyText="No unpaid bill is past its due date." />
        </section>
      ) : null}
    </div>
  );
}
