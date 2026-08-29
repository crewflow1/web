"use client";

import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { useRouter, usePathname } from "next/navigation";
import { buildCommands, matchCommand, type Command } from "../_nav/commands";
import type { NavRole } from "../_nav/nav-model";

/**
 * Global command palette — opens on Cmd/Ctrl+K, the header "Search" pill, or a
 * `cf:command-open` event (the mobile nav's Search row).
 *
 * Product UX rebuild, Wave 1C: grown from entity-search-only into the product's
 * primary way to move and act, on one keyboard-first surface:
 *   • CONTEXT — when a job is open, commands that target that job (incl. the
 *     otherwise-orphaned valuations screen);
 *   • CREATE  — action verbs (New job, Create quote, New RAMS…);
 *   • GO TO   — navigate to any authorised destination (from the nav model);
 *   • RESULTS — entity search (unchanged: /api/search over 12 entity types);
 *   • RECENT  — recent destinations, shown when the query is empty.
 *
 * The non-entity half comes from ../_nav/commands.ts so it never drifts from the
 * sidebar/mobile nav. Entity search, the focus trap, and the type→label/icon map
 * (pinned by __tests__/search/palette-type-coverage.test.ts) are preserved.
 */

// Keep this union, TYPE_LABELS and TYPE_ICONS in lockstep with every `type`
// the backend can emit (app/api/search/route.ts). A drift-guard test
// (__tests__/search/palette-type-coverage.test.ts) fails if any backend type
// is missing a label or icon here.
type Hit = {
  type:
    | "customer"
    | "job"
    | "quote"
    | "invoice"
    | "lead"
    | "staff"
    | "risk_assessment"
    | "permit"
    | "job_document"
    | "snag"
    | "purchase_order"
    | "site_report"
    | "supplier"
    | "finance"
    | "blueprint"
    | "asset"
    | "vehicle"
    | "toolbox_talk"
    | "diary_entry"
    | "support_ticket"
    | "staff_qualification"
    | "attachment";
  id: string;
  title: string;
  subtitle: string | null;
  href: string;
};

const TYPE_LABELS: Record<Hit["type"], string> = {
  customer: "Customer",
  job: "Job",
  quote: "Quote",
  invoice: "Invoice",
  lead: "Lead",
  staff: "Staff",
  risk_assessment: "RAMS",
  permit: "Permit",
  job_document: "Document",
  snag: "Snag",
  purchase_order: "PO",
  site_report: "Report",
  supplier: "Supplier",
  finance: "Cost",
  blueprint: "Drawing",
  asset: "Asset",
  vehicle: "Vehicle",
  toolbox_talk: "Toolbox talk",
  diary_entry: "Site diary",
  support_ticket: "Ticket",
  staff_qualification: "Qualification",
  attachment: "File",
};

const TYPE_ICONS: Record<Hit["type"], string> = {
  customer: "👤",
  job: "🔧",
  quote: "📝",
  invoice: "💷",
  lead: "🎯",
  staff: "👷",
  risk_assessment: "🦺",
  permit: "📋",
  job_document: "📄",
  snag: "🚧",
  purchase_order: "🛒",
  site_report: "📑",
  supplier: "🏬",
  finance: "🧾",
  blueprint: "📐",
  asset: "🏗️",
  vehicle: "🚐",
  toolbox_talk: "🗣️",
  diary_entry: "📓",
  support_ticket: "🎫",
  staff_qualification: "🎓",
  attachment: "📎",
};

const RECENTS_KEY = "cf-cmd-recents";

type Recent = { label: string; href: string };

type Item =
  | { key: string; kind: "recent"; group: string; label: string; href: string }
  | { key: string; kind: "command"; group: string; label: string; href: string; cmd: Command }
  | { key: string; kind: "hit"; group: string; label: string; href: string; hit: Hit };

function coerceRole(role: string): NavRole {
  return role === "staff" || role === "admin" || role === "owner" ? role : "owner";
}

export function SearchPalette({
  role = "owner",
  flags = [],
}: {
  role?: string;
  /** Server-resolved feature flags — keeps palette commands derived from the
   *  same flag-filtered nav model as the sidebar/mobile nav. */
  flags?: readonly string[];
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [active, setActive] = useState(0);
  const [loading, setLoading] = useState(false);
  const [recents, setRecents] = useState<Recent[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const router = useRouter();
  const pathname = usePathname();

  const navRole = coerceRole(role);
  const commands = useMemo(
    () => buildCommands(navRole, pathname, flags),
    [navRole, pathname, flags],
  );

  // Load recents once.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(RECENTS_KEY);
      if (raw) setRecents(JSON.parse(raw));
    } catch {
      /* ignore */
    }
  }, []);

  const recordRecent = useCallback((r: Recent) => {
    setRecents((prev) => {
      const next = [r, ...prev.filter((x) => x.href !== r.href)].slice(0, 6);
      try {
        localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);

  // Global Cmd/Ctrl+K + the mobile "cf:command-open" event.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      } else if (e.key === "Escape" && open) {
        setOpen(false);
      } else if (e.key === "Tab" && open) {
        const root = dialogRef.current;
        if (!root) return;
        const f = root.querySelectorAll<HTMLElement>(
          'a[href],button:not([disabled]),input:not([disabled]),[tabindex]:not([tabindex="-1"])',
        );
        const first = f[0];
        const last = f[f.length - 1];
        if (!first || !last) return;
        const activeEl = document.activeElement;
        if (e.shiftKey && (activeEl === first || activeEl === root)) {
          last.focus();
          e.preventDefault();
        } else if (!e.shiftKey && activeEl === last) {
          first.focus();
          e.preventDefault();
        }
      }
    }
    function onOpenEvent() {
      setOpen(true);
    }
    window.addEventListener("keydown", onKey);
    window.addEventListener("cf:command-open", onOpenEvent);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("cf:command-open", onOpenEvent);
    };
  }, [open]);

  // Focus input when opening; reset on close.
  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 10);
    } else {
      setQ("");
      setHits([]);
      setActive(0);
    }
  }, [open]);

  // Debounced entity fetch (2+ chars).
  useEffect(() => {
    if (q.trim().length < 2) {
      setHits([]);
      return;
    }
    const ctrl = new AbortController();
    setLoading(true);
    const timer = setTimeout(async () => {
      try {
        const r = await fetch(`/api/search?q=${encodeURIComponent(q)}`, { signal: ctrl.signal });
        if (r.ok) {
          const j = (await r.json()) as { hits: Hit[] };
          setHits(j.hits ?? []);
        }
      } catch {
        /* ignore aborts */
      } finally {
        setLoading(false);
      }
    }, 200);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [q]);

  // Build the flat, grouped, selectable item list.
  const items = useMemo<Item[]>(() => {
    const out: Item[] = [];
    const trimmed = q.trim();
    if (!trimmed) {
      // Default state: recents, this-job context, a few create actions.
      for (const r of recents) {
        out.push({ key: `r-${r.href}`, kind: "recent", group: "Recent", label: r.label, href: r.href });
      }
      for (const c of commands.filter((c) => c.kind === "context")) {
        out.push({ key: c.id, kind: "command", group: c.group, label: c.label, href: c.href, cmd: c });
      }
      for (const c of commands.filter((c) => c.kind === "action").slice(0, 5)) {
        out.push({ key: c.id, kind: "command", group: c.group, label: c.label, href: c.href, cmd: c });
      }
      return out;
    }
    // Query state: matching commands first (instant), then entity hits.
    for (const c of commands.filter((c) => matchCommand(c, trimmed)).slice(0, 8)) {
      out.push({ key: c.id, kind: "command", group: c.group, label: c.label, href: c.href, cmd: c });
    }
    for (const h of hits) {
      out.push({ key: `h-${h.type}-${h.id}`, kind: "hit", group: "Results", label: h.title, href: h.href, hit: h });
    }
    return out;
  }, [q, recents, commands, hits]);

  // Keep active index valid as items change.
  useEffect(() => {
    setActive((a) => (a >= items.length ? 0 : a));
  }, [items.length]);

  const choose = useCallback(
    (item: Item | undefined) => {
      if (!item) return;
      setOpen(false);
      if (item.kind === "recent") {
        router.push(item.href);
      } else if (item.kind === "command") {
        if (item.cmd.kind !== "context" || !item.href.includes("?")) {
          recordRecent({ label: item.label.replace(/^Go to /, ""), href: item.href });
        }
        router.push(item.href);
      } else {
        recordRecent({ label: item.label, href: item.href });
        router.push(item.href);
      }
    },
    [router, recordRecent],
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActive((a) => Math.min(a + 1, items.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActive((a) => Math.max(a - 1, 0));
      } else if (e.key === "Enter") {
        choose(items[active]);
      }
    },
    [items, active, choose],
  );

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Search (⌘K)"
        className="hidden items-center gap-2 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs text-slate-500 hover:bg-slate-50 sm:inline-flex"
      >
        <span aria-hidden>🔎</span>
        <span>Search</span>
        <kbd className="ml-2 rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[10px] font-mono text-slate-500">
          ⌘K
        </kbd>
      </button>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Search"
        className="rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-sm text-slate-700 hover:bg-slate-50 sm:hidden"
      >
        🔎
      </button>

      {open ? (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center bg-slate-900/50 px-4 pt-24"
          onClick={() => setOpen(false)}
        >
          <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-label="Search and commands"
            className="w-full max-w-xl overflow-hidden rounded-xl border border-slate-200 bg-white shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 border-b border-slate-200 px-3 py-2.5">
              <span aria-hidden className="text-slate-400">🔎</span>
              <input
                ref={inputRef}
                type="text"
                value={q}
                onChange={(e) => {
                  setQ(e.target.value);
                  setActive(0);
                }}
                onKeyDown={onKeyDown}
                placeholder="Search jobs, customers, invoices… or jump to a page"
                className="flex-1 bg-transparent text-sm outline-none placeholder:text-slate-400"
              />
              {loading ? <span className="text-xs text-slate-500">…</span> : null}
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="text-xs text-slate-500 hover:text-slate-900"
                aria-label="Close"
              >
                Esc
              </button>
            </div>

            <div className="max-h-96 overflow-y-auto py-1">
              {items.length === 0 ? (
                <p className="px-3 py-6 text-center text-xs text-slate-500">
                  {q.trim().length >= 2 && !loading
                    ? `No matches for “${q}”.`
                    : "Type to search records, or jump to any page. Try “new job”, “stock”, “overdue”."}
                </p>
              ) : (
                <ul>
                  {items.map((item, i) => {
                    const prev = items[i - 1];
                    const showHeader = !prev || prev.group !== item.group;
                    const isActive = i === active;
                    return (
                      <li key={item.key}>
                        {showHeader ? (
                          <div className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                            {item.group}
                          </div>
                        ) : null}
                        <button
                          type="button"
                          onMouseEnter={() => setActive(i)}
                          onClick={() => choose(item)}
                          className={
                            isActive
                              ? "flex w-full items-center gap-3 bg-slate-100 px-3 py-2 text-left"
                              : "flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-slate-50"
                          }
                        >
                          <span aria-hidden className="w-4 text-center text-sm">
                            {item.kind === "hit"
                              ? TYPE_ICONS[item.hit.type]
                              : item.kind === "recent"
                                ? "🕘"
                                : item.cmd.kind === "action"
                                  ? "＋"
                                  : item.cmd.kind === "context"
                                    ? "◧"
                                    : "→"}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-medium text-slate-900">
                              {item.label}
                            </span>
                            {item.kind === "hit" && item.hit.subtitle ? (
                              <span className="block truncate text-xs text-slate-500">
                                {item.hit.subtitle}
                              </span>
                            ) : null}
                          </span>
                          {item.kind === "hit" ? (
                            <span className="shrink-0 text-[10px] font-medium uppercase tracking-wide text-slate-500">
                              {TYPE_LABELS[item.hit.type]}
                            </span>
                          ) : null}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            <div className="border-t border-slate-100 px-3 py-1.5 text-[10px] text-slate-500">
              ↑↓ to navigate · ⏎ to open · Esc to close
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
