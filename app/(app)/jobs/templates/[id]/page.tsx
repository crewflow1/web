import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { readFailure } from "@/lib/supabase/read-failure";
import { requireOrgContext } from "@/server/auth/session";
import { ConfirmForm } from "@/components/forms/ConfirmForm";
import { updateJobTemplate, deleteJobTemplate } from "../actions";
import { TemplateForm, type TemplateDefaults } from "../_template-form";

/**
 * Edit-template page. Admin-only. Loads the template + its milestone/checklist
 * children (ACTIVE-org pinned — RLS admits every org the viewer belongs to, so
 * an unpinned by-id load could render another org's template inside this shell).
 * A row in a non-active org is indistinguishable from a missing one → notFound.
 */
export default async function EditJobTemplatePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { ctx } = await requireOrgContext();
  const isAdmin =
    ctx.membership.role === "owner" || ctx.membership.role === "admin";
  if (!isAdmin) redirect("/jobs/templates");

  const supabase = await createClient();
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const tbl = (c: unknown) => (c as { from: (t: string) => any }).from.bind(c);
  /* eslint-enable @typescript-eslint/no-explicit-any */

  const { data: header, error: headerError } = await tbl(supabase)("job_templates")
    .select("id, name, job_type, description, default_status")
    .eq("id", id)
    .eq("org_id", ctx.org.id)
    .maybeSingle();
  if (headerError) throw readFailure("job template: header", headerError);
  if (!header) notFound();

  const [msRes, clRes] = await Promise.all([
    tbl(supabase)("job_template_milestones")
      .select("title, offset_start_days, offset_end_days, weight, customer_visible, sort")
      .eq("org_id", ctx.org.id)
      .eq("template_id", id)
      .order("sort", { ascending: true }),
    tbl(supabase)("job_template_checklist_items")
      .select("label, requires_photo, sort")
      .eq("org_id", ctx.org.id)
      .eq("template_id", id)
      .order("sort", { ascending: true }),
  ]);
  if (msRes.error) throw readFailure("job template: milestones", msRes.error);
  if (clRes.error) throw readFailure("job template: checklist", clRes.error);

  const defaults: TemplateDefaults = {
    name: header.name ?? "",
    job_type: header.job_type ?? "",
    description: header.description ?? "",
    default_status: header.default_status ?? "",
    milestones: (msRes.data ?? []).map(
      (m: {
        title: string;
        offset_start_days: number | null;
        offset_end_days: number | null;
        weight: number | string | null;
        customer_visible: boolean;
      }) => ({
        title: m.title,
        offset_start_days: m.offset_start_days,
        offset_end_days: m.offset_end_days,
        weight: m.weight === null ? null : Number(m.weight),
        customer_visible: m.customer_visible,
      }),
    ),
    checklist: (clRes.data ?? []).map(
      (c: { label: string; requires_photo: boolean }) => ({
        label: c.label,
        requires_photo: c.requires_photo,
      }),
    ),
  };

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div className="flex items-center gap-2 text-sm text-slate-500">
        <Link href="/jobs/templates" className="hover:text-slate-900">
          Templates
        </Link>
        <span aria-hidden>/</span>
        <span className="text-slate-900">Edit</span>
      </div>

      <header>
        <h1 className="text-2xl font-bold text-slate-900">{header.name}</h1>
      </header>

      <TemplateForm
        action={updateJobTemplate.bind(null, id)}
        submitLabel="Save template"
        defaults={defaults}
      />

      <section className="rounded-xl border border-red-200 bg-red-50/50 p-4">
        <h2 className="text-sm font-semibold text-red-800">Delete template</h2>
        <p className="mt-1 text-xs text-red-700">
          Removes this template and its milestones/checklist. Jobs already
          created from it keep their own copy.
        </p>
        <ConfirmForm
          action={deleteJobTemplate.bind(null, id)}
          confirm="Delete this template? Jobs created from it are unaffected."
        >
          <button
            type="submit"
            className="mt-3 h-9 rounded-lg border border-red-300 bg-white px-4 text-sm font-medium text-red-700 hover:bg-red-50"
          >
            Delete template
          </button>
        </ConfirmForm>
      </section>
    </div>
  );
}
