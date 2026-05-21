import Link from "next/link";
import { redirect } from "next/navigation";
import { requireUser, getOrgForUser, orgHasActiveAccess } from "@/server/auth/session";
import { RefreshStatusButton } from "./_refresh-button";

/**
 * Lock screen for orgs that aren't active yet.
 *
 * Reached by `requireOrgContext()` when the user's org is in any of
 * the non-access states (pending / suspended / rejected). Each state
 * gets its own headline + body so the customer knows what's happening
 * and what to do.
 *
 * Friction-removal pass (Sprint A): explicit signup timestamp, hours-
 * elapsed counter, "we'll email you when approved" promise, and a
 * Refresh status button that re-runs the gate — so the user has
 * something they CAN do other than wait blindly.
 *
 * If the user lands here with an active org (e.g. by typing the URL),
 * we bounce them straight to /dashboard.
 */

const COPY: Record<
  string,
  { title: string; body: string; action?: string }
> = {
  pending: {
    title: "CrewFlow access pending approval.",
    body: "Thanks for signing up. A CrewFlow team member is reviewing your company. We'll email you the moment access is unlocked — no need to refresh this page.",
    action: "Most signups are approved within one UK business day (Mon–Fri, 9–5 GMT).",
  },
  suspended: {
    title: "CrewFlow access is paused for this company.",
    body: "Access has been temporarily suspended — usually a billing issue or active investigation. Email us and we'll get it sorted.",
  },
  rejected: {
    title: "We couldn't approve this signup.",
    body: "If you think this is a mistake, reply to your signup confirmation email or contact us and we'll take another look.",
  },
};

function hoursAgo(iso: string): number {
  const ms = Date.now() - new Date(iso).getTime();
  return Math.max(0, Math.floor(ms / 3_600_000));
}

export default async function AccessPendingPage() {
  const user = await requireUser();
  const ctx = await getOrgForUser(user.id);

  // No org → finish onboarding first.
  if (!ctx) redirect("/onboarding/company");

  // Org is active/trial → no need for the lock screen, bounce to app.
  if (orgHasActiveAccess(ctx.org.status)) redirect("/dashboard");

  // COPY.pending is statically present — non-null assertion is safe.
  const copy = COPY[ctx.org.status] ?? COPY.pending!;

  // Created-at on organizations is the closest thing to a "submitted at"
  // for pending review. We don't expose the exact timestamp (avoid
  // implying SLA), just an integer hours count so the user knows
  // something is happening.
  const createdAtIso =
    (ctx.org as { created_at?: string }).created_at ?? null;
  const elapsedHours = createdAtIso ? hoursAgo(createdAtIso) : null;

  return (
    <div className="min-h-screen bg-slate-100 px-4 py-12">
      <div className="mx-auto max-w-lg space-y-6">
        <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
          <div className="border-b border-slate-200 bg-slate-50 px-6 py-4">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
              {ctx.org.status === "rejected"
                ? "Signup rejected"
                : ctx.org.status === "suspended"
                  ? "Access paused"
                  : "Pending approval"}
            </p>
            <h1 className="mt-1 text-xl font-bold text-slate-900">
              {copy.title}
            </h1>
          </div>
          <div className="space-y-4 px-6 py-6 text-sm text-slate-700">
            <p>{copy.body}</p>
            {copy.action ? (
              <p className="rounded-md bg-slate-50 px-3 py-2 text-xs text-slate-600">
                {copy.action}
              </p>
            ) : null}

            <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
              <p>
                <strong className="text-slate-900">Signed in as:</strong>{" "}
                {user.email}
              </p>
              <p className="mt-0.5">
                <strong className="text-slate-900">Company:</strong>{" "}
                {ctx.org.name}
              </p>
              {ctx.org.status === "pending" && elapsedHours !== null ? (
                <p className="mt-0.5">
                  <strong className="text-slate-900">Submitted:</strong>{" "}
                  {elapsedHours === 0
                    ? "just now"
                    : elapsedHours === 1
                      ? "1 hour ago"
                      : `${elapsedHours} hours ago`}
                </p>
              ) : null}
            </div>

            <div className="flex flex-wrap gap-2 pt-1">
              {ctx.org.status === "pending" ? (
                <RefreshStatusButton />
              ) : null}
              <a
                href="mailto:hello@crewflow.uk?subject=Access%20pending%20-%20CrewFlow"
                className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
              >
                Email CrewFlow
              </a>
              <Link
                href="/login"
                className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
              >
                Sign out / switch account
              </Link>
            </div>
          </div>
        </div>

        <p className="text-center text-xs text-slate-400">
          Powered by CrewFlow · For contractors who&apos;d rather be on
          the tools than at a desk.
        </p>
      </div>
    </div>
  );
}
