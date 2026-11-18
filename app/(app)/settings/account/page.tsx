import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { readFailure } from "@/lib/supabase/read-failure";
import { requireOrgContext } from "@/server/auth/session";
import {
  accountDeletionEnabled,
  getLiveOrgDeletion,
  ORG_DELETION_COOLING_OFF_SECONDS,
} from "@/server/services/privacy-deletion";
import {
  CancelCompanyDeletionForm,
  DeleteAccountForm,
  DeleteCompanyForm,
} from "./_forms.client";

/**
 * Settings → Account.
 *
 * Two different things live here and the page keeps them visibly apart:
 *
 *   1. DELETE MY ACCOUNT — a person removes their own login and profile. The
 *      company, its records and its other people are NOT affected.
 *   2. DELETE COMPANY — the OWNER removes the whole company, for everyone.
 *
 * While the capability is dark (FEATURE_ACCOUNT_DELETION off — the default) the
 * page renders the support-assisted path instead of a control that does nothing.
 * Every control here is also enforced server-side (see ./actions.ts); what the
 * page hides is a courtesy, not the boundary.
 */
export const dynamic = "force-dynamic";

const COOLING_OFF_DAYS = Math.round(ORG_DELETION_COOLING_OFF_SECONDS / 86_400);

function formatWhen(iso: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "full",
    timeStyle: "short",
    timeZone: "Europe/London",
  }).format(new Date(iso));
}

export default async function AccountSettingsPage() {
  const { ctx, user } = await requireOrgContext();
  const enabled = accountDeletionEnabled();
  const isOwner = ctx.membership.role === "owner";

  // Is the viewer the ONLY owner of this company? (Then their account cannot be
  // deleted until the company is, or another owner exists.) Fail loud: rendering
  // "you may delete" over a failed read would mislead — the server would refuse.
  let soleOwner = false;
  if (isOwner) {
    const supabase = await createClient();
    const { count, error } = await supabase
      .from("memberships")
      .select("id", { count: "exact", head: true })
      .eq("org_id", ctx.org.id)
      .eq("role", "owner");
    if (error) throw readFailure("settings/account: owner count", error);
    soleOwner = (count ?? 0) <= 1;
  }

  const live = enabled ? await getLiveOrgDeletion(ctx.org.id) : null;

  return (
    <div className="mx-auto max-w-2xl space-y-6 py-8">
      <div>
        <Link href="/settings" className="text-sm text-slate-600 hover:underline">
          ← Settings
        </Link>
        <h1 className="mt-1 text-2xl font-bold text-slate-900">Account</h1>
        <p className="mt-1 text-sm text-slate-600">
          Signed in as <span className="font-medium text-slate-900">{user.email}</span> ·{" "}
          {ctx.org.name}
        </p>
      </div>

      {live ? (
        <section
          aria-labelledby="pending-deletion-heading"
          className="rounded-xl border border-amber-300 bg-amber-50 p-5"
        >
          <h2 id="pending-deletion-heading" className="text-base font-semibold text-amber-950">
            {ctx.org.name} is scheduled for deletion
          </h2>
          <p className="mt-1 text-sm text-amber-950">
            {live.status === "scheduled" ? (
              <>
                Everything belonging to this company will be permanently deleted on or after{" "}
                <strong>{formatWhen(live.scheduledFor)}</strong>. Until then nothing has been
                deleted and an owner can cancel.
              </>
            ) : (
              <>The deletion has started and can no longer be cancelled.</>
            )}
          </p>
          {isOwner && live.status === "scheduled" ? <CancelCompanyDeletionForm /> : null}
        </section>
      ) : null}

      {!enabled ? (
        <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="text-base font-semibold text-slate-900">Delete your account or company</h2>
          <p className="mt-2 text-sm text-slate-700">
            Deletion is a support-assisted process for this workspace. Contact support from this
            account and tell us whether you want to delete <strong>your own account</strong> or the{" "}
            <strong>whole company</strong> (owner only). We verify the request, agree a date, carry
            it out and send you confirmation.
          </p>
          <p className="mt-2 text-sm text-slate-700">
            You can download a copy of the company&apos;s data first from{" "}
            <Link href="/settings/data-retention" className="font-medium text-slate-900 underline">
              Data retention
            </Link>
            .
          </p>
        </section>
      ) : (
        <>
          {/* 1. A PERSON --------------------------------------------------- */}
          <section
            aria-labelledby="delete-account-heading"
            className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm"
          >
            <h2 id="delete-account-heading" className="text-base font-semibold text-slate-900">
              Delete my account
            </h2>
            <p className="mt-1 text-sm text-slate-700">
              Removes <strong>your</strong> login and profile. It does not delete {ctx.org.name}.
            </p>
            <dl className="mt-4 space-y-3 text-sm text-slate-700">
              <div>
                <dt className="font-medium text-slate-900">Deleted straight away</dt>
                <dd>
                  Your login, name, email and phone; your notification and device settings; your
                  rota and job assignments; your pay rate and emergency contact; drafts you created.
                  You are signed out everywhere.
                </dd>
              </div>
              <div>
                <dt className="font-medium text-slate-900">Kept by your employer, no longer in your name</dt>
                <dd>
                  Records the company must keep — payroll, pension and holiday records, timesheets
                  (notes and location removed), signed health &amp; safety and quality records — and
                  work you recorded (diaries, messages, photos). These stay with the company and
                  show &ldquo;Deleted user&rdquo;. To have them erased, ask your employer.
                </dd>
              </div>
            </dl>
            {soleOwner ? (
              <p
                role="note"
                className="mt-4 rounded-md border border-slate-300 bg-slate-50 px-3 py-3 text-sm text-slate-800"
              >
                You are the only owner of {ctx.org.name}. Delete the company below, or have another
                owner added, before you can delete your own account.
              </p>
            ) : (
              <DeleteAccountForm email={user.email ?? ""} />
            )}
          </section>

          {/* 2. THE COMPANY ------------------------------------------------ */}
          {isOwner ? (
            <section
              aria-labelledby="delete-company-heading"
              className="rounded-xl border border-red-200 bg-white p-6 shadow-sm"
            >
              <h2 id="delete-company-heading" className="text-base font-semibold text-slate-900">
                Delete company
              </h2>
              <p className="mt-1 text-sm text-slate-700">
                Permanently deletes <strong>{ctx.org.name}</strong> for everyone. Only the owner can
                do this.
              </p>
              <dl className="mt-4 space-y-3 text-sm text-slate-700">
                <div>
                  <dt className="font-medium text-slate-900">What is deleted</dt>
                  <dd>
                    Every customer, quote, job, invoice, payroll and CIS record, document, photo,
                    message and file; every team member&apos;s access; and the account of anyone who
                    belongs to no other company. This cannot be undone and we cannot restore it.
                  </dd>
                </div>
                <div>
                  <dt className="font-medium text-slate-900">Before you start</dt>
                  <dd>
                    You are legally required to keep your own business records (accounts, VAT,
                    payroll, CIS).{" "}
                    <Link href="/settings/data-retention" className="font-medium text-slate-900 underline">
                      Download your data
                    </Link>{" "}
                    first.
                  </dd>
                </div>
                <div>
                  <dt className="font-medium text-slate-900">What happens next</dt>
                  <dd>
                    Nothing is deleted for {COOLING_OFF_DAYS} days. During that time any owner can
                    cancel here. After {COOLING_OFF_DAYS} days your subscription is cancelled and the
                    company is deleted. Your subscription continues until then.
                  </dd>
                </div>
                <div>
                  <dt className="font-medium text-slate-900">What we keep</dt>
                  <dd>
                    Our own record of invoices we issued to you (amounts and dates), as tax law
                    requires, and a record that the deletion happened. Neither contains your
                    business data.
                  </dd>
                </div>
              </dl>
              {live ? (
                <p className="mt-4 text-sm text-slate-700">A deletion is already scheduled (see above).</p>
              ) : (
                <DeleteCompanyForm companyName={ctx.org.name} coolingOffDays={COOLING_OFF_DAYS} />
              )}
            </section>
          ) : null}
        </>
      )}
    </div>
  );
}
