"use client";

import { useState } from "react";

/**
 * Public enquiry form (client). Posts JSON to /api/public/lead and shows inline
 * success / field errors. Includes a hidden `website` honeypot (real users never
 * fill it) and a mandatory consent box. No tenant data, no secrets — the only
 * thing it knows is the company slug from the URL.
 */
export function PublicLeadForm({ slug, orgName }: { slug: string; orgName: string }) {
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setFormError(null);
    setFieldErrors({});
    const fd = new FormData(e.currentTarget);
    const payload = {
      orgSlug: slug,
      name: String(fd.get("name") ?? ""),
      email: String(fd.get("email") ?? ""),
      phone: String(fd.get("phone") ?? ""),
      service: String(fd.get("service") ?? ""),
      postcode: String(fd.get("postcode") ?? ""),
      message: String(fd.get("message") ?? ""),
      consent: fd.get("consent") === "on",
      website: String(fd.get("website") ?? ""), // honeypot
    };
    try {
      const res = await fetch("/api/public/lead", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        fieldErrors?: Record<string, string>;
      };
      if (res.ok && json.ok) {
        setDone(true);
        return;
      }
      if (json.fieldErrors) setFieldErrors(json.fieldErrors);
      setFormError(json.error ?? "Something went wrong. Please try again.");
    } catch {
      setFormError("We couldn't reach the server. Please check your connection and try again.");
    } finally {
      setSubmitting(false);
    }
  }

  if (done) {
    return (
      <div role="status" className="rounded-xl border border-green-200 bg-green-50 px-5 py-6 text-green-900">
        <p className="text-base font-semibold">Thank you — your enquiry has been sent.</p>
        <p className="mt-1 text-sm">{orgName} has received your details and will be in touch soon.</p>
      </div>
    );
  }

  const err = (k: string) =>
    fieldErrors[k] ? (
      <p className="mt-1 text-xs text-red-600" role="alert">
        {fieldErrors[k]}
      </p>
    ) : null;

  const field = "mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none";

  return (
    <form onSubmit={onSubmit} className="space-y-4 rounded-xl border border-slate-200 bg-white p-5 shadow-sm" noValidate>
      {formError ? (
        <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          {formError}
        </div>
      ) : null}

      <div>
        <label htmlFor="name" className="text-sm font-medium text-slate-800">Your name <span className="text-red-500">*</span></label>
        <input id="name" name="name" type="text" autoComplete="name" required className={field} placeholder="e.g. Alex Smith" />
        {err("name")}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="email" className="text-sm font-medium text-slate-800">Email</label>
          <input id="email" name="email" type="email" autoComplete="email" className={field} placeholder="you@example.com" />
          {err("email")}
        </div>
        <div>
          <label htmlFor="phone" className="text-sm font-medium text-slate-800">Phone</label>
          <input id="phone" name="phone" type="tel" autoComplete="tel" className={field} placeholder="07700 900000" />
          {err("phone")}
        </div>
      </div>
      <p className="-mt-2 text-xs text-slate-500">Give us at least one way to reply — email or phone.</p>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="service" className="text-sm font-medium text-slate-800">What do you need?</label>
          <input id="service" name="service" type="text" className={field} placeholder="e.g. Roof repair, extension" />
          {err("service")}
        </div>
        <div>
          <label htmlFor="postcode" className="text-sm font-medium text-slate-800">Postcode</label>
          <input id="postcode" name="postcode" type="text" autoComplete="postal-code" className={field} placeholder="e.g. SW1A 1AA" />
          {err("postcode")}
        </div>
      </div>

      <div>
        <label htmlFor="message" className="text-sm font-medium text-slate-800">Details <span className="text-red-500">*</span></label>
        <textarea id="message" name="message" required rows={4} className={field} placeholder="Tell us about the job — what, where, and any timing." />
        {err("message")}
      </div>

      {/* Honeypot — visually hidden, off the tab order; bots fill it, humans don't. */}
      <div aria-hidden="true" className="absolute left-[-9999px] h-0 w-0 overflow-hidden">
        <label htmlFor="website">Leave this field empty</label>
        <input id="website" name="website" type="text" tabIndex={-1} autoComplete="off" />
      </div>

      <label className="flex items-start gap-2 text-sm text-slate-700">
        <input type="checkbox" name="consent" className="mt-0.5" required />
        <span>
          I agree that {orgName} can contact me about this enquiry. <span className="text-red-500">*</span>
        </span>
      </label>
      {err("consent")}

      <button
        type="submit"
        disabled={submitting}
        className="w-full rounded-md bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-60"
      >
        {submitting ? "Sending…" : "Send enquiry"}
      </button>
    </form>
  );
}
