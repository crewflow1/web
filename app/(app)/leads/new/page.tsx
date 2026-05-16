import Link from "next/link";
import { requireOrgContext } from "@/server/auth/session";
import { createLead } from "../actions";
import { Field, TextareaField, SelectField } from "../../_components/field";
import {
  LEAD_SOURCES,
  LEAD_URGENCIES,
} from "@/lib/leads/schema";
import {
  listCustomersForLead,
  listStaffForLead,
} from "../_form-helpers";

const ERROR_MAP: Record<string, string> = {
  create_failed: "Couldn't save the lead. Try again.",
};

type SP = Promise<{ error?: string }>;

export default async function NewLeadPage({ searchParams }: { searchParams: SP }) {
  await requireOrgContext();
  const sp = await searchParams;

  const [customers, staff] = await Promise.all([
    listCustomersForLead(),
    listStaffForLead(),
  ]);

  const errorMessage = sp.error
    ? ERROR_MAP[sp.error] ?? decodeURIComponent(sp.error)
    : null;

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

      {errorMessage ? (
        <div
          role="alert"
          className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          {errorMessage}
        </div>
      ) : null}

      <form
        action={createLead}
        className="space-y-5 rounded-xl border border-slate-200 bg-white p-6 shadow-sm"
      >
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <SelectField
            name="source"
            label="Source"
            required
            defaultValue="phone"
            options={LEAD_SOURCES.map((s) => ({ value: s, label: s }))}
          />
          <SelectField
            name="urgency"
            label="Urgency"
            defaultValue="normal"
            options={LEAD_URGENCIES.map((u) => ({ value: u, label: u }))}
          />
        </div>

        <Field
          name="service"
          label="Service / scope"
          optional
          placeholder="e.g. Storm damage repair"
        />

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <SelectField
            name="customer_id"
            label="Customer"
            options={[
              { value: "", label: "— None / new enquirer —" },
              ...customers.map((c) => ({ value: c.id, label: c.name })),
            ]}
          />
          <SelectField
            name="assigned_to"
            label="Assigned to"
            options={[
              { value: "", label: "— Unassigned —" },
              ...staff.map((s) => ({
                value: s.id,
                label: s.full_name ?? s.email,
              })),
            ]}
          />
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field
            name="postcode"
            label="Postcode"
            optional
            placeholder="BT15 1AA"
          />
          <Field
            name="estimated_value"
            label="Estimated value (£)"
            type="number"
            inputMode="decimal"
            optional
            placeholder="0.00"
          />
        </div>

        <TextareaField
          name="notes"
          label="Notes"
          optional
          rows={3}
          placeholder="Anything worth remembering."
        />

        <TextareaField
          name="ai_summary"
          label="AI / call summary"
          optional
          rows={3}
          placeholder="Auto-fills from the AI receptionist when wired up (Slice 6)."
        />

        <div className="flex items-center gap-3">
          <button
            type="submit"
            className="rounded-md bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-slate-800"
          >
            Save lead
          </button>
          <Link
            href="/leads"
            className="text-sm font-medium text-slate-600 hover:text-slate-900"
          >
            Cancel
          </Link>
        </div>
      </form>
    </div>
  );
}
