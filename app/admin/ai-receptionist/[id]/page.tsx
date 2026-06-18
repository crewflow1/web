import Link from "next/link";
import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireUser } from "@/server/auth/session";
import { isSuperAdminEmail } from "@/server/auth/superadmin";
import {
  AI_RECEPTIONIST_STATUSES,
  AI_RECEPTIONIST_STATUS_LABELS,
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
import {
  Alert,
  Badge,
  Button,
  GlowHeader,
  Panel,
  Surface,
  Textarea,
  type Accent,
} from "@/components/ui";

/** Dark-surface accent per setup status (mirrors the legacy light styles). */
const STATUS_ACCENT: Record<AiReceptionistStatus, Accent> = {
  not_started: "slate",
  in_progress: "sky",
  testing: "amber",
  live: "emerald",
};

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
  const user = await requireUser();
  if (!isSuperAdminEmail(user.email)) notFound();

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
    <Surface>
      <GlowHeader
        eyebrow={
          <span className="flex items-center gap-2">
            <Link
              href="/admin/ai-receptionist"
              className="text-indigo-300 hover:text-indigo-200"
            >
              AI Receptionist setups
            </Link>
            <span aria-hidden>/</span>
            <span className="text-slate-400">{row.org?.name ?? "Unknown"}</span>
          </span>
        }
        title={row.org?.name ?? "Unknown org"}
        subtitle={
          <>
            Slug:{" "}
            <code className="rounded bg-slate-800/80 px-1 font-mono text-[0.9em] text-slate-300 ring-1 ring-inset ring-slate-700">
              {row.org?.slug}
            </code>
            {row.org?.email ? ` · ${row.org.email}` : ""}
          </>
        }
        actions={
          <div className="flex flex-col items-end gap-1">
            <Badge accent={STATUS_ACCENT[status] ?? "slate"}>
              {AI_RECEPTIONIST_STATUS_LABELS[status] ?? status}
            </Badge>
            <p className="text-[11px] text-slate-500">
              Checklist {ticks}/{TEST_CHECKLIST_ITEMS.length}
            </p>
            {!row.enabled ? (
              <p className="text-[11px] text-amber-300">
                Customer toggle is OFF
              </p>
            ) : null}
          </div>
        }
      />

      <div className="space-y-6 p-5 sm:p-7">
        {savedMessage ? (
          <Alert tone="success">{savedMessage}</Alert>
        ) : null}
        {errorMessage ? (
          <Alert tone="danger">{errorMessage}</Alert>
        ) : null}

        {/* Customer-provided data */}
        <Panel title="Customer-provided details">
          <dl className="grid gap-3 text-sm sm:grid-cols-2">
            <Detail label="Business phone" value={row.business_phone} />
            <Detail label="WhatsApp" value={row.whatsapp_number} />
            <Detail label="Facebook page" value={row.facebook_page} />
            <Detail label="Instagram" value={row.instagram_handle} />
            <Detail label="Preferred voice" value={row.preferred_voice} />
            <Detail label="Trade type" value={row.trade_type} />
            <div className="sm:col-span-2">
              <Detail label="Business hours" value={row.business_hours} multiline />
            </div>
          </dl>
          <p className="mt-3 text-xs text-slate-500">
            Created {row.created_at.slice(0, 10)} · Last update{" "}
            {row.updated_at.slice(0, 16).replace("T", " ")}
          </p>
        </Panel>

        {/* Status moves */}
        <Panel
          title="Lifecycle"
          subtitle="Move the setup through the lifecycle. Marking Live stamps a configured_at + configured_by audit and flips the customer's badge to green."
        >
          <div className="flex flex-wrap gap-2">
            {AI_RECEPTIONIST_STATUSES.map((s) => (
              <form key={s} action={setAiReceptionistStatus}>
                <input type="hidden" name="id" value={row.id} />
                <input type="hidden" name="status" value={s} />
                <Button
                  type="submit"
                  variant="glass"
                  size="sm"
                  disabled={status === s}
                >
                  {AI_RECEPTIONIST_STATUS_LABELS[s]}
                </Button>
              </form>
            ))}
          </div>

          {status !== "live" && ticks === TEST_CHECKLIST_ITEMS.length ? (
            <form action={markAiReceptionistConfigured} className="mt-4">
              <input type="hidden" name="id" value={row.id} />
              <Button
                type="submit"
                className="border border-emerald-400/30 bg-emerald-500/15 text-emerald-300 shadow-none hover:bg-emerald-500/25 focus-visible:ring-emerald-500 focus-visible:ring-offset-slate-950"
              >
                Mark AI receptionist configured (Live)
              </Button>
              <p className="mt-1 text-xs text-emerald-300">
                All {TEST_CHECKLIST_ITEMS.length} checklist items ticked — ready to go.
              </p>
            </form>
          ) : null}
        </Panel>

        {/* Test checklist */}
        <Panel
          title="Test checklist"
          subtitle="Tick each item once verified end-to-end. Customer sees the same list (without timestamps)."
        >
          <ul className="space-y-2">
            {TEST_CHECKLIST_ITEMS.map((item) => {
              const stamped = row[item.key] != null;
              const isStaff = item.key as TestChecklistKey;
              return (
                <li
                  key={item.key}
                  className="flex items-center justify-between gap-3 rounded-xl border border-slate-800 bg-slate-900/60 px-3 py-2 text-sm"
                >
                  <div>
                    <p
                      className={
                        stamped ? "font-medium text-white" : "text-slate-300"
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
                    <Button
                      type="submit"
                      variant={stamped ? "glass" : "accent"}
                      size="sm"
                    >
                      {stamped ? "Untick" : "Tick"}
                    </Button>
                  </form>
                </li>
              );
            })}
          </ul>
        </Panel>

        {/* HQ notes */}
        <Panel
          title="Internal notes"
          subtitle="Visible to HQ only. Use for Twilio subaccount IDs, Meta page tokens (DO NOT paste secrets), provisioning blockers, etc."
        >
          <form action={updateAiReceptionistNotes} className="space-y-2">
            <input type="hidden" name="id" value={row.id} />
            <Textarea
              name="hq_notes"
              rows={5}
              maxLength={4000}
              defaultValue={row.hq_notes ?? ""}
            />
            <Button type="submit" variant="accent" size="sm">
              Save notes
            </Button>
          </form>
        </Panel>
      </div>
    </Surface>
  );
}

function Detail({
  label,
  value,
  multiline,
}: {
  label: string;
  value: string | null;
  multiline?: boolean;
}) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">
        {label}
      </dt>
      <dd
        className={
          multiline
            ? "mt-0.5 whitespace-pre-wrap text-sm text-white"
            : "mt-0.5 text-sm text-white"
        }
      >
        {value ?? "—"}
      </dd>
    </div>
  );
}
