"use client";

import { useActionState, useState } from "react";
import Link from "next/link";
import { FormShell, SubmitButton } from "@/components/forms/FormShell";
import { Field, TextareaField, SelectField } from "../../_components/field";
import {
  AI_RECEPTIONIST_VOICES,
  AI_RECEPTIONIST_TIMEZONES,
  ANSWERING_MODE_LABELS,
  TRADE_TYPES,
  WEEKDAY_LABELS,
} from "@/lib/ai-receptionist/schema";
import { ANSWERING_MODES, WEEKDAYS } from "@/lib/telephony/answering-policy";
import { INITIAL_FORM_STATE, type FormState } from "@/lib/forms/state";

/**
 * Customer-side AI Receptionist setup form.
 *
 * The "Enable" toggle is the gate: when off, every other field is dimmed but kept
 * visible so the user can preview what they'd fill in. Beyond the channel handles
 * it now exposes the SELF-SERVE structured answering policy (Twilio receptionist
 * PR 2/3): when the AI answers, business hours, staff-first routing, escalation,
 * recording + consent, and notifications.
 */

type Values = Record<string, unknown>;

type ActionFn = (
  prev: FormState<Values>,
  formData: FormData,
) => Promise<FormState<Values>>;

const VOICE_LABELS: Record<string, string> = {
  british_female_warm: "British female — warm",
  british_female_professional: "British female — professional",
  british_male_warm: "British male — warm",
  british_male_professional: "British male — professional",
  scottish_female: "Scottish female",
  scottish_male: "Scottish male",
  welsh_female: "Welsh female",
  welsh_male: "Welsh male",
  irish_female: "Irish female",
  irish_male: "Irish male",
};

const TRADE_LABELS: Record<string, string> = {
  general_builder: "General builder",
  plumber: "Plumber",
  electrician: "Electrician",
  roofer: "Roofer",
  carpenter: "Carpenter",
  plasterer: "Plasterer",
  painter_decorator: "Painter / decorator",
  landscaper: "Landscaper",
  tiler: "Tiler",
  kitchen_bathroom: "Kitchen / bathroom fitter",
  extensions_renovations: "Extensions / renovations",
  groundworks: "Groundworks",
  scaffolder: "Scaffolder",
  joiner: "Joiner",
  heating_engineer: "Heating engineer",
  other: "Other",
};

export type AiReceptionistDefaults = {
  enabled: boolean;
  business_phone: string;
  whatsapp_number: string;
  facebook_page: string;
  instagram_handle: string;
  preferred_voice: string;
  business_hours: string;
  trade_type: string;
  answering_mode: string;
  timezone: string;
  weekly_hours: Record<string, { open: string; close: string } | null> | null;
  closures: string;
  ring_timeout_seconds: number;
  staff_numbers: string;
  fallback_number: string;
  urgent_escalation_number: string;
  greeting: string;
  service_areas: string;
  recording_enabled: boolean;
  transcription_enabled: boolean;
  recording_consent_message: string;
  notify_email: boolean;
  notify_sms: boolean;
};

/** A labelled section wrapper so the long form stays scannable. */
function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-4 border-t border-slate-200 pt-5">
      <div>
        <h3 className="text-sm font-semibold text-slate-900">{title}</h3>
        {description ? <p className="mt-0.5 text-xs text-slate-600">{description}</p> : null}
      </div>
      {children}
    </section>
  );
}

/** A plain checkbox row (the field primitives have no checkbox variant). */
function CheckboxRow({
  name,
  label,
  help,
  defaultChecked,
}: {
  name: string;
  label: string;
  help?: string;
  defaultChecked?: boolean;
}) {
  return (
    <label className="flex items-start gap-3">
      <input
        type="checkbox"
        name={name}
        defaultChecked={defaultChecked}
        className="mt-0.5 h-5 w-5 rounded border-slate-300 text-slate-900 focus:ring-slate-500"
      />
      <span>
        <span className="block text-sm font-medium text-slate-900">{label}</span>
        {help ? <span className="mt-0.5 block text-xs text-slate-600">{help}</span> : null}
      </span>
    </label>
  );
}

/** The structured per-weekday opening-hours editor. */
function WeeklyHours({
  weekly,
  errors,
}: {
  weekly: Record<string, { open: string; close: string } | null> | null;
  errors: Record<string, string>;
}) {
  const [closedDays, setClosedDays] = useState<Record<string, boolean>>(() => {
    const init: Record<string, boolean> = {};
    for (const d of WEEKDAYS) {
      if (weekly) init[d] = weekly[d] == null;
      else init[d] = d === "sat" || d === "sun"; // sensible default: Mon–Fri open
    }
    return init;
  });

  return (
    <div className="space-y-2">
      {WEEKDAYS.map((day) => {
        const closed = closedDays[day];
        const stored = weekly?.[day] ?? null;
        const open = stored?.open ?? "09:00";
        const close = stored?.close ?? "17:00";
        const err = errors[`hours_${day}`];
        return (
          <div key={day} className="rounded-md border border-slate-200 p-3">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
              <span className="w-24 shrink-0 text-sm font-medium text-slate-800">
                {WEEKDAY_LABELS[day]}
              </span>
              <label className="flex items-center gap-2 text-sm text-slate-700">
                <input
                  type="checkbox"
                  name={`hours_${day}_closed`}
                  checked={closed}
                  onChange={(e) =>
                    setClosedDays((prev) => ({ ...prev, [day]: e.target.checked }))
                  }
                  className="h-4 w-4 rounded border-slate-300 text-slate-900 focus:ring-slate-500"
                />
                Closed
              </label>
              <div className={`flex items-center gap-2 ${closed ? "opacity-40" : ""}`}>
                <input
                  type="time"
                  name={`hours_${day}_open`}
                  defaultValue={open}
                  disabled={closed}
                  aria-label={`${WEEKDAY_LABELS[day]} opening time`}
                  className="rounded-md border border-slate-300 px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-slate-500"
                />
                <span className="text-slate-400">–</span>
                <input
                  type="time"
                  name={`hours_${day}_close`}
                  defaultValue={close}
                  disabled={closed}
                  aria-label={`${WEEKDAY_LABELS[day]} closing time`}
                  className="rounded-md border border-slate-300 px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-slate-500"
                />
              </div>
            </div>
            {err ? (
              <p role="alert" className="mt-1.5 text-xs text-red-700">
                {err}
              </p>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

export function AiReceptionistForm({
  action,
  isAdmin,
  defaults,
}: {
  action: ActionFn;
  isAdmin: boolean;
  defaults: AiReceptionistDefaults;
}) {
  const [state, formAction, pending] = useActionState<FormState<Values>, FormData>(
    action,
    INITIAL_FORM_STATE,
  );
  const [enabled, setEnabled] = useState<boolean>(defaults.enabled);
  const fe = state.fieldErrors ?? {};

  return (
    <FormShell
      state={state}
      action={formAction}
      className="space-y-5 rounded-xl border border-slate-200 bg-white p-6 shadow-sm"
    >
      <fieldset disabled={!isAdmin} className="space-y-5 disabled:opacity-60">
        <label className="flex items-start gap-3 rounded-md border border-slate-200 bg-slate-50 p-3">
          <input
            type="checkbox"
            name="enabled"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            className="mt-0.5 h-5 w-5 rounded border-slate-300 text-slate-900 focus:ring-slate-500"
          />
          <span>
            <span className="block text-sm font-medium text-slate-900">
              Enable AI Receptionist
            </span>
            <span className="mt-0.5 block text-xs text-slate-600">
              An AI receptionist answers your calls, captures every enquiry and
              creates a lead in CrewFlow. Set how and when it answers below. You
              can keep your existing number or get a dedicated CrewFlow number
              during setup.
            </span>
          </span>
        </label>

        <div className={enabled ? "space-y-4" : "space-y-4 opacity-60"}>
          <Field
            name="business_phone"
            label="Business phone number"
            type="tel"
            required={enabled}
            placeholder="+44 ..."
            defaultValue={defaults.business_phone}
            error={fe.business_phone}
            help="The number customers call. We&rsquo;ll set up call routing + AI answering on it."
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              name="whatsapp_number"
              label="WhatsApp number"
              type="tel"
              optional
              placeholder="+44 ..."
              defaultValue={defaults.whatsapp_number}
              error={fe.whatsapp_number}
              help="Often the same as the business phone."
            />
            <Field
              name="instagram_handle"
              label="Instagram account"
              optional
              placeholder="@yourcompany"
              defaultValue={defaults.instagram_handle}
              error={fe.instagram_handle}
            />
          </div>
          <Field
            name="facebook_page"
            label="Facebook page"
            optional
            placeholder="https://facebook.com/yourcompany"
            defaultValue={defaults.facebook_page}
            error={fe.facebook_page}
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <SelectField
              name="preferred_voice"
              label="Preferred UK voice"
              options={[
                { value: "", label: "— No preference —" },
                ...AI_RECEPTIONIST_VOICES.map((v) => ({
                  value: v,
                  label: VOICE_LABELS[v] ?? v,
                })),
              ]}
              defaultValue={defaults.preferred_voice}
              error={fe.preferred_voice}
            />
            <SelectField
              name="trade_type"
              label="Trade type"
              options={[
                { value: "", label: "— Pick a trade —" },
                ...TRADE_TYPES.map((t) => ({
                  value: t,
                  label: TRADE_LABELS[t] ?? t,
                })),
              ]}
              defaultValue={defaults.trade_type}
              error={fe.trade_type}
            />
          </div>

          {/* ── When should the AI answer? ───────────────────────────────── */}
          <Section
            title="When should the AI answer?"
            description="Ring your team first, and let the AI step in only when you want it to."
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <SelectField
                name="answering_mode"
                label="AI answers"
                options={ANSWERING_MODES.map((m) => ({ value: m, label: ANSWERING_MODE_LABELS[m] }))}
                defaultValue={defaults.answering_mode}
                error={fe.answering_mode}
              />
              <SelectField
                name="timezone"
                label="Timezone"
                options={AI_RECEPTIONIST_TIMEZONES.map((t) => ({ value: t, label: t }))}
                defaultValue={defaults.timezone}
                error={fe.timezone}
              />
            </div>
            <TextareaField
              name="staff_numbers"
              label="Your team's numbers (ring these first)"
              rows={3}
              optional
              placeholder={"+447700900123\n+447700900124"}
              defaultValue={defaults.staff_numbers}
              error={fe.staff_numbers}
              help="One number per line, in international format. All ring at once; the AI steps in if nobody answers."
            />
            <Field
              name="ring_timeout_seconds"
              label="Ring your team for (seconds) before the AI answers"
              type="number"
              defaultValue={String(defaults.ring_timeout_seconds)}
              error={fe.ring_timeout_seconds}
              help="Between 5 and 120 seconds."
            />
          </Section>

          {/* ── Business hours ───────────────────────────────────────────── */}
          <Section
            title="Business hours"
            description="Used to decide what counts as out-of-hours. Mark a day closed if you're not open."
          >
            <WeeklyHours weekly={defaults.weekly_hours} errors={fe} />
            <TextareaField
              name="closures"
              label="Holiday / closure dates"
              rows={2}
              optional
              placeholder={"2026-12-25\n2026-12-26"}
              defaultValue={defaults.closures}
              error={fe.closures}
              help="One date per line (YYYY-MM-DD). Treated as closed, e.g. bank holidays."
            />
          </Section>

          {/* ── Escalation ───────────────────────────────────────────────── */}
          <Section
            title="Escalation"
            description="Optional numbers for fallback and urgent calls."
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                name="fallback_number"
                label="Fallback number"
                type="tel"
                optional
                placeholder="+44 ..."
                defaultValue={defaults.fallback_number}
                error={fe.fallback_number}
                help="Dialled if your team can't be reached."
              />
              <Field
                name="urgent_escalation_number"
                label="Urgent transfer number"
                type="tel"
                optional
                placeholder="+44 ..."
                defaultValue={defaults.urgent_escalation_number}
                error={fe.urgent_escalation_number}
                help="Where the AI transfers an urgent caller to a human."
              />
            </div>
          </Section>

          {/* ── Greeting & context ───────────────────────────────────────── */}
          <Section title="Greeting & context">
            <TextareaField
              name="greeting"
              label="Custom greeting"
              rows={2}
              optional
              placeholder="Thanks for calling Ace Plumbing — how can I help?"
              defaultValue={defaults.greeting}
              error={fe.greeting}
              help="Leave blank to use a greeting with your business name."
            />
            <TextareaField
              name="service_areas"
              label="Service areas"
              rows={2}
              optional
              placeholder="Belfast, Lisburn, Newtownabbey and surrounding areas"
              defaultValue={defaults.service_areas}
              error={fe.service_areas}
              help="Helps the AI answer &ldquo;do you cover my area?&rdquo;."
            />
            <TextareaField
              name="business_hours"
              label="Extra notes for the AI"
              rows={2}
              optional
              placeholder="We don't do emergency callouts. Quotes are free."
              defaultValue={defaults.business_hours}
              error={fe.business_hours}
              help="Anything else the AI should know when talking to callers."
            />
          </Section>

          {/* ── Call recording ───────────────────────────────────────────── */}
          <Section
            title="Call recording"
            description="Off by default. UK guidance: tell callers before recording."
          >
            <CheckboxRow
              name="recording_enabled"
              label="Record AI-answered calls"
              help="Callers hear the consent message below before recording begins."
              defaultChecked={defaults.recording_enabled}
            />
            <CheckboxRow
              name="transcription_enabled"
              label="Transcribe recordings"
              defaultChecked={defaults.transcription_enabled}
            />
            <TextareaField
              name="recording_consent_message"
              label="Recording consent message"
              rows={2}
              optional
              placeholder="This call may be recorded for quality and training purposes."
              defaultValue={defaults.recording_consent_message}
              error={fe.recording_consent_message}
            />
          </Section>

          {/* ── Notifications ────────────────────────────────────────────── */}
          <Section title="Notifications" description="Where new enquiries and missed calls are sent (in addition to your CrewFlow inbox).">
            <CheckboxRow name="notify_email" label="Email me" defaultChecked={defaults.notify_email} />
            <CheckboxRow name="notify_sms" label="Text me" defaultChecked={defaults.notify_sms} />
          </Section>
        </div>

        {isAdmin ? (
          <div className="flex flex-wrap items-center gap-3 pt-2">
            <SubmitButton pending={pending}>
              {enabled ? "Save receptionist settings" : "Save"}
            </SubmitButton>
            <Link
              href="/settings"
              className="text-sm font-medium text-slate-600 hover:text-slate-900"
            >
              Back to Settings
            </Link>
          </div>
        ) : null}
      </fieldset>
    </FormShell>
  );
}
