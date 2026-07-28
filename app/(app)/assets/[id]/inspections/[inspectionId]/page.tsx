import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { AttachmentsPanel } from "@/components/attachments/AttachmentsPanel";
import {
  INSPECTION_OUTCOME_LABELS,
  INSPECTION_STATUS_LABELS,
  type InspectionOutcome,
  type InspectionStatus,
} from "@/lib/assets/inspection";
import {
  CHECK_LEVEL_LABELS,
  type TemplateItem,
  type TemplateSnapshot,
} from "@/lib/assets/inspection-template";
import { completeTemplatedInspection, saveInspectionAnswers } from "../../../inspection-actions";

export const metadata = { title: "Inspection · CrewFlow" };

type Row = {
  id: string;
  asset_id: string;
  title: string;
  status: InspectionStatus;
  outcome: InspectionOutcome | null;
  safety_critical: boolean;
  content: {
    answers?: Record<string, string>;
    comments?: Record<string, string>;
    signatures?: Record<string, string>;
    failed_keys?: string[];
    critical_failed_keys?: string[];
  } | null;
  template_snapshot: TemplateSnapshot | null;
  inspected_at: string | null;
  created_at: string;
  assets: { id: string; name: string; asset_ref: string | null } | null;
};

const SAVED_MAP: Record<string, string> = {
  progress: "Progress saved. You can finish this inspection later.",
  issued: "Inspection recorded and locked.",
};
const ERROR_MAP: Record<string, string> = {
  inspection_failed: "Couldn't save. Try again.",
  inspection_not_draft: "This inspection is already recorded and locked.",
  answers_missing: "Answer every required item (use N/A only where allowed).",
  fail_comment_missing: "Add a comment for each failed item.",
  signature_missing: "Type your full name to sign each item that requires a signature.",
  inspection_invalid: "This inspection has no checklist attached.",
};

export default async function InspectionRunPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; inspectionId: string }>;
  searchParams: Promise<{ saved?: string; error?: string }>;
}) {
  const { id: assetId, inspectionId } = await params;
  const sp = await searchParams;
  const { ctx } = await requireOrgContext();
  const supabase = await createClient();

  // Pinned to the ACTIVE org — RLS admits every org the viewer belongs to, so
  // id + asset_id alone would render another org's inspection (an immutable
  // safety record) inside this org's shell.
  const { data: insp } = await (
    supabase.from("asset_inspections" as never) as unknown as {
      select: (c: string) => {
        eq: (k: string, v: unknown) => {
          eq: (k: string, v: unknown) => {
            eq: (k: string, v: unknown) => {
              maybeSingle: () => Promise<{ data: Row | null }>;
            };
          };
        };
      };
    }
  )
    .select(
      "id, asset_id, title, status, outcome, safety_critical, content, template_snapshot, inspected_at, created_at, assets(id, name, asset_ref)",
    )
    .eq("id", inspectionId)
    .eq("asset_id", assetId)
    .eq("org_id", ctx.org.id)
    .maybeSingle();
  if (!insp || !insp.template_snapshot) notFound();

  const snapshot = insp.template_snapshot;
  const answers = insp.content?.answers ?? {};
  const comments = insp.content?.comments ?? {};
  const signatures = insp.content?.signatures ?? {};
  const failedKeys = new Set(insp.content?.failed_keys ?? []);
  const criticalKeys = new Set(insp.content?.critical_failed_keys ?? []);
  const running = insp.status === "draft";

  const savedMessage = sp.saved ? (SAVED_MAP[sp.saved] ?? null) : null;
  const errorMessage = sp.error ? (ERROR_MAP[sp.error] ?? null) : null;

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <header>
        <Link
          href={`/assets/${assetId}`}
          className="mb-1 inline-flex items-center gap-1 text-xs font-medium text-slate-500 transition hover:text-slate-900"
        >
          ← {insp.assets?.name ?? "Asset"}
        </Link>
        <h1 className="text-2xl font-bold text-slate-900">{insp.title}</h1>
        <p className="mt-1 text-sm text-slate-600">
          {CHECK_LEVEL_LABELS[snapshot.check_level]} · template v{snapshot.version} ·{" "}
          {INSPECTION_STATUS_LABELS[insp.status]}
          {insp.inspected_at ? ` · ${insp.inspected_at.slice(0, 10)}` : ""}
        </p>
      </header>

      {savedMessage ? (
        <div role="status" className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{savedMessage}</div>
      ) : null}
      {errorMessage ? (
        <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{errorMessage}</div>
      ) : null}

      {!running && insp.outcome ? (
        <div
          role="status"
          className={`rounded-md border px-3 py-2 text-sm ${
            insp.outcome === "fail"
              ? "border-red-300 bg-red-50 text-red-800"
              : insp.outcome === "pass_with_defects"
                ? "border-amber-300 bg-amber-50 text-amber-800"
                : "border-emerald-300 bg-emerald-50 text-emerald-800"
          }`}
        >
          <strong>{INSPECTION_OUTCOME_LABELS[insp.outcome]}.</strong>{" "}
          {insp.outcome === "fail" && insp.safety_critical
            ? "Safety-critical defect recorded. Do not use this equipment — report to your supervisor. This asset is blocked from issue until a passing re-inspection is recorded."
            : insp.outcome === "pass_with_defects"
              ? "Defects recorded — rectify per their severity. The asset is not blocked."
              : "No defects recorded."}{" "}
          This record is locked.
        </div>
      ) : null}

      <form action={completeTemplatedInspection} className="space-y-5">
        <input type="hidden" name="inspection_id" value={insp.id} />

        {snapshot.sections.map((s, sIdx) => (
          <section key={s.key} className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
            <h2 className="text-base font-semibold text-slate-900">
              {sIdx + 1}. {s.title}
            </h2>
            <ul className="mt-3 space-y-4">
              {s.items.map((item) => (
                <li key={item.key}>
                  <ItemField
                    item={item}
                    answer={answers[item.key]}
                    comment={comments[item.key]}
                    signature={signatures[item.key]}
                    readOnly={!running}
                    failed={failedKeys.has(item.key)}
                    critical={criticalKeys.has(item.key)}
                  />
                </li>
              ))}
            </ul>
          </section>
        ))}

        {running ? (
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="submit"
              className="rounded-md bg-slate-900 px-5 py-2.5 text-sm font-semibold text-white hover:bg-slate-800"
            >
              Complete inspection
            </button>
            <button
              type="submit"
              formAction={saveInspectionAnswers}
              className="rounded-md border border-slate-300 px-5 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              Save progress
            </button>
            <span className="text-xs text-slate-500">
              Completing derives the outcome from your answers and locks the record.
            </span>
          </div>
        ) : null}
      </form>

      {/* Photos / evidence ride the universal attachments pipeline. */}
      <AttachmentsPanel targetTable="asset_inspections" targetId={insp.id} />
    </div>
  );
}

function ItemField({
  item,
  answer,
  comment,
  signature,
  readOnly,
  failed,
  critical,
}: {
  item: TemplateItem;
  answer: string | undefined;
  comment: string | undefined;
  signature: string | undefined;
  readOnly: boolean;
  failed: boolean;
  critical: boolean;
}) {
  const name = `answer.${item.key}`;
  const box = failed
    ? critical
      ? "border-red-300 bg-red-50"
      : "border-amber-300 bg-amber-50"
    : "border-slate-200 bg-white";
  return (
    <div className={`rounded-md border p-3 ${box}`}>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium text-slate-900">{item.prompt}</span>
        {item.safety_critical ? (
          <span className="rounded-full bg-red-100 px-2 py-0.5 text-[11px] font-medium text-red-700">Safety-critical</span>
        ) : null}
        {item.requires_photo ? (
          <span className="rounded-full bg-blue-50 px-2 py-0.5 text-[11px] font-medium text-blue-700">Photo required</span>
        ) : null}
        {item.requires_photo_on_fail ? (
          <span className="rounded-full bg-blue-50 px-2 py-0.5 text-[11px] font-medium text-blue-700">Photo on fail</span>
        ) : null}
        {!item.required ? <span className="text-[11px] text-slate-400">Optional</span> : null}
      </div>
      {item.guidance ? <p className="mt-0.5 text-xs text-slate-500">{item.guidance}</p> : null}

      <div className="mt-2">
        {item.response_type === "pass_fail" || item.response_type === "yes_no" ? (
          <div className="flex flex-wrap gap-2">
            {(item.response_type === "pass_fail" ? ["pass", "fail"] : ["yes", "no"])
              .concat(item.allow_na ? ["na"] : [])
              .map((v) => (
                <label
                  key={v}
                  className="flex min-h-10 cursor-pointer items-center gap-2 rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-800 has-[:checked]:border-slate-900 has-[:checked]:bg-slate-900 has-[:checked]:text-white"
                >
                  <input
                    type="radio"
                    name={name}
                    value={v}
                    defaultChecked={answer === v}
                    disabled={readOnly}
                    className="sr-only"
                  />
                  {v === "na" ? "N/A" : v[0]?.toUpperCase() + v.slice(1)}
                </label>
              ))}
          </div>
        ) : item.response_type === "choice" ? (
          <select
            name={name}
            defaultValue={answer ?? ""}
            disabled={readOnly}
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
          >
            <option value="">Select…</option>
            {(item.choices ?? []).map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
            {item.allow_na ? <option value="na">N/A</option> : null}
          </select>
        ) : item.response_type === "number" || item.response_type === "meter_reading" ? (
          <input
            type="number"
            step="any"
            name={name}
            defaultValue={answer ?? ""}
            disabled={readOnly}
            placeholder={item.response_type === "meter_reading" ? "Reading" : ""}
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
          />
        ) : item.response_type === "date" ? (
          <input
            type="date"
            name={name}
            defaultValue={answer ?? ""}
            disabled={readOnly}
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
          />
        ) : item.response_type === "acknowledgement" ? (
          <label className="flex min-h-10 items-center gap-2 text-sm text-slate-800">
            <input
              type="checkbox"
              name={name}
              value="acknowledged"
              defaultChecked={answer === "acknowledged"}
              disabled={readOnly}
              className="h-5 w-5 rounded border-slate-300"
            />
            Confirmed
          </label>
        ) : (
          <input
            name={name}
            defaultValue={answer ?? ""}
            disabled={readOnly}
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
          />
        )}
      </div>

      {readOnly && comment ? (
        <p className="mt-2 text-xs text-slate-600">
          <span className="font-medium">Comment:</span> {comment}
        </p>
      ) : null}
      {readOnly && signature ? (
        <p className="mt-1 text-xs text-slate-600">
          <span className="font-medium">Signed:</span> {signature}
        </p>
      ) : null}
      {!readOnly && item.requires_signature ? (
        <input
          name={`signature.${item.key}`}
          defaultValue={signature ?? ""}
          placeholder="Type your full name to sign (required to complete)"
          aria-label="Type your full name to sign this item"
          className="mt-2 w-full rounded-md border border-purple-200 bg-purple-50/50 px-3 py-2 text-sm"
        />
      ) : null}
      {!readOnly ? (
        <input
          name={`comment.${item.key}`}
          defaultValue={comment ?? ""}
          placeholder={item.requires_comment_on_fail ? "Comment (required if failed)" : "Comment (optional)"}
          className="mt-2 w-full rounded-md border border-slate-200 px-3 py-1.5 text-xs"
        />
      ) : null}
    </div>
  );
}
