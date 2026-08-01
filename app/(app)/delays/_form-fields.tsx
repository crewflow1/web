import {
  DELAY_CATEGORIES,
  DELAY_CATEGORY_DESCRIPTIONS,
  DELAY_CATEGORY_LABELS,
} from "@/lib/eot/lifecycle";

/**
 * Shared field block for the create (new/page.tsx) and draft-edit
 * ([id]/page.tsx) forms — one owner for the inputs so the two forms cannot
 * drift. Server component; plain HTML inputs, no client JS.
 *
 * `working days lost` is a MANUAL claim by design: the label says so, and no
 * script pre-computes it from the dates — see 20261084's header for why
 * false precision is the enemy here.
 */

export const inputClass =
  "mt-1.5 block min-h-[44px] w-full rounded-md border border-slate-300 bg-white px-3 py-2.5 text-sm placeholder:text-slate-400 focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500";
export const labelClass = "block text-sm font-medium text-slate-800";
export const hintClass = "mt-1 text-xs text-slate-500";

export interface DelayFormDefaults {
  category?: string;
  startedOn?: string;
  endedOn?: string | null;
  workingDaysLost?: number | null;
  description?: string;
  diaryEntryId?: string | null;
  variationQuoteId?: string | null;
  weatherDistrict?: string | null;
}

export function DelayEventFields({
  defaults = {},
  diaryOptions,
  variationOptions,
}: {
  defaults?: DelayFormDefaults;
  /** Null = the pickers are unavailable (no job chosen yet), not empty. */
  diaryOptions: Array<{ id: string; label: string }> | null;
  variationOptions: Array<{ id: string; label: string }> | null;
}) {
  return (
    <>
      <div>
        <label htmlFor="category" className={labelClass}>
          Category<span className="ml-0.5 text-red-500">*</span>
        </label>
        <select
          id="category"
          name="category"
          required
          defaultValue={defaults.category ?? "weather"}
          className={inputClass}
        >
          {DELAY_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {DELAY_CATEGORY_LABELS[c]}
            </option>
          ))}
        </select>
        <p className={hintClass}>
          {DELAY_CATEGORIES.map((c) => `${DELAY_CATEGORY_LABELS[c]}: ${DELAY_CATEGORY_DESCRIPTIONS[c]}`).join(" ")}
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="startedOn" className={labelClass}>
            Started on<span className="ml-0.5 text-red-500">*</span>
          </label>
          <input
            id="startedOn"
            name="startedOn"
            type="date"
            required
            defaultValue={defaults.startedOn ?? ""}
            className={inputClass}
          />
        </div>
        <div>
          <label htmlFor="endedOn" className={labelClass}>
            Ended on
          </label>
          <input
            id="endedOn"
            name="endedOn"
            type="date"
            defaultValue={defaults.endedOn ?? ""}
            className={inputClass}
          />
          <p className={hintClass}>Leave blank while the delay is still ongoing.</p>
        </div>
      </div>

      <div>
        <label htmlFor="workingDaysLost" className={labelClass}>
          Working days lost (your claim)
        </label>
        <input
          id="workingDaysLost"
          name="workingDaysLost"
          type="number"
          min={0}
          step={1}
          inputMode="numeric"
          defaultValue={defaults.workingDaysLost ?? ""}
          className={inputClass}
        />
        <p className={hintClass}>
          Your assessment, not a calculation — the calendar span rarely equals working
          time lost. Leave blank to quantify it later.
        </p>
      </div>

      <div>
        <label htmlFor="description" className={labelClass}>
          What happened<span className="ml-0.5 text-red-500">*</span>
        </label>
        <textarea
          id="description"
          name="description"
          required
          rows={4}
          maxLength={4000}
          defaultValue={defaults.description ?? ""}
          placeholder="e.g. 40mph gusts from 07:00 — crane ops suspended, roofing crew stood down for the day"
          className={inputClass}
        />
      </div>

      <fieldset className="space-y-4 rounded-lg border border-slate-200 p-4">
        <legend className="px-1 text-sm font-semibold text-slate-800">Evidence links</legend>
        {diaryOptions !== null ? (
          <div>
            <label htmlFor="diaryEntryId" className={labelClass}>
              Site diary entry
            </label>
            <select
              id="diaryEntryId"
              name="diaryEntryId"
              defaultValue={defaults.diaryEntryId ?? ""}
              className={inputClass}
            >
              <option value="">— none linked yet —</option>
              {diaryOptions.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.label}
                </option>
              ))}
            </select>
            <p className={hintClass}>
              The contemporaneous page that proves this stoppage. Only this job&apos;s
              entries can be linked.
            </p>
          </div>
        ) : null}
        {variationOptions !== null ? (
          <div>
            <label htmlFor="variationQuoteId" className={labelClass}>
              Variation
            </label>
            <select
              id="variationQuoteId"
              name="variationQuoteId"
              defaultValue={defaults.variationQuoteId ?? ""}
              className={inputClass}
            >
              <option value="">— none linked yet —</option>
              {variationOptions.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.label}
                </option>
              ))}
            </select>
            <p className={hintClass}>
              The variation this delay relates to — ideally the one carrying the
              extension-of-time request.
            </p>
          </div>
        ) : null}
        <div>
          <label htmlFor="weatherDistrict" className={labelClass}>
            Postcode district (weather events)
          </label>
          <input
            id="weatherDistrict"
            name="weatherDistrict"
            type="text"
            maxLength={4}
            placeholder="e.g. LS1"
            defaultValue={defaults.weatherDistrict ?? ""}
            className={inputClass}
          />
          <p className={hintClass}>
            The site&apos;s outward postcode (the &quot;LS1&quot; in LS1 4AP). No weather
            provider is connected yet, so no readings can corroborate this today — the
            district is stored so the evidence attaches automatically when one is.
          </p>
        </div>
      </fieldset>
    </>
  );
}
