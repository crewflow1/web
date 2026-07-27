import Link from "next/link";
import { requireOrgContext } from "@/server/auth/session";
import { listJobOptions } from "@/app/(app)/diary/_data";
import { createPermit } from "../actions";
import { listRamsOptions } from "../_data";
import { PermitFormFields } from "../_fields";
import { errorMessage, primaryBtn } from "../_meta";

/**
 * /health-safety/permits/new — draft a new permit.
 *
 * Posts to createPermit, which redirects to the new draft's detail page, where
 * the control conditions are added and the permit is later issued. The validity
 * window uses datetime-local pickers that submit offset-qualified ISO instants
 * (see _datetime-field); both are optional here and enforced by the issue gate.
 */

type SP = Promise<{ error?: string }>;

export default async function NewPermitPage({
  searchParams,
}: {
  searchParams: SP;
}) {
  await requireOrgContext();
  const sp = await searchParams;

  const [jobs, ramsOptions] = await Promise.all([
    listJobOptions(),
    listRamsOptions(),
  ]);

  const error = errorMessage(sp.error);

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <nav
        aria-label="Breadcrumb"
        className="flex items-center gap-2 text-sm text-slate-500"
      >
        <Link href="/health-safety" className="hover:text-slate-900">
          Health &amp; safety
        </Link>
        <span aria-hidden>/</span>
        <Link href="/health-safety/permits" className="hover:text-slate-900">
          Permits
        </Link>
        <span aria-hidden>/</span>
        <span className="text-slate-900">New</span>
      </nav>

      <h1 className="text-2xl font-bold text-slate-900">New permit to work</h1>

      {error ? (
        <div
          role="alert"
          aria-live="assertive"
          className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          {error}
        </div>
      ) : null}

      <form
        action={createPermit}
        className="space-y-5 rounded-xl border border-slate-200 bg-white p-6 shadow-sm"
      >
        <PermitFormFields
          jobs={jobs}
          ramsOptions={ramsOptions}
          autoFocusTitle
        />

        <p className="text-xs text-slate-500">
          You can leave the validity window and conditions for now — the permit
          stays a draft until you issue it, and it can&rsquo;t be issued until
          it&rsquo;s complete.
        </p>

        <div className="flex items-center gap-3 pt-1">
          <button type="submit" className={primaryBtn}>
            Save draft
          </button>
          <Link
            href="/health-safety/permits"
            className="inline-flex min-h-[44px] items-center text-sm font-medium text-slate-600 hover:text-slate-900"
          >
            Cancel
          </Link>
        </div>
      </form>
    </div>
  );
}
