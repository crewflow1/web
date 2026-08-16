import Link from "next/link";
import { requireOrgContext } from "@/server/auth/session";
import { isSelfServeBillingConfigured } from "@/lib/billing/self-serve";
import { listPlans, getPlan, FEATURE_KEYS, type FeatureKey } from "@/lib/billing/plans";
import { planHasFeature } from "@/lib/billing/entitlements";
import { resolveOrgPlanKey } from "@/server/services/entitlements";
import {
  wireSelfServeBillingDeps,
  listOrgSaasInvoices,
  type SaasInvoice,
  type SubscriptionRow,
} from "@/server/services/self-serve-billing";
import { openBillingPortal, changePlan } from "./actions";

/**
 * Settings → Billing — self-serve tenant plan management (DARK).
 *
 * DARK CONTRACT: while self-serve billing is not configured (the two-switch gate
 * is off — ALWAYS today), this page shows the plan catalogue read-only + the
 * existing "email us to change plan" fallback, and NO server action can reach
 * Stripe. When configured + admin, it surfaces the manage-billing portal, plan
 * upgrade/downgrade, and the org's CrewFlow invoices read from Stripe.
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
  searchParams: Promise<{ error?: string; change?: string; plan?: string }>;
}) {
  const { ctx } = await requireOrgContext();
  const sp = await searchParams;
  const isAdmin =
    ctx.membership.role === "owner" || ctx.membership.role === "admin";
  const configured = isSelfServeBillingConfigured();

  const currentPlanKey = await resolveOrgPlanKey(ctx.org.id);
  const currentPlan = getPlan(currentPlanKey) ?? getPlan("trial")!;

  // Subscription projection + invoices — only read Stripe when configured.
  let subscription: SubscriptionRow | null = null;
  let invoices: SaasInvoice[] = [];
  if (configured) {
    const deps = wireSelfServeBillingDeps();
    subscription = await deps.loadSubscription(ctx.org.id);
    const inv = await listOrgSaasInvoices(deps, { orgId: ctx.org.id });
    if (inv.ok) invoices = inv.invoices;
  }

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

      {/* Current plan --------------------------------------------------- */}
      <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-base font-semibold text-slate-900">Current plan</h2>
        <dl className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="rounded-md border border-slate-200 bg-slate-50/60 px-3 py-2">
            <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">Plan</dt>
            <dd className="mt-0.5 text-sm font-semibold text-slate-900">{currentPlan.name}</dd>
          </div>
          <div className="rounded-md border border-slate-200 bg-slate-50/60 px-3 py-2">
            <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">
              Subscription status
            </dt>
            <dd className="mt-0.5 text-sm font-semibold capitalize text-slate-900">
              {subscription?.status ?? "—"}
            </dd>
          </div>
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

        <ul className="mt-4 grid grid-cols-1 gap-1.5 sm:grid-cols-2">
          {FEATURE_KEYS.map((f) => {
            const included = planHasFeature(currentPlanKey, f);
            return (
              <li
                key={f}
                className={`flex items-center gap-2 text-sm ${included ? "text-slate-800" : "text-slate-400"}`}
              >
                <span aria-hidden>{included ? "✓" : "○"}</span>
                {FEATURE_LABELS[f]}
              </li>
            );
          })}
        </ul>

        {configured && isAdmin ? (
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
              href={`mailto:hello@crewflow.uk?subject=${encodeURIComponent(`Plan change — ${ctx.org.name}`)}`}
              className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-slate-800"
            >
              Email us to change plan
            </a>
            <p className="text-xs text-slate-500">
              Self-serve billing isn&apos;t enabled yet — we&apos;ll switch it on soon.
            </p>
          </div>
        )}
      </section>

      {/* Plans ---------------------------------------------------------- */}
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
                {configured && isAdmin && plan.stripeLookupKey && !isCurrent ? (
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

      {/* Invoices ------------------------------------------------------- */}
      {configured ? (
        <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="text-base font-semibold text-slate-900">Invoices &amp; receipts</h2>
          {invoices.length === 0 ? (
            <p className="mt-2 text-sm text-slate-500">No invoices yet.</p>
          ) : (
            <ul className="mt-4 divide-y divide-slate-100">
              {invoices.map((inv) => (
                <li key={inv.id} className="flex items-center justify-between py-2.5 text-sm">
                  <div className="min-w-0">
                    <div className="font-medium text-slate-900">{inv.number ?? inv.id}</div>
                    <div className="text-xs text-slate-500">
                      {inv.created?.slice(0, 10) ?? ""} · {inv.status ?? ""}
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="font-semibold text-slate-900">
                      {inv.currency} {inv.amount_paid.toFixed(2)}
                    </span>
                    {inv.hosted_invoice_url ? (
                      <a
                        href={inv.hosted_invoice_url}
                        target="_blank"
                        rel="noreferrer"
                        className="text-xs font-medium text-blue-600 hover:text-blue-700"
                      >
                        View
                      </a>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}
    </div>
  );
}
