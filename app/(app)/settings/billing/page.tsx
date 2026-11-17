import Link from "next/link";
import { requireCapability } from "@/server/auth/capabilities";
import { canWith } from "@/lib/auth/capability-rules";
import { isSelfServeBillingConfigured } from "@/lib/billing/self-serve";
import { listPlans, getPlan, FEATURE_KEYS, type FeatureKey } from "@/lib/billing/plans";
import { planHasFeature } from "@/lib/billing/entitlements";
import { resolveOrgPlanKey } from "@/server/services/entitlements";
import {
  wireSelfServeBillingDeps,
  type SubscriptionRow,
} from "@/server/services/self-serve-billing";
import { isSuperAdminEmail } from "@/server/auth/superadmin";
import { loadBillingHistory, wireBillingHistoryDeps } from "@/server/services/billing-history";
import {
  loadCancellationOrg,
  previewCancellation,
  wireCancellationDeps,
  type CancellationPreview,
} from "@/server/services/subscription-cancellation";
import {
  CANCELLATION_ERROR_COPY,
  formatAccessDate,
  isSelfServeCancellationDisabled,
} from "@/lib/billing/cancellation";
import { InvoiceHistory } from "@/components/billing/invoice-history";
import {
  CancelSubscription,
  KeepSubscription,
  type CancelPreviewView,
} from "@/components/billing/cancel-subscription.client";
import { openBillingPortal, changePlan } from "./actions";
import { SETUP_FEE_GBP } from "@/lib/hq/customer-financials";
import { MONTHLY_PRICE_GBP } from "@/lib/hq/metrics";

/**
 * Settings → Billing — self-serve tenant plan management (DARK).
 *
 * DARK CONTRACT (plan management): while self-serve billing is not configured
 * (the two-switch gate is off — ALWAYS today), this page shows the plan
 * catalogue read-only + the "email us to change plan" fallback, and neither
 * plan-management action (portal / change plan) can reach Stripe. When
 * configured + admin, it surfaces the manage-billing portal and plan
 * upgrade/downgrade.
 *
 * NOT behind that gate — available to founder-provisioned customers today:
 *   • Invoices & receipts (server/services/billing-history.ts): a read-only
 *     list, from Stripe when the SaaS key is present, else CrewFlow's records.
 *   • Cancel subscription (OWNER only): the terms promise "cancel at any time
 *     from the settings page". The action lives in app/account/billing/actions
 *     and re-derives owner + org from the session; hiding the control here is
 *     presentation, not the boundary.
 */

const FEATURE_LABELS: Record<FeatureKey, string> = {
  core: "Core platform",
  ai_receptionist: "AI receptionist",
  advanced_reporting: "Advanced reporting & exports",
  outbound_webhooks: "Outbound webhooks",
  api_access: "API access",
  priority_support: "Priority support",
};

const ERROR_COPY: Record<string, string> = {
  forbidden: "Only owners and admins can manage billing.",
  feature_disabled: "Self-serve billing isn't enabled yet.",
  no_customer: "No billing account yet — start a plan to create one.",
  org_not_found: "Couldn't load your organisation.",
  invalid_plan: "That isn't a plan you can switch to.",
  same_plan: "You're already on that plan.",
  not_purchasable: "That plan can't be purchased self-serve.",
  price_unresolved: "That plan's price isn't set up yet. Contact us.",
  portal_failed: "Couldn't open the billing portal. Try again.",
  change_failed: "Couldn't start the plan change. Try again.",
};

export default async function BillingSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{
    error?: string;
    change?: string;
    plan?: string;
    cancellation_scheduled?: string;
    resumed?: string;
    emailed?: string;
  }>;
}) {
  // R4: gate on settings:view BEFORE any subscription / Stripe invoice read, so a
  // staff member never sees the org's subscription status or SaaS invoice list
  // (even once self-serve billing is configured). The manage controls below are
  // gated on settings:manage. Owner always; admin with the grant; staff denied.
  const { ctx, grants, user } = await requireCapability("settings", "view");
  const sp = await searchParams;
  const canManage = canWith(ctx.membership.role, grants, "settings", "manage");
  const configured = isSelfServeBillingConfigured();

  const currentPlanKey = await resolveOrgPlanKey(ctx.org.id);
  const currentPlan = getPlan(currentPlanKey) ?? getPlan("trial")!;

  // Subscription projection — only read when plan management is configured.
  let subscription: SubscriptionRow | null = null;
  if (configured) {
    subscription = await wireSelfServeBillingDeps().loadSubscription(ctx.org.id);
  }

  // Billing history + cancellation: NOT behind the self-serve gate (see header).
  const [history, billingOrg] = await Promise.all([
    loadBillingHistory(wireBillingHistoryDeps(), ctx.org.id),
    loadCancellationOrg(ctx.org.id),
  ]);
  // The REAL owner only. An impersonating HQ operator is presented with a
  // synthetic `owner` role; they must not be offered the customer's cancel
  // button (and the action refuses them regardless).
  const isAccountOwner =
    ctx.membership.role === "owner" && !isSuperAdminEmail(user.email);
  const cancelDisabled = isSelfServeCancellationDisabled();
  const hasCardSubscription = Boolean(
    billingOrg?.stripe_customer_id || billingOrg?.stripe_subscription_id,
  );

  // What cancelling would do right now (end of the paid period, or immediately
  // when nothing renews) — read live from Stripe so the date shown is the date
  // Stripe will honour. Owner/admin only (settings:manage); staff never get here.
  let preview: CancellationPreview | null = null;
  if (isAccountOwner || canManage) {
    try {
      preview = await previewCancellation(wireCancellationDeps(), ctx.org.id);
    } catch (e) {
      console.error("[settings/billing] cancellation preview failed", {
        org_id: ctx.org.id,
        error: e instanceof Error ? e.message : String(e),
      });
      preview = { kind: "unavailable", reason: "billing_unavailable" };
    }
  }
  const scheduledEnd =
    preview?.kind === "end_of_period" && preview.alreadyScheduled ? preview.accessEndsAt : null;
  const cancelView: CancelPreviewView | null =
    preview?.kind === "end_of_period"
      ? { kind: "end_of_period", accessEndsAt: preview.accessEndsAt, dateLabel: formatAccessDate(preview.accessEndsAt) }
      : preview?.kind === "immediate"
        ? { kind: "immediate" }
        : null;

  const errorMsg = sp.error ? (ERROR_COPY[sp.error] ?? "Something went wrong.") : null;

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-slate-900">Billing</h1>
        <Link href="/settings" className="text-sm text-slate-500 hover:text-slate-700">
          ← Settings
        </Link>
      </div>

      {errorMsg ? (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          {errorMsg}
        </div>
      ) : null}
      {sp.change === "success" ? (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
          Plan change confirmed{sp.plan ? ` — you're now on ${getPlan(sp.plan)?.name ?? sp.plan}.` : "."}
        </div>
      ) : null}

      {sp.cancellation_scheduled === "1" && scheduledEnd ? (
        <div role="status" className="rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
          <strong className="font-semibold">Cancellation scheduled.</strong> You keep full access until{" "}
          {formatAccessDate(scheduledEnd)}, and nothing more will be charged.
          {sp.emailed === "1" ? ` We've emailed a confirmation to ${user.email}.` : ""}
        </div>
      ) : null}
      {sp.resumed === "1" && preview?.kind === "end_of_period" && !preview.alreadyScheduled ? (
        <div role="status" className="rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
          <strong className="font-semibold">Your subscription will continue.</strong> It next renews on{" "}
          {formatAccessDate(preview.accessEndsAt)}.
          {sp.emailed === "1" ? ` We've emailed a confirmation to ${user.email}.` : ""}
        </div>
      ) : null}

      {/* Current plan --------------------------------------------------- */}
      <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-base font-semibold text-slate-900">Current plan</h2>
        <dl className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="rounded-md border border-slate-200 bg-slate-50/60 px-3 py-2">
            <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">Plan</dt>
            <dd className="mt-0.5 text-sm font-semibold text-slate-900" data-testid="billing-plan">
              {configured
                ? currentPlan.name
                : `CrewFlow — £${MONTHLY_PRICE_GBP.toLocaleString("en-GB")} a month, every feature`}
              {configured ? null : (
                <span className="mt-0.5 block text-xs font-normal text-slate-500">
                  Plus a one-time £{SETUP_FEE_GBP.toLocaleString("en-GB")} setup fee, charged once.
                </span>
              )}
            </dd>
          </div>
          <div className="rounded-md border border-slate-200 bg-slate-50/60 px-3 py-2">
            <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">
              Subscription status
            </dt>
            <dd className="mt-0.5 text-sm font-semibold capitalize text-slate-900">
              {subscription?.status ??
                (preview?.kind === "end_of_period"
                  ? preview.alreadyScheduled
                    ? "Cancellation scheduled"
                    : "Active"
                  : "—")}
            </dd>
          </div>
          {!subscription && preview?.kind === "end_of_period" ? (
            <div className="rounded-md border border-slate-200 bg-slate-50/60 px-3 py-2 sm:col-span-2">
              <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">
                {preview.alreadyScheduled ? "Access ends" : "Renews"}
              </dt>
              <dd className="mt-0.5 text-sm font-semibold text-slate-900" data-testid="billing-period-end">
                {formatAccessDate(preview.accessEndsAt)}
              </dd>
            </div>
          ) : null}
          {subscription?.current_period_end ? (
            <div className="rounded-md border border-slate-200 bg-slate-50/60 px-3 py-2 sm:col-span-2">
              <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">
                {subscription.cancel_at_period_end ? "Access ends" : "Renews"}
              </dt>
              <dd className="mt-0.5 text-sm font-semibold text-slate-900">
                {subscription.current_period_end.slice(0, 10)}
              </dd>
            </div>
          ) : null}
        </dl>

        {/* The per-plan feature checklist only means something when self-serve plans exist;
            founder-provisioned customers are on the single all-features plan (no seat caps). */}
        {configured ? (
        <ul className="mt-4 grid grid-cols-1 gap-1.5 sm:grid-cols-2">
          {FEATURE_KEYS.map((f) => {
            const included = planHasFeature(currentPlanKey, f);
            return (
              <li
                key={f}
                className={`flex items-center gap-2 text-sm ${included ? "text-slate-800" : "text-slate-500"}`}
              >
                <span aria-hidden>{included ? "✓" : "○"}</span>
                {FEATURE_LABELS[f]}
              </li>
            );
          })}
        </ul>
        ) : null}

        {configured && canManage ? (
          <form action={openBillingPortal} className="mt-5">
            <button
              type="submit"
              className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-slate-800"
            >
              Manage billing
            </button>
          </form>
        ) : (
          <div className="mt-5 flex flex-wrap items-center gap-3">
            <a
              href={`mailto:hello@crewflow.uk?subject=${encodeURIComponent(`Billing question — ${ctx.org.name}`)}`}
              className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-slate-800"
            >
              Email us about billing
            </a>
            <p className="text-xs text-slate-500">
              Questions about invoices or your plan go to hello@crewflow.uk.
            </p>
          </div>
        )}
      </section>

      {/* Plans (self-serve only) --------------------------------------- */}
      {configured ? (
      <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-base font-semibold text-slate-900">Plans</h2>
        <p className="mt-1 text-sm text-slate-600">
          {configured
            ? "Upgrade or downgrade at any time. Changes take effect via secure Stripe checkout."
            : "Here's what each plan includes. Self-serve switching is coming soon."}
        </p>
        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
          {listPlans().map((plan) => {
            const isCurrent = plan.key === currentPlanKey;
            return (
              <div
                key={plan.key}
                className={`rounded-lg border p-4 ${isCurrent ? "border-slate-900 bg-slate-50" : "border-slate-200"}`}
              >
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-slate-900">{plan.name}</h3>
                  {isCurrent ? (
                    <span className="rounded-full bg-slate-900 px-2 py-0.5 text-[11px] font-medium text-white">
                      Current
                    </span>
                  ) : null}
                </div>
                <p className="mt-1 text-xs text-slate-500">{plan.description}</p>
                <p className="mt-2 text-xs text-slate-500">
                  {plan.seats === null ? "Unlimited seats" : `Up to ${plan.seats} seats`}
                </p>
                {configured && canManage && plan.stripeLookupKey && !isCurrent ? (
                  <form action={changePlan} className="mt-3">
                    <input type="hidden" name="plan_key" value={plan.key} />
                    <button
                      type="submit"
                      className="w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-800 transition hover:bg-slate-100"
                    >
                      {plan.rank > currentPlan.rank ? "Upgrade" : "Switch"} to {plan.name}
                    </button>
                  </form>
                ) : null}
              </div>
            );
          })}
        </div>
      </section>
      ) : null}

      <InvoiceHistory history={history} />

      {/* Cancel --------------------------------------------------------- */}
      <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-base font-semibold text-slate-900">Cancel subscription</h2>
        {scheduledEnd ? (
          <div data-testid="cancellation-scheduled" className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            <p>
              <strong className="font-semibold">Your subscription ends on {formatAccessDate(scheduledEnd)}.</strong>{" "}
              You and your team keep full access until then. It won&apos;t renew, and no refund is
              issued for the rest of the period.
            </p>
            {isAccountOwner && !cancelDisabled ? (
              <KeepSubscription orgId={ctx.org.id} dateLabel={formatAccessDate(scheduledEnd)} />
            ) : null}
          </div>
        ) : (
          <p className="mt-1 text-sm text-slate-600">
            {preview?.kind === "end_of_period"
              ? `Cancelling takes effect at the end of your current paid period, on ${formatAccessDate(preview.accessEndsAt)}. You keep full access until then. You'll see exactly what happens before you confirm.`
              : "You'll see exactly what happens before you confirm."}
          </p>
        )}
        <div className="mt-4">
          {scheduledEnd ? null : !isAccountOwner ? (
            <p className="text-sm text-slate-600">
              Only the account owner can cancel the subscription.
            </p>
          ) : cancelDisabled ? (
            <p className="text-sm text-slate-700">
              Cancelling online is temporarily unavailable. Email{" "}
              <a
                href={`mailto:hello@crewflow.uk?subject=${encodeURIComponent(`Cancel subscription — ${ctx.org.name}`)}`}
                className="font-medium text-slate-900 underline"
              >
                hello@crewflow.uk
              </a>{" "}
              and we&apos;ll cancel it for you today.
            </p>
          ) : !cancelView ? (
            <p className="text-sm text-slate-700" role="alert">
              {CANCELLATION_ERROR_COPY[
                preview?.kind === "unavailable" ? preview.reason : "billing_unavailable"
              ] ?? CANCELLATION_ERROR_COPY.billing_unavailable}
            </p>
          ) : (
            <CancelSubscription
              orgId={ctx.org.id}
              orgName={ctx.org.name}
              hasSubscription={hasCardSubscription}
              preview={cancelView}
              dataExportHref="/api/gdpr/export"
            />
          )}
        </div>
      </section>
    </div>
  );
}
