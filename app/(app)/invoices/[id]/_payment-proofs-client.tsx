"use client";

import { useState, useTransition } from "react";
import { getPaymentProofSignedUrl } from "./proof-actions";

/**
 * One customer-submitted payment proof, with an open control.
 *
 * The `portal-uploads` bucket is private (public: false), so the file can only
 * be opened through a short-lived signed URL minted server-side. Mirrors
 * <AttachmentRow> (components/attachments/AttachmentsClient.tsx): click →
 * mint → window.open, with the failure surfaced inline rather than thrown.
 */

export type PaymentProof = {
  id: string;
  filename: string;
  mime_type: string | null;
  size_bytes: number | null;
  notes: string | null;
  uploaded_at: string;
};

export function PaymentProofRow({ proof }: { proof: PaymentProof }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function onOpen() {
    setError(null);
    startTransition(async () => {
      const url = await getPaymentProofSignedUrl(proof.id);
      if (!url) {
        setError("Couldn't open this file. Refresh and try again.");
        return;
      }
      window.open(url, "_blank", "noopener,noreferrer");
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
          {pending ? "Opening…" : proof.filename}
        </button>
        <p className="text-xs text-slate-500">
          {proof.size_bytes != null
            ? `${(proof.size_bytes / 1024 / 1024).toFixed(2)} MB · `
            : ""}
          Sent {proof.uploaded_at.slice(0, 10)}
        </p>
        {proof.notes ? (
          <p className="mt-0.5 text-xs text-slate-600">
            <span className="text-slate-400">Customer note:</span> {proof.notes}
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="text-xs text-red-700">
            {error}
          </p>
        ) : null}
      </div>
    </li>
  );
}
