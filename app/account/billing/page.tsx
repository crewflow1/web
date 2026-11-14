import Link from "next/link";
import { redirect } from "next/navigation";
import { NOINDEX_METADATA } from "@/lib/seo/metadata";
import { orgHasActiveAccess } from "@/server/auth/session";
import { requireBillingAccount } from "@/server/auth/billing-account";
import {
  isSubscriptionTombstoned,
  loadCancellationOrg,
  loadLatestCancellation,
  wireReactivationDeps,
} from "@/server/services/subscription-cancellation";
import {
  loadBillingHistory,
  wireBillingHistoryDeps,
} from "@/server/services/billing-history";
import {
  CANCELLATION_COPY,
  isSelfServeCancellationDisabled,
} from "@/lib/billing/cancellation";
import { buttonClass } from "@/components/ui/button";
import { InvoiceHistory } from "@/components/billing/invoice-history";
import { CancelSubscription } from "@/components/billing/cancel-subscription.client";
import { ReactivationRequest } from "@/components/billing/reactivation-request.client";

/**
 * /account/billing — what a workspace's OWNER is still entitled to when the
 * workspace has no active access (subscription cancelled, or access suspended
 * after a failed payment).
 *
 * It lives OUTSIDE the (app) shell on purpose. Everything under (app) funnels
 * through requireOrgContext(), which sends a non-active org to /access-pending
 * — so before this page existed a cancelled owner could not reach their
 * invoices or their data, and a suspended (past-due) owner could not reach a
 * cancel button at all. Here they can:
 *
 *   • see plainly what state the account is in and what that means for money;
 *   • download their invoices and receipts;
 *   • download a full export of their data;
 *   • cancel (if the subscription is still live) or ask to reactivate.
 *
 * Owner-only, org taken from the caller's own membership (requireBillingAccount).
 * An active workspace is sent to Settings → Billing, which has the same controls
 * inside the product shell.
 */
export const metadata = { ...NOINDEX_METADATA, title: "Billing & your data · CrewFlow" };

const EXPORT_HREF = "/api/account/export";

export default async function AccountBillingPage({
  searchParams,
}: {
  searchParams: Promise<{ cancelled?: string; emailed?: string }>;
}) {
  const { user, ctx, isOwner } = await requireBillingAccount();
  if (orgHasActiveAccess(ctx.org.status)) redirect("/settings/billing");
  // Only a cancelled or suspended workspace has anything here; a pending or
  // rejected signup has never been billed. Non-owners get the lock screen.
  if (!isOwner || (ctx.org.status !== "cancelled" && ctx.org.status !== "suspended")) {
    redirect("/access-pending");
  }
  const sp = await searchParams;
  const orgId = ctx.org.id;
  const cancelled = ctx.org.status === "cancelled";

  const [org, cancellation, history, lastRequest] = await Promise.all([
    loadCancellationOrg(orgId),
    loadLatestCancellation(orgId),
    loadBillingHistory(wireBillingHistoryDeps(), orgId),
    cancelled ? wireReactivationDeps().lastReactivationRequestAt(orgId) : Promise.resolve(null),
  ]);

  const linkedToStripe = Boolean(org?.stripe_customer_id || org?.stripe_subscription_id);
  // The workspace is cancelled, but we hold a Stripe subscription id we have
  // never seen confirmed as terminated (e.g. it was marked cancelled by hand).
  // Say so, and let the owner make sure billing has stopped.
  const billingUnconfirmed =
    cancelled && org?.stripe_subscription_id
      ? !(await isSubscriptionTombstoned(orgId, org.stripe_subscription_id))
      : false;
  const cancelDisabled = isSelfServeCancellationDisabled();
  const reactivationRequested =
    lastRequest !== null &&
    (cancellation?.confirmedAt ? lastRequest >= cancellation.confirmedAt : true);
  const hadSubscription = cancellation ? cancellation.hadSubscription : linkedToStripe;

  return (
    <div className="min-h-screen bg-slate-100 px-4 py-10">
      <main className="mx-auto max-w-2xl space-y-6">
        <header>
          <p className="text-sm font-semibold tracking-tight text-slate-900">CrewFlow</p>
          <h1 className="mt-2 text-xl font-bold text-slate-900">Billing &amp; your data</h1>
          <p className="mt-1 text-sm text-slate-600">
            {ctx.org.name} · signed in as {user.email}
          </p>
        </header>

        {sp.cancelled === "1" && cancelled ? (
          <div
            role="status"
            className="rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900"
          >
            <strong className="font-semibold">Your subscription is cancelled.</strong>{" "}
            {hadSubscription
              ? "No further payments will be taken."
              : "There was no card subscription on the account, so nothing further will be charged."}
            {sp.emailed === "1" ? ` We've emailed a confirmation to ${user.email}.` : ""}
          </div>
        ) : null}

        {/* Status ---------------------------------------------------------- */}
        <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          {cancelled ? (
            <>
              <h2 className="text-base font-semibold text-slate-900">
                Subscription cancelled
                {cancellation?.confirmedAt
                  ? ` on ${cancellation.confirmedAt.slice(0, 10)}`
                  : ""}
              </h2>
              <ul className="mt-3 space-y-2 text-sm text-slate-700">
                <li>{CANCELLATION_COPY.charges}</li>
                {hadSubscription ? (
                  <>
                    <li>{CANCELLATION_COPY.unpaid}</li>
                    <li>
                      {CANCELLATION_COPY.refund}{" "}
                      <Link href="/terms" className="font-medium text-slate-900 underline">
                        Terms
                      </Link>
                    </li>
                  </>
                ) : null}
              </ul>
              {billingUnconfirmed ? (
                <div className="mt-4 rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
                  <p>
                    This workspace is cancelled, but we haven&apos;t been able to confirm that
                    your card subscription has been stopped.
                  </p>
                  <div className="mt-3">
                    {cancelDisabled ? (
                      <p>
                        Email{" "}
                        <a href="mailto:hello@crewflow.uk" className="font-medium underline">
                          hello@crewflow.uk
                        </a>{" "}
                        and we&apos;ll check it today.
                      </p>
                    ) : (
                      <CancelSubscription
                        orgId={orgId}
                        orgName={ctx.org.name}
                        hasSubscription
                        triggerLabel="Check and stop billing"
                        dataExportHref={EXPORT_HREF}
                      />
                    )}
                  </div>
                </div>
              ) : null}
            </>
          ) : (
            <>
              <h2 className="text-base font-semibold text-slate-900">Access is paused</h2>
              <p className="mt-2 text-sm text-slate-700">
                Access to this workspace is paused. If a payment failed, paying the outstanding
                invoice below restores it. Your data is untouched, and you can download it or
                cancel your subscription from this page.
              </p>
              <p className="mt-2 text-sm text-slate-700">
                Not sure why it&apos;s paused? Email{" "}
                <a href="mailto:hello@crewflow.uk" className="font-medium text-slate-900 underline">
                  hello@crewflow.uk
                </a>
                .
              </p>
            </>
          )}
        </section>

        {/* Data ------------------------------------------------------------ */}
        <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="text-base font-semibold text-slate-900">Your data</h2>
          <p className="mt-2 text-sm text-slate-700">
            {cancelled
              ? CANCELLATION_COPY.data
              : "Everything you entered is yours. Download a full export at any time."}
          </p>
          <p className="mt-2 text-sm text-slate-600">
            The export is a ZIP of your records as JSON files. It doesn&apos;t include uploaded
            files such as photos and drawings — email us if you need those.
          </p>
          <a href={EXPORT_HREF} className={buttonClass("secondary", "md", "mt-4")}>
            Download data export
          </a>
        </section>

        <InvoiceHistory history={history} />

        {/* Reactivate / cancel -------------------------------------------- */}
        {cancelled ? (
          <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
            <h2 className="text-base font-semibold text-slate-900">Reactivate</h2>
            <p className="mt-2 text-sm text-slate-700">
              Want CrewFlow back? Ask us to reactivate and we&apos;ll send you a link to restart
              your subscription. Your workspace is restored as it was, as long as your data
              hasn&apos;t yet been deleted.
            </p>
            <div className="mt-4">
              <ReactivationRequest orgId={orgId} alreadyRequested={reactivationRequested} />
            </div>
          </section>
        ) : (
          <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
            <h2 className="text-base font-semibold text-slate-900">Cancel subscription</h2>
            <p className="mt-2 text-sm text-slate-700">
              Cancelling takes effect immediately and stops all further payments.
            </p>
            <div className="mt-4">
              {cancelDisabled ? (
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
              ) : (
                <CancelSubscription
                  orgId={orgId}
                  orgName={ctx.org.name}
                  hasSubscription={linkedToStripe}
                  dataExportHref={EXPORT_HREF}
                />
              )}
            </div>
          </section>
        )}

        <p className="text-center text-sm text-slate-600">
          <Link href="/login" className="underline">
            Sign out / switch account
          </Link>
        </p>
      </main>
    </div>
  );
}
