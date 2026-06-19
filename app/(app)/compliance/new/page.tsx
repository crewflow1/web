import Link from "next/link";
import { requireOrgContext } from "@/server/auth/session";
import { uploadComplianceDocument } from "../actions";
import { FadeIn } from "@/components/ui";

const ERROR_MAP: Record<string, string> = {
  no_file: "Pick a file to upload.",
  bad_type: "Only PDF, JPG, PNG, HEIC, HEIF and WebP are allowed.",
  too_large: "File is too large (max 25 MB).",
  upload_failed: "Upload failed. Try again.",
  record_failed: "Couldn't save the document. Try again.",
  "Title is required": "Title is required.",
  "Use the date picker — format must be YYYY-MM-DD": "Pick a valid expiry date.",
};

type SP = Promise<{ error?: string }>;

export default async function NewComplianceDocPage({
  searchParams,
}: {
  searchParams: SP;
}) {
  await requireOrgContext();
  const sp = await searchParams;
  const errorMessage = sp.error ? ERROR_MAP[sp.error] ?? decodeURIComponent(sp.error) : null;

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div className="flex items-center gap-2 text-sm text-slate-500">
        <Link href="/compliance" className="hover:text-slate-900">
          Compliance
        </Link>
        <span aria-hidden>/</span>
        <span className="text-slate-900">New</span>
      </div>

      <h1 className="text-2xl font-bold text-slate-900">Add compliance document</h1>

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
          action={uploadComplianceDocument}
          encType="multipart/form-data"
          className="space-y-5 rounded-xl border border-slate-200 bg-white p-6 shadow-sm"
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label
                htmlFor="kind"
                className="block text-sm font-medium text-slate-800"
              >
                Document type<span className="ml-0.5 text-red-500">*</span>
              </label>
              <select
                id="kind"
                name="kind"
                required
                defaultValue="insurance"
                className="mt-1.5 block w-full rounded-md border border-slate-300 bg-white px-3 py-2.5 text-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
              >
                <option value="insurance">Insurance certificate</option>
                <option value="certificate">Trade certificate</option>
                <option value="permit">Permit</option>
                <option value="contract">Contract</option>
                <option value="other">Other</option>
              </select>
            </div>
            <div>
              <label
                htmlFor="expires_at"
                className="block text-sm font-medium text-slate-800"
              >
                Expires on
              </label>
              <input
                id="expires_at"
                name="expires_at"
                type="date"
                className="mt-1.5 block w-full rounded-md border border-slate-300 bg-white px-3 py-2.5 text-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
              />
              <p className="mt-1 text-xs text-slate-500">
                We&rsquo;ll remind you 30 days, 7 days and on the day.
              </p>
            </div>
          </div>

          <div>
            <label
              htmlFor="title"
              className="block text-sm font-medium text-slate-800"
            >
              Title<span className="ml-0.5 text-red-500">*</span>
            </label>
            <input
              id="title"
              name="title"
              type="text"
              required
              placeholder="Public Liability Insurance — Tradewise"
              className="mt-1.5 block w-full rounded-md border border-slate-300 bg-white px-3 py-2.5 text-sm placeholder:text-slate-400 focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
            />
          </div>

          <div>
            <label
              htmlFor="notes"
              className="block text-sm font-medium text-slate-800"
            >
              Notes
            </label>
            <textarea
              id="notes"
              name="notes"
              rows={3}
              placeholder="Optional"
              className="mt-1.5 block w-full rounded-md border border-slate-300 bg-white px-3 py-2.5 text-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
            />
          </div>

          <div>
            <label
              htmlFor="file"
              className="block text-sm font-medium text-slate-800"
            >
              Document<span className="ml-0.5 text-red-500">*</span>
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
              PDF, JPG, PNG, HEIC, HEIF or WebP. Max 25 MB.
            </p>
          </div>

          <div className="flex items-center gap-3 pt-2">
            <button
              type="submit"
              className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
            >
              Upload document
            </button>
            <Link
              href="/compliance"
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
