import Link from "next/link";
import { Plus } from "lucide-react";
import { listSalesSources } from "@/server/services/hq-sales";
import { Banner } from "../../_components";
import { CompanyForm } from "../../_form";
import { createCompanyAction } from "../../actions";

/**
 * Sales AI — add a company to the master intelligence database (CEO
 * Directive 003). HQ operator only (layout gates it; the action
 * re-checks). On save the company is searchable immediately and a
 * `created` event is added to its timeline + the global activity feed.
 */

export const dynamic = "force-dynamic";

type SP = Promise<{ error?: string }>;

export default async function NewCompanyPage({
  searchParams,
}: {
  searchParams: SP;
}) {
  const sp = await searchParams;
  const sources = await listSalesSources(true);
  const errorMsg = sp.error ? decodeURIComponent(sp.error) : null;

  return (
    <div className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-950 text-slate-100 shadow-xl">
      <div className="space-y-5 p-5 sm:p-7">
        <p className="text-sm text-slate-500">
          <Link href="/admin/sales" className="hover:text-slate-300">
            Sales AI
          </Link>{" "}
          /{" "}
          <Link href="/admin/sales/companies" className="hover:text-slate-300">
            Companies
          </Link>{" "}
          / <span className="text-slate-300">New</span>
        </p>

        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-500/15 text-indigo-300 ring-1 ring-inset ring-indigo-400/30">
            <Plus className="h-5 w-5" strokeWidth={1.75} aria-hidden />
          </span>
          <div>
            <h1 className="text-lg font-bold tracking-tight text-white">
              New company
            </h1>
            <p className="text-xs text-slate-400">
              Capture a company. You can add contacts, research, and
              recommendations once it exists.
            </p>
          </div>
        </div>

        {errorMsg ? <Banner kind="error">{errorMsg}</Banner> : null}

        <CompanyForm
          action={createCompanyAction}
          sources={sources}
          submitLabel="Create company"
        />
      </div>
    </div>
  );
}
