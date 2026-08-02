import Link from "next/link";
import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireHqPage } from "@/server/auth/hq";
import {
  AI_RECEPTIONIST_STATUSES,
  AI_RECEPTIONIST_STATUS_LABELS,
  AI_RECEPTIONIST_STATUS_STYLES,
  TEST_CHECKLIST_ITEMS,
  type AiReceptionistStatus,
  type TestChecklistKey,
} from "@/lib/ai-receptionist/schema";
import {
  markAiReceptionistConfigured,
  setAiReceptionistStatus,
  toggleAiReceptionistChecklist,
  updateAiReceptionistNotes,
} from "../actions";
import { VoicePanel } from "../_components/voice-panel";

type Row = {
  id: string;
  org_id: string;
  enabled: boolean;
  business_phone: string | null;
  whatsapp_number: string | null;
  facebook_page: string | null;
  instagram_handle: string | null;
  preferred_voice: string | null;
  business_hours: string | null;
  trade_type: string | null;
  status: string;
  test_call_at: string | null;
  test_sms_at: string | null;
  test_whatsapp_at: string | null;
  test_meta_at: string | null;
  test_voice_at: string | null;
  test_lead_at: string | null;
  configured_at: string | null;
  configured_by: string | null;
  hq_notes: string | null;
  created_at: string;
  updated_at: string;
  org: {
    id: string;
    name: string;
    slug: string;
    status: string;
    phone: string | null;
    email: string | null;
  } | null;
};

const SAVED_MAP: Record<string, string> = {
  status: "Status updated.",
  checklist: "Checklist updated.",
  notes: "Notes saved.",
  configured: "Marked as Live — customer can see the green badge.",
};
const ERROR_MAP: Record<string, string> = {
  invalid_input: "Invalid input — try again.",
  update_failed: "Couldn't update. Try again.",
};

type SP = Promise<{ saved?: string; error?: string }>;

export default async function HqAiReceptionistDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: SP;
}) {
  await requireHqPage();

  const { id } = await params;
  const sp = await searchParams;
  const supabase = createAdminClient();

  const result = await supabase
    .from("ai_receptionist_setups" as never)
    .select(
      `
        id, org_id, enabled, business_phone, whatsapp_number, facebook_page,
        instagram_handle, preferred_voice, business_hours, trade_type,
        status, test_call_at, test_sms_at, test_whatsapp_at, test_meta_at,
        test_voice_at, test_lead_at, configured_at, configured_by, hq_notes,
        created_at, updated_at,
        org:organizations ( id, name, slug, status, phone, email )
      `,
    )
    .eq("id" as never, id)
    .maybeSingle();

  const row = ((result as { data?: Row | null }).data ?? null) as Row | null;
  if (!row) notFound();

  const status = row.status as AiReceptionistStatus;
  const ticks = TEST_CHECKLIST_ITEMS.filter((item) => row[item.key] != null).length;

  const savedMessage = sp.saved ? SAVED_MAP[sp.saved] ?? null : null;
  const errorMessage = sp.error ? ERROR_MAP[sp.error] ?? sp.error : null;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2 text-sm text-slate-500">
        <Link href="/admin/ai-receptionist" className="hover:text-slate-900">
          AI Receptionist setups
        </Link>
        <span aria-hidden>/</span>
        <span className="text-slate-900">{row.org?.name ?? "Unknown"}</span>
      </div>

      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">
            {row.org?.name ?? "Unknown org"}
          </h1>
          <p className="mt-1 text-sm text-slate-600">
            Slug: <code className="rounded bg-slate-100 px-1">{row.org?.slug}</code>
            {row.org?.email ? ` · ${row.org.email}` : ""}
          </p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <span
            className={`inline-flex rounded-full px-3 py-1 text-xs font-medium ${
              AI_RECEPTIONIST_STATUS_STYLES[status] ?? "bg-slate-100 text-slate-700"
            }`}
          >
            {AI_RECEPTIONIST_STATUS_LABELS[status] ?? status}
          </span>
          <p className="text-[11px] text-slate-500">
            Checklist {ticks}/{TEST_CHECKLIST_ITEMS.length}
          </p>
          {!row.enabled ? (
            <p className="text-[11px] text-amber-700">
              Customer toggle is OFF
            </p>
          ) : null}
        </div>
      </header>

      {savedMessage ? (
        <div
          role="status"
          className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800"
        >
          {savedMessage}
        </div>
      ) : null}
      {errorMessage ? (
        <div
          role="alert"
          className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          {errorMessage}
        </div>
      ) : null}

      {/* Customer-provided data */}
      <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-base font-semibold text-slate-900">
          Customer-provided details
        </h2>
        <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
          <Detail label="Business phone" value={row.business_phone} />
          <Detail label="WhatsApp" value={row.whatsapp_number} />
          <Detail label="Facebook page" value={row.facebook_page} />
          <Detail label="Instagram" value={row.instagram_handle} />
          <Detail label="Preferred voice" value={row.preferred_voice} />
          <Detail label="Trade type" value={row.trade_type} />
          {/* className on Detail itself: a wrapper div would nest div-in-div
              inside the <dl>, which fails axe's only-dlitems check. */}
          <Detail label="Business hours" value={row.business_hours} multiline className="sm:col-span-2" />
        </dl>
        <p className="mt-3 text-xs text-slate-500">
          Created {row.created_at.slice(0, 10)} · Last update{" "}
          {row.updated_at.slice(0, 16).replace("T", " ")}
        </p>
      </section>

      {/* Status moves */}
      <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-base font-semibold text-slate-900">Lifecycle</h2>
        <p className="mt-1 text-sm text-slate-600">
          Move the setup through the lifecycle. Marking Live stamps a
          configured_at + configured_by audit and flips the customer&rsquo;s
          badge to green.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          {AI_RECEPTIONIST_STATUSES.map((s) => (
            <form key={s} action={setAiReceptionistStatus}>
              <input type="hidden" name="id" value={row.id} />
              <input type="hidden" name="status" value={s} />
              <button
                type="submit"
                disabled={status === s}
                className={`rounded-md border px-3 py-1.5 text-xs font-medium ${
                  status === s
                    ? "border-slate-300 bg-slate-100 text-slate-600"
                    : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
                }`}
              >
                {AI_RECEPTIONIST_STATUS_LABELS[s]}
              </button>
            </form>
          ))}
        </div>

        {status !== "live" && ticks === TEST_CHECKLIST_ITEMS.length ? (
          <form action={markAiReceptionistConfigured} className="mt-4">
            <input type="hidden" name="id" value={row.id} />
            <button
              type="submit"
              className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700"
            >
              Mark AI receptionist configured (Live)
            </button>
            <p className="mt-1 text-xs text-emerald-700">
              All {TEST_CHECKLIST_ITEMS.length} checklist items ticked — ready to go.
            </p>
          </form>
        ) : null}
      </section>

      {/* Test checklist */}
      <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-base font-semibold text-slate-900">Test checklist</h2>
        <p className="mt-1 text-sm text-slate-600">
          Tick each item once verified end-to-end. Customer sees the same list
          (without timestamps).
        </p>
        <ul className="mt-3 space-y-2">
          {TEST_CHECKLIST_ITEMS.map((item) => {
            const stamped = row[item.key] != null;
            const isStaff = item.key as TestChecklistKey;
            return (
              <li
                key={item.key}
                className="flex items-center justify-between gap-3 rounded-md border border-slate-200 px-3 py-2 text-sm"
              >
                <div>
                  <p
                    className={
                      stamped ? "font-medium text-slate-900" : "text-slate-700"
                    }
                  >
                    {item.label}
                  </p>
                  {stamped ? (
                    <p className="text-xs text-slate-500">
                      ✓ {String(row[item.key]).slice(0, 16).replace("T", " ")}
                    </p>
                  ) : (
                    <p className="text-xs text-slate-500">Not yet verified</p>
                  )}
                </div>
                <form action={toggleAiReceptionistChecklist}>
                  <input type="hidden" name="id" value={row.id} />
                  <input type="hidden" name="key" value={isStaff} />
                  <input
                    type="hidden"
                    name="toggle"
                    value={stamped ? "false" : "true"}
                  />
                  <button
                    type="submit"
                    className={
                      stamped
                        ? "rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                        : "rounded-md bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-800"
                    }
                  >
                    {stamped ? "Untick" : "Tick"}
                  </button>
                </form>
              </li>
            );
          })}
        </ul>
      </section>

      {/* HQ notes */}
      <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-base font-semibold text-slate-900">Internal notes</h2>
        <p className="mt-1 text-sm text-slate-600">
          Visible to HQ only. Use for Twilio subaccount IDs, Meta page tokens
          (DO NOT paste secrets), provisioning blockers, etc.
        </p>
        <form action={updateAiReceptionistNotes} className="mt-3 space-y-2">
          <input type="hidden" name="id" value={row.id} />
          <textarea
            name="hq_notes"
            rows={5}
            maxLength={4000}
            defaultValue={row.hq_notes ?? ""}
            aria-label="Internal notes"
            className="block w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
          />
          <button
            type="submit"
            className="rounded-md bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-800"
          >
            Save notes
          </button>
        </form>
      </section>

      {row.org_id ? <VoicePanel orgId={row.org_id} setupId={row.id} /> : null}
    </div>
  );
}

function Detail({
  label,
  value,
  multiline,
  className,
}: {
  label: string;
  value: string | null;
  multiline?: boolean;
  className?: string;
}) {
  return (
    <div className={className}>
      <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">
        {label}
      </dt>
      <dd
        className={
          multiline
            ? "mt-0.5 whitespace-pre-wrap text-sm text-slate-900"
            : "mt-0.5 text-sm text-slate-900"
        }
      >
        {value ?? "—"}
      </dd>
    </div>
  );
}
