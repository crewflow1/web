"use client";

import { useActionState, useState } from "react";
import Link from "next/link";
import { FormShell, SubmitButton } from "@/components/forms/FormShell";
import { Field, TextareaField, SelectField } from "../../_components/field";
import {
  AI_RECEPTIONIST_VOICES,
  TRADE_TYPES,
} from "@/lib/ai-receptionist/schema";
import { INITIAL_FORM_STATE, type FormState } from "@/lib/forms/state";

/**
 * Customer-side AI Receptionist setup form.
 *
 * The "Enable" toggle is the gate: when off, every other field is
 * dimmed but kept visible so the user can preview what they'd fill in.
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

export function AiReceptionistForm({
  action,
  isAdmin,
  defaults,
}: {
  action: ActionFn;
  isAdmin: boolean;
  defaults: {
    enabled: boolean;
    business_phone: string;
    whatsapp_number: string;
    facebook_page: string;
    instagram_handle: string;
    preferred_voice: string;
    business_hours: string;
    trade_type: string;
  };
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
              Our team will configure your phone, WhatsApp, Facebook and
              Instagram so an AI receptionist captures every enquiry and
              creates a lead in CrewFlow. Setup is white-glove —
              you&rsquo;ll see &ldquo;Pending&rdquo; here until we&rsquo;ve
              tested every channel and switched it to &ldquo;Live&rdquo;.
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
          <TextareaField
            name="business_hours"
            label="Business hours"
            rows={3}
            optional
            placeholder={"Mon-Fri 08:00 – 17:00\nSat 09:00 – 13:00\nClosed Sundays"}
            defaultValue={defaults.business_hours}
            error={fe.business_hours}
            help="Outside hours the AI will offer to take a message + log a lead."
          />
        </div>

        {isAdmin ? (
          <div className="flex flex-wrap items-center gap-3 pt-2">
            <SubmitButton pending={pending}>
              {enabled ? "Save + request setup" : "Save"}
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
