import Link from "next/link";
import { IconTile } from "@/components/ui";
import { notFound } from "next/navigation";
import { Pencil } from "lucide-react";
import { getCompany, listSalesSources } from "@/server/services/hq-sales";
import { Banner } from "../../../_components";
import { CompanyForm } from "../../../_form";
import { updateCompanyAction } from "../../../actions";

/**
 * Sales AI — edit a company (CEO Directive 003). Saving updates the
 * master record, writes an audit entry, and (if the status changed) adds
 * a status_change event to the timeline. HQ operator only.
 */

export const dynamic = "force-dynamic";

type Params = Promise<{ id: string }>;
type SP = Promise<{ error?: string }>;

export default async function EditCompanyPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: SP;
}) {
  const { id } = await params;
  const sp = await searchParams;

  const [company, sources] = await Promise.all([
    getCompany(id),
    listSalesSources(true),
  ]);
  if (!company) notFound();

  const errorMsg = sp.error ? decodeURIComponent(sp.error) : null;

  return (
    <div className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-950 text-slate-100 shadow-xl">
      <div className="space-y-5 p-5 sm:p-7">
        <p className="text-sm text-slate-500">
          <Link href="/admin/sales" className="transition-colors hover:text-slate-300">
            Sales AI
          </Link>{" "}
          /{" "}
          <Link href="/admin/sales/companies" className="transition-colors hover:text-slate-300">
            Companies
          </Link>{" "}
          /{" "}
          <Link
            href={`/admin/sales/companies/${company.id}`}
            className="transition-colors hover:text-slate-300"
          >
            {company.name}
          </Link>{" "}
          / <span className="text-slate-300">Edit</span>
        </p>

        <div className="flex items-center gap-3">
          <IconTile size="md">
            <Pencil className="h-5 w-5" strokeWidth={1.75} aria-hidden />
          </IconTile>
          <div>
            <h1 className="text-lg font-bold tracking-tight text-white">
              Edit company
            </h1>
            <p className="text-xs text-slate-400">{company.name}</p>
          </div>
        </div>

        {errorMsg ? <Banner kind="error">{errorMsg}</Banner> : null}

        <CompanyForm
          action={updateCompanyAction}
          sources={sources}
          initial={company}
          submitLabel="Save changes"
        />
      </div>
    </div>
  );
}
