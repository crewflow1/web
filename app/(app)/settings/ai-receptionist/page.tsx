import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { AiReceptionistForm } from "./_form";
import { saveAiReceptionistSetup } from "./actions";
import {
  AI_RECEPTIONIST_STATUS_LABELS,
  AI_RECEPTIONIST_STATUS_STYLES,
  TEST_CHECKLIST_ITEMS,
  type AiReceptionistStatus,
} from "@/lib/ai-receptionist/schema";
import { FadeIn } from "@/components/ui";

/**
 * /settings/ai-receptionist
 *
 * Customer-facing AI receptionist onboarding form. White-glove setup —
 * the customer fills in channel handles + preferences; HQ does the
 * actual provisioning.
 *
 * Status the customer sees is derived:
 *   - row absent OR enabled=false → "Off" (no badge)
 *   - enabled=true, status != 'live' → "Pending"
 *   - status='live' → "Live"
 */

type SetupRow = {
  id: string;
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
};

export default async function AiReceptionistSettingsPage() {
  const { ctx } = await requireOrgContext();
  const isAdmin = ctx.membership.role === "owner" || ctx.membership.role === "admin";
  const supabase = await createClient();

  const { data: row } = await (
    supabase.from("ai_receptionist_setups" as never) as unknown as {
      select: (cols: string) => {
        eq: (k: string, v: unknown) => {
          maybeSingle: () => Promise<{ data: SetupRow | null }>;
        };
      };
    }
  )
    .select(
      "id, enabled, business_phone, whatsapp_number, facebook_page, instagram_handle, preferred_voice, business_hours, trade_type, status, test_call_at, test_sms_at, test_whatsapp_at, test_meta_at, test_voice_at, test_lead_at, configured_at",
    )
    .eq("org_id", ctx.org.id)
    .maybeSingle();

  const status = (row?.status as AiReceptionistStatus | undefined) ?? "not_started";
  const customerBadge =
    !row || !row.enabled
      ? null
      : status === "live"
        ? { label: "Live", style: "bg-emerald-100 text-emerald-800" }
        : { label: "Pending", style: "bg-amber-100 text-amber-800" };

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="flex items-center gap-2 text-sm text-slate-500">
        <Link href="/settings" className="hover:text-slate-900">
          Settings
        </Link>
        <span aria-hidden>/</span>
        <span className="text-slate-900">AI Receptionist</span>
      </div>

      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">AI Receptionist</h1>
          <p className="mt-1 text-sm text-slate-600">
            Answer every call, WhatsApp and DM with an AI receptionist that
            qualifies the job and creates a lead automatically. White-glove
            setup — our team configures everything for you.
          </p>
        </div>
        {customerBadge ? (
          <span
            className={`inline-flex shrink-0 items-center rounded-full px-3 py-1 text-xs font-medium ${customerBadge.style}`}
          >
            {customerBadge.label}
          </span>
        ) : null}
      </header>

      {row?.enabled && status !== "live" ? (
        <div className="rounded-md border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          <p className="font-medium">Setup in progress.</p>
          <p className="mt-1 text-xs text-amber-800">
            Status:{" "}
            <span
              className={`inline-flex rounded-full px-2 py-0.5 font-medium ${
                AI_RECEPTIONIST_STATUS_STYLES[status]
              }`}
            >
              {AI_RECEPTIONIST_STATUS_LABELS[status]}
            </span>
            . Our team is provisioning your channels and will run a full test
            before flipping the switch to Live.
          </p>
          <div className="mt-3 space-y-1">
            <p className="text-xs font-semibold text-amber-900">Test checklist</p>
            <ul className="space-y-0.5 text-xs">
              {TEST_CHECKLIST_ITEMS.map((item) => {
                const stamped = row[item.key] != null;
                return (
                  <li key={item.key} className="flex items-center gap-2">
                    <span
                      aria-hidden
                      className={`inline-block h-3 w-3 rounded-full border ${
                        stamped
                          ? "border-emerald-500 bg-emerald-500"
                          : "border-amber-300 bg-white"
                      }`}
                    />
                    <span className={stamped ? "text-amber-900 line-through" : "text-amber-900"}>
                      {item.label}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      ) : row?.enabled && status === "live" ? (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900">
          <p className="font-medium">Live since {row.configured_at?.slice(0, 10)}.</p>
          <p className="mt-1 text-xs text-emerald-800">
            Every call, message and DM is being answered by the AI. Captured
            enquiries land in{" "}
            <Link href="/inbox" className="font-medium underline hover:text-emerald-900">
              Inbox
            </Link>
            .
          </p>
        </div>
      ) : null}

      <FadeIn>
        <AiReceptionistForm
          action={saveAiReceptionistSetup}
          isAdmin={isAdmin}
          defaults={{
            enabled: row?.enabled ?? false,
            business_phone: row?.business_phone ?? "",
            whatsapp_number: row?.whatsapp_number ?? "",
            facebook_page: row?.facebook_page ?? "",
            instagram_handle: row?.instagram_handle ?? "",
            preferred_voice: row?.preferred_voice ?? "",
            business_hours: row?.business_hours ?? "",
            trade_type: row?.trade_type ?? "",
          }}
        />
      </FadeIn>
    </div>
  );
}
