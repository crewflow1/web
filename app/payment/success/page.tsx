import Link from "next/link";
import { env } from "@/lib/env";
import { FadeIn } from "@/components/ui";

/**
 * Public Stripe Checkout success landing.
 *
 * Where the customer lands after paying the one-off setup fee from the
 * email's "Pay setup fee" button. Payment confirmation + workspace
 * provisioning happen server-side via the Stripe webhook — this page is
 * purely reassurance ("we've got it, watch your inbox").
 *
 * Public route (no auth) — the customer typically isn't signed in yet.
 * The actual sign-in link arrives in a separate onboarding email once HQ
 * provisions the workspace.
 */

export const dynamic = "force-dynamic";

type SP = Promise<{ company?: string }>;

export default async function PaymentSuccessPage({
  searchParams,
}: {
  searchParams: SP;
}) {
  const sp = await searchParams;
  const company = (sp.company ?? "").trim();
  const appName = env.NEXT_PUBLIC_APP_NAME || "CrewFlow";

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 px-4 py-16">
      <FadeIn className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-sm">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-emerald-100">
          <svg
            className="h-7 w-7 text-emerald-600"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M20 6 9 17l-5-5" />
          </svg>
        </div>

        <h1 className="mt-5 text-2xl font-bold text-slate-900">
          Payment received
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-slate-600">
          Thank you{company ? ` — ${company}` : ""}. Your one-off setup
          payment for {appName} is confirmed.
        </p>
        <p className="mt-3 text-sm leading-relaxed text-slate-600">
          We&rsquo;re setting up your workspace now. Watch your inbox: as soon
          as it&rsquo;s ready you&rsquo;ll get a separate email with a secure
          link to sign in — usually within an hour during UK business hours.
        </p>

        <div className="mt-6 rounded-lg bg-slate-50 px-4 py-3 text-xs text-slate-500">
          A receipt has also been emailed to you. You can close this tab.
        </div>

        <Link
          href="/"
          className="mt-6 inline-block text-sm font-semibold text-slate-900 underline-offset-4 hover:underline"
        >
          Back to {appName}
        </Link>
      </FadeIn>
    </main>
  );
}
