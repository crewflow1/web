"use client";

/**
 * FEATURE 2 — the shared <ImportButton>.
 *
 * ONE component, placed next to any supported create button. It is a secondary
 * action (design-system `secondary` variant), clearly labelled "Import" with an
 * upload icon — never hidden in a menu, and it never replaces or restyles the
 * create button beside it. The parent decides visibility: it renders this only
 * where the operator can create that record type (the same capability the
 * create action enforces), so the button is permission-gated by construction.
 *
 * FLOW: pick a file → upload + governed extraction (server action) → a review
 * dialog shows the proposed values with confidence / uncertain / missing
 * markers → "Use these values" carries them into the EXISTING create form (a
 * route prefill, or the existing create modal via its open event). The operator
 * then edits and saves through the normal validated workflow. Nothing is ever
 * created by this component.
 *
 * Extraction failing or being off (dark AI) NEVER blocks the operator — the
 * dialog says so and the "Continue" action still opens the create form empty.
 */

import { useId, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Upload, FileText, Loader2, CircleCheck, TriangleAlert } from "lucide-react";
import { Button, buttonClass } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { AUTOFILL_FORMS } from "@/lib/imports/autofill/registry";
import type { AutofillExtraction, AutofillFormType } from "@/lib/imports/autofill/types";
import {
  AUTOFILL_ACCEPT,
  AUTOFILL_MAX_BYTES,
  isAllowedAutofillMime,
} from "@/lib/imports/autofill/mime";
import { startImportAction, discardImportAction } from "./actions";

type Phase =
  | { kind: "idle" }
  | { kind: "extracting"; filename: string }
  | { kind: "review"; draftId: string; extraction: AutofillExtraction; filename: string }
  | { kind: "error"; message: string };

const ERROR_COPY = {
  forbidden: "You don't have permission to import this record type.",
  unknown_form: "That record type can't be imported.",
  no_file: "No file was received. Please try again.",
  unsupported_file: "That file type isn't supported. Upload a PDF or a photo (JPG, PNG, HEIC).",
  file_too_large: "That file is too large (max 15 MB).",
  failed: "Something went wrong reading that document. You can still fill the form by hand.",
} satisfies Record<string, string>;

export function ImportButton({
  formType,
  size = "md",
  className,
}: {
  formType: AutofillFormType;
  size?: "sm" | "md" | "lg";
  className?: string;
}) {
  const config = AUTOFILL_FORMS[formType];
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [pending, startTransition] = useTransition();
  const titleId = useId();

  function reset() {
    setPhase({ kind: "idle" });
    if (inputRef.current) inputRef.current.value = "";
  }

  function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    // Client pre-flight so an obviously bad file never leaves the device.
    if (file.size > AUTOFILL_MAX_BYTES) {
      setPhase({ kind: "error", message: ERROR_COPY.file_too_large });
      return;
    }
    if (file.type && !isAllowedAutofillMime(file.type)) {
      setPhase({ kind: "error", message: ERROR_COPY.unsupported_file });
      return;
    }
    setPhase({ kind: "extracting", filename: file.name });
    const fd = new FormData();
    fd.set("formType", formType);
    fd.set("file", file);
    startTransition(async () => {
      try {
        const result = await startImportAction(fd);
        if (result.ok) {
          setPhase({
            kind: "review",
            draftId: result.draftId,
            extraction: result.extraction,
            filename: file.name,
          });
        } else {
          setPhase({ kind: "error", message: ERROR_COPY[result.error] ?? ERROR_COPY.failed });
        }
      } catch {
        setPhase({ kind: "error", message: ERROR_COPY.failed });
      }
    });
  }

  function apply(draftId: string, extraction: AutofillExtraction) {
    if (config.target.kind === "route") {
      // Prefill the existing /new page. The values are re-read server-side from
      // the draft (so a refresh keeps them and they are re-validated), keyed by
      // the draft id in the URL.
      const sep = config.target.newPath.includes("?") ? "&" : "?";
      router.push(`${config.target.newPath}${sep}import=${encodeURIComponent(draftId)}`);
    } else {
      // The existing create modal listens for this event; hand it the draft id
      // and the proposed values so it can prefill itself.
      window.dispatchEvent(
        new CustomEvent(config.target.eventName, {
          detail: { draftId, prefill: extraction.fields },
        }),
      );
    }
    reset();
  }

  function discard(draftId?: string) {
    if (draftId) void discardImportAction(draftId);
    reset();
  }

  const open = phase.kind !== "idle";

  return (
    <>
      <Button
        type="button"
        variant="secondary"
        size={size}
        className={className}
        onClick={() => inputRef.current?.click()}
        aria-label={`Import a ${config.recordLabel} from a document`}
      >
        <Upload aria-hidden className="h-4 w-4" />
        Import
      </Button>
      <input
        ref={inputRef}
        type="file"
        accept={AUTOFILL_ACCEPT}
        // No `capture`: the native chooser then offers camera, photo library AND
        // files on mobile (forcing `capture` would lock out PDFs and the gallery).
        className="hidden"
        onChange={onPick}
        data-testid={`import-input-${formType}`}
      />

      <Modal
        open={open}
        onClose={() => (phase.kind === "review" ? discard(phase.draftId) : reset())}
        labelledBy={titleId}
        size="lg"
      >
        <div className="px-6 py-6 sm:px-8 sm:py-8">
          <h2 id={titleId} className="text-xl font-semibold text-slate-900">
            Import {config.recordLabel}
          </h2>

          {phase.kind === "extracting" ? (
            <div className="mt-6 flex items-center gap-3 text-sm text-slate-600">
              <Loader2 aria-hidden className="h-5 w-5 animate-spin text-slate-500" />
              Reading <span className="font-medium text-slate-900">{phase.filename}</span>…
            </div>
          ) : null}

          {phase.kind === "error" ? (
            <div className="mt-6 space-y-4">
              <div
                role="alert"
                className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800"
              >
                <TriangleAlert aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{phase.message}</span>
              </div>
              <div className="flex justify-end">
                <Button variant="secondary" onClick={reset}>
                  Close
                </Button>
              </div>
            </div>
          ) : null}

          {phase.kind === "review" ? (
            <ReviewPanel
              extraction={phase.extraction}
              fields={config.fields}
              recordLabel={config.recordLabel}
              pending={pending}
              onApply={() => apply(phase.draftId, phase.extraction)}
              onDiscard={() => discard(phase.draftId)}
            />
          ) : null}
        </div>
      </Modal>
    </>
  );
}

function ReviewPanel({
  extraction,
  fields,
  recordLabel,
  pending,
  onApply,
  onDiscard,
}: {
  extraction: AutofillExtraction;
  fields: readonly { key: string; label: string }[];
  recordLabel: string;
  pending: boolean;
  onApply: () => void;
  onDiscard: () => void;
}) {
  const uncertain = new Set(extraction.uncertainFields);
  const found = fields.filter((f) => f.key in extraction.fields);
  const nothing = extraction.engine === "none" || found.length === 0;

  return (
    <div className="mt-5 space-y-5">
      <p className="text-sm text-slate-600">
        {nothing ? (
          <>
            AI document reading isn&rsquo;t enabled on this account, so no values were
            suggested. You can still continue and fill the {recordLabel} form by hand — your
            document was uploaded.
          </>
        ) : (
          <>
            Suggested from your document. <span className="font-medium">Nothing is saved yet</span> —
            review and edit everything on the next screen before saving.
          </>
        )}
      </p>

      {!nothing ? (
        <div className="rounded-lg border border-slate-200">
          <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2 text-xs text-slate-500">
            <span>Proposed values</span>
            <span>Overall confidence: {extraction.overallConfidence}%</span>
          </div>
          <dl className="divide-y divide-slate-100">
            {fields.map((f) => {
              const value = extraction.fields[f.key];
              const isUncertain = uncertain.has(f.key);
              return (
                <div key={f.key} className="flex items-start gap-3 px-4 py-2.5">
                  <dt className="w-40 shrink-0 text-sm font-medium text-slate-600">{f.label}</dt>
                  <dd className="flex-1 text-sm">
                    {value ? (
                      <span className="flex items-start gap-2">
                        <span className="break-words text-slate-900">{value}</span>
                        {isUncertain ? (
                          <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">
                            <TriangleAlert aria-hidden className="h-3 w-3" />
                            Check
                          </span>
                        ) : (
                          <CircleCheck aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
                        )}
                      </span>
                    ) : (
                      <span className="text-slate-400">Not found</span>
                    )}
                  </dd>
                </div>
              );
            })}
          </dl>
        </div>
      ) : null}

      <div className="flex items-center justify-between gap-3">
        <span className="flex items-center gap-1.5 text-xs text-slate-400">
          <FileText aria-hidden className="h-3.5 w-3.5" />
          Document stored privately to your organisation.
        </span>
        <div className="flex items-center gap-2">
          <Button variant="secondary" onClick={onDiscard} disabled={pending}>
            Discard
          </Button>
          <button type="button" onClick={onApply} disabled={pending} className={buttonClass("primary", "md")}>
            {nothing ? "Continue to form" : "Use these values"}
          </button>
        </div>
      </div>
    </div>
  );
}
