import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { updateCustomer, deleteCustomer, rotateCustomerPortalToken } from "../actions";
import { CustomerForm } from "../_form";

/**
 * Customer edit page.
 *
 * Loads the customer under user JWT (RLS filters to the caller's org).
 * Renders an edit form + a delete form. Delete only succeeds for
 * admins/owners (RLS).
 */
export default async function EditCustomerPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; saved?: string }>;
}) {
  const { id } = await params;
  const { error, saved } = await searchParams;

  await requireOrgContext();
  const supabase = await createClient();
  const { data: customer } = await supabase
    .from("customers")
    .select("id, name, email, phone, notes, portal_token, created_at")
    .eq("id", id)
    .maybeSingle();

  if (!customer) notFound();

  // Wave 6 — rollups
  const [quotesRes, jobsRes, leadsRes] = await Promise.all([
    supabase
      .from("quotes")
      .select("id, number, status, total, created_at")
      .eq("customer_id", id)
      .order("created_at", { ascending: false }),
    supabase
      .from("jobs")
      .select("id, status, scheduled_date, created_at")
      .eq("customer_id", id)
      .order("created_at", { ascending: false }),
    supabase
      .from("leads")
      .select("id, source, service, urgency, created_at")
      .eq("customer_id", id)
      .order("created_at", { ascending: false }),
  ]);

  const quoteIds = (quotesRes.data ?? []).map((q) => q.id);
  let invoiceRows: Array<{
    id: string;
    number: string;
    status: string;
    total: number | string | null;
    due_date: string | null;
    paid_at: string | null;
    created_at: string;
  }> = [];
  let paymentRows: Array<{
    id: string;
    invoice_id: string;
    amount: number | string | null;
    paid_at: string;
    reference: string | null;
  }> = [];
  if (quoteIds.length > 0) {
    const { data: invs } = await supabase
      .from("invoices")
      .select("id, number, status, total, due_date, paid_at, created_at")
      .in("quote_id", quoteIds)
      .order("created_at", { ascending: false });
    invoiceRows = invs ?? [];
    if (invoiceRows.length > 0) {
      const { data: pays } = await supabase
        .from("invoice_payments")
        .select("id, invoice_id, amount, paid_at, reference")
        .in(
          "invoice_id",
          invoiceRows.map((i) => i.id),
        );
      paymentRows = pays ?? [];
    }
  }

  // Totals
  const totalInvoiced = invoiceRows.reduce((s, i) => s + Number(i.total ?? 0), 0);
  const totalPaid = paymentRows.reduce((s, p) => s + Number(p.amount ?? 0), 0);
  const outstanding = Math.max(0, totalInvoiced - totalPaid);
  // Lifetime revenue = sum of paid invoice totals.
  const lifetimeRevenue = invoiceRows
    .filter((i) => i.status === "paid")
    .reduce((s, i) => s + Number(i.total ?? 0), 0);

  // Timeline — merge quotes / invoices / jobs / payments / leads.
  type TimelineEntry = {
    when: string;
    kind: string;
    label: string;
    href?: string;
  };
  const timeline: TimelineEntry[] = [
    ...((quotesRes.data ?? []) as Array<{ id: string; number: string; status: string; created_at: string }>).map((q) => ({
      when: q.created_at,
      kind: "quote",
      label: `Quote ${q.number} · ${q.status}`,
      href: `/quotes/${q.id}`,
    })),
    ...invoiceRows.map((i) => ({
      when: i.created_at,
      kind: "invoice",
      label: `Invoice ${i.number} · ${i.status}`,
      href: `/invoices/${i.id}`,
    })),
    ...((jobsRes.data ?? []) as Array<{ id: string; status: string; created_at: string }>).map((j) => ({
      when: j.created_at,
      kind: "job",
      label: `Job · ${j.status}`,
      href: `/jobs/${j.id}`,
    })),
    ...((leadsRes.data ?? []) as Array<{ id: string; service: string | null; source: string; created_at: string }>).map((l) => ({
      when: l.created_at,
      kind: "lead",
      label: `Lead · ${l.service ?? l.source}`,
      href: `/leads/${l.id}`,
    })),
    ...paymentRows.map((p) => ({
      when: p.paid_at,
      kind: "payment",
      label: `Payment £${Number(p.amount ?? 0).toFixed(2)}${p.reference ? ` · ${p.reference}` : ""}`,
      href: `/invoices/${p.invoice_id}`,
    })),
  ].sort((a, b) => (a.when < b.when ? 1 : -1));

  // Lifecycle button actions (portal token rotate / delete) still
  // redirect with ?error/?saved. Update form errors render inline.
  const errorMessage = error
    ? error === "delete_failed"
      ? "Couldn't delete. Only admins/owners can delete customers."
      : error === "portal_token_failed"
        ? "Couldn't generate the portal link. Try again."
        : error === "not_allowed"
          ? "You don't have permission for that action."
          : decodeURIComponent(error)
    : null;

  const portalSaved = saved === "portal_link";

  // Bind id into action so the form submission knows which customer.
  const updateAction = updateCustomer.bind(null, customer.id);
  const deleteAction = deleteCustomer.bind(null, customer.id);

  const GBP = new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: "GBP",
    minimumFractionDigits: 2,
  });

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="flex items-center gap-2 text-sm text-slate-500">
        <Link href="/customers" className="hover:text-slate-900">
          Customers
        </Link>
        <span aria-hidden>/</span>
        <span className="truncate text-slate-900">{customer.name}</span>
      </div>

      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">{customer.name}</h1>
          <p className="mt-1 text-sm text-slate-600">
            Customer since {customer.created_at.slice(0, 10)}
            {customer.email ? ` · ${customer.email}` : ""}
            {customer.phone ? ` · ${customer.phone}` : ""}
          </p>
        </div>
      </header>

      {/* Rollup tiles */}
      <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Tile label="Lifetime revenue" value={GBP.format(lifetimeRevenue)} sub="paid invoices" />
        <Tile label="Total invoiced" value={GBP.format(totalInvoiced)} sub={`${invoiceRows.length} invoice${invoiceRows.length === 1 ? "" : "s"}`} />
        <Tile label="Total paid" value={GBP.format(totalPaid)} sub={`${paymentRows.length} payment${paymentRows.length === 1 ? "" : "s"}`} />
        <Tile
          label="Outstanding"
          value={GBP.format(outstanding)}
          sub={outstanding === 0 ? "fully paid" : "still owed"}
          emphasis={outstanding > 0}
        />
      </section>

      {/* Quotes */}
      <SummaryCard
        title="Quotes"
        href="/quotes"
        empty="No quotes yet."
        items={((quotesRes.data ?? []) as Array<{ id: string; number: string; status: string; total: number | string | null }>).map((q) => ({
          id: q.id,
          left: q.number,
          mid: q.status,
          right: GBP.format(Number(q.total ?? 0)),
          href: `/quotes/${q.id}`,
        }))}
      />

      {/* Jobs */}
      <SummaryCard
        title="Jobs"
        href="/jobs"
        empty="No jobs yet."
        items={((jobsRes.data ?? []) as Array<{ id: string; status: string; scheduled_date: string | null; created_at: string }>).map((j) => ({
          id: j.id,
          left: `Job · ${j.id.slice(0, 8)}`,
          mid: j.status,
          right: j.scheduled_date ?? j.created_at.slice(0, 10),
          href: `/jobs/${j.id}`,
        }))}
      />

      {/* Invoices */}
      <SummaryCard
        title="Invoices"
        href="/invoices"
        empty="No invoices yet."
        items={invoiceRows.map((i) => ({
          id: i.id,
          left: i.number,
          mid: i.status,
          right: GBP.format(Number(i.total ?? 0)),
          href: `/invoices/${i.id}`,
        }))}
      />

      {/* Payments */}
      <SummaryCard
        title="Payments"
        href="/payments"
        empty="No payments recorded."
        items={paymentRows
          .sort((a, b) => (a.paid_at < b.paid_at ? 1 : -1))
          .map((p) => ({
            id: p.id,
            left: GBP.format(Number(p.amount ?? 0)),
            mid: p.reference ?? "—",
            right: p.paid_at.slice(0, 10),
            href: `/invoices/${p.invoice_id}`,
          }))}
      />

      {/* Timeline */}
      <section className="rounded-xl border border-slate-200 bg-white shadow-sm">
        <header className="border-b border-slate-200 px-6 py-3">
          <h2 className="text-base font-semibold text-slate-900">Timeline</h2>
          <p className="text-xs text-slate-500">Everything that&apos;s happened with this customer, newest first.</p>
        </header>
        {timeline.length === 0 ? (
          <p className="p-6 text-sm text-slate-500">No activity yet.</p>
        ) : (
          <ol className="divide-y divide-slate-100">
            {timeline.slice(0, 20).map((t, i) => (
              <li key={`${t.kind}-${i}`} className="flex items-center justify-between px-6 py-2 text-sm">
                {t.href ? (
                  <Link href={t.href} className="min-w-0 flex-1 truncate text-slate-700 hover:text-slate-900">
                    <span className="mr-2 text-xs uppercase tracking-wide text-slate-400">{t.kind}</span>
                    {t.label}
                  </Link>
                ) : (
                  <span className="min-w-0 flex-1 truncate text-slate-700">
                    <span className="mr-2 text-xs uppercase tracking-wide text-slate-400">{t.kind}</span>
                    {t.label}
                  </span>
                )}
                <span className="ml-3 shrink-0 text-xs text-slate-500">{t.when.slice(0, 10)}</span>
              </li>
            ))}
          </ol>
        )}
      </section>

      <header>
        <h2 className="text-base font-semibold text-slate-900">Edit details</h2>
      </header>

      {errorMessage ? (
        <div
          role="alert"
          className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          {errorMessage}
        </div>
      ) : null}
      {portalSaved ? (
        <div
          role="status"
          className="rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-700"
        >
          Portal link generated. Share the URL below with the customer.
        </div>
      ) : null}

      <CustomerForm
        action={updateAction}
        submitLabel="Save changes"
        cancelHref="/customers"
        defaults={{
          name: customer.name,
          email: customer.email ?? "",
          phone: customer.phone ?? "",
          notes: customer.notes ?? "",
        }}
      />

      {/* Customer portal link */}
      <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-base font-semibold text-slate-900">Customer portal link</h2>
        <p className="mt-1 text-sm text-slate-600">
          Share this URL with {customer.name} so they can see their quotes
          and invoices online. Anyone with the link gets access — no
          password needed.
        </p>

        {customer.portal_token ? (
          <div className="mt-4 space-y-3">
            <div className="break-all rounded-md bg-slate-50 px-3 py-2 font-mono text-xs text-slate-700">
              /customer-portal/{customer.portal_token}
            </div>
            <p className="text-xs text-slate-500">
              Prepend your site URL when sharing —
              <code className="ml-1 rounded bg-slate-100 px-1 py-0.5">
                https://crewflow.uk/customer-portal/{customer.portal_token.slice(0, 8)}…
              </code>
            </p>
            <form action={rotateCustomerPortalToken.bind(null, customer.id)}>
              <button
                type="submit"
                className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
              >
                Regenerate (invalidates current link)
              </button>
            </form>
          </div>
        ) : (
          <form
            action={rotateCustomerPortalToken.bind(null, customer.id)}
            className="mt-4"
          >
            <button
              type="submit"
              className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-slate-800"
            >
              Generate portal link
            </button>
          </form>
        )}
      </section>

      <form
        action={deleteAction}
        className="rounded-xl border border-red-200 bg-red-50/50 p-4"
      >
        <p className="text-sm font-medium text-red-900">Delete this customer</p>
        <p className="mt-1 text-xs text-red-700">
          Removes the customer record. Linked jobs will keep their reference but
          the link will be cleared. Only admins/owners can delete.
        </p>
        <button
          type="submit"
          className="mt-3 rounded-md border border-red-300 bg-white px-3 py-1.5 text-xs font-medium text-red-700 transition hover:bg-red-100"
        >
          Delete customer
        </button>
      </form>
    </div>
  );
}

function Tile({
  label,
  value,
  sub,
  emphasis,
}: {
  label: string;
  value: string;
  sub: string;
  emphasis?: boolean;
}) {
  return (
    <div
      className={
        emphasis
          ? "rounded-xl border border-amber-200 bg-amber-50 p-4 shadow-sm"
          : "rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
      }
    >
      <div className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</div>
      <div className="mt-1 text-xl font-bold text-slate-900">{value}</div>
      <div className="mt-0.5 text-xs text-slate-500">{sub}</div>
    </div>
  );
}

function SummaryCard({
  title,
  href,
  items,
  empty,
}: {
  title: string;
  href: string;
  items: Array<{ id: string; left: string; mid: string; right: string; href: string }>;
  empty: string;
}) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white shadow-sm">
      <header className="flex items-center justify-between border-b border-slate-200 px-6 py-3">
        <h2 className="text-base font-semibold text-slate-900">{title}</h2>
        <Link href={href} className="text-xs font-medium text-slate-500 hover:text-slate-900">
          All {title.toLowerCase()} →
        </Link>
      </header>
      {items.length === 0 ? (
        <p className="p-6 text-sm text-slate-500">{empty}</p>
      ) : (
        <ul className="divide-y divide-slate-100">
          {items.slice(0, 5).map((it) => (
            <li key={it.id} className="flex items-center justify-between gap-3 px-6 py-2 text-sm">
              <Link href={it.href} className="min-w-0 flex-1 truncate font-medium text-slate-900 hover:underline">
                {it.left}
              </Link>
              <span className="hidden text-xs text-slate-500 sm:inline">{it.mid}</span>
              <span className="shrink-0 text-xs text-slate-700">{it.right}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
