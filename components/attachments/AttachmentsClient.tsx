"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { AttachmentTargetTable } from "@/server/services/tenant-attachments";
import {
  uploadAttachment,
  removeAttachment,
  getAttachmentSignedUrl,
} from "./actions";

const ERROR_MAP: Record<string, string> = {
  bad_file_type: "Only PDF, JPG, PNG, HEIC, HEIF, WebP, Excel, CSV or Word files.",
  file_too_large: "File is too large (max 25 MB).",
  no_file: "Pick a file first.",
  upload_failed: "Upload failed. Try again.",
  record_failed: "Couldn't record the file. Try again.",
  bad_target: "Invalid attachment target.",
};

export function AttachmentsUploadForm({
  targetTable,
  targetId,
}: {
  targetTable: AttachmentTargetTable;
  targetId: string;
}) {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const fd = new FormData(e.currentTarget);
    startTransition(async () => {
      const result = await uploadAttachment(fd);
      if (!result.ok) {
        setError(ERROR_MAP[result.error] ?? result.error);
        return;
      }
      if (fileInputRef.current) fileInputRef.current.value = "";
      router.refresh();
    });
  }

  return (
    <form onSubmit={onSubmit} className="mt-3 flex flex-wrap items-center gap-2">
      <input type="hidden" name="target_table" value={targetTable} />
      <input type="hidden" name="target_id" value={targetId} />
      <input
        ref={fileInputRef}
        type="file"
        name="file"
        required
        accept="application/pdf,image/jpeg,image/png,image/heic,image/heif,image/webp,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,text/csv,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        className="block w-full max-w-xs rounded-md border border-slate-300 bg-white px-2 py-1.5 text-xs file:mr-2 file:rounded-md file:border-0 file:bg-slate-100 file:px-2 file:py-1 file:text-xs file:font-medium hover:file:bg-slate-200"
      />
      <button
        type="submit"
        disabled={pending}
        className="rounded-md bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {pending ? "Uploading…" : "Upload"}
      </button>
      {error ? (
        <p role="alert" className="basis-full text-xs text-red-700">
          {error}
        </p>
      ) : null}
    </form>
  );
}

export function AttachmentRow({
  attachment,
  targetTable,
  targetId,
}: {
  attachment: {
    id: string;
    filename: string;
    mime_type: string | null;
    size_bytes: number | null;
    created_at: string;
  };
  targetTable: AttachmentTargetTable;
  targetId: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function onOpen() {
    setError(null);
    startTransition(async () => {
      const url = await getAttachmentSignedUrl(attachment.id);
      if (!url) {
        setError("Couldn't open the file.");
        return;
      }
      window.open(url, "_blank", "noopener,noreferrer");
    });
  }

  function onDelete() {
    if (!confirm(`Delete "${attachment.filename}"?`)) return;
    setError(null);
    startTransition(async () => {
      const result = await removeAttachment(attachment.id, targetTable, targetId);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  return (
    <li className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
      <div className="min-w-0 flex-1">
        <button
          type="button"
          onClick={onOpen}
          disabled={pending}
          className="truncate text-left font-medium text-slate-900 hover:text-slate-700 disabled:cursor-wait"
        >
          {attachment.filename}
        </button>
        <p className="text-xs text-slate-500">
          {attachment.size_bytes != null
            ? `${(attachment.size_bytes / 1024 / 1024).toFixed(2)} MB · `
            : ""}
          {attachment.created_at.slice(0, 10)}
        </p>
        {error ? (
          <p role="alert" className="text-xs text-red-700">
            {error}
          </p>
        ) : null}
      </div>
      <button
        type="button"
        onClick={onDelete}
        disabled={pending}
        className="rounded-md border border-red-300 bg-white px-2 py-1 text-xs font-medium text-red-700 hover:bg-red-50 disabled:cursor-wait"
      >
        Delete
      </button>
    </li>
  );
}
