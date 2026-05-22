import Link from "next/link";

/**
 * Stub for HQ sections that haven't yet shipped a dedicated page.
 *
 * NEVER a dead end (directive rule 5). Each stub:
 *   - says exactly what's coming
 *   - says which sprint ships it
 *   - links the user to the nearest working surface that's already
 *     live (usually /admin/organizations or /admin/overview).
 */
export function ComingSoonStub({
  title,
  sprint,
  body,
  primaryHref,
  primaryLabel,
}: {
  title: string;
  sprint: "HQ-2" | "HQ-3" | "HQ-4" | "HQ-5" | "HQ-6";
  body: string;
  primaryHref?: string;
  primaryLabel?: string;
}) {
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-bold text-slate-900">{title}</h1>
        <p className="mt-1 text-sm text-slate-600">
          CrewFlow HQ ·{" "}
          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-800">
            Ships in {sprint}
          </span>
        </p>
      </header>

      <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <p className="text-sm text-slate-700">{body}</p>
        <div className="mt-5 flex flex-wrap gap-2">
          {primaryHref ? (
            <Link
              href={primaryHref}
              className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-slate-800"
            >
              {primaryLabel ?? "Use the legacy view"}
            </Link>
          ) : null}
          <Link
            href="/admin/overview"
            className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            Back to overview
          </Link>
        </div>
      </section>
    </div>
  );
}
