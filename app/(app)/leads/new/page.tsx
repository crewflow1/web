import Link from "next/link";
import { requireOrgContext } from "@/server/auth/session";
import { createLead } from "../actions";
import { LeadForm } from "../_form";
import { listCustomersForLead, listStaffForLead } from "../_form-helpers";
import { FadeIn } from "@/components/ui";

export default async function NewLeadPage() {
  await requireOrgContext();

  const [customers, staff] = await Promise.all([
    listCustomersForLead(),
    listStaffForLead(),
  ]);

  return (
    <div className="mx-auto max-w-xl space-y-6">
      <div className="flex items-center gap-2 text-sm text-slate-500">
        <Link href="/leads" className="hover:text-slate-900">
          Leads
        </Link>
        <span aria-hidden>/</span>
        <span className="text-slate-900">New</span>
      </div>

      <header>
        <h1 className="text-2xl font-bold text-slate-900">New lead</h1>
        <p className="mt-1 text-sm text-slate-600">
          Capture the enquiry now; you can quote, schedule, and close from
          the pipeline.
        </p>
      </header>

      <FadeIn>
        <LeadForm
          action={createLead}
          submitLabel="Save lead"
          cancelHref="/leads"
          customers={customers}
          staff={staff}
        />
      </FadeIn>
    </div>
  );
}
