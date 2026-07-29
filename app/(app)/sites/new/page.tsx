import Link from "next/link";
import { redirect } from "next/navigation";
import { requireOrgContext } from "@/server/auth/session";
import { SiteForm } from "../_form";
import { createSite } from "../actions";

export const dynamic = "force-dynamic";

export const metadata = { title: "Add site · CrewFlow" };

export default async function NewSitePage() {
  const { ctx } = await requireOrgContext();
  // Sites are reference data: `sites_insert` is `is_org_admin(org_id)`, so a
  // member reaching this URL would fill the form in and be refused by RLS on
  // submit. Send them back instead of wasting the typing.
  const isAdmin = ctx.membership.role === "owner" || ctx.membership.role === "admin";
  if (!isAdmin) redirect("/sites");

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div className="flex items-center gap-2 text-sm text-slate-500">
        <Link href="/sites" className="hover:text-slate-900">
          Sites
        </Link>
        <span aria-hidden>/</span>
        <span className="text-slate-900">New</span>
      </div>
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Add a site</h1>
        <p className="mt-1 text-sm text-slate-600">
          One of <span className="font-medium text-slate-800">your</span> places. A customer&rsquo;s
          job address isn&rsquo;t a site — that stays on the job.
        </p>
      </div>
      <SiteForm action={createSite} submitLabel="Save site" cancelHref="/sites" />
    </div>
  );
}
