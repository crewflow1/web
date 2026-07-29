"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { LOGO_ACCEPT } from "@/lib/branding/logo";
import { uploadLogoAction, deleteLogoAction } from "./logo-actions";

/**
 * Company logo control — upload / replace / remove an image file.
 *
 * Replaces the old free-text "Logo URL" input. Renders inside the
 * Organisation section of /settings, OUTSIDE the main org <form> (it's its
 * own multipart submission). Controls are shown only to owners/admins; the
 * server action re-checks the role regardless.
 */

const ERROR_MAP: Record<string, string> = {
  no_file: "Choose an image first.",
  empty_file: "That file looks empty — choose another.",
  forbidden: "Only owners and admins can change the logo.",
  bad_file_type: "Use a PNG, JPG or WebP image.",
  ext_mismatch: "The file’s extension doesn’t match its contents.",
  file_too_large: "Image is too large — keep it under 2 MB.",
  upload_failed: "Upload failed. Try again.",
  record_failed: "Couldn’t save the logo. Try again.",
};

export function LogoUpload({
  isAdmin,
  logoSrc,
  hasLogo,
}: {
  isAdmin: boolean;
  logoSrc: string | null;
  hasLogo: boolean;
}) {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function onUpload(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const fd = new FormData(e.currentTarget);
    startTransition(async () => {
      const result = await uploadLogoAction(fd);
      if (!result.ok) {
        setError(ERROR_MAP[result.error] ?? "Something went wrong. Try again.");
        return;
      }
      if (fileInputRef.current) fileInputRef.current.value = "";
      router.refresh();
    });
  }

  function onRemove() {
    if (!confirm("Remove your company logo?")) return;
    setError(null);
    startTransition(async () => {
      const result = await deleteLogoAction();
      if (!result.ok) {
        setError(ERROR_MAP[result.error] ?? "Something went wrong. Try again.");
        return;
      }
      router.refresh();
    });
  }

  return (
    <div>
      <span className="block text-sm font-medium text-slate-800">Logo</span>
      <p className="mt-1 text-xs text-slate-500">
        PNG, JPG or WebP, up to 2 MB. Shown on quote and invoice PDFs and your
        customer portal. Square or wide works best.
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-4">
        <div className="flex h-16 w-32 shrink-0 items-center justify-center overflow-hidden rounded-md border border-slate-200 bg-slate-50">
          {logoSrc ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={logoSrc}
              alt="Company logo"
              className="h-full w-full object-contain"
            />
          ) : (
            <span className="px-2 text-center text-[11px] text-slate-600">
              No logo yet
            </span>
          )}
        </div>

        {isAdmin ? (
          <form onSubmit={onUpload} className="flex flex-wrap items-center gap-2">
            <input
              ref={fileInputRef}
              type="file"
              name="file"
              required
              accept={LOGO_ACCEPT}
              className="block max-w-xs rounded-md border border-slate-300 bg-white px-2 py-1.5 text-xs file:mr-2 file:rounded-md file:border-0 file:bg-slate-100 file:px-2 file:py-1 file:text-xs file:font-medium hover:file:bg-slate-200"
            />
            <button
              type="submit"
              disabled={pending}
              className="rounded-md bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {pending ? "Saving…" : hasLogo ? "Replace" : "Upload"}
            </button>
            {hasLogo ? (
              <button
                type="button"
                onClick={onRemove}
                disabled={pending}
                className="rounded-md border border-red-300 bg-white px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-60"
              >
                Remove
              </button>
            ) : null}
          </form>
        ) : (
          <p className="text-xs text-slate-500">
            Ask an owner or admin to change the company logo.
          </p>
        )}
      </div>

      {error ? (
        <p role="alert" className="mt-2 text-xs text-red-700">
          {error}
        </p>
      ) : null}
    </div>
  );
}
