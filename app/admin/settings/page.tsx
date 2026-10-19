import { requireHqPage } from "@/server/auth/hq";
import { getSettings } from "@/server/services/hq-settings";
import {
  SECTION_IDS,
  SECTION_LABEL,
  SECTION_BLURB,
  type SectionId,
  type HqSettings,
} from "@/lib/hq/settings";
import {
  getEmailReadiness,
  getSmsReadiness,
  getWhatsAppReadiness,
  type ProviderReadiness,
} from "@/lib/comms/readiness";
import { saveSection } from "./actions";

/**
 * /admin/settings — Phase 4, rebuilt by the settings-truth remediation
 * (2026-10-19).
 *
 * EVERY control on this page has a real consumer, named in its hint —
 * the truthfulness rule lives in lib/hq/settings.ts. Seven sections,
 * each a small <form> posting to saveSection.bind(null, sectionId);
 * the integrations section additionally renders a READ-ONLY provider
 * readiness panel derived from lib/comms/readiness.ts (build + env
 * facts), replacing the hand-flipped *_connected toggles that used to
 * counterfeit connection state.
 *
 * No client JS — every form is a server action POST. Mirrors the
 * pattern used by /admin/impersonation and /admin/notifications so
 * the operator surface stays consistent.
 *
 * Auth: HQ layout already gates non-superadmins with notFound().
 * The page double-checks for defence in depth.
 */

export const dynamic = "force-dynamic";

type SP = Promise<{
  section?: string;
  saved?: string;
  error?: string;
}>;

export default async function HqSettingsPage({
  searchParams,
}: {
  searchParams: SP;
}) {
  await requireHqPage();

  const sp = await searchParams;
  const settings = await getSettings();

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-bold text-slate-900">Settings</h1>
        <p className="text-sm text-slate-600">
          Platform configuration. Every change is logged to the
          activity audit (admin_activity_log) with a before/after diff.
        </p>
      </header>

      {sp.saved ? (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
          {sp.saved === "nothing"
            ? "No changes — values were already up to date."
            : `Saved ${sp.saved} field${Number(sp.saved) === 1 ? "" : "s"}.`}
        </div>
      ) : null}

      {sp.error ? (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900">
          {sp.error}
        </div>
      ) : null}

      <nav className="rounded-xl border border-slate-200 bg-white p-3 text-sm">
        <p className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
          Jump to
        </p>
        <ul className="flex flex-wrap gap-1">
          {SECTION_IDS.map((id) => (
            <li key={id}>
              <a
                href={`#${id}`}
                className="rounded-md px-2 py-1 text-slate-700 hover:bg-slate-100 hover:text-slate-900"
              >
                {SECTION_LABEL[id]}
              </a>
            </li>
          ))}
        </ul>
      </nav>

      <SectionGeneral settings={settings} />
      <SectionNotifications settings={settings} />
      <SectionAlerts settings={settings} />
      <SectionBilling settings={settings} />
      <SectionSupport settings={settings} />
      <SectionIntegrations settings={settings} />
      <SectionFeatureFlags />
    </div>
  );
}

// =====================================================================
// Section shell
// =====================================================================

function SectionShell({
  id,
  children,
}: {
  id: SectionId;
  children: React.ReactNode;
}) {
  return (
    <section
      id={id}
      className="scroll-mt-6 rounded-xl border border-slate-200 bg-white p-6 shadow-sm"
    >
      <header className="mb-4">
        <h2 className="text-lg font-semibold text-slate-900">
          {SECTION_LABEL[id]}
        </h2>
        <p className="mt-1 text-xs text-slate-500">
          {SECTION_BLURB[id]}
        </p>
      </header>
      <form action={saveSection.bind(null, id)} className="space-y-4">
        {children}
        <div className="flex items-center justify-end gap-2 border-t border-slate-100 pt-4">
          <button
            type="submit"
            className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-slate-800"
          >
            Save {SECTION_LABEL[id].toLowerCase()}
          </button>
        </div>
      </form>
    </section>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block text-sm">
      <span className="block font-medium text-slate-800">{label}</span>
      {hint ? (
        <span className="mt-0.5 block text-xs text-slate-500">{hint}</span>
      ) : null}
      <span className="mt-1.5 block">{children}</span>
    </label>
  );
}

const inputCls =
  "w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500";
const textareaCls = inputCls + " min-h-[80px] resize-y";

function Toggle({
  name,
  defaultChecked,
  label,
}: {
  name: string;
  defaultChecked: boolean;
  label: string;
}) {
  return (
    <label className="flex items-center gap-2 text-sm text-slate-800">
      <input
        type="checkbox"
        name={name}
        defaultChecked={defaultChecked}
        className="h-4 w-4 rounded border-slate-300 text-slate-900 focus:ring-slate-500"
      />
      <span>{label}</span>
    </label>
  );
}

// =====================================================================
// Section forms
// =====================================================================

function SectionGeneral({ settings }: { settings: HqSettings }) {
  const s = settings.general;
  return (
    <SectionShell id="general">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Timezone"
          hint="IANA name, e.g. Europe/London. Governs the quiet-hours window below."
        >
          <input
            type="text"
            name="timezone"
            defaultValue={s.timezone}
            className={inputCls}
          />
        </Field>
      </div>
    </SectionShell>
  );
}

function SectionNotifications({ settings }: { settings: HqSettings }) {
  const s = settings.notifications;
  return (
    <SectionShell id="notifications">
      <Field
        label="HQ email recipients"
        hint="Comma-separated. HQ notification emails (today: critical alert fires from the nightly alerts poll) go to these addresses. Empty = no HQ email."
      >
        <textarea
          name="hq_email_recipients"
          defaultValue={s.hq_email_recipients}
          className={textareaCls}
          placeholder="ops@crewflow.uk, support@crewflow.uk"
        />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Quiet hours start"
          hint="HH:MM (24h), in the timezone above. Non-urgent HQ email queued in this window is deferred until it ends."
        >
          <input
            type="text"
            name="quiet_hours_start"
            defaultValue={s.quiet_hours_start}
            className={inputCls}
          />
        </Field>
        <Field label="Quiet hours end" hint="HH:MM (24h). Equal start and end disables quiet hours.">
          <input
            type="text"
            name="quiet_hours_end"
            defaultValue={s.quiet_hours_end}
            className={inputCls}
          />
        </Field>
      </div>
      <Toggle
        name="send_during_quiet_hours_for_urgent"
        defaultChecked={s.send_during_quiet_hours_for_urgent}
        label="Still send urgent HQ email during quiet hours"
      />
    </SectionShell>
  );
}

function SectionAlerts({ settings }: { settings: HqSettings }) {
  const s = settings.alerts;
  return (
    <SectionShell id="alerts">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Critical CC email"
          hint="Optional — added as an extra recipient on every critical alert fire's email, alongside the HQ recipients above."
        >
          <input
            type="email"
            name="critical_cc_email"
            defaultValue={s.critical_cc_email}
            className={inputCls}
          />
        </Field>
      </div>
    </SectionShell>
  );
}

function SectionBilling({ settings }: { settings: HqSettings }) {
  const s = settings.billing;
  return (
    <SectionShell id="billing">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Default invoice due (days)"
          hint="Pre-fills the due date (today + N) on the /admin/billing Record-invoice form."
        >
          <input
            type="number"
            name="default_invoice_due_days"
            min={0}
            max={180}
            defaultValue={s.default_invoice_due_days}
            className={inputCls}
          />
        </Field>
      </div>
    </SectionShell>
  );
}

function SectionSupport({ settings }: { settings: HqSettings }) {
  const s = settings.support;
  return (
    <SectionShell id="support">
      <Field
        label="Default reply signature"
        hint="Pre-filled into the reply box on /admin/support tickets — visible and editable before every send. Empty = no prefill."
      >
        <textarea
          name="default_reply_signature"
          defaultValue={s.default_reply_signature}
          className={textareaCls}
        />
      </Field>
    </SectionShell>
  );
}

function SectionIntegrations({ settings }: { settings: HqSettings }) {
  const s = settings.integrations;
  // REAL readiness, computed per request from build + env facts — the
  // same probes /api/health serves. Read-only by construction: there is
  // nothing here a form could change (connection edits live in Vercel).
  const email = getEmailReadiness();
  const sms = getSmsReadiness();
  const whatsapp = getWhatsAppReadiness();
  const stripeConfigured =
    typeof process.env.STRIPE_SECRET_KEY === "string" &&
    process.env.STRIPE_SECRET_KEY.trim().length > 0;
  return (
    <SectionShell id="integrations">
      <div className="space-y-2">
        <ReadinessRow label="Email (Resend)" r={email} />
        <ReadinessRow label="SMS (Twilio)" r={sms} />
        <ReadinessRow label="WhatsApp (Meta)" r={whatsapp} />
        <div className="flex items-start justify-between gap-3 rounded-md border border-slate-200 bg-slate-50 px-3 py-2">
          <p className="text-xs font-medium text-slate-800">Stripe</p>
          <p className="text-xs text-slate-600">
            {stripeConfigured ? (
              <span className="font-semibold text-emerald-700">
                Credentials present
              </span>
            ) : (
              <>missing STRIPE_SECRET_KEY</>
            )}
          </p>
        </div>
      </div>
      <Field label="Notes" hint="Free-form operator record — shown here only.">
        <textarea
          name="notes"
          defaultValue={s.notes}
          className={textareaCls}
          placeholder="Free-form notes on the current integration state."
        />
      </Field>
    </SectionShell>
  );
}

function ReadinessRow({ label, r }: { label: string; r: ProviderReadiness }) {
  return (
    <div className="flex items-start justify-between gap-3 rounded-md border border-slate-200 bg-slate-50 px-3 py-2">
      <p className="text-xs font-medium text-slate-800">{label}</p>
      <p className="text-right text-xs text-slate-600">
        {r.outboundReady ? (
          <span className="font-semibold text-emerald-700">Ready to send</span>
        ) : (
          <>not ready — {r.blockers.join(", ")}</>
        )}
      </p>
    </div>
  );
}

function SectionFeatureFlags() {
  // Deliberately NO toggles: the switches that used to render here persisted
  // to JSONB and were read by nothing — a super-admin could "enable WhatsApp"
  // and believe it worked. Production flags are Vercel env vars; this panel
  // now states that truth instead of counterfeiting control.
  return (
    <SectionShell id="feature_flags">
      <p className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700">
        Production feature flags are <span className="font-semibold">Vercel environment variables</span>{" "}
        (<code className="font-mono">NEXT_PUBLIC_FEATURE_*</code> /{" "}
        <code className="font-mono">FEATURE_*</code>), changed via a deploy —
        never from this panel. The live activation state of every gated
        capability is documented in{" "}
        <code className="font-mono">docs/launch/PRODUCTION-ACTIVATION-MATRIX.md</code>.
      </p>
    </SectionShell>
  );
}
