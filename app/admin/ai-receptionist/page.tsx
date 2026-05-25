import Link from "next/link";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireUser } from "@/server/auth/session";
import { isSuperAdminEmail } from "@/server/auth/superadmin";
import { notFound } from "next/navigation";
import {
  AI_RECEPTIONIST_STATUSES,
  AI_RECEPTIONIST_STATUS_LABELS,
  AI_RECEPTIONIST_STATUS_STYLES,
  TEST_CHECKLIST_ITEMS,
  type AiReceptionistStatus,
} from "@/lib/ai-receptionist/schema";

/**
 * /admin/ai-receptionist — HQ queue for white-glove AI Receptionist
 * onboarding.
 *
 * Lists every org that&rsquo;s ever toggled the receptionist on. Per-row
 * shows: company name, business phone, channels, status, test-checklist
 * progress (X of 6). Click into a row to drive status moves + ticking
 * the checklist.
 *
 * Filter by status via ?status=not_started|in_progress|testing|live.
 */

type Row = {
  id: string;
  org_id: string;
  enabled: boolean;
  business_phone: string | null;
  whatsapp_number: string | null;
  facebook_page: string | null;
  instagram_handle: string | null;
  preferred_voice: string | null;
  trade_type: string | null;
  status: string;
  test_call_at: string | null;
  test_sms_at: string | null;
  test_whatsapp_at: string | null;
  test_meta_at: string | null;
  test_voice_at: string | null;
  test_lead_at: string | null;
  configured_at: string | null;
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

type SP = Promise<{ status?: string }>;

export default async function HqAiReceptionistPage({
  searchParams,
}: {
  searchParams: SP;
}) {
  const user = await requireUser();
  if (!isSuperAdminEmail(user.email)) notFound();

  const sp = await searchParams;
  const supabase = createAdminClient();

  const filter = sp.status as AiReceptionistStatus | undefined;

  const baseQuery = supabase
    .from("ai_receptionist_setups" as never)
    .select(
      `
        id, org_id, enabled, business_phone, whatsapp_number, facebook_page,
        instagram_handle, preferred_voice, trade_type,
        status, test_call_at, test_sms_at, test_whatsapp_at, test_meta_at,
        test_voice_at, test_lead_at, configured_at, created_at, updated_at,
        org:organizations ( id, name, slug, status, phone, email )
      `,
    )
    .order("updated_at", { ascending: false })
    .limit(500);

  const result = filter
    ? await baseQuery.eq("status" as never, filter)
    : await baseQuery;
  const rows = ((result as { data?: Row[] | null }).data ?? []) as Row[];

  // Bucket counts for the filter pills.
  const counts: Record<AiReceptionistStatus, number> = {
    not_started: 0,
    in_progress: 0,
    testing: 0,
    live: 0,
  };
  for (const r of rows) {
    if ((AI_RECEPTIONIST_STATUSES as readonly string[]).includes(r.status)) {
      counts[r.status as AiReceptionistStatus]++;
    }
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-bold text-slate-900">
          AI Receptionist setups
        </h1>
        <p className="mt-1 text-sm text-slate-600">
          White-glove onboarding queue. Customers enable on
          /settings/ai-receptionist — work them through the lifecycle here.
        </p>
      </header>

      <nav aria-label="Status" className="flex flex-wrap gap-2 text-xs">
        <FilterPill current={filter ?? "all"} value="all" label={`All (${rows.length})`} />
        {AI_RECEPTIONIST_STATUSES.map((s) => (
          <FilterPill
            key={s}
            current={filter ?? "all"}
            value={s}
            label={`${AI_RECEPTIONIST_STATUS_LABELS[s]} (${counts[s]})`}
          />
        ))}
      </nav>

      {rows.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 bg-white p-12 text-center text-sm text-slate-600">
          No matching setups.
        </div>
      ) : (
        <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
          <table className="min-w-full divide-y divide-slate-200">
            <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-3">Company</th>
                <th className="px-4 py-3">Phone</th>
                <th className="px-4 py-3 hidden md:table-cell">Channels</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Checklist</th>
                <th className="px-4 py-3 hidden lg:table-cell">Updated</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 bg-white text-sm">
              {rows.map((row) => {
                const ticks = TEST_CHECKLIST_ITEMS.filter(
                  (item) => row[item.key] != null,
                ).length;
                const channels: string[] = [];
                if (row.business_phone) channels.push("Call/SMS");
                if (row.whatsapp_number) channels.push("WA");
                if (row.facebook_page) channels.push("FB");
                if (row.instagram_handle) channels.push("IG");

                return (
                  <tr key={row.id} className="hover:bg-slate-50">
                    <td className="px-4 py-3">
                      <Link
                        href={`/admin/ai-receptionist/${row.id}`}
                        className="font-medium text-slate-900 hover:text-slate-700"
                      >
                        {row.org?.name ?? "Unknown"}
                      </Link>
                      <p className="text-xs text-slate-500">{row.org?.slug}</p>
                    </td>
                    <td className="px-4 py-3 text-slate-700">
                      {row.business_phone ?? "—"}
                    </td>
                    <td className="px-4 py-3 text-slate-600 hidden md:table-cell">
                      {channels.length === 0 ? "—" : channels.join(", ")}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
                          AI_RECEPTIONIST_STATUS_STYLES[
                            row.status as AiReceptionistStatus
                          ] ?? "bg-slate-100 text-slate-700"
                        }`}
                      >
                        {AI_RECEPTIONIST_STATUS_LABELS[
                          row.status as AiReceptionistStatus
                        ] ?? row.status}
                      </span>
                      {!row.enabled ? (
                        <span className="ml-1 text-[10px] text-slate-500">
                          (off)
                        </span>
                      ) : null}
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-700">
                      {ticks}/{TEST_CHECKLIST_ITEMS.length}
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-500 hidden lg:table-cell">
                      {row.updated_at.slice(0, 10)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}

function FilterPill({
  current,
  value,
  label,
}: {
  current: string;
  value: string;
  label: string;
}) {
  const isActive = current === value;
  const href =
    value === "all"
      ? "/admin/ai-receptionist"
      : `/admin/ai-receptionist?status=${value}`;
  return (
    <Link
      href={href}
      aria-current={isActive ? "page" : undefined}
      className={
        isActive
          ? "rounded-full bg-slate-900 px-3 py-1 font-medium text-white"
          : "rounded-full border border-slate-300 bg-white px-3 py-1 font-medium text-slate-700 hover:bg-slate-50"
      }
    >
      {label}
    </Link>
  );
}
