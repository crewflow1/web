import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import {
  CHECK_LEVEL_LABELS,
  RESPONSE_TYPES,
  RESPONSE_TYPE_LABELS,
  TEMPLATE_STATUS_LABELS,
  templateDefinitionSchema,
  validateForPublish,
  type CheckLevel,
  type TemplateItem,
  type TemplateStatus,
} from "@/lib/assets/inspection-template";
import {
  addItem,
  addSection,
  archiveTemplate,
  cloneTemplate,
  createNextVersion,
  moveItem,
  moveSection,
  publishTemplate,
  removeItem,
  removeSection,
} from "../../template-actions";
import { StateForm } from "@/components/forms/StateForm";
import type { FormState } from "@/lib/forms/state";

export const metadata = { title: "Inspection template · CrewFlow" };

type Row = {
  id: string;
  family_id: string;
  version: number;
  name: string;
  description: string | null;
  categories: string[] | null;
  check_level: CheckLevel;
  status: TemplateStatus;
  definition: unknown;
  published_at: string | null;
  created_at: string;
};

type VersionRow = { id: string; version: number; status: TemplateStatus; published_at: string | null };

const STATUS_STYLES: Record<TemplateStatus, string> = {
  draft: "bg-amber-100 text-amber-800",
  published: "bg-emerald-100 text-emerald-800",
  superseded: "bg-slate-100 text-slate-500",
  archived: "bg-slate-100 text-slate-400",
};

const SAVED_MAP: Record<string, string> = {
  created: "Draft created. Add sections and items, then publish.",
  cloned: "Template cloned as a new draft.",
  version: "New draft version created. Changes apply only to future inspections once published.",
  section: "Section added.",
  section_removed: "Section removed.",
  item: "Item added.",
  item_removed: "Item removed.",
  published: "Version published. It is now locked — editing creates the next version.",
  archived: "Template archived. It can no longer start inspections.",
};
const ERROR_MAP: Record<string, string> = {
  template_invalid: "Please check the template details.",
  template_failed: "Couldn't save the change. Try again.",
  template_missing: "That template could not be found.",
  not_draft: "This version is locked. Create a new version to make changes.",
  not_publishable: "Add at least one section with at least one item before publishing.",
  draft_exists: "A draft version already exists for this template. Finish or archive it first.",
  already_archived: "This version is already archived.",
  section_title: "Give the section a title.",
  item_invalid: "Please check the item details (choice items need at least 2 options).",
};

export default async function TemplateEditorPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ saved?: string; error?: string }>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const { ctx } = await requireOrgContext();
  const supabase = await createClient();

  // Pinned to the ACTIVE org — RLS admits every org the viewer belongs to, so a
  // by-id read alone renders another org's template here, and the editor
  // actions on this page then write against it.
  const { data: t } = await (
    supabase.from("asset_inspection_templates" as never) as unknown as {
      select: (c: string) => {
        eq: (k: string, v: unknown) => {
          eq: (k: string, v: unknown) => { maybeSingle: () => Promise<{ data: Row | null }> };
        };
      };
    }
  )
    .select("id, family_id, version, name, description, categories, check_level, status, definition, published_at, created_at")
    .eq("id", id)
    .eq("org_id", ctx.org.id)
    .maybeSingle();
  if (!t) notFound();

  // The version list walks family_id, which is NOT a primary key — without the
  // org predicate a shared/colliding family would blend versions across orgs.
  const { data: versionsRaw } = await (
    supabase.from("asset_inspection_templates" as never) as unknown as {
      select: (c: string) => {
        eq: (k: string, v: unknown) => {
          eq: (k: string, v: unknown) => {
            order: (c: string, o: { ascending: boolean }) => Promise<{ data: VersionRow[] | null }>;
          };
        };
      };
    }
  )
    .select("id, version, status, published_at")
    .eq("family_id", t.family_id)
    .eq("org_id", ctx.org.id)
    .order("version", { ascending: false });
  const versions = versionsRaw ?? [];

  const parsedDef = templateDefinitionSchema.safeParse(t.definition);
  const sections = parsedDef.success ? parsedDef.data.sections : [];
  const publishProblems = parsedDef.success ? validateForPublish(parsedDef.data) : ["Definition is invalid."];
  const editable = t.status === "draft";

  const savedMessage = sp.saved ? (SAVED_MAP[sp.saved] ?? null) : null;
  const errorMessage = sp.error ? (ERROR_MAP[sp.error] ?? null) : null;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <header>
        <Link href="/assets/templates" className="mb-1 inline-flex items-center gap-1 text-xs font-medium text-slate-500 transition hover:text-slate-900">
          ← Templates
        </Link>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-bold text-slate-900">{t.name}</h1>
          <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${STATUS_STYLES[t.status]}`}>
            {TEMPLATE_STATUS_LABELS[t.status]}
          </span>
          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600">v{t.version}</span>
        </div>
        <p className="mt-1 text-sm text-slate-600">
          {CHECK_LEVEL_LABELS[t.check_level]}
          {t.categories?.length ? ` · ${t.categories.join(", ")}` : " · All assets"}
        </p>
        {t.description ? <p className="mt-1 text-sm text-slate-500">{t.description}</p> : null}
      </header>

      {savedMessage ? (
        <div role="status" className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{savedMessage}</div>
      ) : null}
      {errorMessage ? (
        <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{errorMessage}</div>
      ) : null}

      {!editable ? (
        <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600">
          This version is <strong>locked</strong> — a checklist that inspections were recorded
          against can never be silently rewritten. To change it, create the next version;
          changes apply only to future inspections once published.
        </div>
      ) : null}

      {/* Lifecycle actions */}
      <div className="flex flex-wrap items-center gap-2">
        {editable ? (
          <StateForm action={publishTemplate}>
            <input type="hidden" name="template_id" value={t.id} />
            <button
              type="submit"
              className="rounded-md bg-emerald-700 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-800"
            >
              Publish v{t.version}
            </button>
          </StateForm>
        ) : null}
        {t.status === "published" || t.status === "superseded" ? (
          <StateForm action={createNextVersion}>
            <input type="hidden" name="template_id" value={t.id} />
            <button type="submit" className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800">
              Create new version
            </button>
          </StateForm>
        ) : null}
        <StateForm action={cloneTemplate}>
          <input type="hidden" name="template_id" value={t.id} />
          <button type="submit" className="rounded-md border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">
            Clone as new template
          </button>
        </StateForm>
        {t.status !== "archived" ? (
          <StateForm action={archiveTemplate}>
            <input type="hidden" name="template_id" value={t.id} />
            <button type="submit" className="rounded-md border border-red-300 px-4 py-2 text-sm font-medium text-red-700 hover:bg-red-50">
              Archive
            </button>
          </StateForm>
        ) : null}
      </div>

      {editable && publishProblems.length > 0 ? (
        <ul className="list-inside list-disc rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          {publishProblems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      ) : null}

      {/* The checklist */}
      {sections.map((s, sIdx) => (
        <section key={s.key} className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-base font-semibold text-slate-900">
              {sIdx + 1}. {s.title}
            </h2>
            {editable ? (
              <div className="flex items-center gap-1">
                <MoveButtons action={moveSection} hidden={{ template_id: t.id, section_key: s.key }} />
                <StateForm action={removeSection}>
                  <input type="hidden" name="template_id" value={t.id} />
                  <input type="hidden" name="section_key" value={s.key} />
                  <button type="submit" className="rounded-md border border-slate-300 px-2 py-1 text-xs text-slate-500 hover:bg-slate-50">
                    Remove
                  </button>
                </StateForm>
              </div>
            ) : null}
          </div>

          <ul className="mt-3 divide-y divide-slate-100">
            {s.items.map((i) => (
              <li key={i.key} className="flex flex-wrap items-center gap-x-2 gap-y-1 py-2 text-sm">
                <span className="text-slate-900">{i.prompt}</span>
                <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-600">
                  {RESPONSE_TYPE_LABELS[i.response_type]}
                </span>
                {i.safety_critical ? (
                  <span className="rounded-full bg-red-50 px-2 py-0.5 text-[11px] font-medium text-red-700">Blocks use on fail</span>
                ) : null}
                {!i.required ? (
                  <span className="rounded-full bg-slate-50 px-2 py-0.5 text-[11px] text-slate-500">Optional</span>
                ) : null}
                {i.allow_na ? (
                  <span className="rounded-full bg-slate-50 px-2 py-0.5 text-[11px] text-slate-500">N/A allowed</span>
                ) : null}
                {i.requires_photo ? (
                  <span className="rounded-full bg-blue-50 px-2 py-0.5 text-[11px] text-blue-700">Photo always</span>
                ) : null}
                {i.requires_photo_on_fail ? (
                  <span className="rounded-full bg-blue-50 px-2 py-0.5 text-[11px] text-blue-700">Photo on fail</span>
                ) : null}
                {i.requires_signature ? (
                  <span className="rounded-full bg-purple-50 px-2 py-0.5 text-[11px] text-purple-700">Signature</span>
                ) : null}
                <FailRule item={i} />
                {editable ? (
                  <span className="ml-auto flex items-center gap-1">
                    <MoveButtons action={moveItem} hidden={{ template_id: t.id, item_key: i.key }} />
                    <StateForm action={removeItem}>
                      <input type="hidden" name="template_id" value={t.id} />
                      <input type="hidden" name="item_key" value={i.key} />
                      <button type="submit" className="rounded-md border border-slate-300 px-2 py-0.5 text-[11px] text-slate-500 hover:bg-slate-50">
                        Remove
                      </button>
                    </StateForm>
                  </span>
                ) : null}
                {i.guidance ? (
                  <span className="w-full text-xs text-slate-500">{i.guidance}</span>
                ) : null}
              </li>
            ))}
            {s.items.length === 0 ? (
              <li className="py-2 text-sm text-slate-400">No items yet.</li>
            ) : null}
          </ul>

          {editable ? <AddItemForm templateId={t.id} sectionKey={s.key} /> : null}
        </section>
      ))}

      {editable ? (
        <StateForm action={addSection} className="flex items-end gap-2 rounded-xl border border-dashed border-slate-300 bg-white p-4">
          <input type="hidden" name="template_id" value={t.id} />
          <label className="flex-1 text-xs font-medium text-slate-600">
            New section
            <input
              name="title"
              required
              maxLength={120}
              placeholder="e.g. Walkaround (engine off)"
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900"
            />
          </label>
          <button type="submit" className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800">
            Add section
          </button>
        </StateForm>
      ) : null}

      {/* Version history */}
      <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="text-base font-semibold text-slate-900">Version history</h2>
        <ul className="mt-2 divide-y divide-slate-100 text-sm">
          {versions.map((v) => (
            <li key={v.id} className="flex items-center gap-2 py-2">
              <Link href={`/assets/templates/${v.id}`} className={`font-medium ${v.id === t.id ? "text-slate-400" : "text-slate-900 hover:underline"}`}>
                v{v.version}
                {v.id === t.id ? " (this page)" : ""}
              </Link>
              <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${STATUS_STYLES[v.status]}`}>
                {TEMPLATE_STATUS_LABELS[v.status]}
              </span>
              {v.published_at ? (
                <span className="text-xs text-slate-400">published {v.published_at.slice(0, 10)}</span>
              ) : null}
            </li>
          ))}
        </ul>
        <p className="mt-2 text-xs text-slate-500">
          Completed inspections keep the exact version they were recorded against, forever.
        </p>
      </section>
    </div>
  );
}

function MoveButtons({
  action,
  hidden,
}: {
  action: (prev: FormState, formData: FormData) => Promise<FormState>;
  hidden: Record<string, string>;
}) {
  return (
    <>
      {(["up", "down"] as const).map((dir) => (
        <StateForm key={dir} action={action}>
          {Object.entries(hidden).map(([k, v]) => (
            <input key={k} type="hidden" name={k} value={v} />
          ))}
          <input type="hidden" name="dir" value={dir} />
          <button
            type="submit"
            aria-label={`Move ${dir}`}
            className="rounded-md border border-slate-300 px-2 py-0.5 text-[11px] text-slate-500 hover:bg-slate-50"
          >
            {dir === "up" ? "↑" : "↓"}
          </button>
        </StateForm>
      ))}
    </>
  );
}

function FailRule({ item }: { item: TemplateItem }) {
  let rule: string | null = null;
  if (item.response_type === "yes_no") rule = `Fails on “${item.fail_on ?? "no"}”`;
  else if (item.response_type === "choice" && item.failing_choices?.length)
    rule = `Fails on: ${item.failing_choices.join(", ")}`;
  else if (
    (item.response_type === "number" || item.response_type === "meter_reading") &&
    (item.min != null || item.max != null)
  )
    rule = `Range ${item.min ?? "−∞"}–${item.max ?? "∞"}`;
  if (!rule) return null;
  return <span className="text-[11px] text-slate-400">{rule}</span>;
}

function AddItemForm({ templateId, sectionKey }: { templateId: string; sectionKey: string }) {
  return (
    <details className="mt-3 rounded-md border border-slate-200 bg-slate-50 p-3">
      <summary className="cursor-pointer text-xs font-semibold text-slate-700">+ Add item</summary>
      <StateForm action={addItem} className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <input type="hidden" name="template_id" value={templateId} />
        <input type="hidden" name="section_key" value={sectionKey} />
        <label className="text-xs font-medium text-slate-600 sm:col-span-2">
          Question / check
          <input name="prompt" required maxLength={300} className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm" />
        </label>
        <label className="text-xs font-medium text-slate-600 sm:col-span-2">
          Guidance (optional)
          <input name="guidance" maxLength={500} className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm" />
        </label>
        <label className="text-xs font-medium text-slate-600">
          Response type
          <select name="response_type" defaultValue="pass_fail" className="mt-1 w-full rounded-md border border-slate-300 px-2 py-2 text-sm">
            {RESPONSE_TYPES.map((r) => (
              <option key={r} value={r}>
                {RESPONSE_TYPE_LABELS[r]}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs font-medium text-slate-600">
          Severity if failed (non-critical)
          <select name="severity" defaultValue="minor" className="mt-1 w-full rounded-md border border-slate-300 px-2 py-2 text-sm">
            <option value="minor">Minor — rectify when practical</option>
            <option value="major">Major — rectify before next use</option>
          </select>
        </label>
        <label className="text-xs font-medium text-slate-600">
          Yes/no: fails on
          <select name="fail_on" defaultValue="" className="mt-1 w-full rounded-md border border-slate-300 px-2 py-2 text-sm">
            <option value="">— (not a yes/no item)</option>
            <option value="no">“No” is a failure</option>
            <option value="yes">“Yes” is a failure</option>
          </select>
        </label>
        <label className="text-xs font-medium text-slate-600">
          Choice options (comma-separated)
          <input name="choices" maxLength={600} placeholder="e.g. Manual pin, Semi-automatic, Fully automatic" className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm" />
        </label>
        <label className="text-xs font-medium text-slate-600">
          Failing choices (comma-separated)
          <input name="failing_choices" maxLength={600} className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm" />
        </label>
        <div className="grid grid-cols-2 gap-2">
          <label className="text-xs font-medium text-slate-600">
            Min (numeric)
            <input name="min" type="number" step="any" className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm" />
          </label>
          <label className="text-xs font-medium text-slate-600">
            Max (numeric)
            <input name="max" type="number" step="any" className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm" />
          </label>
        </div>
        <fieldset className="sm:col-span-2">
          <legend className="text-xs font-medium text-slate-600">Rules & evidence</legend>
          <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-700">
            <label className="flex items-center gap-1.5">
              <input type="checkbox" name="required" defaultChecked className="h-4 w-4 rounded border-slate-300" /> Required
            </label>
            <label className="flex items-center gap-1.5">
              <input type="checkbox" name="safety_critical" className="h-4 w-4 rounded border-slate-300" />
              <span className="font-medium text-red-700">Safety-critical (fail blocks the asset)</span>
            </label>
            <label className="flex items-center gap-1.5">
              <input type="checkbox" name="allow_na" className="h-4 w-4 rounded border-slate-300" /> Allow N/A
            </label>
            <label className="flex items-center gap-1.5">
              <input type="checkbox" name="requires_photo" className="h-4 w-4 rounded border-slate-300" /> Photo always
            </label>
            <label className="flex items-center gap-1.5">
              <input type="checkbox" name="requires_photo_on_fail" className="h-4 w-4 rounded border-slate-300" /> Photo on fail
            </label>
            <label className="flex items-center gap-1.5">
              <input type="checkbox" name="requires_comment_on_fail" defaultChecked className="h-4 w-4 rounded border-slate-300" /> Comment on fail
            </label>
            <label className="flex items-center gap-1.5">
              <input type="checkbox" name="requires_signature" className="h-4 w-4 rounded border-slate-300" /> Signature
            </label>
          </div>
        </fieldset>
        <div className="sm:col-span-2">
          <button type="submit" className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800">
            Add item
          </button>
        </div>
      </StateForm>
    </details>
  );
}
