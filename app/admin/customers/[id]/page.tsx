import Link from "next/link";
import { notFound } from "next/navigation";
import { loadCustomerSnapshot } from "@/server/services/hq-customer-snapshot";
import {
  formatGbp,
  SETUP_FEE_LABELS,
  formatMigrationEta,
  type SetupFeeStatus,
  type SubscriptionStatus,
  type HealthRisk,
} from "@/lib/hq/customer-financials";
import {
  updateCustomerFinancials,
  updateCustomerProgress,
  updateCustomerNotes,
  setCustomerLifecycle,
  resetOnboarding,
  markSetupComplete,
  resendInvite,
} from "../actions";
import { startImpersonation } from "@/app/admin/impersonation/actions";
import { CustomerImpersonateModal } from "./_impersonate";
import { ClientConfirmForm } from "./_confirm";
import {
  createSetupCheckout,
  createSubscriptionCheckout,
} from "./_stripe-actions";
import { InternalNotesPanel } from "./_internal-notes-panel";
import {
  AnimatedNumber,
  Alert,
  Button,
  ButtonLink,
  GlowHeader,
  Input,
  Panel,
  Select,
  StatTile,
  Surface,
  Textarea,
} from "@/components/ui";

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

// Dark-surface status pills. The shared *_PILL maps in
// lib/hq/customer-financials are light-themed (consumed by other light
// views), so HQ's dark surfaces resolve their own token idioms locally
// — presentation only, no behaviour change.
const SUBSCRIPTION_PILL_DARK: Record<SubscriptionStatus, string> = {
  trial: "bg-sky-500/15 text-sky-300 ring-1 ring-inset ring-sky-400/30",
  active:
    "bg-emerald-500/15 text-emerald-300 ring-1 ring-inset ring-emerald-400/30",
  past_due: "bg-amber-500/15 text-amber-300 ring-1 ring-inset ring-amber-400/30",
  suspended: "bg-rose-500/15 text-rose-300 ring-1 ring-inset ring-rose-400/30",
  cancelled:
    "bg-slate-700/40 text-slate-300 ring-1 ring-inset ring-slate-600/40",
  pending: "bg-amber-500/15 text-amber-300 ring-1 ring-inset ring-amber-400/30",
};

const SETUP_FEE_PILL_DARK: Record<SetupFeeStatus, string> = {
  pending: "bg-amber-500/15 text-amber-300 ring-1 ring-inset ring-amber-400/30",
  sent: "bg-sky-500/15 text-sky-300 ring-1 ring-inset ring-sky-400/30",
  paid: "bg-emerald-500/15 text-emerald-300 ring-1 ring-inset ring-emerald-400/30",
  waived: "bg-slate-700/40 text-slate-300 ring-1 ring-inset ring-slate-600/40",
  refunded: "bg-rose-500/15 text-rose-300 ring-1 ring-inset ring-rose-400/30",
};

const HEALTH_PILL_DARK: Record<HealthRisk, string> = {
  high: "bg-rose-500/15 text-rose-300 ring-1 ring-inset ring-rose-400/30",
  medium: "bg-amber-500/15 text-amber-300 ring-1 ring-inset ring-amber-400/30",
  low: "bg-emerald-500/15 text-emerald-300 ring-1 ring-inset ring-emerald-400/30",
};

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
    <Surface>
      <GlowHeader
        eyebrow="CrewFlow HQ · Customers OS"
        title={org.name}
        subtitle={
          <>
            Workspace · {org.created_at.slice(0, 10)} ·{" "}
            <Link
              href="/admin/customers"
              className="text-indigo-300 hover:text-indigo-200"
            >
              Back to Customers OS
            </Link>
          </>
        }
        actions={
          <>
            <span
              className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium ${SUBSCRIPTION_PILL_DARK[subscription]}`}
            >
              {subscription}
            </span>
            <span
              className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium ${SETUP_FEE_PILL_DARK[setupFee]}`}
            >
              Setup: {SETUP_FEE_LABELS[setupFee]}
            </span>
            <span
              className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium ${HEALTH_PILL_DARK[health.risk]}`}
              title={health.reasons.join(" · ")}
            >
              Health {health.score} ({health.risk})
            </span>
          </>
        }
      />

      <div className="space-y-6 p-5 sm:p-7">
        {/* Identity */}
        <Panel>
          <p className="text-sm text-slate-300">
            Owner:{" "}
            <strong className="text-white">{owner?.full_name ?? "—"}</strong> ·{" "}
            {ownerEmail ? (
              <a
                href={`mailto:${ownerEmail}`}
                className="text-indigo-300 hover:text-indigo-200"
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
                  className="text-indigo-300 hover:text-indigo-200"
                >
                  {phone}
                </a>
              </>
            ) : null}
          </p>
          <p className="mt-1 text-xs text-slate-500">
            VAT: {org.vat_number ?? "—"} · Slug: {org.slug}
          </p>
        </Panel>

        {/* Banners */}
        {errorMsg ? <Alert tone="danger">{errorMsg}</Alert> : null}
        {saved ? <Alert tone="success">{saved}</Alert> : null}

        {/* KPI tiles */}
        <section className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <StatTile
            accent="emerald"
            label="MRR"
            value={
              <AnimatedNumber value={Number(org.mrr_gbp)} format="currency" />
            }
          />
          <StatTile
            label="LTV"
            value={<AnimatedNumber value={ltv} format="currency" />}
          />
          <StatTile
            label="Onboarding"
            value={`${org.onboarding_percent}%`}
            sub={
              <ProgressBar
                percent={org.onboarding_percent}
                colour="bg-indigo-400/80"
              />
            }
          />
          <StatTile
            label="Migration"
            value={`${org.migration_percent}%`}
            sub={
              <ProgressBar
                percent={org.migration_percent}
                colour="bg-emerald-400/80"
              />
            }
          />
          <StatTile
            label="Migration ETA"
            value={formatMigrationEta(org.migration_eta)}
          />
          <StatTile
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
        <Panel
          title="Actions"
          subtitle="Every action lands in the activity timeline below."
        >
          <div className="flex flex-wrap gap-2">
            <ButtonLink href="/dashboard" variant="glass" size="sm">
              Open workspace
            </ButtonLink>
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
              action={startImpersonation}
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
        </Panel>

        {/* Phase 6 — recovery actions */}
        <Panel
          title="Recovery actions"
          subtitle="Operator escape hatches for stuck customers. Each is audit logged."
        >
          <div className="flex flex-wrap gap-2">
            <ClientConfirmForm
              action={resetOnboarding}
              confirm={`Reset onboarding for ${org.name}? The checklist starts fresh; previously completed steps stay done.`}
            >
              <input type="hidden" name="org_id" value={org.id} />
              <Button type="submit" variant="glass" size="sm">
                Reset onboarding
              </Button>
            </ClientConfirmForm>
            <ClientConfirmForm
              action={markSetupComplete}
              confirm={`Mark ${org.name}'s setup as complete? Hides the customer's checklist banner.`}
            >
              <input type="hidden" name="org_id" value={org.id} />
              <Button type="submit" variant="glass" size="sm">
                Mark setup complete
              </Button>
            </ClientConfirmForm>
            <ClientConfirmForm
              action={resendInvite}
              confirm={`Re-send the magic-link invite to ${org.name}'s owner?`}
            >
              <input type="hidden" name="org_id" value={org.id} />
              <Button type="submit" variant="glass" size="sm">
                Resend invite
              </Button>
            </ClientConfirmForm>
          </div>
        </Panel>

        {/* Financials editor */}
        <Panel
          title="Financials"
          subtitle="Manual until Stripe lands. Setup fee + MRR + LTV are operator-managed. The cached LTV overrides the heuristic estimate when set."
        >
          <form
            action={updateCustomerFinancials}
            className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4"
          >
            <input type="hidden" name="org_id" value={org.id} />
            <label className="text-[11px] font-medium text-slate-400">
              Setup fee status
              <Select
                name="setup_fee_status"
                defaultValue={setupFee}
                className="mt-1"
              >
                {Object.entries(SETUP_FEE_LABELS).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </Select>
            </label>
            <label className="text-[11px] font-medium text-slate-400">
              MRR (£/mo)
              <Input
                name="mrr_gbp"
                type="number"
                min={0}
                step={1}
                defaultValue={Number(org.mrr_gbp).toString()}
                className="mt-1"
              />
            </label>
            <label className="text-[11px] font-medium text-slate-400">
              LTV override (£) <span className="text-slate-600">optional</span>
              <Input
                name="ltv_gbp"
                type="number"
                min={0}
                step={1}
                defaultValue={Number(org.ltv_gbp) > 0 ? Number(org.ltv_gbp).toString() : ""}
                placeholder={`Est. ${formatGbp(ltv)}`}
                className="mt-1"
              />
            </label>
            <label className="text-[11px] font-medium text-slate-400">
              Billing email <span className="text-slate-600">optional</span>
              <Input
                name="billing_email"
                type="email"
                defaultValue={billingEmail ?? ""}
                placeholder={ownerEmail ?? "—"}
                className="mt-1"
              />
            </label>
            <div className="sm:col-span-2 lg:col-span-4">
              <Button type="submit" variant="accent" size="sm">
                Save financials
              </Button>
              {org.setup_fee_paid_at ? (
                <span className="ml-3 text-[11px] text-slate-500">
                  Setup fee paid {org.setup_fee_paid_at.slice(0, 10)}
                </span>
              ) : null}
              {org.stripe_customer_id ? (
                <span className="ml-3 text-[11px] text-slate-500">
                  Stripe customer:{" "}
                  <code className="rounded bg-slate-800/80 px-1 font-mono text-[0.9em] text-slate-300 ring-1 ring-inset ring-slate-700">
                    {org.stripe_customer_id}
                  </code>
                </span>
              ) : (
                <span className="ml-3 text-[11px] text-slate-600">
                  Stripe not yet linked
                </span>
              )}
            </div>
          </form>
        </Panel>

        {/* Stripe checkout actions */}
        <Panel
          title="Stripe checkout"
          subtitle={
            <>
              Open a hosted Stripe Checkout. The webhook at{" "}
              <code className="rounded bg-slate-800/80 px-1 font-mono text-[0.9em] text-slate-300 ring-1 ring-inset ring-slate-700">
                /api/webhooks/stripe
              </code>{" "}
              is the source of truth — billing state updates only when Stripe
              confirms payment.
            </>
          }
          action={
            <div className="flex flex-wrap items-center gap-3">
              <a
                href="/api/admin/stripe/provision"
                target="_blank"
                rel="noreferrer noopener"
                className="rounded-md bg-amber-500/15 px-2 py-1 text-[11px] font-semibold text-amber-300 ring-1 ring-inset ring-amber-400/30 hover:bg-amber-500/25"
              >
                Provision Stripe products →
              </a>
              <a
                href="/api/admin/stripe/verify"
                target="_blank"
                rel="noreferrer noopener"
                className="text-[11px] font-medium text-slate-400 hover:text-slate-200 hover:underline"
              >
                Run integration diagnostic →
              </a>
            </div>
          }
        >
          <div className="flex flex-wrap gap-2">
            <form action={createSetupCheckout}>
              <input type="hidden" name="org_id" value={org.id} />
              <button
                type="submit"
                className="rounded-md bg-indigo-500/15 px-3 py-1.5 text-xs font-semibold text-indigo-300 ring-1 ring-inset ring-indigo-400/30 hover:bg-indigo-500/25"
              >
                Open setup-fee checkout (£1,000)
              </button>
            </form>
            <form action={createSubscriptionCheckout}>
              <input type="hidden" name="org_id" value={org.id} />
              <button
                type="submit"
                className="rounded-md bg-emerald-500/15 px-3 py-1.5 text-xs font-semibold text-emerald-300 ring-1 ring-inset ring-emerald-400/30 hover:bg-emerald-500/25"
              >
                Open subscription checkout (£500/mo)
              </button>
            </form>
          </div>
        </Panel>

        {/* Internal notes panel */}
        <InternalNotesPanel orgId={org.id} />

        {/* Onboarding / migration */}
        <Panel
          title="Onboarding & migration"
          subtitle={
            <>
              Cross-checked against the customer&apos;s setup checklist on{" "}
              <code className="rounded bg-slate-800/80 px-1 font-mono text-[0.9em] text-slate-300 ring-1 ring-inset ring-slate-700">
                /dashboard
              </code>
              . AI migration assistant slot reserved for a later sprint.
            </>
          }
        >
          <form
            action={updateCustomerProgress}
            className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4"
          >
            <input type="hidden" name="org_id" value={org.id} />
            <label className="text-[11px] font-medium text-slate-400">
              Onboarding %
              <Input
                name="onboarding_percent"
                type="number"
                min={0}
                max={100}
                defaultValue={org.onboarding_percent}
                className="mt-1"
              />
            </label>
            <label className="text-[11px] font-medium text-slate-400">
              Migration %
              <Input
                name="migration_percent"
                type="number"
                min={0}
                max={100}
                defaultValue={org.migration_percent}
                className="mt-1"
              />
            </label>
            <label className="text-[11px] font-medium text-slate-400">
              Migration stage <span className="text-slate-600">optional</span>
              <Input
                name="migration_stage"
                type="text"
                maxLength={200}
                defaultValue={org.migration_stage ?? ""}
                placeholder="e.g. Importing invoices"
                className="mt-1"
              />
            </label>
            <label className="text-[11px] font-medium text-slate-400">
              Migration ETA <span className="text-slate-600">optional</span>
              <Input
                name="migration_eta"
                type="date"
                defaultValue={org.migration_eta ?? ""}
                className="mt-1"
              />
            </label>
            <div className="sm:col-span-2 lg:col-span-4">
              <Button type="submit" variant="accent" size="sm">
                Save progress
              </Button>
              {demoRequest ? (
                <span className="ml-3 text-[11px] text-slate-500">
                  Originated from demo {demoRequest.created_at.slice(0, 10)} ·{" "}
                  <Link
                    href={`/admin/demos?demo=${demoRequest.id}`}
                    className="text-indigo-300 underline hover:text-indigo-200"
                  >
                    open demo
                  </Link>
                </span>
              ) : null}
            </div>
          </form>
        </Panel>

        {/* CEO notes */}
        <Panel
          title="CEO notes"
          subtitle="Private. Visible only to super-admins. Never shown to the customer."
        >
          <form action={updateCustomerNotes} className="space-y-2">
            <input type="hidden" name="org_id" value={org.id} />
            <Textarea
              name="notes"
              rows={4}
              maxLength={10_000}
              defaultValue={org.admin_org_notes ?? ""}
              placeholder="Late payer · Needs onboarding call · High-value lead · …"
            />
            <Button type="submit" variant="accent" size="sm">
              Save notes
            </Button>
          </form>
        </Panel>

        {/* Timeline */}
        <Panel
          title="Timeline"
          subtitle="Aggregates demo, payment, migration, support and usage events for this workspace."
        >
          {timeline.length === 0 ? (
            <p className="py-8 text-center text-sm text-slate-500">
              No events yet. Status flips, notes, contact clicks, payments, and
              migrations all land here.
            </p>
          ) : (
            <ol className="divide-y divide-slate-800">
              {timeline.slice(0, 50).map((ev, i) => (
                <li
                  key={`${ev.at}-${i}`}
                  className="flex items-start gap-3 py-2.5 text-sm first:pt-0 last:pb-0"
                >
                  <span
                    className={`mt-1.5 inline-block h-2 w-2 shrink-0 rounded-full ${kindColour(ev.kind)}`}
                    aria-hidden
                  />
                  <div className="min-w-0 flex-1">
                    <p className="font-medium text-slate-100">{ev.label}</p>
                    {ev.detail ? (
                      <p className="mt-0.5 text-xs text-slate-400">
                        {ev.detail}
                      </p>
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
        </Panel>

        {/* Health detail */}
        <Panel
          title="Health detail"
          subtitle="Today's heuristic — recomputes every render. HQ-6 swaps in a cron-driven cache with richer signals (jobs, quotes, invoice activity)."
        >
          <ul className="space-y-1 text-sm text-slate-300">
            {health.reasons.map((r) => (
              <li key={r}>· {r}</li>
            ))}
          </ul>
        </Panel>
      </div>
    </Surface>
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

function ProgressBar({ percent, colour }: { percent: number; colour: string }) {
  const safe = Math.max(0, Math.min(100, percent));
  return (
    <div
      className="h-1.5 w-full rounded-full bg-slate-800"
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
      <span className="rounded-md border border-slate-800 bg-slate-900/40 px-3 py-1.5 text-xs font-medium text-slate-600">
        {label}
      </span>
    );
  }
  return (
    <a
      href={href}
      className="rounded-md border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-800"
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
        return "bg-amber-500/15 text-amber-300 ring-1 ring-inset ring-amber-400/30 hover:bg-amber-500/25";
      case "red":
        return "bg-rose-500/15 text-rose-300 ring-1 ring-inset ring-rose-400/30 hover:bg-rose-500/25";
      case "emerald":
        return "bg-emerald-500/15 text-emerald-300 ring-1 ring-inset ring-emerald-400/30 hover:bg-emerald-500/25";
    }
  })();
  return (
    <ConfirmForm action={setCustomerLifecycle} confirm={confirm}>
      <input type="hidden" name="org_id" value={orgId} />
      <input type="hidden" name="status" value={status} />
      <button
        type="submit"
        disabled={disabled}
        className={`rounded-md px-3 py-1.5 text-xs font-medium ${cls} disabled:cursor-not-allowed disabled:opacity-50`}
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
