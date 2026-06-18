import { requireUser } from "@/server/auth/session";
import { isSuperAdminEmail } from "@/server/auth/superadmin";
import { notFound } from "next/navigation";
import { getSettings } from "@/server/services/hq-settings";
import {
  SECTION_IDS,
  SECTION_LABEL,
  SECTION_BLURB,
  type SectionId,
  type HqSettings,
} from "@/lib/hq/settings";
import { saveSection } from "./actions";
import {
  Alert,
  Button,
  GlowHeader,
  Input,
  Surface,
  Textarea,
} from "@/components/ui";

/**
 * /admin/settings — Phase 4.
 *
 * Real settings page replacing the HQ-6 stub. Eight sections, each
 * is a small <form> posting to saveSection.bind(null, sectionId).
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
  const user = await requireUser();
  if (!isSuperAdminEmail(user.email)) notFound();

  const sp = await searchParams;
  const settings = await getSettings();

  return (
    <Surface>
      <GlowHeader
        eyebrow="CrewFlow HQ"
        title="Settings"
        subtitle={
          <>
            Platform configuration. Every change is logged to the activity audit
            (
            <code className="rounded bg-slate-800/80 px-1 font-mono text-[0.9em] text-slate-300 ring-1 ring-inset ring-slate-700">
              admin_activity_log
            </code>
            ) with a before/after diff.
          </>
        }
      />

      <div className="space-y-6 p-5 sm:p-7">
        {sp.saved ? (
          <Alert tone="success">
            {sp.saved === "nothing"
              ? "No changes — values were already up to date."
              : `Saved ${sp.saved} field${Number(sp.saved) === 1 ? "" : "s"}.`}
          </Alert>
        ) : null}

        {sp.error ? <Alert tone="danger">{sp.error}</Alert> : null}

        <nav className="rounded-2xl border border-slate-800 bg-slate-900/40 p-3 text-sm">
          <p className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
            Jump to
          </p>
          <ul className="flex flex-wrap gap-1">
            {SECTION_IDS.map((id) => (
              <li key={id}>
                <a
                  href={`#${id}`}
                  className="rounded-md px-2 py-1 text-slate-300 hover:bg-slate-800/70 hover:text-white"
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
        <SectionBranding settings={settings} />
        <SectionSupport settings={settings} />
        <SectionIntegrations settings={settings} />
        <SectionFeatureFlags settings={settings} />
      </div>
    </Surface>
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
      className="scroll-mt-6 rounded-2xl border border-slate-800 bg-slate-900/40 p-6"
    >
      <header className="mb-4">
        <h2 className="text-lg font-semibold text-white">
          {SECTION_LABEL[id]}
        </h2>
        <p className="mt-1 text-xs text-slate-500">
          {SECTION_BLURB[id]}
        </p>
      </header>
      <form action={saveSection.bind(null, id)} className="space-y-4">
        {children}
        <div className="flex items-center justify-end gap-2 border-t border-slate-800 pt-4">
          <Button type="submit" variant="accent">
            Save {SECTION_LABEL[id].toLowerCase()}
          </Button>
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
      <span className="block font-medium text-slate-300">{label}</span>
      {hint ? (
        <span className="mt-0.5 block text-xs text-slate-500">{hint}</span>
      ) : null}
      <span className="mt-1.5 block">{children}</span>
    </label>
  );
}

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
    <label className="flex items-center gap-2 text-sm text-slate-300">
      <input
        type="checkbox"
        name={name}
        defaultChecked={defaultChecked}
        className="h-4 w-4 rounded border-slate-700 bg-slate-900/80 text-indigo-500 focus:ring-indigo-500/30"
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
        <Field label="Platform name" hint="Shown in HQ headers and emails.">
          <Input
            type="text"
            name="platform_name"
            defaultValue={s.platform_name}
          />
        </Field>
        <Field label="Support email" hint="Customer support inbox.">
          <Input
            type="email"
            name="support_email"
            defaultValue={s.support_email}
          />
        </Field>
        <Field label="Ops Slack URL" hint="Optional — leave blank to disable.">
          <Input
            type="url"
            name="ops_slack_url"
            defaultValue={s.ops_slack_url}
            placeholder="https://hooks.slack.com/..."
          />
        </Field>
        <Field label="Timezone" hint="IANA name, e.g. Europe/London.">
          <Input
            type="text"
            name="timezone"
            defaultValue={s.timezone}
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
        hint="Comma-separated. Every HQ notification email goes to these addresses."
      >
        <Textarea
          name="hq_email_recipients"
          defaultValue={s.hq_email_recipients}
          className="min-h-[80px]"
          placeholder="ops@crewflow.uk, support@crewflow.uk"
        />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Quiet hours start" hint="HH:MM (24h)">
          <Input
            type="text"
            name="quiet_hours_start"
            defaultValue={s.quiet_hours_start}
          />
        </Field>
        <Field label="Quiet hours end" hint="HH:MM (24h)">
          <Input
            type="text"
            name="quiet_hours_end"
            defaultValue={s.quiet_hours_end}
          />
        </Field>
      </div>
      <div className="space-y-2">
        <Toggle
          name="send_during_quiet_hours_for_urgent"
          defaultChecked={s.send_during_quiet_hours_for_urgent}
          label="Still send urgent alerts during quiet hours"
        />
        <Toggle
          name="daily_digest_enabled"
          defaultChecked={s.daily_digest_enabled}
          label="Send a 09:00 digest of the last 24h"
        />
      </div>
    </SectionShell>
  );
}

function SectionAlerts({ settings }: { settings: HqSettings }) {
  const s = settings.alerts;
  return (
    <SectionShell id="alerts">
      <div className="grid gap-4 sm:grid-cols-3">
        <Field
          label="Cooldown (hours)"
          hint="Minimum gap between re-firing the same alert after resolution."
        >
          <Input
            type="number"
            name="cooldown_hours"
            min={0}
            max={168}
            defaultValue={s.cooldown_hours}
          />
        </Field>
        <Field
          label="Default snooze (hours)"
          hint="Used by the snooze button on /admin/alerts."
        >
          <Input
            type="number"
            name="default_snooze_hours"
            min={1}
            max={168}
            defaultValue={s.default_snooze_hours}
          />
        </Field>
        <Field
          label="Critical CC email"
          hint="Optional — CC'd on every critical-severity alert."
        >
          <Input
            type="email"
            name="critical_cc_email"
            defaultValue={s.critical_cc_email}
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
          hint="Net N applied to new invoices."
        >
          <Input
            type="number"
            name="default_invoice_due_days"
            min={0}
            max={180}
            defaultValue={s.default_invoice_due_days}
          />
        </Field>
        <Field
          label="Default setup fee (GBP)"
          hint="Pre-fills the one-time setup fee for new customers."
        >
          <Input
            type="number"
            name="default_setup_fee_gbp"
            min={0}
            max={100000}
            step={1}
            defaultValue={s.default_setup_fee_gbp}
          />
        </Field>
      </div>
      <Field label="Default invoice footer">
        <Textarea
          name="default_invoice_footer"
          defaultValue={s.default_invoice_footer}
          className="min-h-[80px]"
        />
      </Field>
    </SectionShell>
  );
}

function SectionBranding({ settings }: { settings: HqSettings }) {
  const s = settings.branding;
  return (
    <SectionShell id="branding">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Logo URL" hint="Public URL — used on PDFs and public quote pages.">
          <Input
            type="url"
            name="logo_url"
            defaultValue={s.logo_url}
            placeholder="https://crewflow.uk/logo.png"
          />
        </Field>
        <Field label="Primary brand colour" hint="Hex, e.g. #0f172a">
          <Input
            type="text"
            name="primary_color"
            defaultValue={s.primary_color}
          />
        </Field>
      </div>
      <Field label="PDF footer" hint="Optional small print under invoices and quotes.">
        <Textarea
          name="pdf_footer"
          defaultValue={s.pdf_footer}
          className="min-h-[80px]"
        />
      </Field>
    </SectionShell>
  );
}

function SectionSupport({ settings }: { settings: HqSettings }) {
  const s = settings.support;
  return (
    <SectionShell id="support">
      <Field label="Default reply signature">
        <Textarea
          name="default_reply_signature"
          defaultValue={s.default_reply_signature}
          className="min-h-[80px]"
        />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Auto-close (days)"
          hint="Resolved tickets auto-close after N days. 0 disables."
        >
          <Input
            type="number"
            name="auto_close_days"
            min={0}
            max={180}
            defaultValue={s.auto_close_days}
          />
        </Field>
        <Field
          label="Escalation email"
          hint="Operator escalation contact. Optional."
        >
          <Input
            type="email"
            name="escalation_email"
            defaultValue={s.escalation_email}
          />
        </Field>
      </div>
    </SectionShell>
  );
}

function SectionIntegrations({ settings }: { settings: HqSettings }) {
  const s = settings.integrations;
  return (
    <SectionShell id="integrations">
      <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
        These toggles record what HQ has wired up. The actual API
        credentials live in Vercel env vars — flipping a toggle here
        does NOT connect or disconnect the provider.
      </p>
      <div className="space-y-2">
        <Toggle
          name="stripe_connected"
          defaultChecked={s.stripe_connected}
          label="Stripe connected"
        />
        <Toggle
          name="resend_connected"
          defaultChecked={s.resend_connected}
          label="Resend connected"
        />
        <Toggle
          name="whatsapp_connected"
          defaultChecked={s.whatsapp_connected}
          label="WhatsApp connected"
        />
      </div>
      <Field label="Notes">
        <Textarea
          name="notes"
          defaultValue={s.notes}
          className="min-h-[80px]"
          placeholder="Free-form notes on the current integration state."
        />
      </Field>
    </SectionShell>
  );
}

function SectionFeatureFlags({ settings }: { settings: HqSettings }) {
  const s = settings.feature_flags;
  return (
    <SectionShell id="feature_flags">
      <p className="rounded-md border border-slate-800 bg-slate-900/60 px-3 py-2 text-xs text-slate-300">
        Operator-only flags. Customer plan / role flags live elsewhere.
      </p>
      <div className="space-y-2">
        <Toggle
          name="enable_ai_coo"
          defaultChecked={s.enable_ai_coo}
          label="Enable AI COO ranker on /admin/alerts"
        />
        <Toggle
          name="enable_whatsapp_outbound"
          defaultChecked={s.enable_whatsapp_outbound}
          label="Enable outbound WhatsApp from HQ"
        />
        <Toggle
          name="enable_self_service_billing"
          defaultChecked={s.enable_self_service_billing}
          label="Enable customer self-service billing in /billing"
        />
      </div>
    </SectionShell>
  );
}
