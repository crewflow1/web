import Link from "next/link";

/**
 * Customer-side 404 (HQ-12.polish).
 *
 * Picked up automatically by notFound() in any (app) route. Replaces
 * the root marketing 404 with one that keeps the workspace shell.
 */
export default function CustomerAppNotFound() {
  return (
    <main className="flex min-h-[60vh] flex-col items-center justify-center py-16 text-center">
      <p className="text-sm font-semibold uppercase tracking-wide text-amber-600">
        404
      </p>
      <h1 className="mt-2 text-3xl font-bold text-slate-900">
        That page doesn&apos;t exist
      </h1>
      <p className="mt-3 max-w-md text-sm text-slate-600">
        The link might have changed or expired. Head back to your dashboard,
        or open a ticket if you think this is a bug.
      </p>
      <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
        <Link
          href="/dashboard"
          className="rounded-md bg-slate-900 px-5 py-2.5 text-sm font-medium text-white hover:bg-slate-800"
        >
          Back to dashboard
        </Link>
        <Link
          href="/support/new"
          className="rounded-md border border-slate-300 bg-white px-5 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
        >
          Raise a ticket
        </Link>
      </div>
    </main>
  );
}
