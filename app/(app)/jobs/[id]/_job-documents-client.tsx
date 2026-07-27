"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
// Type-only import: the service module is `server-only`, so it must never be
// pulled into the client bundle. All runtime values (accept list, max size,
// doc types) arrive as props from the server panel.
import type {
  JobDocumentRow,
  JobDocumentVersionRow,
} from "@/server/services/job-documents";
import {
  uploadJobDocument,
  uploadJobDocumentVersion,
  completeJobDocumentAction,
  deleteJobDocumentAction,
  getJobDocumentDownloadUrlAction,
} from "./job-documents-actions";

const ERROR_MAP: Record<string, string> = {
  bad_file_type: "Unsupported file type. Use PDF, an image, Word, Excel or CSV.",
  file_too_large: "File is too large (max 25 MB).",
  no_file: "Choose a file first.",
  title_required: "Give the document a name.",
  bad_target: "Something went wrong. Refresh and try again.",
  upload_failed: "Upload failed. Please try again.",
  record_failed: "Couldn’t save the document. Please try again.",
  job_not_found: "This job could no longer be found.",
  not_found: "That document is no longer available.",
  locked: "This document is completed and locked.",
  forbidden: "You don’t have permission to do that.",
  update_failed: "Couldn’t update the document. Please try again.",
  delete_failed: "Couldn’t delete the document. Please try again.",
  lookup_failed: "Couldn’t open the file. Please try again.",
  sign_failed: "Couldn’t open the file. Please try again.",
};
const friendly = (code: string): string => ERROR_MAP[code] ?? code;

function formatBytes(n: number | null | undefined): string {
  if (!n || n <= 0) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function prettyDocType(s: string): string {
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

const STATUS_BADGE: Record<string, string> = {
  draft: "bg-slate-100 text-slate-700",
  in_progress: "bg-blue-100 text-blue-800",
  completed: "bg-emerald-100 text-emerald-800",
};

// ---------------------------------------------------------------------------
// New document — name + type + file (Choose file OR Take photo), then submit.
// Used for the staff area, the admin private area, and (as a write-only drop
// box) the staff view of the private area.
// ---------------------------------------------------------------------------
export function NewDocumentForm({
  jobId,
  visibility,
  docTypes,
  accept,
  maxBytes,
  dropbox = false,
}: {
  jobId: string;
  visibility: "staff" | "private";
  docTypes: readonly string[];
  accept: string;
  maxBytes: number;
  dropbox?: boolean;
}) {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [docType, setDocType] = useState("custom");
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [pending, startTransition] = useTransition();
  const chooseRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);

  function pick(f: File | null) {
    setError(null);
    setDone(false);
    if (f && f.size > maxBytes) {
      setError(friendly("file_too_large"));
      return;
    }
    setFile(f);
  }

  function reset() {
    setTitle("");
    setDocType("custom");
    setFile(null);
    if (chooseRef.current) chooseRef.current.value = "";
    if (cameraRef.current) cameraRef.current.value = "";
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setDone(false);
    if (!title.trim()) {
      setError(friendly("title_required"));
      return;
    }
    if (!file) {
      setError(friendly("no_file"));
      return;
    }
    const fd = new FormData();
    fd.set("job_id", jobId);
    fd.set("visibility", visibility);
    fd.set("title", title.trim());
    fd.set("doc_type", docType);
    fd.set("file", file);
    startTransition(async () => {
      const res = await uploadJobDocument(fd);
      if (!res.ok) {
        setError(friendly(res.error));
        return;
      }
      reset();
      setDone(true);
      router.refresh();
    });
  }

  return (
    <form onSubmit={onSubmit} className="mt-3 space-y-3">
      <div>
        <label
          htmlFor={`jobdoc-title-${visibility}`}
          className="block text-xs font-medium text-slate-600"
        >
          Document name
        </label>
        <input
          id={`jobdoc-title-${visibility}`}
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="e.g. EICR certificate"
          className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2.5 text-base text-slate-900 placeholder:text-slate-400 focus:border-slate-400 focus:outline-none"
        />
      </div>

      <div>
        <label
          htmlFor={`jobdoc-type-${visibility}`}
          className="block text-xs font-medium text-slate-600"
        >
          Type
        </label>
        <select
          id={`jobdoc-type-${visibility}`}
          value={docType}
          onChange={(e) => setDocType(e.target.value)}
          className="mt-1 block w-full rounded-md border border-slate-300 bg-white px-3 py-2.5 text-base text-slate-900 focus:border-slate-400 focus:outline-none"
        >
          {docTypes.map((t) => (
            <option key={t} value={t}>
              {prettyDocType(t)}
            </option>
          ))}
        </select>
      </div>

      {/* Two entry points so mobile users can shoot straight from the camera. */}
      <input
        ref={chooseRef}
        type="file"
        accept={accept}
        hidden
        onChange={(e) => pick(e.target.files?.[0] ?? null)}
      />
      <input
        ref={cameraRef}
        type="file"
        accept="image/*"
        capture="environment"
        hidden
        onChange={(e) => pick(e.target.files?.[0] ?? null)}
      />
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => chooseRef.current?.click()}
          className="min-w-[8rem] flex-1 rounded-md border border-slate-300 bg-white px-4 py-3 text-sm font-medium text-slate-700 hover:bg-slate-50"
        >
          Choose file
        </button>
        <button
          type="button"
          onClick={() => cameraRef.current?.click()}
          className="min-w-[8rem] flex-1 rounded-md border border-slate-300 bg-white px-4 py-3 text-sm font-medium text-slate-700 hover:bg-slate-50"
        >
          Take photo
        </button>
      </div>

      {file ? (
        <p className="truncate text-xs text-slate-500">
          Selected: {file.name}
          {formatBytes(file.size) ? ` · ${formatBytes(file.size)}` : ""}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={pending}
        className="w-full rounded-md bg-slate-900 px-4 py-3 text-base font-semibold text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {pending
          ? "Uploading…"
          : dropbox
            ? "Send to office"
            : "Upload document"}
      </button>

      {error ? (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      ) : null}
      {done ? (
        <p className="text-sm text-emerald-700">
          {dropbox
            ? "Sent. The office can see this — it stays hidden from the team."
            : "Uploaded."}
        </p>
      ) : null}
    </form>
  );
}

// ---------------------------------------------------------------------------
// A single document: download current, add a version, complete, delete
// (admin), and a collapsible version history.
// ---------------------------------------------------------------------------
export function DocumentRow({
  doc,
  versions,
  jobId,
  accept,
  maxBytes,
  canDelete,
}: {
  doc: JobDocumentRow;
  versions: JobDocumentVersionRow[];
  jobId: string;
  accept: string;
  maxBytes: number;
  canDelete: boolean;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const newVerRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);

  const current = versions[0]; // newest first — may be undefined
  const completed = doc.status === "completed";

  function openVersion(versionId: string) {
    setError(null);
    startTransition(async () => {
      const res = await getJobDocumentDownloadUrlAction(versionId);
      if (!res.ok) {
        setError(friendly(res.error));
        return;
      }
      window.open(res.url, "_blank", "noopener,noreferrer");
    });
  }

  function submitVersion(f: File | null) {
    if (newVerRef.current) newVerRef.current.value = "";
    if (cameraRef.current) cameraRef.current.value = "";
    if (!f) return;
    setError(null);
    if (f.size > maxBytes) {
      setError(friendly("file_too_large"));
      return;
    }
    const fd = new FormData();
    fd.set("document_id", doc.id);
    fd.set("job_id", jobId);
    fd.set("file", f);
    startTransition(async () => {
      const res = await uploadJobDocumentVersion(fd);
      if (!res.ok) {
        setError(friendly(res.error));
        return;
      }
      router.refresh();
    });
  }

  function onComplete() {
    if (
      !confirm(
        `Mark “${doc.title}” as completed? This locks it — no more versions can be added.`,
      )
    ) {
      return;
    }
    setError(null);
    startTransition(async () => {
      const res = await completeJobDocumentAction(doc.id, jobId);
      if (!res.ok) {
        setError(friendly(res.error));
        return;
      }
      router.refresh();
    });
  }

  function onDelete() {
    if (
      !confirm(`Delete “${doc.title}” and all its versions? This can’t be undone.`)
    ) {
      return;
    }
    setError(null);
    startTransition(async () => {
      const res = await deleteJobDocumentAction(doc.id, jobId);
      if (!res.ok) {
        setError(friendly(res.error));
        return;
      }
      router.refresh();
    });
  }

  return (
    <li className="rounded-lg border border-slate-200 p-3">
      <div className="min-w-0">
        <p className="truncate font-medium text-slate-900">{doc.title}</p>
        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-slate-600">
            {prettyDocType(doc.doc_type)}
          </span>
          <span
            className={`rounded-full px-2 py-0.5 font-medium ${STATUS_BADGE[doc.status] ?? "bg-slate-100 text-slate-700"}`}
          >
            {doc.status === "in_progress" ? "in progress" : doc.status}
          </span>
          <span className="text-slate-400">
            {versions.length} version{versions.length === 1 ? "" : "s"}
          </span>
        </div>
      </div>

      {/* Hidden inputs for "New version" / "Photo" (camera on mobile). */}
      <input
        ref={newVerRef}
        type="file"
        accept={accept}
        hidden
        onChange={(e) => submitVersion(e.target.files?.[0] ?? null)}
      />
      <input
        ref={cameraRef}
        type="file"
        accept="image/*"
        capture="environment"
        hidden
        onChange={(e) => submitVersion(e.target.files?.[0] ?? null)}
      />

      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => current && openVersion(current.id)}
          disabled={pending || !current}
          className="rounded-md bg-slate-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Download
        </button>

        {!completed ? (
          <>
            <button
              type="button"
              onClick={() => newVerRef.current?.click()}
              disabled={pending}
              className="rounded-md border border-slate-300 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            >
              New version
            </button>
            <button
              type="button"
              onClick={() => cameraRef.current?.click()}
              disabled={pending}
              className="rounded-md border border-slate-300 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            >
              Photo
            </button>
            <button
              type="button"
              onClick={onComplete}
              disabled={pending}
              className="rounded-md border border-emerald-300 bg-emerald-50 px-4 py-2.5 text-sm font-medium text-emerald-700 hover:bg-emerald-100 disabled:opacity-50"
            >
              Complete
            </button>
          </>
        ) : null}

        {canDelete ? (
          <button
            type="button"
            onClick={onDelete}
            disabled={pending}
            className="rounded-md border border-red-300 bg-white px-4 py-2.5 text-sm font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
          >
            Delete
          </button>
        ) : null}
      </div>

      {error ? (
        <p role="alert" className="mt-2 text-sm text-red-700">
          {error}
        </p>
      ) : null}

      {versions.length > 0 ? (
        <details className="mt-3">
          <summary className="cursor-pointer text-sm font-medium text-slate-600">
            Version history
          </summary>
          <ul className="mt-2 divide-y divide-slate-100">
            {versions.map((v) => (
              <li
                key={v.id}
                className="flex items-center justify-between gap-3 py-2 text-sm"
              >
                <div className="min-w-0">
                  <p className="truncate text-slate-800">
                    v{v.version_no} · {v.filename}
                  </p>
                  <p className="text-xs text-slate-400">
                    {formatBytes(v.size_bytes)}
                    {formatBytes(v.size_bytes) ? " · " : ""}
                    {v.created_at.slice(0, 10)}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => openVersion(v.id)}
                  disabled={pending}
                  className="shrink-0 rounded-md border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                >
                  Download
                </button>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </li>
  );
}
