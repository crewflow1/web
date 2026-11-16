import Link from "next/link";

/**
 * Shown to the OWNER of a suspended / cancelled company (the only member who can still sign in —
 * D-17). It explains why nothing can be changed and what to do next. It exposes no locked
 * functionality: Billing and support are the two things a held owner is allowed to use.
 */
const COPY: Record<string, { title: string; body: string }> = {
  suspended: {
    title: "This account is suspended — read-only",
    body: "You can view and export your records, but nothing can be added or changed and your team cannot sign in. Settle billing or contact us to restore full access.",
  },
  cancelled: {
    title: "This account has been cancelled — read-only",
    body: "You can still view and export your records for now, but nothing can be added or changed and your team cannot sign in. Contact us if you want to reactivate.",
  },
};

export function HeldCompanyBanner({ status }: { status: string }) {
  const copy = COPY[status];
  if (!copy) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="held-company-banner"
      className="mb-6 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-950"
    >
      <p className="font-semibold">{copy.title}</p>
      <p className="mt-1">{copy.body}</p>
      <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1 font-medium">
        <Link href="/settings/billing" className="underline underline-offset-2">
          Billing
        </Link>
        <a
          href="mailto:hello@crewflow.uk?subject=Account%20access%20-%20CrewFlow"
          className="underline underline-offset-2"
        >
          Contact support
        </a>
      </p>
    </div>
  );
}
