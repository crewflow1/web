import { redirect } from "next/navigation";
import { createOrg } from "./actions";
import { requireUser } from "@/server/auth/session";

type SearchParams = Promise<{ error?: string }>;

export default async function CompanyPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  // Invited users (with invited_org_id in their auth metadata) go to the
  // join flow instead of the create-org flow.
  const user = await requireUser();
  const meta = (user.user_metadata ?? {}) as { invited_org_id?: string };
  if (meta.invited_org_id) {
    redirect("/onboarding/join");
  }

  const { error } = await searchParams;
  const errorMessage = error ? decodeURIComponent(error) : null;

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
        Step 1 of 3
      </p>
      <h1 className="mt-2 text-2xl font-bold text-slate-900">
        Tell us about your business
      </h1>
      <p className="mt-1.5 text-sm text-slate-600">
        Just a few details so we can set things up. You can change all of these later.
      </p>

      {errorMessage ? (
        <div
          role="alert"
          className="mt-5 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          {errorMessage}
        </div>
      ) : null}

      <form action={createOrg} className="mt-6 space-y-5">
        <Field
          name="name"
          label="Company / trading name"
          required
          autoComplete="organization"
          placeholder="e.g. Murphy Roofing"
        />
        <Field
          name="first_name"
          label="Your first name"
          required
          autoComplete="given-name"
          placeholder="John"
        />
        <Field
          name="phone"
          label="Mobile number"
          type="tel"
          inputMode="tel"
          required
          autoComplete="tel"
          placeholder="+44 7700 900123"
          help="Where we send urgent lead notifications."
        />
        <Field
          name="postcode"
          label="Business postcode"
          required
          autoComplete="postal-code"
          placeholder="BT15 1AA"
          help="Used for callback locality matching."
        />
        <Field
          name="vat_number"
          label="VAT number"
          optional
          placeholder="GB123456789"
          help="Optional — shows on quotes and invoices."
        />

        <button
          type="submit"
          className="w-full rounded-md bg-slate-900 px-4 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-slate-900 focus:ring-offset-2"
        >
          Continue →
        </button>
      </form>
    </div>
  );
}

function Field({
  name,
  label,
  type = "text",
  required = false,
  optional = false,
  placeholder,
  help,
  autoComplete,
  inputMode,
}: {
  name: string;
  label: string;
  type?: string;
  required?: boolean;
  optional?: boolean;
  placeholder?: string;
  help?: string;
  autoComplete?: string;
  inputMode?:
    | "tel"
    | "text"
    | "search"
    | "email"
    | "url"
    | "numeric"
    | "decimal";
}) {
  return (
    <div>
      <label
        htmlFor={name}
        className="flex items-baseline justify-between text-sm font-medium text-slate-800"
      >
        <span>
          {label}
          {required ? <span className="ml-0.5 text-red-500">*</span> : null}
        </span>
        {optional ? <span className="text-xs text-slate-400">Optional</span> : null}
      </label>
      <input
        id={name}
        name={name}
        type={type}
        required={required}
        placeholder={placeholder}
        autoComplete={autoComplete}
        inputMode={inputMode}
        className="mt-1.5 block w-full rounded-md border border-slate-300 px-3 py-2.5 text-sm placeholder:text-slate-400 focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
      />
      {help ? <p className="mt-1 text-xs text-slate-500">{help}</p> : null}
    </div>
  );
}
