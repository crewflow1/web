"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { INITIAL_FORM_STATE, type FormState } from "@/lib/forms/state";
import { SCOPES, SCOPE_LABELS } from "@/lib/api-auth/scopes";
import { EXPOSABLE_WEBHOOK_EVENTS, WEBHOOK_EVENT_LABELS } from "@/lib/webhooks/events";
import { LISTING_CATEGORIES, CATEGORY_LABELS } from "@/lib/marketplace/registry";
import {
  createPartner,
  createListing,
  submitListing,
  type PartnerFormValues,
  type ListingFormValues,
} from "./actions";

/**
 * /settings/marketplace developer-console client forms (Phase 14).
 *
 * The scope + webhook-event pickers render from the SAME build-fact registries
 * the server actions + migrations validate against (lib/api-auth/scopes,
 * lib/webhooks/events), so the UI can never offer a scope/event the platform
 * would reject.
 */

function SubmitButton({ label, pendingLabel }: { label: string; pendingLabel: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="inline-flex items-center rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-slate-800 disabled:opacity-60"
    >
      {pending ? pendingLabel : label}
    </button>
  );
}

function Banner({ state }: { state: FormState<unknown> }) {
  if (state.error) {
    return (
      <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
        {state.error}
      </p>
    );
  }
  if (state.ok && state.successMessage) {
    return (
      <p className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
        {state.successMessage}
      </p>
    );
  }
  return null;
}

const inputCls =
  "mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-slate-500 focus:outline-none";

export function CreatePartnerForm() {
  const [state, action] = useActionState<FormState<PartnerFormValues>, FormData>(
    createPartner,
    INITIAL_FORM_STATE as FormState<PartnerFormValues>,
  );
  return (
    <form action={action} className="space-y-4">
      <Banner state={state} />
      <div>
        <label htmlFor="p-name" className="block text-sm font-medium text-slate-700">
          Developer name
        </label>
        <input id="p-name" name="name" type="text" required maxLength={120} className={inputCls}
          defaultValue={typeof state.values.name === "string" ? state.values.name : ""} />
        {state.fieldErrors.name ? <p className="mt-1 text-xs text-red-600">{state.fieldErrors.name}</p> : null}
      </div>
      <div>
        <label htmlFor="p-slug" className="block text-sm font-medium text-slate-700">
          Slug
        </label>
        <input id="p-slug" name="slug" type="text" required className={inputCls} placeholder="acme-integrations"
          defaultValue={typeof state.values.slug === "string" ? state.values.slug : ""} />
        {state.fieldErrors.slug ? <p className="mt-1 text-xs text-red-600">{state.fieldErrors.slug}</p> : null}
      </div>
      <div>
        <label htmlFor="p-email" className="block text-sm font-medium text-slate-700">
          Contact email <span className="text-slate-400">(optional)</span>
        </label>
        <input id="p-email" name="contact_email" type="email" maxLength={200} className={inputCls} />
      </div>
      <div>
        <label htmlFor="p-web" className="block text-sm font-medium text-slate-700">
          Website <span className="text-slate-400">(optional, https)</span>
        </label>
        <input id="p-web" name="website_url" type="url" maxLength={300} className={inputCls} placeholder="https://…" />
      </div>
      <SubmitButton label="Create developer profile" pendingLabel="Creating…" />
    </form>
  );
}

export function CreateListingForm({ partnerId }: { partnerId: string }) {
  const [state, action] = useActionState<FormState<ListingFormValues>, FormData>(
    createListing,
    INITIAL_FORM_STATE as FormState<ListingFormValues>,
  );
  return (
    <form action={action} className="space-y-4">
      <Banner state={state} />
      <input type="hidden" name="partner_id" value={partnerId} />
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="l-name" className="block text-sm font-medium text-slate-700">
            App name
          </label>
          <input id="l-name" name="name" type="text" required maxLength={120} className={inputCls}
            defaultValue={typeof state.values.name === "string" ? state.values.name : ""} />
          {state.fieldErrors.name ? <p className="mt-1 text-xs text-red-600">{state.fieldErrors.name}</p> : null}
        </div>
        <div>
          <label htmlFor="l-slug" className="block text-sm font-medium text-slate-700">
            Slug
          </label>
          <input id="l-slug" name="slug" type="text" required className={inputCls} placeholder="acme-sync"
            defaultValue={typeof state.values.slug === "string" ? state.values.slug : ""} />
          {state.fieldErrors.slug ? <p className="mt-1 text-xs text-red-600">{state.fieldErrors.slug}</p> : null}
        </div>
      </div>
      <div>
        <label htmlFor="l-short" className="block text-sm font-medium text-slate-700">
          Short description
        </label>
        <input id="l-short" name="short_description" type="text" required maxLength={200} className={inputCls}
          defaultValue={typeof state.values.short_description === "string" ? state.values.short_description : ""} />
        {state.fieldErrors.short_description ? (
          <p className="mt-1 text-xs text-red-600">{state.fieldErrors.short_description}</p>
        ) : null}
      </div>
      <div>
        <label htmlFor="l-desc" className="block text-sm font-medium text-slate-700">
          Full description <span className="text-slate-400">(optional)</span>
        </label>
        <textarea id="l-desc" name="description" rows={3} maxLength={4000} className={inputCls} />
      </div>
      <div>
        <label htmlFor="l-cat" className="block text-sm font-medium text-slate-700">
          Category
        </label>
        <select id="l-cat" name="category" defaultValue="other" className={`${inputCls} sm:w-72`}>
          {LISTING_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {CATEGORY_LABELS[c]}
            </option>
          ))}
        </select>
      </div>

      <fieldset>
        <legend className="text-sm font-medium text-slate-700">Requested scopes</legend>
        <p className="text-xs text-slate-500">
          Tenants must consent to exactly these when they install your app.
        </p>
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          {SCOPES.map((scope) => (
            <label key={scope} className="flex items-start gap-2 text-sm text-slate-700">
              <input type="checkbox" name="scopes" value={scope} className="mt-0.5 h-4 w-4 rounded border-slate-300" />
              <span>
                <span className="font-medium">{SCOPE_LABELS[scope]}</span>{" "}
                <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-[11px] text-slate-600">{scope}</code>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <div>
        <label htmlFor="l-webhook" className="block text-sm font-medium text-slate-700">
          Webhook URL <span className="text-slate-400">(optional, https)</span>
        </label>
        <input id="l-webhook" name="webhook_url" type="url" maxLength={300} className={inputCls} placeholder="https://…" />
      </div>
      <fieldset>
        <legend className="text-sm font-medium text-slate-700">Webhook events</legend>
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          {EXPOSABLE_WEBHOOK_EVENTS.map((ev) => (
            <label key={ev} className="flex items-start gap-2 text-sm text-slate-700">
              <input type="checkbox" name="events" value={ev} className="mt-0.5 h-4 w-4 rounded border-slate-300" />
              <span className="font-medium">{WEBHOOK_EVENT_LABELS[ev]}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <SubmitButton label="Create listing (draft)" pendingLabel="Creating…" />
    </form>
  );
}

export function SubmitListingButton({ listingId }: { listingId: string }) {
  const [state, action] = useActionState<FormState<Record<string, never>>, FormData>(
    submitListing,
    INITIAL_FORM_STATE as FormState<Record<string, never>>,
  );
  return (
    <form action={action} className="inline">
      <input type="hidden" name="listing_id" value={listingId} />
      <button
        type="submit"
        className="inline-flex items-center rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 transition hover:bg-slate-50"
      >
        Submit for review
      </button>
      {state.error ? <p className="mt-1 text-xs text-red-600">{state.error}</p> : null}
    </form>
  );
}
