/**
 * CrewFlow HQ — AI Communication Centre, pure channel model
 * (CEO Directive 004, Phase 5).
 *
 * Server/client-safe. NO Supabase / server-only imports. The Communication
 * Centre unifies every messaging touch — Email, Phone, LinkedIn, Instagram,
 * WhatsApp, SMS, Facebook — into one timeline, so this module owns the
 * vocabulary that maps a stored timeline event to a communication channel
 * and rolls a window of events up into a per-channel summary.
 *
 * ARCHITECTURE ONLY. Nothing here sends a message or connects an
 * integration; it classifies and aggregates events that already exist in
 * the permanent, audited timeline. Channels with no events yet (WhatsApp,
 * SMS) still appear in the model so the centre is honest about what is and
 * isn't wired up — the connectors are "planned", never faked.
 */

import { directionLabel, type SalesTimelineEvent } from "./model";

// ---------------------------------------------------------------------
// Communication channels — the directive's exact set, in display order.
// ---------------------------------------------------------------------

export const COMM_CHANNELS = [
  "email",
  "phone",
  "linkedin",
  "instagram",
  "whatsapp",
  "sms",
  "facebook",
] as const;
export type CommChannel = (typeof COMM_CHANNELS)[number];

export const COMM_CHANNEL_LABELS: Record<CommChannel, string> = {
  email: "Email",
  phone: "Phone",
  linkedin: "LinkedIn",
  instagram: "Instagram",
  whatsapp: "WhatsApp",
  sms: "SMS",
  facebook: "Facebook",
};

export function commChannelLabel(c: string): string {
  return COMM_CHANNEL_LABELS[c as CommChannel] ?? c;
}

export function isCommChannel(c: string): c is CommChannel {
  return (COMM_CHANNELS as readonly string[]).includes(c);
}

/**
 * Timeline event type → communication channel. Covers human-logged touches
 * and the AI engine's comm actions (sends + drafts) so a unified inbox can
 * show both. Events that aren't a message — notes, demos, meetings,
 * lifecycle markers, task-queue churn — map to null and are excluded.
 */
const EVENT_CHANNEL: Record<string, CommChannel> = {
  email: "email",
  email_sent: "email",
  email_generated: "email",
  call: "phone",
  call_completed: "phone",
  linkedin: "linkedin",
  linkedin_sent: "linkedin",
  linkedin_generated: "linkedin",
  instagram: "instagram",
  facebook: "facebook",
  whatsapp: "whatsapp",
  sms: "sms",
};

/**
 * Resolve the channel for an event. Falls back to the event type used
 * directly as a channel slug, then to an explicit `metadata.channel` hint,
 * so a future WhatsApp/SMS connector that stamps the channel is picked up
 * with no code change. Returns null when the event isn't a communication.
 */
export function eventChannel(
  eventType: string,
  metadata?: Record<string, unknown> | null,
): CommChannel | null {
  const mapped = EVENT_CHANNEL[eventType];
  if (mapped) return mapped;
  if (isCommChannel(eventType)) return eventType;
  const hint = metadata?.["channel"];
  if (typeof hint === "string" && isCommChannel(hint)) return hint;
  return null;
}

export function isCommEvent(
  eventType: string,
  metadata?: Record<string, unknown> | null,
): boolean {
  return eventChannel(eventType, metadata) != null;
}

/** All timeline event types that are communications (for a bounded read). */
export const COMM_EVENT_TYPES: readonly string[] = Object.keys(EVENT_CHANNEL);

// ---------------------------------------------------------------------
// Per-channel roll-up over a window of events.
// ---------------------------------------------------------------------

export type CommChannelStat = {
  channel: CommChannel;
  label: string;
  total: number;
  inbound: number;
  outbound: number;
  lastAt: string | null;
};

export type CommsSummary = {
  /** One entry per channel, in display order — includes zero-event channels. */
  byChannel: CommChannelStat[];
  total: number;
  inbound: number;
  outbound: number;
  /** Channels with at least one event in the window. */
  channelsActive: number;
  lastContactAt: string | null;
};

function emptyStat(channel: CommChannel): CommChannelStat {
  return {
    channel,
    label: COMM_CHANNEL_LABELS[channel],
    total: 0,
    inbound: 0,
    outbound: 0,
    lastAt: null,
  };
}

function laterIso(a: string | null, b: string): string {
  if (!a) return b;
  return new Date(b).getTime() > new Date(a).getTime() ? b : a;
}

export function summariseComms(
  events: ReadonlyArray<Pick<SalesTimelineEvent, "event_type" | "direction" | "occurred_at" | "metadata">>,
): CommsSummary {
  const stats = new Map<CommChannel, CommChannelStat>();
  for (const c of COMM_CHANNELS) stats.set(c, emptyStat(c));

  let total = 0;
  let inbound = 0;
  let outbound = 0;
  let lastContactAt: string | null = null;

  for (const e of events) {
    const channel = eventChannel(e.event_type, e.metadata);
    if (!channel) continue;
    const stat = stats.get(channel);
    if (!stat) continue;

    total += 1;
    stat.total += 1;
    if (e.direction === "inbound") {
      inbound += 1;
      stat.inbound += 1;
    } else if (e.direction === "outbound") {
      outbound += 1;
      stat.outbound += 1;
    }
    stat.lastAt = laterIso(stat.lastAt, e.occurred_at);
    lastContactAt = laterIso(lastContactAt, e.occurred_at);
  }

  const byChannel = COMM_CHANNELS.map((c) => stats.get(c) ?? emptyStat(c));
  const channelsActive = byChannel.filter((s) => s.total > 0).length;

  return { byChannel, total, inbound, outbound, channelsActive, lastContactAt };
}

/** "12 in · 8 out" style descriptor for a channel stat (pure, for the UI). */
export function commDirectionSummary(stat: CommChannelStat): string {
  if (stat.total === 0) return "No messages yet";
  const parts: string[] = [];
  if (stat.inbound > 0) parts.push(`${stat.inbound} ${directionLabel("inbound").toLowerCase()}`);
  if (stat.outbound > 0) parts.push(`${stat.outbound} ${directionLabel("outbound").toLowerCase()}`);
  return parts.length > 0 ? parts.join(" · ") : `${stat.total} logged`;
}
