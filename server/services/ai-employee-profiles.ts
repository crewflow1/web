import "server-only";
import {
  listEmployees,
  getEmployeeBySlug,
  type AIEmployee,
  type AIEmployeeProfile,
  type AuditEntry,
  type AuditKind,
  type EmployeeAudit,
  type MemoryRef,
  type TaskRef,
  type TaskStatus,
} from "@/lib/ai-employees/framework";
import {
  TASK_STATUSES,
  type AiEmployee,
  type AiEmployeeMemoryEntry,
  type AiEmployeeTask,
} from "@/lib/ai-employees/model";
import { computeEmployeeStats } from "@/lib/ai-employees/stats";
import type { AdminActivityRow } from "@/server/services/hq-audit";
import {
  listAiEmployees,
  loadAiEmployeeBySlug,
} from "@/server/services/ai-employees";
import {
  getAiWorkforceStats,
  statsForEmployee,
} from "@/server/services/ai-employee-stats";

/**
 * CrewFlow HQ — AI Employee Framework service binding (CEO Directive 007,
 * Phase 1).
 *
 * The seam between the PURE Employee SDK (`lib/ai-employees/framework`) and
 * the LIVE data layer. It binds the existing `ai_employees` rows + workforce
 * telemetry onto each employee's six-dimension profile — REUSING the services
 * the boardroom already shipped (`listAiEmployees`, `loadAiEmployeeBySlug`,
 * `getAiWorkforceStats`). No new tables, no duplicated reads, no new model.
 *
 * Where an employee has a live row it binds runtime + performance and maps its
 * real task / memory / activity history into the framework's runtime, memory
 * and audit shapes. Where it does not, the SDK's honest "foundation" baseline
 * shows through unchanged — figures are never invented.
 *
 * Service-role only (the ai_employee_* tables are RLS-enabled with no
 * policies); every caller is already past the /admin isSuperAdminEmail gate.
 */

export type RosterEntry = {
  /** The SDK handle — stable identity, config, and the profile composer. */
  employee: AIEmployee;
  /** The composed six dimensions, with live data bound where it exists. */
  profile: AIEmployeeProfile;
  /** True when a live `ai_employees` row backs this employee. */
  seeded: boolean;
};

export type EmployeeProfileDetail = RosterEntry & {
  /** The live row, when seeded — lets the UI surface operator-edited fields. */
  row: AiEmployee | null;
};

// ---- Pure live → framework-dimension mappers ------------------------

function coerceTaskStatus(status: string): TaskStatus {
  return (TASK_STATUSES as ReadonlyArray<string>).includes(status)
    ? (status as TaskStatus)
    : "pending";
}

function toTaskRef(t: AiEmployeeTask): TaskRef {
  return {
    id: t.id,
    title: t.title,
    status: coerceTaskStatus(t.status),
    at: t.completed_at ?? t.created_at,
  };
}

const TERMINAL: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
  "completed",
  "failed",
  "cancelled",
]);

function toMemoryRef(m: AiEmployeeMemoryEntry): MemoryRef {
  const label =
    m.mem_key && m.mem_key.length > 0
      ? m.mem_key
      : m.content.length > 60
        ? `${m.content.slice(0, 57)}…`
        : m.content;
  return { id: m.id, label, kind: m.scope, at: m.created_at };
}

/** Classify an audit-log action into one of the four audit buckets. */
function auditKindOf(action: string): AuditKind {
  const a = action.toLowerCase();
  if (a.includes("approve")) return "approval";
  if (a.includes("reject")) return "rejection";
  if (a.includes("decision") || a.includes("decide")) return "decision";
  return "action";
}

function toAuditEntry(r: AdminActivityRow): AuditEntry {
  const detail =
    r.metadata && typeof r.metadata === "object"
      ? (((r.metadata as Record<string, unknown>).summary as string) ?? null)
      : null;
  return {
    id: r.id,
    at: r.created_at,
    actor: r.actor_email,
    kind: auditKindOf(r.action),
    action: r.action,
    detail,
  };
}

function bucketAudit(rows: ReadonlyArray<AdminActivityRow>): EmployeeAudit {
  const audit: EmployeeAudit = {
    actions: [],
    decisions: [],
    approvals: [],
    rejections: [],
  };
  for (const r of rows) {
    const entry = toAuditEntry(r);
    if (entry.kind === "approval") audit.approvals.push(entry);
    else if (entry.kind === "rejection") audit.rejections.push(entry);
    else if (entry.kind === "decision") audit.decisions.push(entry);
    else audit.actions.push(entry);
  }
  return audit;
}

/**
 * Enrich the SDK-composed profile with the employee's REAL history, mapped
 * into the framework's runtime / memory / audit shapes. Health, identity,
 * configuration and performance come straight from the SDK (unchanged) — this
 * only fills the list-bearing dimensions that the pure SDK can't read.
 */
function enrichProfile(
  base: AIEmployeeProfile,
  tasks: ReadonlyArray<AiEmployeeTask>,
  memory: ReadonlyArray<AiEmployeeMemoryEntry>,
  activity: ReadonlyArray<AdminActivityRow>,
): AIEmployeeProfile {
  const refs = tasks.map(toTaskRef);
  const previousTasks = refs.filter((t) => TERMINAL.has(t.status));
  const queue = refs.filter((t) => t.status === "pending");
  const memoryRefs = memory.map(toMemoryRef);

  return {
    ...base,
    runtime: { ...base.runtime, previousTasks, queue },
    memory: {
      ...base.memory,
      longTerm: { scope: base.memory.longTerm.scope, entries: memoryRefs },
    },
    audit: bucketAudit(activity),
  };
}

// ---- Public API -----------------------------------------------------

/**
 * The whole workforce as six-dimension profiles, in roster order. One bounded
 * read of rows + one bucketed telemetry read back the entire grid — no N+1.
 */
export async function getEmployeeRoster(): Promise<RosterEntry[]> {
  const [rows, ws] = await Promise.all([
    listAiEmployees(),
    getAiWorkforceStats(),
  ]);
  const rowBySlug = new Map(rows.map((r) => [r.slug, r]));

  return listEmployees().map((employee) => {
    const row = rowBySlug.get(employee.slug) ?? null;
    const stats = row ? statsForEmployee(ws, row.id) : null;
    return {
      employee,
      profile: employee.profile({ row, stats }),
      seeded: row != null,
    };
  });
}

/**
 * One employee's full profile, with its real task / memory / activity history
 * bound onto the framework dimensions. Returns null only for an unknown slug
 * (the page maps that to notFound()). An unseeded-but-known employee returns
 * an honest foundation profile.
 */
export async function getEmployeeProfile(
  slug: string,
): Promise<EmployeeProfileDetail | null> {
  const employee = getEmployeeBySlug(slug);
  if (!employee) return null;

  const live = await loadAiEmployeeBySlug(slug);
  if (!live) {
    // Known to the framework, not yet seeded in the DB → honest foundation.
    return { employee, profile: employee.profile(), seeded: false, row: null };
  }

  // Derive this employee's stats from the already-read detail bundle, so the
  // detail view needs no second workforce-wide read. Reuses the pure stats lib.
  const stats = computeEmployeeStats(
    live.tasks.map((t) => ({
      status: t.status,
      title: t.title,
      created_at: t.created_at,
      completed_at: t.completed_at,
    })),
    live.memory.map((m) => ({ content: m.content })),
  );

  const base = employee.profile({ row: live.employee, stats });
  const profile = enrichProfile(base, live.tasks, live.memory, live.activity);

  return { employee, profile, seeded: true, row: live.employee };
}
