import Link from "next/link";
import {
  Facebook,
  Instagram,
  Linkedin,
  Mail,
  MessageCircle,
  MessageSquare,
  MessagesSquare,
  Phone,
  Plug,
  Search,
  ShieldCheck,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  listCommunicationWindow,
  listIntegrations,
} from "@/server/services/hq-sales";
import { directionLabel } from "@/lib/sales/model";
import {
  COMM_CHANNELS,
  commChannelLabel,
  commDirectionSummary,
  eventChannel,
  summariseComms,
  type CommChannel,
} from "@/lib/sales/comms";
import { EmptyState, Pill, Section, TimelineItem, Tile } from "../_components";
import { inputCls } from "../_styles";

/**
 * Sales AI — AI Communication Centre (CEO Directive 004, Phase 5).
 *
 * Every messaging touch — Email, Phone, LinkedIn, Instagram, WhatsApp,
 * SMS, Facebook — across ALL companies, unified into one searchable,
 * channel-filtered timeline, with a per-channel roll-up and the planned-
 * connector status board. ARCHITECTURE ONLY: nothing here sends a message
 * or connects an integration; it presents the permanent, audited timeline
 * that the autonomous engine will one day write to. Channels with no
 * traffic yet (WhatsApp, SMS) are shown honestly as awaiting their
 * connector rather than hidden. HQ operator only (the layout gates the
 * whole module to Super Admin).
 */

export const dynamic = "force-dynamic";

type SP = Promise<{ channel?: string; dir?: string; q?: string; show?: string }>;

const WINDOWS = [120, 240, 480] as const;
type WindowSize = (typeof WINDOWS)[number];

const CHANNEL_ICONS: Record<CommChannel, LucideIcon> = {
  email: Mail,
  phone: Phone,
  linkedin: Linkedin,
  instagram: Instagram,
  whatsapp: MessageCircle,
  sms: MessageSquare,
  facebook: Facebook,
};

const DIRECTIONS = ["inbound", "outbound"] as const;

function dayHeading(dayKey: string, now: Date): string {
  const today = now.toISOString().slice(0, 10);
  const yesterday = new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10);
  if (dayKey === today) return "Today";
  if (dayKey === yesterday) return "Yesterday";
  return new Date(`${dayKey}T00:00:00Z`).toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

function integrationPill(status: string): string {
  if (status === "connected") {
    return "bg-emerald-500/15 text-emerald-300 ring-1 ring-inset ring-emerald-400/30";
  }
  if (status === "disabled") {
    return "bg-slate-700/40 text-slate-500 ring-1 ring-inset ring-slate-600/40";
  }
  return "bg-indigo-500/15 text-indigo-300 ring-1 ring-inset ring-indigo-400/30";
}

export default async function CommunicationsPage({
  searchParams,
}: {
  searchParams: SP;
}) {
  const sp = await searchParams;
  const requested = Number.parseInt(sp.show ?? "120", 10);
  const limit: WindowSize = WINDOWS.includes(requested as WindowSize)
    ? (requested as WindowSize)
    : 120;
  const query = sp.q?.trim() ?? "";
  const selectedChannel: CommChannel | null =
    sp.channel && (COMM_CHANNELS as readonly string[]).includes(sp.channel)
      ? (sp.channel as CommChannel)
      : null;
  const selectedDir: (typeof DIRECTIONS)[number] | null =
    sp.dir === "inbound" || sp.dir === "outbound" ? sp.dir : null;

  const [feed, integrations] = await Promise.all([
    listCommunicationWindow(limit, query || undefined),
    listIntegrations(),
  ]);

  // Per-channel roll-up is computed over the full (search-scoped) window so
  // the breakdown is complete regardless of the channel/direction filter.
  const summary = summariseComms(feed);

  const visible = feed.filter((e) => {
    if (selectedChannel && eventChannel(e.event_type, e.metadata) !== selectedChannel) {
      return false;
    }
    if (selectedDir && e.direction !== selectedDir) return false;
    return true;
  });

  const now = new Date();
  const groups: { day: string; events: typeof visible }[] = [];
  for (const e of visible) {
    const day = e.occurred_at.slice(0, 10);
    const last = groups[groups.length - 1];
    if (last && last.day === day) last.events.push(e);
    else groups.push({ day, events: [e] });
  }

  const commsConnectors = integrations.filter(
    (i) => i.category === "comms" || i.category === "social",
  );

  const buildHref = (over: Partial<{ channel: string; dir: string; q: string; show: string }>) => {
    const qs = new URLSearchParams();
    const channel = over.channel !== undefined ? over.channel : selectedChannel ?? "";
    const dir = over.dir !== undefined ? over.dir : selectedDir ?? "";
    const q = over.q !== undefined ? over.q : query;
    const show = over.show !== undefined ? over.show : limit !== 120 ? String(limit) : "";
    if (channel) qs.set("channel", channel);
    if (dir) qs.set("dir", dir);
    if (q) qs.set("q", q);
    if (show) qs.set("show", show);
    const s = qs.toString();
    return s ? `/admin/sales/communications?${s}` : "/admin/sales/communications";
  };

  return (
    <div className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-950 text-slate-100 shadow-xl">
      {/* Header */}
      <div className="relative border-b border-slate-800 px-5 py-6 sm:px-7">
        <div
          className="pointer-events-none absolute inset-0 opacity-60"
          style={{
            background:
              "radial-gradient(60% 120% at 15% 0%, rgba(99,102,241,0.18), transparent 60%), radial-gradient(50% 120% at 90% 0%, rgba(16,185,129,0.12), transparent 55%)",
          }}
          aria-hidden
        />
        <div className="relative">
          <p className="text-sm text-slate-500">
            <Link href="/admin/sales" className="hover:text-slate-300">
              Sales AI
            </Link>{" "}
            / <span className="text-slate-300">Communications</span>
          </p>
          <div className="mt-3 flex flex-wrap items-start justify-between gap-4">
            <div className="flex items-start gap-3">
              <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-indigo-500/15 text-indigo-300 ring-1 ring-inset ring-indigo-400/30">
                <MessagesSquare className="h-6 w-6" strokeWidth={1.75} aria-hidden />
              </span>
              <div>
                <h1 className="text-xl font-bold tracking-tight text-white">
                  Communication Centre
                </h1>
                <p className="mt-0.5 max-w-xl text-sm text-slate-400">
                  Every email, call, LinkedIn, Instagram, WhatsApp, SMS and
                  Facebook touch across the master database — one unified,
                  searchable timeline.
                </p>
              </div>
            </div>
            <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-500/10 px-3 py-1 text-[11px] font-medium text-amber-300 ring-1 ring-inset ring-amber-400/30">
              <ShieldCheck className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
              Architecture only · no messages are sent
            </span>
          </div>
        </div>
      </div>

      <div className="space-y-5 p-5 sm:p-7">
        {/* Totals */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Tile label="Messages" value={summary.total.toLocaleString()} accent sub="in this window" />
          <Tile label="Inbound" value={summary.inbound.toLocaleString()} sub="prospect → us" />
          <Tile label="Outbound" value={summary.outbound.toLocaleString()} sub="us → prospect" />
          <Tile
            label="Active channels"
            value={`${summary.channelsActive}/${COMM_CHANNELS.length}`}
            sub="with traffic"
          />
        </div>

        {/* Per-channel breakdown */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-7">
          {summary.byChannel.map((stat) => {
            const Icon = CHANNEL_ICONS[stat.channel];
            const active = selectedChannel === stat.channel;
            return (
              <Link
                key={stat.channel}
                href={buildHref({ channel: active ? "" : stat.channel })}
                aria-current={active ? "true" : undefined}
                className={`group flex flex-col gap-1.5 rounded-xl border p-3 transition ${
                  active
                    ? "border-indigo-500 bg-indigo-500/10"
                    : "border-slate-800 bg-slate-900/60 hover:border-slate-700 hover:bg-slate-900"
                }`}
              >
                <span className="flex items-center justify-between">
                  <Icon
                    className={`h-4 w-4 ${active ? "text-indigo-300" : "text-slate-400"}`}
                    strokeWidth={1.75}
                    aria-hidden
                  />
                  <span className="text-lg font-bold tabular-nums text-white">
                    {stat.total.toLocaleString()}
                  </span>
                </span>
                <span className="text-[11px] font-semibold text-slate-200">
                  {stat.label}
                </span>
                <span className="truncate text-[10px] text-slate-500">
                  {commDirectionSummary(stat)}
                </span>
              </Link>
            );
          })}
        </div>

        {/* Search + filters */}
        <div className="space-y-3 rounded-xl border border-slate-800 bg-slate-900/50 p-4">
          <form method="get" className="flex flex-wrap items-center gap-2">
            {selectedChannel ? (
              <input type="hidden" name="channel" value={selectedChannel} />
            ) : null}
            {selectedDir ? <input type="hidden" name="dir" value={selectedDir} /> : null}
            {limit !== 120 ? <input type="hidden" name="show" value={limit} /> : null}
            <div className="relative min-w-0 flex-1">
              <Search
                className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500"
                aria-hidden
              />
              <input
                type="search"
                name="q"
                defaultValue={query}
                placeholder="Search every message — subject, body, outcome…"
                aria-label="Search communications"
                className={`${inputCls} mt-0 pl-9`}
              />
            </div>
            <button
              type="submit"
              className="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-indigo-500"
            >
              Search
            </button>
            {query ? (
              <Link
                href={buildHref({ q: "" })}
                className="inline-flex items-center gap-1 rounded-md border border-slate-700 px-3 py-1.5 text-xs font-medium text-slate-300 transition hover:bg-slate-800"
              >
                <X className="h-3.5 w-3.5" aria-hidden />
                Clear
              </Link>
            ) : null}
          </form>

          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
              Direction
            </span>
            <FilterChip href={buildHref({ dir: "" })} label="All" active={!selectedDir} />
            {DIRECTIONS.map((d) => (
              <FilterChip
                key={d}
                href={buildHref({ dir: selectedDir === d ? "" : d })}
                label={directionLabel(d)}
                active={selectedDir === d}
              />
            ))}
            {selectedChannel ? (
              <Link
                href={buildHref({ channel: "" })}
                className="ml-auto inline-flex items-center gap-1 rounded-md border border-slate-700 px-2.5 py-1 text-[11px] font-medium text-slate-300 transition hover:bg-slate-800"
              >
                <X className="h-3 w-3" aria-hidden />
                {commChannelLabel(selectedChannel)} only
              </Link>
            ) : null}
          </div>
        </div>

        {/* Unified timeline */}
        {visible.length === 0 ? (
          <EmptyState
            message={
              feed.length === 0
                ? "No communications logged yet. Messages appear here as the engine logs email, calls, LinkedIn, Instagram, WhatsApp, SMS and Facebook touches."
                : "No messages match these filters in this window."
            }
            cta={
              selectedChannel || selectedDir || query ? (
                <Link
                  href="/admin/sales/communications"
                  className="text-xs font-medium text-indigo-400 hover:text-indigo-300"
                >
                  Clear filters
                </Link>
              ) : (
                <Link
                  href="/admin/sales/companies"
                  className="text-xs font-medium text-indigo-400 hover:text-indigo-300"
                >
                  Browse companies →
                </Link>
              )
            }
          />
        ) : (
          <div className="space-y-4">
            {groups.map((g) => (
              <Section key={g.day} title={dayHeading(g.day, now)}>
                <ul className="relative">
                  {g.events.map((e) => (
                    <TimelineItem key={e.id} event={e} showCompany />
                  ))}
                </ul>
              </Section>
            ))}
          </div>
        )}

        {/* Window controls */}
        <div className="flex flex-wrap items-center gap-2 border-t border-slate-800 pt-4">
          <span className="text-[11px] text-slate-500">Show latest</span>
          {WINDOWS.map((w) => (
            <Link
              key={w}
              href={buildHref({ show: w === 120 ? "" : String(w) })}
              aria-current={w === limit ? "page" : undefined}
              className={`rounded-md border px-3 py-1.5 text-xs font-medium transition ${
                w === limit
                  ? "border-indigo-500 bg-indigo-600 text-white"
                  : "border-slate-700 text-slate-300 hover:bg-slate-800"
              }`}
            >
              {w}
            </Link>
          ))}
          <span className="ml-auto text-[11px] text-slate-600">
            {visible.length.toLocaleString()} shown
            {summary.lastContactAt
              ? ` · last ${summary.lastContactAt.slice(0, 10)}`
              : ""}
          </span>
        </div>

        {/* Planned connectors */}
        <Section
          title="Channel connectors"
          subtitle="The integrations that will feed this timeline. Future work — planned connectors are wired into the schema, never faked."
          action={
            <span className="inline-flex items-center gap-1.5 rounded-full bg-indigo-500/10 px-2.5 py-1 text-[11px] font-medium text-indigo-300 ring-1 ring-inset ring-indigo-400/30">
              <Plug className="h-3.5 w-3.5" aria-hidden />
              {commsConnectors.length}
            </span>
          }
        >
          {commsConnectors.length === 0 ? (
            <p className="text-sm text-slate-500">No connectors registered yet.</p>
          ) : (
            <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {commsConnectors.map((i) => (
                <li
                  key={i.slug}
                  className="flex items-center justify-between gap-3 rounded-lg border border-slate-800 bg-slate-900/60 px-3 py-2"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-semibold text-slate-200">
                      {i.label}
                    </span>
                    <span className="text-[10px] uppercase tracking-wide text-slate-500">
                      {i.category}
                    </span>
                  </span>
                  <Pill className={integrationPill(i.status)}>{i.status}</Pill>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>
    </div>
  );
}

function FilterChip({
  href,
  label,
  active,
}: {
  href: string;
  label: string;
  active: boolean;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? "true" : undefined}
      className={`rounded-md border px-2.5 py-1 text-[11px] font-medium transition ${
        active
          ? "border-indigo-500 bg-indigo-600 text-white"
          : "border-slate-700 text-slate-300 hover:bg-slate-800"
      }`}
    >
      {label}
    </Link>
  );
}
