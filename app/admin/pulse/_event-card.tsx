"use client";

import Link from "next/link";
import { motion } from "framer-motion";
import { ArrowUpRight } from "lucide-react";
import type { TimelineEvent } from "@/server/services/spine-timeline";
import {
  eventIcon,
  describeEvent,
  eventHref,
  actorLabel,
  companyLabel,
  severityToken,
  relativeTime,
} from "@/lib/events/render";

/**
 * The Pulse — one event card (Module 1, PR5 / CEO Directive #005, STEP 5).
 *
 * icon · title · description · actor · company · relative time · severity · quick
 * action — exactly the card anatomy the directive specifies. The whole surface is
 * a button that opens the detail drawer; the deep-link "quick action" stops
 * propagation so it navigates instead of opening the drawer. Hover lifts + glows;
 * the active card (its drawer open) keeps an accent ring. No mount/entrance
 * animation here on purpose — the card lives inside a virtualiser that mounts and
 * unmounts rows as you scroll, so a per-row entrance would re-fire on every
 * scroll. Entrance/stagger lives at the list level (and for newly-arrived rows).
 */

export function EventCard({
  event,
  active,
  onOpen,
}: {
  event: TimelineEvent;
  active: boolean;
  onOpen: (event: TimelineEvent) => void;
}) {
  const Icon = eventIcon(event.verb);
  const { title, description } = describeEvent(event);
  const sev = severityToken(event.severity);
  const actor = actorLabel(event);
  const company = companyLabel(event);
  const href = eventHref(event);

  return (
    <motion.div
      role="button"
      tabIndex={0}
      aria-label={`${title} — open details`}
      onClick={() => onOpen(event)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen(event);
        }
      }}
      whileHover={{ y: -1 }}
      whileTap={{ scale: 0.995 }}
      transition={{ type: "spring", stiffness: 500, damping: 34 }}
      className={`group relative flex cursor-pointer gap-3 rounded-xl border bg-slate-900/60 px-3.5 py-3 ring-0 transition-colors duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/60 ${
        active
          ? "border-indigo-400/50 bg-slate-900 ring-1 ring-inset ring-indigo-400/40"
          : `border-slate-800 ring-1 ring-inset ring-transparent hover:border-slate-700 hover:bg-slate-900 ${sev.glow}`
      }`}
    >
      {/* Icon chip */}
      <div
        className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${sev.chip}`}
      >
        <Icon className="h-[18px] w-[18px]" strokeWidth={2} />
      </div>

      {/* Body */}
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-2">
          <p className="truncate text-[13.5px] font-semibold text-slate-100">
            {title}
          </p>
          <time
            dateTime={event.ts}
            title={event.ts}
            className="shrink-0 whitespace-nowrap pt-0.5 text-[11px] tabular-nums text-slate-500"
          >
            {relativeTime(event.ts)}
          </time>
        </div>

        <p className="mt-0.5 truncate text-[12.5px] text-slate-400">
          {description}
        </p>

        <div className="mt-1.5 flex items-center gap-2 text-[11px] text-slate-500">
          <span className="inline-flex items-center gap-1">
            <span className={`h-1.5 w-1.5 rounded-full ${sev.dot}`} />
            <span className="truncate">{actor}</span>
          </span>
          {company ? (
            <>
              <span className="text-slate-700">·</span>
              <span className="truncate text-slate-400">{company}</span>
            </>
          ) : null}
          <span className="text-slate-700">·</span>
          <span className="truncate font-mono text-[10.5px] text-slate-600">
            {event.verb}
          </span>

          {href ? (
            <Link
              href={href}
              onClick={(e) => e.stopPropagation()}
              className="ml-auto inline-flex shrink-0 items-center gap-0.5 rounded-md px-1.5 py-0.5 text-[11px] font-medium text-indigo-300/80 opacity-0 transition hover:bg-indigo-500/10 hover:text-indigo-200 focus:opacity-100 focus-visible:outline-none group-hover:opacity-100"
            >
              Open
              <ArrowUpRight className="h-3 w-3" />
            </Link>
          ) : null}
        </div>
      </div>
    </motion.div>
  );
}
