"use client";

import { useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";
import {
  INITIAL_FORM_STATE,
  isPristine,
  type FormState,
} from "@/lib/forms/state";
import {
  FormErrorBanner,
  FormSuccessBanner,
} from "@/components/forms/Field";

type RotaAction = (
  prevState: FormState<Record<string, unknown>>,
  formData: FormData,
) => Promise<FormState<Record<string, unknown>>>;

type Member = {
  user_id: string;
  user: { full_name: string | null; email: string } | null;
};

type JobOpt = {
  id: string;
  status: string | null;
  customer: { name: string } | null;
};

/**
 * Values a schedule recommendation can PRE-FILL. Every field is one the admin
 * could type by hand; nothing here grants authority, and the write still runs
 * the full `createRotaEntry` gate.
 */
export type RotaPrefill = {
  user_id?: string;
  starts_at?: string;
  ends_at?: string;
  job_id?: string;
};

/**
 * Assign-shift form. Drives `createRotaEntry` via React 19
 * useActionState so validation errors + conflict messages surface
 * inline and form input is preserved on failure.
 *
 * PRE-FILL, NEVER AUTO-SUBMIT. `prefill` seeds the fields when a manager
 * arrives from a schedule recommendation, and that is the whole of it: there is
 * no effect that submits, no `requestSubmit`, and the shift does not exist
 * until a human presses Assign. It applies only while the form is PRISTINE, so
 * a real submission's echoed values always win and a failed attempt is never
 * silently reverted to the suggestion.
 */
export function CreateRotaForm({
  action,
  members,
  jobs,
  prefill,
}: {
  action: RotaAction;
  members: Member[];
  jobs: JobOpt[];
  prefill?: RotaPrefill;
}) {
  const [state, formAction, pending] = useActionState(
    action,
    INITIAL_FORM_STATE as FormState<Record<string, unknown>>,
  );
  const router = useRouter();

  useEffect(() => {
    if (!state.ok) return;
    router.refresh();
  }, [state.ok, state.submittedAt, router]);

  const v = (state.values ?? {}) as Record<string, unknown>;
  const fe = state.fieldErrors ?? {};
  const seed = (isPristine(state) ? prefill : undefined) ?? {};
  const pick = (k: string): string => {
    const x = v[k];
    if (typeof x === "string") return x;
    const s = (seed as Record<string, unknown>)[k];
    return typeof s === "string" ? s : "";
  };

  return (
    <>
      <div className="space-y-2">
        <FormErrorBanner error={state.error} />
        <FormSuccessBanner message={state.ok ? state.successMessage : null} />
      </div>
      <form
        action={formAction}
        noValidate
        // The fields are uncontrolled, so `defaultValue` only lands on mount.
        // Keying by the seed remounts them when a manager clicks a SECOND
        // recommendation without leaving the page — otherwise the form would
        // still be showing the first one's person and times.
        key={`${seed.user_id ?? ""}|${seed.starts_at ?? ""}|${seed.ends_at ?? ""}|${seed.job_id ?? ""}`}
        className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-6 sm:items-end"
      >
        <label className="block text-xs text-slate-600 sm:col-span-2">
          Staff
          <select
            name="user_id"
            required
            defaultValue={pick("user_id")}
            aria-invalid={fe.user_id ? true : undefined}
            className={`mt-1 block w-full rounded-md border bg-white px-2 py-1.5 text-sm ${fe.user_id ? "border-red-400" : "border-slate-300"}`}
          >
            <option value="">—</option>
            {members.map((m) => (
              <option key={m.user_id} value={m.user_id}>
                {m.user?.full_name ?? m.user?.email}
              </option>
            ))}
          </select>
          {fe.user_id ? (
            <p role="alert" className="mt-1 text-[11px] text-red-700">
              {fe.user_id}
            </p>
          ) : null}
        </label>
        <label className="block text-xs text-slate-600">
          Start
          <input
            type="datetime-local"
            name="starts_at"
            required
            defaultValue={pick("starts_at")}
            aria-invalid={fe.starts_at ? true : undefined}
            className={`mt-1 block w-full rounded-md border px-2 py-1.5 text-sm ${fe.starts_at ? "border-red-400" : "border-slate-300"}`}
          />
          {fe.starts_at ? (
            <p role="alert" className="mt-1 text-[11px] text-red-700">
              {fe.starts_at}
            </p>
          ) : null}
        </label>
        <label className="block text-xs text-slate-600">
          End
          <input
            type="datetime-local"
            name="ends_at"
            required
            defaultValue={pick("ends_at")}
            aria-invalid={fe.ends_at ? true : undefined}
            className={`mt-1 block w-full rounded-md border px-2 py-1.5 text-sm ${fe.ends_at ? "border-red-400" : "border-slate-300"}`}
          />
          {fe.ends_at ? (
            <p role="alert" className="mt-1 text-[11px] text-red-700">
              {fe.ends_at}
            </p>
          ) : null}
        </label>
        <label className="block text-xs text-slate-600">
          Job (optional)
          <select
            name="job_id"
            defaultValue={pick("job_id")}
            className="mt-1 block w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm"
          >
            <option value="">—</option>
            {jobs.map((j) => (
              <option key={j.id} value={j.id}>
                {j.customer?.name ?? "Job"} · {j.status}
              </option>
            ))}
          </select>
        </label>
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-slate-900 px-3 py-2 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-60"
        >
          {pending ? "Assigning…" : "Assign"}
        </button>
        <textarea
          name="notes"
          rows={1}
          defaultValue={pick("notes")}
          placeholder="Optional notes (e.g. early start)"
          className="block w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm sm:col-span-6"
        />
      </form>
    </>
  );
}
