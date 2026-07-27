"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { X, ArrowUpRight, Link2, Check, Copy } from "lucide-react";
import type { TimelineEvent } from "@/server/services/spine-timeline";
import {
  eventIcon,
  describeEvent,
  eventHref,
  actorLabel,
  companyLabel,
  severityToken,
  relativeTime,
  absoluteTime,
  shortId,
} from "@/lib/events/render";
import { Skeleton } from "./_primitives";

/**
 * The Pulse — detail drawer (Module 1, PR5 / CEO Directive #005, STEP 5).
 *
 * Everything the directive asks of the drawer: the full event, its payload,
 * related-object deep links, the correlation chain, metadata, timestamps, event
 * ids, replay info, and a raw-envelope debug block. The whole surface is HQ-gated
 * (the page is), so the debug section is always permitted.
 *
 * Opens instantly from the card click with the row the feed already holds, then
 * lazily fetches the correlation chain from /api/hq/pulse/:id. A right-side drawer
 * on desktop; a bottom sheet on small screens (slide direction switches with the
 * breakpoint). Backdrop blur, spring slide, ESC + backdrop close, body-scroll lock
 * — all reduced-motion aware.
 */

function useIsMobile(): boolean {
  const [mobile, setMobile] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 640px)");
    const on = () => setMobile(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return mobile;
}

export function DetailDrawer({
  event,
  onClose,
  onOpen,
}: {
  event: TimelineEvent | null;
  onClose: () => void;
  onOpen: (event: TimelineEvent) => void;
}) {
  const reduce = useReducedMotion();
  const isMobile = useIsMobile();
  const [chain, setChain] = useState<TimelineEvent[] | null>(null);
  const [chainError, setChainError] = useState(false);

  const open = event !== null;
  const eventId = event?.event_id ?? null;

  // Body-scroll lock + ESC while open.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  // Lazily fetch the correlation chain whenever the open event changes.
  useEffect(() => {
    if (eventId == null) return;
    let cancelled = false;
    setChain(null);
    setChainError(false);
    const ctrl = new AbortController();
    (async () => {
      try {
        const res = await fetch(`/api/hq/pulse/${eventId}`, {
          signal: ctrl.signal,
          cache: "no-store",
        });
        if (!res.ok) throw new Error(String(res.status));
        const data = (await res.json()) as { correlation?: TimelineEvent[] };
        if (!cancelled) setChain(Array.isArray(data.correlation) ? data.correlation : []);
      } catch (e) {
        if (!cancelled && !(e instanceof DOMException && e.name === "AbortError")) {
          setChainError(true);
          setChain([]);
        }
      }
    })();
    return () => {
      cancelled = true;
      ctrl.abort();
    };
  }, [eventId]);

  const slide = isMobile
    ? { initial: { y: "100%" }, animate: { y: 0 }, exit: { y: "100%" } }
    : { initial: { x: "100%" }, animate: { x: 0 }, exit: { x: "100%" } };

  return (
    <AnimatePresence>
      {open && event ? (
        <motion.div
          className="fixed inset-0 z-50"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
        >
          {/* Backdrop */}
          <button
            type="button"
            aria-label="Close details"
            onClick={onClose}
            className="absolute inset-0 bg-slate-950/60 backdrop-blur-sm"
          />

          {/* Panel */}
          <motion.aside
            role="dialog"
            aria-modal="true"
            aria-label="Event details"
            initial={reduce ? { opacity: 0 } : slide.initial}
            animate={reduce ? { opacity: 1 } : slide.animate}
            exit={reduce ? { opacity: 0 } : slide.exit}
            transition={{ type: "spring", stiffness: 360, damping: 38 }}
            className="absolute inset-x-0 bottom-0 flex max-h-[88vh] flex-col rounded-t-2xl border border-slate-800 bg-slate-950 text-slate-100 shadow-2xl sm:inset-y-0 sm:left-auto sm:right-0 sm:max-h-none sm:w-[460px] sm:rounded-none sm:rounded-l-2xl sm:border-y-0 sm:border-r-0"
          >
            <DrawerBody event={event} chain={chain} chainError={chainError} onClose={onClose} onOpen={onOpen} />
          </motion.aside>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

function DrawerBody({
  event,
  chain,
  chainError,
  onClose,
  onOpen,
}: {
  event: TimelineEvent;
  chain: TimelineEvent[] | null;
  chainError: boolean;
  onClose: () => void;
  onOpen: (event: TimelineEvent) => void;
}) {
  const Icon = eventIcon(event.verb);
  const { title, description } = describeEvent(event);
  const sev = severityToken(event.severity);
  const href = eventHref(event);
  const company = companyLabel(event);
  const payloadKeys = Object.keys(event.payload ?? {});

  return (
    <>
      {/* Grab handle (mobile) */}
      <div className="mx-auto mt-2 h-1 w-9 shrink-0 rounded-full bg-slate-700 sm:hidden" />

      {/* Header */}
      <header className="flex items-start gap-3 border-b border-slate-800/80 px-5 py-4">
        <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${sev.chip}`}>
          <Icon className="h-5 w-5" strokeWidth={2} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-base font-bold text-slate-50">{title}</h2>
            <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${sev.badge}`}>
              {sev.label}
            </span>
          </div>
          <p className="mt-0.5 truncate text-[12.5px] text-slate-400">{description}</p>
          <p className="mt-1 font-mono text-[11px] text-slate-500">{event.verb}</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="-mr-1 rounded-md p-1.5 text-slate-400 transition hover:bg-slate-800 hover:text-slate-100"
        >
          <X className="h-[18px] w-[18px]" />
        </button>
      </header>

      {/* Scroll body */}
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {/* Deep links */}
        {(href || event.target_type) && (
          <div className="mb-4 flex flex-wrap gap-2">
            {href ? (
              <Link
                href={href}
                className="inline-flex items-center gap-1.5 rounded-lg border border-indigo-400/30 bg-indigo-500/10 px-3 py-1.5 text-[12px] font-medium text-indigo-200 transition hover:bg-indigo-500/20"
              >
                <ArrowUpRight className="h-3.5 w-3.5" />
                Open {event.object_type}
              </Link>
            ) : null}
            {event.target_type && event.target_id ? (
              <span className="inline-flex items-center gap-1.5 rounded-lg border border-slate-800 bg-slate-900/60 px-3 py-1.5 text-[12px] text-slate-300">
                <Link2 className="h-3.5 w-3.5 text-slate-500" />
                {event.target_type} · {shortId(event.target_id)}
              </span>
            ) : null}
          </div>
        )}

        {/* Facts */}
        <Section label="Details">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
            <Fact label="Actor" value={actorLabel(event)} hint={event.actor_type} />
            <Fact label="Company" value={company} />
            <Fact label="Object" value={`${event.object_type}`} hint={shortId(event.object_id)} />
            <Fact label="Visibility" value={event.visibility} />
            <Fact label="When" value={relativeTime(event.ts)} hint={absoluteTime(event.ts)} className="col-span-2" />
          </dl>
        </Section>

        {/* Payload */}
        <Section label={`Payload${payloadKeys.length ? ` · ${payloadKeys.length} field${payloadKeys.length === 1 ? "" : "s"}` : ""}`}>
          {payloadKeys.length === 0 ? (
            <p className="text-[12px] text-slate-500">No payload.</p>
          ) : (
            <pre className="max-h-64 overflow-auto rounded-lg border border-slate-800 bg-slate-900/60 p-3 text-[11.5px] leading-relaxed text-slate-300">
              {JSON.stringify(event.payload, null, 2)}
            </pre>
          )}
        </Section>

        {/* Correlation chain */}
        <Section label="Correlation chain">
          {chain === null ? (
            <div className="space-y-2">
              <Skeleton className="h-11 w-full" />
              <Skeleton className="h-11 w-3/4" />
            </div>
          ) : chainError ? (
            <p className="text-[12px] text-rose-300/80">Couldn&apos;t load the related events.</p>
          ) : chain.length <= 1 ? (
            <p className="text-[12px] text-slate-500">No related events — this one stands alone.</p>
          ) : (
            <ol className="relative space-y-1.5 before:absolute before:bottom-2 before:left-[15px] before:top-2 before:w-px before:bg-slate-800">
              {chain.map((ev) => {
                const RowIcon = eventIcon(ev.verb);
                const rsev = severityToken(ev.severity);
                const current = ev.event_id === event.event_id;
                return (
                  <li key={ev.event_id} className="relative">
                    <button
                      type="button"
                      onClick={() => !current && onOpen(ev)}
                      disabled={current}
                      className={`flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition ${
                        current
                          ? "bg-indigo-500/10 ring-1 ring-inset ring-indigo-400/30"
                          : "hover:bg-slate-900"
                      }`}
                    >
                      <span className={`z-10 flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-lg ${rsev.chip}`}>
                        <RowIcon className="h-3.5 w-3.5" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[12px] font-medium text-slate-200">
                          {describeEvent(ev).title}
                        </span>
                        <span className="block truncate font-mono text-[10px] text-slate-500">
                          #{ev.event_id} · {relativeTime(ev.ts)}
                        </span>
                      </span>
                      {current ? (
                        <span className="shrink-0 text-[10px] font-medium text-indigo-300">This event</span>
                      ) : null}
                    </button>
                  </li>
                );
              })}
            </ol>
          )}
        </Section>

        {/* Identity / replay / debug — HQ only (the whole page is) */}
        <Section label="Identity & replay">
          <dl className="space-y-2.5">
            <IdRow label="Event ID" value={String(event.event_id)} mono />
            <IdRow label="Correlation ID" value={event.correlation_id} mono />
            <IdRow label="Causation ID" value={event.causation_id != null ? String(event.causation_id) : "—"} mono />
            <Fact label="Projected at" value={absoluteTime(event.projected_at)} />
            <p className="pt-1 text-[11px] leading-relaxed text-slate-500">
              Spine offset <span className="font-mono text-slate-400">#{event.event_id}</span> — the
              timeline is a CQRS projection of <span className="font-mono text-slate-400">hq_events</span>;
              re-applying this event is idempotent on <span className="font-mono text-slate-400">event_id</span>.
            </p>
          </dl>
        </Section>

        <details className="group mt-1">
          <summary className="cursor-pointer list-none text-[11px] font-semibold uppercase tracking-wide text-slate-500 transition hover:text-slate-300">
            <span className="inline-flex items-center gap-1">Raw event<span className="text-slate-600 group-open:hidden">▸</span><span className="hidden text-slate-600 group-open:inline">▾</span></span>
          </summary>
          <pre className="mt-2 max-h-72 overflow-auto rounded-lg border border-slate-800 bg-slate-900/60 p-3 text-[11px] leading-relaxed text-slate-400">
            {JSON.stringify(event, null, 2)}
          </pre>
        </details>
      </div>
    </>
  );
}

// --- small helpers -----------------------------------------------------------

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section className="mb-5 last:mb-0">
      <h3 className="mb-2 text-[10.5px] font-semibold uppercase tracking-wider text-slate-500">
        {label}
      </h3>
      {children}
    </section>
  );
}

function Fact({
  label,
  value,
  hint,
  className = "",
}: {
  label: string;
  value: string | null;
  hint?: string | null;
  className?: string;
}) {
  return (
    <div className={className}>
      <dt className="text-[10.5px] uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="mt-0.5 truncate text-[13px] text-slate-200" title={value ?? undefined}>
        {value ?? "—"}
        {hint ? <span className="ml-1.5 font-mono text-[11px] text-slate-500">{hint}</span> : null}
      </dd>
    </div>
  );
}

function IdRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard blocked — non-fatal */
    }
  };
  return (
    <div className="flex items-center justify-between gap-2">
      <dt className="text-[11px] text-slate-500">{label}</dt>
      <dd className="flex min-w-0 items-center gap-1.5">
        <span className={`truncate text-[12px] text-slate-300 ${mono ? "font-mono" : ""}`}>{value}</span>
        {value !== "—" ? (
          <button
            type="button"
            onClick={copy}
            aria-label={`Copy ${label}`}
            className="shrink-0 rounded p-0.5 text-slate-500 transition hover:text-slate-200"
          >
            {copied ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
          </button>
        ) : null}
      </dd>
    </div>
  );
}
