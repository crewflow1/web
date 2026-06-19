import Link from "next/link";
import { requireOrgContext } from "@/server/auth/session";
import { uploadExpenseReceipt } from "../actions";
import { FadeIn } from "@/components/ui";

const ERROR_MAP: Record<string, string> = {
  no_file: "Pick a file to upload.",
  bad_type: "Only PDF, JPG, PNG, HEIC, HEIF and WebP are allowed.",
  too_large: "File is too large (max 10 MB).",
  upload_failed: "Upload failed. Try again.",
  draft_failed: "Couldn't create the expense draft. Try again.",
};

type SP = Promise<{ error?: string }>;

export default async function NewExpensePage({
  searchParams,
}: {
  searchParams: SP;
}) {
  await requireOrgContext();
  const sp = await searchParams;
  const errorMessage = sp.error ? ERROR_MAP[sp.error] ?? sp.error : null;

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div className="flex items-center gap-2 text-sm text-slate-500">
        <Link href="/expenses" className="hover:text-slate-900">
          Expenses
        </Link>
        <span aria-hidden>/</span>
        <span className="text-slate-900">Upload</span>
      </div>

      <h1 className="text-2xl font-bold text-slate-900">Upload receipt</h1>

      {errorMessage ? (
        <div
          role="alert"
          className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          {errorMessage}
        </div>
      ) : null}

      <FadeIn>
        <form
          action={uploadExpenseReceipt}
          encType="multipart/form-data"
          className="space-y-5 rounded-xl border border-slate-200 bg-white p-6 shadow-sm"
        >
          <div>
            <label
              htmlFor="file"
              className="block text-sm font-medium text-slate-800"
            >
              Receipt or supplier invoice
              <span className="ml-0.5 text-red-500">*</span>
            </label>
            <input
              id="file"
              type="file"
              name="file"
              required
              accept="application/pdf,image/jpeg,image/png,image/heic,image/heif,image/webp"
              className="mt-1.5 block w-full rounded-md border border-slate-300 bg-white px-3 py-2.5 text-sm file:mr-3 file:rounded-md file:border-0 file:bg-slate-100 file:px-3 file:py-1.5 file:text-sm file:font-medium hover:file:bg-slate-200"
            />
            <p className="mt-1 text-xs text-slate-500">
              PDF, JPG, PNG, HEIC, HEIF or WebP. Max 10 MB. The AI will
              extract amount, VAT, supplier and category — you review and
              approve before anything posts to your books.
            </p>
          </div>

          <div className="flex items-center gap-3 pt-2">
            <button
              type="submit"
              className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
            >
              Upload + extract
            </button>
            <Link
              href="/expenses"
              className="text-sm font-medium text-slate-600 hover:text-slate-900"
            >
              Cancel
            </Link>
          </div>
        </form>
      </FadeIn>
    </div>
  );
}
