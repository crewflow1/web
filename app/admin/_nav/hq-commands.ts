import { HQ_AREAS } from "./hq-nav-model";

/**
 * HQ command registry — the non-entity half of the HQ command palette
 * (product UX rebuild, HQ phase).
 *
 * The HQ palette is a SEPARATE surface from the product palette
 * (app/(app)/_nav/commands.ts): it is built + rendered only inside the HQ
 * layout, which is gated by `requireHqPage()`. A normal CrewFlow customer never
 * loads this module and can never receive an HQ command — role-gating by
 * construction, not by a runtime check that could drift.
 *
 * Two kinds:
 *   • NAVIGATE — "Go to {destination}" for every HQ area + child, read from the
 *     one HQ nav model so it can never drift from the sidebar/mobile drawer.
 *   • VIEW     — "Show pending approvals / blocked work / failed runs…" — verbs
 *     that jump to a REAL existing destination. Every href here is a live HQ
 *     page (or an anchor on HQ Home); none invents an autonomous-execution
 *     shortcut. Employee search is handled separately by the palette against the
 *     roster the layout passes in.
 *
 * Pure data + builders (no React, no client boundary) so it is unit-testable and
 * importable by the server layout.
 */

export type HqCommandKind = "navigate" | "view";

export interface HqCommand {
  id: string;
  kind: HqCommandKind;
  label: string;
  href: string;
  /** Section header shown in the palette. */
  group: string;
  /** Extra match terms (never rendered). */
  keywords?: string[];
}

/**
 * Contextual "show me X" verbs. Every href is a real HQ destination:
 *   - approvals / decisions / tasks / ops are live pages;
 *   - "recent outcomes" and "what's happening now" anchor onto HQ Home's
 *     Recent + Active sections (ids `#recent` / `#active`).
 * These SURFACE state; none of them executes anything.
 */
const VIEWS: ReadonlyArray<{
  id: string;
  label: string;
  href: string;
  keywords?: string[];
}> = [
  {
    id: "needs-you",
    label: "Show what needs you",
    href: "/admin#needs",
    keywords: ["attention", "inbox", "action", "todo"],
  },
  {
    id: "pending-approvals",
    label: "Show pending approvals",
    href: "/admin/approvals",
    keywords: ["approve", "waiting", "sign off", "authorise"],
  },
  {
    id: "decisions-awaiting",
    label: "Show decisions awaiting input",
    href: "/admin/decisions",
    keywords: ["decide", "proposed", "verdict"],
  },
  {
    id: "blocked-work",
    label: "Show blocked work",
    href: "/admin/tasks",
    keywords: ["stuck", "stalled", "queue"],
  },
  {
    id: "active-now",
    label: "Show what's happening now",
    href: "/admin#active",
    keywords: ["active", "running", "in progress", "live"],
  },
  {
    id: "recent-outcomes",
    label: "Show recent outcomes",
    href: "/admin#recent",
    keywords: ["completed", "done", "finished", "shipped", "applied"],
  },
  {
    id: "failed-runs",
    label: "Show failed runs",
    href: "/admin/ops",
    keywords: ["errors", "failures", "cron", "exceptions", "health"],
  },
];

/**
 * Build the full HQ command list (navigate + view). Employee results are added
 * separately by the palette from the roster prop.
 */
export function buildHqCommands(): HqCommand[] {
  const cmds: HqCommand[] = [];

  // ── Show / views (verbs) ──
  for (const v of VIEWS) {
    cmds.push({
      id: `view-${v.id}`,
      kind: "view",
      label: v.label,
      href: v.href,
      group: "Show",
      keywords: v.keywords,
    });
  }

  // ── Navigate (from the one HQ nav model) ──
  const seen = new Set<string>();
  for (const area of HQ_AREAS) {
    if (!seen.has(area.href)) {
      seen.add(area.href);
      cmds.push({
        id: `nav-${area.id}`,
        kind: "navigate",
        label: `Go to ${area.label}`,
        href: area.href,
        group: "Go to",
      });
    }
    for (const child of area.children) {
      if (seen.has(child.href)) continue;
      seen.add(child.href);
      cmds.push({
        id: `nav-${area.id}-${child.href}`,
        kind: "navigate",
        label: `Go to ${child.label}`,
        href: child.href,
        group: "Go to",
        keywords: [area.label],
      });
    }
  }

  return cmds;
}

/** Case-insensitive substring match over label + keywords. */
export function matchHqCommand(cmd: HqCommand, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return false;
  if (cmd.label.toLowerCase().includes(needle)) return true;
  return (cmd.keywords ?? []).some((k) => k.toLowerCase().includes(needle));
}
