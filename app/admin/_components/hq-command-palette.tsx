"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { buildHqCommands, matchHqCommand, type HqCommand } from "../_nav/hq-commands";
import { statusLabel } from "@/lib/ai-employees/model";

/**
 * HQ command palette — opens on Cmd/Ctrl+K, the sidebar "Search HQ" pill, or a
 * `cf:hq-command-open` event (the mobile top-bar search button).
 *
 * The internal-operations counterpart to the product's SearchPalette. It is
 * rendered ONLY inside app/admin/layout.tsx, which is gated by requireHqPage(),
 * so a normal CrewFlow customer never loads this component and can never receive
 * an HQ command — role-gating by construction.
 *
 * Extremely fast: every source is in memory. The nav/view commands come from
 * hq-commands.ts (never drifting from the sidebar); the AI-employee results are
 * filtered from the small roster the server layout passes in — no fetch, no
 * server round-trip, so results are instant on every keystroke. It exposes only
 * navigation + "show me" destinations that already exist; it never offers an
 * autonomous-execution shortcut.
 */

export type HqPaletteEmployee = {
  slug: string;
  name: string;
  role: string;
  department: string;
  status: string;
};

/** A recent Decision-Centre record, text-searchable by title (roadmap R033 —
 *  "EVERYTHING searchable" includes AI decision records; the layout passes the
 *  recent bounded set, same no-fetch posture as the roster). */
export type HqPaletteDecision = {
  id: string;
  title: string;
  status: string;
};

type Item =
  | { key: string; kind: "command"; group: string; label: string; href: string; cmd: HqCommand }
  | { key: string; kind: "employee"; group: string; label: string; href: string; emp: HqPaletteEmployee }
  | { key: string; kind: "decision"; group: string; label: string; href: string; dec: HqPaletteDecision };

const STATUS_DOT: Record<string, string> = {
  idle: "bg-slate-300",
  working: "bg-emerald-500",
  waiting_approval: "bg-amber-500",
  blocked: "bg-orange-500",
  error: "bg-red-500",
  disabled: "bg-slate-200",
};

export function HqCommandPalette({
  employees,
  decisions = [],
}: {
  employees: HqPaletteEmployee[];
  decisions?: HqPaletteDecision[];
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const router = useRouter();

  const commands = useMemo(() => buildHqCommands(), []);

  // Global Cmd/Ctrl+K + the `cf:hq-command-open` event (mobile / sidebar pill).
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
    window.addEventListener("cf:hq-command-open", onOpenEvent);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("cf:hq-command-open", onOpenEvent);
    };
  }, [open]);

  // Focus the input on open; reset on close.
  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 10);
    } else {
      setQ("");
      setActive(0);
    }
  }, [open]);

  const items = useMemo<Item[]>(() => {
    const out: Item[] = [];
    const trimmed = q.trim();
    if (!trimmed) {
      // Default: the "Show" verbs, then top-level area destinations.
      for (const c of commands.filter((c) => c.kind === "view")) {
        out.push({ key: c.id, kind: "command", group: c.group, label: c.label, href: c.href, cmd: c });
      }
      for (const c of commands.filter((c) => c.kind === "navigate" && c.id.split("-").length === 2)) {
        out.push({ key: c.id, kind: "command", group: "Go to", label: c.label, href: c.href, cmd: c });
      }
      return out;
    }
    // Query: matching commands first (instant), then matching employees.
    for (const c of commands.filter((c) => matchHqCommand(c, trimmed)).slice(0, 8)) {
      out.push({ key: c.id, kind: "command", group: c.group, label: c.label, href: c.href, cmd: c });
    }
    const needle = trimmed.toLowerCase();
    const empMatches = employees
      .filter(
        (e) =>
          e.name.toLowerCase().includes(needle) ||
          e.role.toLowerCase().includes(needle) ||
          e.department.toLowerCase().includes(needle),
      )
      .slice(0, 6);
    for (const e of empMatches) {
      out.push({
        key: `emp-${e.slug}`,
        kind: "employee",
        group: "AI employees",
        label: e.name,
        href: `/admin/ai-boardroom/${e.slug}`,
        emp: e,
      });
    }
    const decMatches = decisions
      .filter((d) => d.title.toLowerCase().includes(needle))
      .slice(0, 6);
    for (const d of decMatches) {
      out.push({
        key: `dec-${d.id}`,
        kind: "decision",
        group: "Decisions",
        label: d.title,
        href: `/admin/decisions/${d.id}`,
        dec: d,
      });
    }
    return out;
  }, [q, commands, employees, decisions]);

  useEffect(() => {
    setActive((a) => (a >= items.length ? 0 : a));
  }, [items.length]);

  const choose = useCallback(
    (item: Item | undefined) => {
      if (!item) return;
      setOpen(false);
      router.push(item.href);
    },
    [router],
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

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-slate-900/50 px-4 pt-24"
      onClick={() => setOpen(false)}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="HQ search and commands"
        className="w-full max-w-xl overflow-hidden rounded-xl border border-slate-200 bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-slate-200 px-3 py-2.5">
          <span aria-hidden className="text-slate-400">⌘</span>
          <input
            ref={inputRef}
            type="text"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
            placeholder="Search HQ — approvals, decisions, an AI employee… or jump to a page"
            className="flex-1 bg-transparent text-sm outline-none placeholder:text-slate-400"
          />
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
              No matches for “{q}”. Try “approvals”, “blocked”, an employee name, or a page.
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
                      <span aria-hidden className="flex w-4 justify-center text-center text-sm">
                        {item.kind === "employee" ? (
                          <span
                            className={`h-2 w-2 rounded-full ${STATUS_DOT[item.emp.status] ?? "bg-slate-300"}`}
                          />
                        ) : item.kind === "decision" ? (
                          "◆"
                        ) : item.cmd.kind === "view" ? (
                          "›"
                        ) : (
                          "→"
                        )}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-slate-900">
                          {item.label}
                        </span>
                        {item.kind === "employee" ? (
                          <span className="block truncate text-xs text-slate-500">
                            {item.emp.role} · {statusLabel(item.emp.status)}
                          </span>
                        ) : item.kind === "decision" ? (
                          <span className="block truncate text-xs text-slate-500">
                            Decision · {item.dec.status.replace(/_/g, " ")}
                          </span>
                        ) : null}
                      </span>
                      {item.kind === "employee" ? (
                        <span className="shrink-0 text-[10px] font-medium uppercase tracking-wide text-slate-400">
                          {item.emp.department}
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
          ↑↓ to navigate · ⏎ to open · Esc to close · HQ only
        </div>
      </div>
    </div>
  );
}
