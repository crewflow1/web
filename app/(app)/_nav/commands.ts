import {
  navForRole,
  utilityForRole,
  type NavRole,
} from "./nav-model";

/**
 * Command registry for the palette (product UX rebuild, Wave 1C foundation).
 *
 * The command palette is being grown from entity-search-only into the product's
 * primary way to MOVE and ACT. This module builds the non-entity half of the
 * palette from the single nav model, so navigation commands can never drift from
 * the sidebar/mobile nav:
 *
 *   • NAVIGATE — "Go to {destination}" for every area + child the role can see.
 *   • ACTION   — verbs that jump to a create/entry route (New job, Create quote…).
 *   • CONTEXT  — when inside a job, commands that target THAT job (and, usefully,
 *                surface the previously-orphaned valuations screen).
 *
 * Entity search (customers/jobs/invoices/…) is unchanged and handled by the
 * palette against /api/search. Pure data + a builder — no React, no client
 * boundary — so it is unit-testable.
 */

export type CommandKind = "navigate" | "action" | "context";

export interface Command {
  id: string;
  kind: CommandKind;
  label: string;
  href: string;
  /** Section header shown in the palette. */
  group: string;
  /** Extra match terms (never rendered). */
  keywords?: string[];
}

/** Verb/actions — each jumps to a verified create/entry route. */
interface ActionDef {
  id: string;
  label: string;
  href: string;
  roles?: readonly NavRole[];
  keywords?: string[];
}

const ADMIN: readonly NavRole[] = ["owner", "admin"];

const ACTIONS: ActionDef[] = [
  { id: "new-job", label: "New job", href: "/jobs/new", keywords: ["create", "project"] },
  { id: "new-lead", label: "New lead", href: "/leads/new", roles: ADMIN, keywords: ["create", "enquiry"] },
  { id: "new-quote", label: "Create quote", href: "/quotes/new", roles: ADMIN, keywords: ["estimate", "proposal"] },
  { id: "new-customer", label: "Add customer", href: "/customers/new", roles: ADMIN, keywords: ["client"] },
  { id: "new-invoice", label: "Create invoice", href: "/invoices/new", roles: ADMIN, keywords: ["bill", "get paid"] },
  { id: "new-expense", label: "Record expense", href: "/expenses/new", roles: ADMIN, keywords: ["cost", "spend"] },
  { id: "new-rams", label: "New RAMS", href: "/health-safety/new", roles: ADMIN, keywords: ["risk assessment", "method statement", "safety"] },
  { id: "new-po", label: "New purchase order", href: "/purchase-orders/new", roles: ADMIN, keywords: ["po", "buy", "order"] },
];

function roleAllowed(roles: readonly NavRole[] | undefined, role: NavRole): boolean {
  return !roles || roles.includes(role);
}

/** Matches `/jobs/<id>` (and deeper) and captures the id — for contextual cmds. */
const JOB_RE = /^\/jobs\/([^/]+)(?:\/|$)/;

/**
 * Build the full command list for a role + current path. Entity hits are added
 * separately by the palette from /api/search.
 */
export function buildCommands(role: NavRole, pathname: string): Command[] {
  const cmds: Command[] = [];

  // ── Contextual (a specific job is open) ──
  const jobMatch = pathname.match(JOB_RE);
  const jobId = jobMatch?.[1];
  // Exclude the non-id job routes (/jobs/new, /jobs/calendar, /jobs/templates).
  if (jobId && !["new", "calendar", "templates"].includes(jobId)) {
    const inThisJob = (label: string, sub: string, id: string, keywords?: string[]): Command => ({
      id,
      kind: "context",
      label,
      href: `/jobs/${jobId}${sub}`,
      group: "This job",
      keywords,
    });
    cmds.push(
      inThisJob("Job overview", "", "ctx-job-overview"),
      inThisJob("Job commercial (margin & cost)", "/commercial", "ctx-job-commercial", ["profit", "p&l"]),
      inThisJob("Job valuations (applications for payment)", "/valuations", "ctx-job-valuations", ["application", "interim", "qs"]),
      inThisJob("Job billing", "/billing", "ctx-job-billing", ["invoice"]),
      { id: "ctx-job-cost", kind: "context", label: "Add cost to this job", href: `/finances/new?job_id=${jobId}`, group: "This job", keywords: ["expense", "spend"] },
    );
  }

  // ── Actions ──
  for (const a of ACTIONS) {
    if (!roleAllowed(a.roles, role)) continue;
    cmds.push({ id: `act-${a.id}`, kind: "action", label: a.label, href: a.href, group: "Create", keywords: a.keywords });
  }

  // ── Navigation (from the nav model) ──
  const seen = new Set<string>();
  for (const area of [...navForRole(role), ...utilityForRole(role)]) {
    const areaLabel = area.label;
    if (!seen.has(area.href)) {
      seen.add(area.href);
      cmds.push({
        id: `nav-${area.id}`,
        kind: "navigate",
        label: `Go to ${areaLabel}`,
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
        keywords: [areaLabel, ...(child.keywords ?? [])],
      });
    }
  }

  return cmds;
}

/** Simple case-insensitive substring match over label + keywords. */
export function matchCommand(cmd: Command, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return false;
  if (cmd.label.toLowerCase().includes(needle)) return true;
  return (cmd.keywords ?? []).some((k) => k.toLowerCase().includes(needle));
}
