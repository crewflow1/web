/**
 * Operator-facing channel badge for the AI-receptionist review surfaces.
 *
 * Presentation only: the `channel` comes from the review item's audit row (carried on
 * every item, `ai_reply_audits.channel`), so surfacing "WhatsApp" vs "Phone" vs "SMS"
 * needs no query change — just this label. Shared by the review list + detail pages so
 * the vocabulary and colours stay identical (Part 8: "see channel identity").
 */

const CHANNEL_META: Record<string, { label: string; style: string }> = {
  whatsapp_msg: { label: "WhatsApp", style: "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200" },
  whatsapp_call: { label: "WhatsApp call", style: "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200" },
  phone: { label: "Phone", style: "bg-sky-50 text-sky-700 ring-1 ring-sky-200" },
  sms: { label: "SMS", style: "bg-indigo-50 text-indigo-700 ring-1 ring-indigo-200" },
  instagram_dm: { label: "Instagram", style: "bg-pink-50 text-pink-700 ring-1 ring-pink-200" },
  facebook_dm: { label: "Facebook", style: "bg-blue-50 text-blue-700 ring-1 ring-blue-200" },
  manual: { label: "Manual", style: "bg-slate-100 text-slate-600 ring-1 ring-slate-200" },
};

export function ChannelBadge({
  channel,
  className = "",
}: {
  channel: string;
  className?: string;
}) {
  const meta =
    CHANNEL_META[channel] ?? {
      label: channel,
      style: "bg-slate-100 text-slate-600 ring-1 ring-slate-200",
    };
  return (
    <span
      className={`inline-flex rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${meta.style} ${className}`}
    >
      {meta.label}
    </span>
  );
}
