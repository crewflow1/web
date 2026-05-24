import Link from "next/link";
import { redirect } from "next/navigation";
import { requireOrgContext } from "@/server/auth/session";
import { buildOnboardingSnapshot } from "@/server/services/onboarding-snapshot";
import { computeProgress } from "@/lib/onboarding/checklist";
import { markCompleted } from "../actions";

/**
 * /onboarding/setup/complete — celebration screen.
 *
 * Rendered when the operator finishes the last required step. The
 * server component stamps `organizations.onboarding_state.completed_at`
 * idempotently on first visit so HQ ops can answer "when did Acme
 * Roofing actually finish setup?"
 *
 * If somehow the user lands here before they're at 100% (open the URL
 * directly, drop steps later, etc.) we bounce them back to the
 * stepper rather than mislead them.
 */

export const dynamic = "force-dynamic";

export default async function OnboardingSetupCompletePage() {
  const { ctx } = await requireOrgContext();
  const snap = await buildOnboardingSnapshot(ctx.org.id);
  const progress = computeProgress(snap);

  if (progress.pct < 100) {
    redirect("/onboarding/setup");
  }

  // Best-effort stamp. Idempotent — only writes once.
  try {
    await markCompleted();
  } catch {
    /* noop */
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6 px-4 pb-12 sm:px-0">
      <header className="space-y-2 text-center">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
          Setup complete
        </p>
        <h1 className="text-3xl font-bold text-slate-900 sm:text-4xl">
          You&apos;re ready to work.
        </h1>
        <p className="mx-auto max-w-md text-sm text-slate-600">
          Everything CrewFlow needs is in place. Your dashboard, quotes,
          invoices, and customer records are live. Welcome aboard.
        </p>
      </header>

      <section className="rounded-xl border border-emerald-200 bg-emerald-50 p-6 text-center shadow-sm">
        <div className="mx-auto inline-flex h-16 w-16 items-center justify-center rounded-full bg-emerald-600 text-3xl font-bold text-white shadow">
          ✓
        </div>
        <p className="mt-4 text-base font-semibold text-emerald-900">
          {progress.done} of {progress.total} steps done — 100% complete.
        </p>
        <p className="mt-2 text-xs text-emerald-800">
          You can come back to <Link href="/onboarding/setup" className="underline">/onboarding/setup</Link>{" "}
          any time to revisit anything. Settings live at{" "}
          <Link href="/settings" className="underline">/settings</Link>.
        </p>
      </section>

      <div className="flex flex-wrap justify-center gap-2">
        <Link
          href="/dashboard"
          className="rounded-md bg-slate-900 px-5 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-slate-800"
        >
          Open dashboard →
        </Link>
        <Link
          href="/quotes/new"
          className="rounded-md border border-slate-300 bg-white px-5 py-2.5 text-sm font-medium text-slate-800 hover:bg-slate-50"
        >
          Create another quote
        </Link>
      </div>

      <section className="rounded-xl border border-slate-200 bg-white p-5 text-sm text-slate-700 shadow-sm">
        <h2 className="text-sm font-semibold text-slate-900">What now?</h2>
        <ul className="mt-3 space-y-2 text-xs text-slate-700">
          <li>
            <strong>Send the first invoice.</strong> Accepted quotes flow
            into <Link href="/invoices" className="underline">/invoices</Link>{" "}
            — generate, send, and track payment.
          </li>
          <li>
            <strong>Invite your team.</strong> Manage roles + clock-ins at{" "}
            <Link href="/staff" className="underline">/staff</Link>.
          </li>
          <li>
            <strong>Migrate your history.</strong>{" "}
            <Link href="/imports" className="underline">/imports</Link>{" "}
            accepts CSVs, Excel, PDFs, and photos. Roll back any time.
          </li>
        </ul>
      </section>
    </div>
  );
}
