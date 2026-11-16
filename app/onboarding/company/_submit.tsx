"use client";

import { useFormStatus } from "react-dom";

/**
 * The company form's submit button. Disabled while the request is in flight so a double
 * click cannot post the form twice — the server also refuses a second company for the same
 * person (see `createOrg`), this just stops the second request being sent at all.
 */
export function CreateCompanySubmit() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      aria-disabled={pending}
      className="w-full rounded-md bg-slate-900 px-4 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-900 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
    >
      {pending ? "Creating your company…" : "Continue →"}
    </button>
  );
}
