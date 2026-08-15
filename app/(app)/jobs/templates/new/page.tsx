import Link from "next/link";
import { redirect } from "next/navigation";
import { requireOrgContext } from "@/server/auth/session";
import { createJobTemplate } from "../actions";
import { TemplateForm } from "../_template-form";

/**
 * Create-template page. Admin-only (the presentational gate; the RPC + RLS are
 * the real one). A member who reaches this URL is redirected to the list.
 */
export default async function NewJobTemplatePage() {
  const { ctx } = await requireOrgContext();
  const isAdmin =
    ctx.membership.role === "owner" || ctx.membership.role === "admin";
  if (!isAdmin) redirect("/jobs/templates");

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div className="flex items-center gap-2 text-sm text-slate-500">
        <Link href="/jobs/templates" className="hover:text-slate-900">
          Templates
        </Link>
        <span aria-hidden>/</span>
        <span className="text-slate-900">New</span>
      </div>

      <header>
        <h1 className="text-2xl font-bold text-slate-900">New job template</h1>
      </header>

      <TemplateForm action={createJobTemplate} submitLabel="Create template" />
    </div>
  );
}
