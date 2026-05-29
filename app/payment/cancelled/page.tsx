import Link from "next/link";
import { env } from "@/lib/env";

/**
 * Public Stripe Checkout cancel landing.
 *
 * Where the customer lands if they back out of the hosted Checkout page
 * before paying. The original payment email still holds a working link
 * (or they can reply for help), so this is a soft, no-blame off-ramp.
 *
 * Public route (no auth) — the customer typically isn't signed in yet.
 */

export const dynamic = "force-dynamic";

export default function PaymentCancelledPage() {
  const appName = env.NEXT_PUBLIC_APP_NAME || "CrewFlow";

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 px-4 py-16">
      <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-sm">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-amber-100">
          <svg
            className="h-7 w-7 text-amber-600"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="9" />
            <path d="M12 8v4" />
            <path d="M12 16h.01" />
          </svg>
        </div>

        <h1 className="mt-5 text-2xl font-bold text-slate-900">
          Payment not completed
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-slate-600">
          No charge was made. You can finish your {appName} setup payment any
          time using the button in the email we sent you.
        </p>
        <p className="mt-3 text-sm leading-relaxed text-slate-600">
          Need a hand or a fresh link? Just reply to that email and a member of
          our team will sort it out.
        </p>

        <Link
          href="/"
          className="mt-6 inline-block text-sm font-semibold text-slate-900 underline-offset-4 hover:underline"
        >
          Back to {appName}
        </Link>
      </div>
    </main>
  );
}
