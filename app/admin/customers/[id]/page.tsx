import Link from "next/link";
import { notFound } from "next/navigation";
import { loadCustomerSnapshot } from "@/server/services/hq-customer-snapshot";
import {
  formatGbp,
  HEALTH_PILL,
  SETUP_FEE_LABELS,
  SETUP_FEE_PILL,
  SUBSCRIPTION_PILL,
  formatMigrationEta,
  type SetupFeeStatus,
} from "@/lib/hq/customer-financials";
import {
  updateCustomerFinancials,
  updateCustomerProgress,
  updateCustomerNotes,
  setCustomerLifecycle,
  logImpersonationAttempt,
} from "../actions";
import { CustomerImpersonateModal } from "./_impersonate";
import { ClientConfirmForm } from "./_confirm";
import {
  createSetupCheckout,
  createSubscriptionCheckout,
} from "./_stripe-actions";

/**
 * Customers OS — per-customer detail page (HQ-3).
 *
 * Sections (top to bottom):
 *   1. Identity header — name, owner, contact, status pills
 *   2. KPI tiles — MRR, LTV, setup fee, subscription, health, migration ETA
 *   3. Financials editor (server form)
 *   4. Onboarding / migration editor (server form)
 *   5. Actions row — Open, Message (mailto:), Call (tel:), Email,
 *      Impersonate (audit-logged stub for HQ-3.1), Suspend, Cancel
 *   6. CEO notes editor
 *   7. Timeline — aggregated from admin_activity_log + demo_requests +
 *      imports + invoice_payments
 *
 * Every editable form is a plain server-action <form>; no client JS
 * for the core flow. The impersonate confirmation uses a tiny client
 * modal (./_impersonate.tsx) for the "are you sure?" gate before the
 * audit row gets written.
 */

type Params = Promise<{ id: string }>;
type SP = Promise<{ saved?: string; error?: string; detail?: string; stripe?: string; kind?: string }>;

export default async function HqCustomerDetailPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: SP;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const snap = await loadCustomerSnapshot(id);
  if (!snap) notFound();

  const { org, owner, subscription, ltv, health, timeline, demoRequest } = snap;
  const setupFee = org.setup_fee_status as SetupFeeStatus;

  const saved = sp.saved
    ? prettySaved(decodeURIComponent(sp.saved))
    : null;
  const errorMsg = sp.error
    ? prettyCheckoutError(
        decodeURIComponent(sp.error),
        sp.detail ? decodeURIComponent(sp.detail) : null,
      )
    : null;

  // Open-workspace deep link — operator wants to view what the
  // customer sees. Goes via /dashboard so the org switcher picks up
  // the active-org cookie if the operator is a member (CEO often is).
  const ownerEmail = owner?.email ?? null;
  const phone = org.phone ?? owner?.phone ?? null;
  const billingEmail = org.billing_email ?? ownerEmail ?? null;

  return (
    <div className="space-y-6">
      {/* Breadcrumb */}
      <p className="text-sm text-slate-500">
        <Link href="/admin/customers" className="hover:text-slate-900">
          Customers OS
        </Link>{" "}
        / <span className="text-slate-900">{org.name}</span>
      </p>

      {/* Identity */}
      <header className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
              Workspace · {org.created_at.slice(0, 10)}
            </p>
            <h1 className="mt-0.5 text-2xl font-bold text-slate-900">
              {org.name}
            </h1>
            <p className="mt-1 text-sm text-slate-600">
              Owner:{" "}
              <strong className="text-slate-900">
                {owner?.full_name ?? "—"}
              </strong>{" "}
              ·{" "}
              {ownerEmail ? (
                <a
                  href={`mailto:${ownerEmail}`}
                  className="hover:text-slate-900"
                >
                  {ownerEmail}
                </a>
              ) : (
                "—"
              )}
              {phone ? (
                <>
                  {" · "}
                  <a
                    href={`tel:${phone.replace(/\s/g, "")}`}
                    className="hover:text-slate-900"
                  >
                    {phone}
                  </a>
                </>
              ) : null}
            </p>
            <p className="mt-1 text-xs text-slate-500">
              VAT: {org.vat_number ?? "—"} · Slug: {org.slug}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-medium ${SUBSCRIPTION_PILL[subscription]}`}
            >
              {subscription}
            </span>
            <span
              className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-medium ${SETUP_FEE_PILL[setupFee]}`}
            >
              Setup: {SETUP_FEE_LABELS[setupFee]}
            </span>
            <span
              className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-medium ${HEALTH_PILL[health.risk]}`}
              title={health.reasons.join(" · ")}
            >
              Health {health.score} ({health.risk})
            </span>
          </div>
        </div>
      </header>

      {/* Banners */}
      {errorMsg ? (
        <div
          role="alert"
          className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          {errorMsg}
        </div>
      ) : null}
      {saved ? (
        <div
          role="status"
          className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800"
        >
          {saved}
        </div>
      ) : null}

      {/* KPI tiles */}
      <section className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Tile label="MRR" value={formatGbp(Number(org.mrr_gbp))} />
        <Tile label="LTV" value={formatGbp(ltv)} />
        <Tile
          label="Onboarding"
          value={`${org.onboarding_percent}%`}
          sub={
            <ProgressBar percent={org.onboarding_percent} colour="bg-slate-900" />
          }
        />
        <Tile
          label="Migration"
          value={`${org.migration_percent}%`}
          sub={
            <ProgressBar percent={org.migration_percent} colour="bg-emerald-600" />
          }
        />
        <Tile label="Migration ETA" value={formatMigrationEta(org.migration_eta)} />
        <Tile
          label="Last login"
          value={org.last_login_at ? org.last_login_at.slice(0, 10) : "—"}
          sub={
            <span className="text-[10px] text-slate-500">
              Trial ends:{" "}
              {org.trial_ends_at ? org.trial_ends_at.slice(0, 10) : "—"}
            </span>
          }
        />
      </section>

      {/* Action row */}
      <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <h2 className="text-base font-semibold text-slate-900">Actions</h2>
        <p className="mt-1 text-xs text-slate-500">
          Every action lands in the activity timeline below.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <Link
            href="/dashboard"
            className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
          >
            Open workspace
          </Link>
          <ContactButton
            href={ownerEmail ? `mailto:${ownerEmail}` : null}
            label="Email owner"
          />
          <ContactButton
            href={
              ownerEmail
                ? `mailto:${ownerEmail}?subject=${encodeURIComponent(`CrewFlow — ${org.name}`)}`
                : null
            }
            label="Message"
          />
          <ContactButton
            href={phone ? `tel:${phone.replace(/\s/g, "")}` : null}
            label="Call"
          />
          <CustomerImpersonateModal
            orgId={org.id}
            orgName={org.name}
            action={logImpersonationAttempt}
          />
          <LifecycleButton
            orgId={org.id}
            status="suspended"
            label="Suspend"
            tone="amber"
            confirm={`Suspend ${org.name}? Their workspace will lock immediately.`}
            disabled={org.status === "suspended"}
          />
          <LifecycleButton
            orgId={org.id}
            status="cancelled"
            label="Cancel"
            tone="red"
            confirm={`Cancel ${org.name}? They lose access; record stays for audit.`}
            disabled={org.status === "cancelled"}
          />
          {(org.status === "suspended" || org.status === "cancelled") ? (
            <LifecycleButton
              orgId={org.id}
              status="active"
              label="Reactivate"
              tone="emerald"
              confirm={`Reactivate ${org.name}? Their workspace will unlock immediately.`}
            />
          ) : null}
        </div>
      </section>

      {/* Financials editor */}
      <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="text-base font-semibold text-slate-900">Financials</h2>
        <p className="mt-1 text-xs text-slate-500">
          Manual until Stripe lands. Setup fee + MRR + LTV are operator-managed.
          The cached LTV overrides the heuristic estimate when set.
        </p>
        <form
          action={updateCustomerFinancials}
          className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4"
        >
          <input type="hidden" name="org_id" value={org.id} />
          <label className="text-[11px] font-medium text-slate-600">
            Setup fee status
            <select
              name="setup_fee_status"
              defaultValue={setupFee}
              className="mt-1 block w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm"
            >
              {Object.entries(SETUP_FEE_LABELS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </label>
          <label className="text-[11px] font-medium text-slate-600">
            MRR (£/mo)
            <input
              name="mrr_gbp"
              type="number"
              min={0}
              step={1}
              defaultValue={Number(org.mrr_gbp).toString()}
              className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm"
            />
          </label>
          <label className="text-[11px] font-medium text-slate-600">
            LTV override (£) <span className="text-slate-400">optional</span>
            <input
              name="ltv_gbp"
              type="number"
              min={0}
              step={1}
              defaultValue={Number(org.ltv_gbp) > 0 ? Number(org.ltv_gbp).toString() : ""}
              placeholder={`Est. ${formatGbp(ltv)}`}
              className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm"
            />
          </label>
          <label className="text-[11px] font-medium text-slate-600">
            Billing email <span className="text-slate-400">optional</span>
            <input
              name="billing_email"
              type="email"
              defaultValue={billingEmail ?? ""}
              placeholder={ownerEmail ?? "—"}
              className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm"
            />
          </label>
          <div className="sm:col-span-2 lg:col-span-4">
            <button
              type="submit"
              className="rounded-md bg-slate-900 px-4 py-1.5 text-xs font-semibold text-white hover:bg-slate-800"
            >
              Save financials
            </button>
            {org.setup_fee_paid_at ? (
              <span className="ml-3 text-[11px] text-slate-500">
                Setup fee paid {org.setup_fee_paid_at.slice(0, 10)}
              </span>
            ) : null}
            {org.stripe_customer_id ? (
              <span className="ml-3 text-[11px] text-slate-500">
                Stripe customer: <code>{org.stripe_customer_id}</code>
              </span>
            ) : (
              <span className="ml-3 text-[11px] text-slate-400">
                Stripe not yet linked
              </span>
            )}
          </div>
        </form>
      </section>

      {/* Stripe checkout actions */}
      <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 className="text-base font-semibold text-slate-900">
            Stripe checkout
          </h2>
          <div className="flex flex-wrap items-center gap-3">
            <a
              href="/api/admin/stripe/provision"
              target="_blank"
              rel="noreferrer noopener"
              className="rounded-md border border-amber-300 bg-amber-50 px-2 py-1 text-[11px] font-semibold text-amber-900 hover:bg-amber-100"
            >
              Provision Stripe products →
            </a>
            <a
              href="/api/admin/stripe/verify"
              target="_blank"
              rel="noreferrer noopener"
              className="text-[11px] font-medium text-slate-500 hover:text-slate-900 hover:underline"
            >
              Run integration diagnostic →
            </a>
          </div>
        </div>
        <p className="mt-1 text-xs text-slate-500">
          Open a hosted Stripe Checkout. The webhook at{" "}
          <code className="rounded bg-slate-100 px-1 py-0.5 text-[10px]">
            /api/webhooks/stripe
          </code>{" "}
          is the source of truth — billing state updates only when Stripe
          confirms payment.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <form action={createSetupCheckout}>
            <input type="hidden" name="org_id" value={org.id} />
            <button
              type="submit"
              className="rounded-md border border-indigo-300 bg-indigo-50 px-3 py-1.5 text-xs font-semibold text-indigo-900 hover:bg-indigo-100"
            >
              Open setup-fee checkout (£1,000)
            </button>
          </form>
          <form action={createSubscriptionCheckout}>
            <input type="hidden" name="org_id" value={org.id} />
            <button
              type="submit"
              className="rounded-md border border-emerald-300 bg-emerald-50 px-3 py-1.5 text-xs font-semibold text-emerald-900 hover:bg-emerald-100"
            >
              Open subscription checkout (£500/mo)
            </button>
          </form>
        </div>
      </section>

      {/* Onboarding / migration */}
      <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="text-base font-semibold text-slate-900">
          Onboarding &amp; migration
        </h2>
        <p className="mt-1 text-xs text-slate-500">
          Cross-checked against the customer&apos;s setup checklist on{" "}
          <code>/dashboard</code>. AI migration assistant slot reserved for a
          later sprint.
        </p>
        <form
          action={updateCustomerProgress}
          className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4"
        >
          <input type="hidden" name="org_id" value={org.id} />
          <label className="text-[11px] font-medium text-slate-600">
            Onboarding %
            <input
              name="onboarding_percent"
              type="number"
              min={0}
              max={100}
              defaultValue={org.onboarding_percent}
              className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm"
            />
          </label>
          <label className="text-[11px] font-medium text-slate-600">
            Migration %
            <input
              name="migration_percent"
              type="number"
              min={0}
              max={100}
              defaultValue={org.migration_percent}
              className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm"
            />
          </label>
          <label className="text-[11px] font-medium text-slate-600">
            Migration stage <span className="text-slate-400">optional</span>
            <input
              name="migration_stage"
              type="text"
              maxLength={200}
              defaultValue={org.migration_stage ?? ""}
              placeholder="e.g. Importing invoices"
              className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm"
            />
          </label>
          <label className="text-[11px] font-medium text-slate-600">
            Migration ETA <span className="text-slate-400">optional</span>
            <input
              name="migration_eta"
              type="date"
              defaultValue={org.migration_eta ?? ""}
              className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm"
            />
          </label>
          <div className="sm:col-span-2 lg:col-span-4">
            <button
              type="submit"
              className="rounded-md bg-slate-900 px-4 py-1.5 text-xs font-semibold text-white hover:bg-slate-800"
            >
              Save progress
            </button>
            {demoRequest ? (
              <span className="ml-3 text-[11px] text-slate-500">
                Originated from demo {demoRequest.created_at.slice(0, 10)} ·{" "}
                <Link
                  href={`/admin/demos?demo=${demoRequest.id}`}
                  className="underline hover:text-slate-900"
                >
                  open demo
                </Link>
              </span>
            ) : null}
          </div>
        </form>
      </section>

      {/* CEO notes */}
      <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="text-base font-semibold text-slate-900">CEO notes</h2>
        <p className="mt-1 text-xs text-slate-500">
          Private. Visible only to super-admins. Never shown to the customer.
        </p>
        <form action={updateCustomerNotes} className="mt-3 space-y-2">
          <input type="hidden" name="org_id" value={org.id} />
          <textarea
            name="notes"
            rows={4}
            maxLength={10_000}
            defaultValue={org.admin_org_notes ?? ""}
            placeholder="Late payer · Needs onboarding call · High-value lead · …"
            className="block w-full rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
          />
          <button
            type="submit"
            className="rounded-md bg-slate-900 px-4 py-1.5 text-xs font-semibold text-white hover:bg-slate-800"
          >
            Save notes
          </button>
        </form>
      </section>

      {/* Timeline */}
      <section className="rounded-xl border border-slate-200 bg-white shadow-sm">
        <header className="border-b border-slate-200 px-5 py-3">
          <h2 className="text-base font-semibold text-slate-900">Timeline</h2>
          <p className="mt-0.5 text-xs text-slate-500">
            Aggregates demo, payment, migration, support and usage events for
            this workspace.
          </p>
        </header>
        {timeline.length === 0 ? (
          <p className="px-5 py-8 text-center text-sm text-slate-500">
            No events yet. Status flips, notes, contact clicks, payments, and
            migrations all land here.
          </p>
        ) : (
          <ol className="divide-y divide-slate-100">
            {timeline.slice(0, 50).map((ev, i) => (
              <li
                key={`${ev.at}-${i}`}
                className="flex items-start gap-3 px-5 py-2.5 text-sm"
              >
                <span
                  className={`mt-1.5 inline-block h-2 w-2 shrink-0 rounded-full ${kindColour(ev.kind)}`}
                  aria-hidden
                />
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-slate-900">{ev.label}</p>
                  {ev.detail ? (
                    <p className="mt-0.5 text-xs text-slate-600">{ev.detail}</p>
                  ) : null}
                  {ev.actor ? (
                    <p className="mt-0.5 text-[11px] text-slate-500">
                      by {ev.actor}
                    </p>
                  ) : null}
                </div>
                <span className="shrink-0 text-[11px] text-slate-500">
                  {ev.at.slice(0, 16).replace("T", " ")}
                </span>
              </li>
            ))}
          </ol>
        )}
      </section>

      {/* Health detail */}
      <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="text-base font-semibold text-slate-900">Health detail</h2>
        <p className="mt-1 text-xs text-slate-500">
          Today&apos;s heuristic — recomputes every render. HQ-6 swaps in a
          cron-driven cache with richer signals (jobs, quotes, invoice activity).
        </p>
        <ul className="mt-3 space-y-1 text-sm text-slate-700">
          {health.reasons.map((r) => (
            <li key={r}>· {r}</li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function prettyCheckoutError(code: string, detail: string | null): string {
  const labels: Record<string, string> = {
    stripe_not_configured:
      "Stripe isn't configured on the server (STRIPE_SECRET_KEY missing).",
    setup_fee_price_unresolved:
      "Couldn't find a £1,000 GBP one-off price in Stripe.",
    subscription_price_unresolved:
      "Couldn't find a £500/mo GBP recurring price in Stripe.",
    stripe_customer_create_failed:
      "Stripe rejected the customer.create call (often: invalid email or restricted-key permissions).",
    stripe_session_create_failed:
      "Stripe rejected checkout.sessions.create.",
    stripe_no_session_url:
      "Stripe returned a session but no checkout URL.",
    org_not_found: "Org lookup failed.",
    invalid_input: "Invalid input.",
    db_org_load_failed: "Database lookup for this org failed.",
    unhandled_exception:
      "Unhandled exception in the checkout action — see Vercel function logs (grep for `[stripe-checkout]`).",
  };
  const head = labels[code] ?? `Checkout failed: ${code}`;
  return detail ? `${head} · ${detail}` : head;
}

function prettySaved(saved: string): string {
  switch (saved) {
    case "financials":
      return "Financials saved.";
    case "progress":
      return "Onboarding / migration saved.";
    case "notes":
      return "Notes saved.";
    case "impersonation_logged":
      return "Impersonation request recorded — full session-swap lands in HQ-3.1.";
    default:
      if (saved.startsWith("lifecycle_")) {
        return `Lifecycle → ${saved.slice("lifecycle_".length)}.`;
      }
      return "Saved.";
  }
}

function kindColour(kind: string): string {
  switch (kind) {
    case "demo":
      return "bg-indigo-500";
    case "payment":
      return "bg-emerald-500";
    case "migration":
      return "bg-cyan-500";
    case "support":
      return "bg-rose-500";
    case "usage":
      return "bg-violet-500";
    default:
      return "bg-slate-500";
  }
}

function Tile({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
        {label}
      </p>
      <p className="mt-1 text-lg font-bold text-slate-900">{value}</p>
      {sub ? <div className="mt-1">{sub}</div> : null}
    </div>
  );
}

function ProgressBar({ percent, colour }: { percent: number; colour: string }) {
  const safe = Math.max(0, Math.min(100, percent));
  return (
    <div
      className="h-1.5 w-full rounded-full bg-slate-100"
      aria-label={`${safe}% complete`}
    >
      <div
        className={`h-1.5 rounded-full ${colour}`}
        style={{ width: `${safe}%` }}
      />
    </div>
  );
}

function ContactButton({
  href,
  label,
}: {
  href: string | null;
  label: string;
}) {
  if (!href) {
    return (
      <span className="rounded-md border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-medium text-slate-400">
        {label}
      </span>
    );
  }
  return (
    <a
      href={href}
      className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
    >
      {label}
    </a>
  );
}

function LifecycleButton({
  orgId,
  status,
  label,
  tone,
  confirm,
  disabled,
}: {
  orgId: string;
  status: "suspended" | "cancelled" | "active";
  label: string;
  tone: "amber" | "red" | "emerald";
  confirm: string;
  disabled?: boolean;
}) {
  const cls = (() => {
    switch (tone) {
      case "amber":
        return "border-amber-300 bg-amber-50 text-amber-900 hover:bg-amber-100";
      case "red":
        return "border-red-300 bg-white text-red-700 hover:bg-red-50";
      case "emerald":
        return "border-emerald-300 bg-emerald-50 text-emerald-900 hover:bg-emerald-100";
    }
  })();
  return (
    <ConfirmForm action={setCustomerLifecycle} confirm={confirm}>
      <input type="hidden" name="org_id" value={orgId} />
      <input type="hidden" name="status" value={status} />
      <button
        type="submit"
        disabled={disabled}
        className={`rounded-md border px-3 py-1.5 text-xs font-medium ${cls} disabled:cursor-not-allowed disabled:opacity-50`}
      >
        {label}
      </button>
    </ConfirmForm>
  );
}

function ConfirmForm({
  action,
  confirm,
  children,
}: {
  action: (formData: FormData) => Promise<void>;
  confirm: string;
  children: React.ReactNode;
}) {
  // Confirmation modal lives in a thin client wrapper so we don't ship
  // any JS for the rest of the page. Native browser confirm() is
  // deliberate: it's loud, focuses the action, and works on every
  // device — overkill modal libraries don't earn their bytes here.
  return (
    <ClientConfirmForm action={action} confirm={confirm}>
      {children}
    </ClientConfirmForm>
  );
}
