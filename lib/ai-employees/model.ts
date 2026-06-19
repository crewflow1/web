/**
 * CrewFlow HQ — AI Employee Framework, pure model + presentation layer.
 *
 * Server/client-safe. NO Supabase / server-only imports — both the
 * service layer and the React components import from here so the
 * vocabulary (statuses, departments, scopes, pills) lives in one
 * place.
 *
 * FRAMEWORK ONLY (CEO Directive 001). Nothing here calls a model
 * provider or executes anything. `model_provider` / `model_name` are
 * inert planning strings; `permissions.can_execute` is always treated
 * as locked in Phase 1 and surfaced read-only in the UI.
 */

import { relativeTime as relativeTimeCore } from "@/lib/time/relative";

// ---------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------

export const AI_EMPLOYEE_STATUSES = [
  "idle",
  "working",
  "waiting_approval",
  "blocked",
  "error",
  "disabled",
] as const;
export type AiEmployeeStatus = (typeof AI_EMPLOYEE_STATUSES)[number];

export const STATUS_LABELS: Record<AiEmployeeStatus, string> = {
  idle: "Idle",
  working: "Working",
  waiting_approval: "Waiting approval",
  blocked: "Blocked",
  error: "Error",
  disabled: "Disabled",
};

export function statusLabel(status: string): string {
  return STATUS_LABELS[(status as AiEmployeeStatus)] ?? status;
}

/** Active states pulse their status dot in the UI. */
export const STATUS_PULSE: Record<AiEmployeeStatus, boolean> = {
  idle: false,
  working: true,
  waiting_approval: true,
  blocked: false,
  error: true,
  disabled: false,
};

// ---------------------------------------------------------------------
// Departments
// ---------------------------------------------------------------------

export const DEPARTMENTS = [
  "executive",
  "engineering",
  "sales",
  "marketing",
  "design",
  "quality",
  "documentation",
  "product",
  "finance",
  "support",
  "operations",
] as const;
export type Department = (typeof DEPARTMENTS)[number];

export const DEPARTMENT_LABELS: Record<Department, string> = {
  executive: "Executive",
  engineering: "Engineering",
  sales: "Sales",
  marketing: "Marketing",
  design: "Design",
  quality: "Quality",
  documentation: "Documentation",
  product: "Product",
  finance: "Finance",
  support: "Support",
  operations: "Operations",
};

export function departmentLabel(dept: string): string {
  return DEPARTMENT_LABELS[(dept as Department)] ?? dept;
}

// ---------------------------------------------------------------------
// Memory scope
// ---------------------------------------------------------------------

export const MEMORY_SCOPES = [
  "isolated",
  "department",
  "organization",
  "global",
] as const;
export type MemoryScope = (typeof MEMORY_SCOPES)[number];

export const MEMORY_SCOPE_LABELS: Record<MemoryScope, string> = {
  isolated: "Isolated",
  department: "Department-shared",
  organization: "Organization-wide",
  global: "Global",
};

export const MEMORY_SCOPE_HELP: Record<MemoryScope, string> = {
  isolated: "Only this employee can read its own memory.",
  department: "Shared across employees in the same department.",
  organization: "Readable by every AI employee in the org.",
  global: "Shared across the entire boardroom.",
};

export function memoryScopeLabel(scope: string): string {
  return MEMORY_SCOPE_LABELS[(scope as MemoryScope)] ?? scope;
}

// ---------------------------------------------------------------------
// Task status
// ---------------------------------------------------------------------

export const TASK_STATUSES = [
  "pending",
  "in_progress",
  "waiting_approval",
  "completed",
  "failed",
  "cancelled",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  pending: "Pending",
  in_progress: "In progress",
  waiting_approval: "Waiting approval",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

export function taskStatusLabel(status: string): string {
  return TASK_STATUS_LABELS[(status as TaskStatus)] ?? status;
}

// ---------------------------------------------------------------------
// Accent tokens — keyed by the seeded `accent` value. The Tailwind
// class strings that render these live in
// app/admin/ai-boardroom/_styles.ts (so the JIT scanner, which only
// globs app/components/emails, picks them up). This module stays free
// of presentation classes so it remains a pure, portable data layer.
// ---------------------------------------------------------------------

export const ACCENTS = [
  "violet",
  "sky",
  "emerald",
  "pink",
  "fuchsia",
  "amber",
  "cyan",
  "indigo",
  "green",
  "blue",
  "slate",
] as const;
export type Accent = (typeof ACCENTS)[number];

// ---------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------

export type AiPermissions = {
  /** Phase 1: always false. Surfaced read-only. */
  can_execute: boolean;
  requires_approval: boolean;
  scopes: string[];
};

/**
 * Coerce arbitrary jsonb into the permissions shape, defaulting to the
 * locked-down posture. `can_execute` is forced to a boolean and the
 * UI renders it read-only — the framework never grants execution in
 * Phase 1.
 */
export function normalizePermissions(input: unknown): AiPermissions {
  const obj = (input && typeof input === "object" ? input : {}) as Record<
    string,
    unknown
  >;
  const scopes = Array.isArray(obj.scopes)
    ? obj.scopes.filter((s): s is string => typeof s === "string")
    : [];
  return {
    can_execute: obj.can_execute === true,
    requires_approval: obj.requires_approval !== false,
    scopes,
  };
}

// ---------------------------------------------------------------------
// Domain row types (mirror the DB columns)
// ---------------------------------------------------------------------

export type AiEmployee = {
  id: string;
  name: string;
  slug: string;
  role: string;
  department: string;
  description: string;
  icon: string;
  accent: string;
  status: string;
  model_provider: string | null;
  model_name: string | null;
  system_prompt: string;
  tools_allowed: string[];
  permissions: AiPermissions;
  memory_scope: string;
  current_task: string | null;
  last_activity_at: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
};

export type AiEmployeeTask = {
  id: string;
  ai_employee_id: string;
  title: string;
  status: string;
  summary: string | null;
  created_by_email: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

export type AiEmployeeMemoryEntry = {
  id: string;
  ai_employee_id: string;
  scope: string;
  mem_key: string | null;
  content: string;
  created_at: string;
  updated_at: string;
};

// ---------------------------------------------------------------------
// Small formatting helpers (pure)
// ---------------------------------------------------------------------

/** "—" | "just now" | "12m ago" | "3h ago" | "5d ago" | ISO date. */
export function relativeTime(iso: string | null): string {
  return relativeTimeCore(iso);
}

/** Count employees per status — drives the boardroom status cards. */
export function countByStatus(
  employees: ReadonlyArray<{ status: string }>,
): Record<AiEmployeeStatus, number> {
  const counts = {
    idle: 0,
    working: 0,
    waiting_approval: 0,
    blocked: 0,
    error: 0,
    disabled: 0,
  } as Record<AiEmployeeStatus, number>;
  for (const e of employees) {
    if ((e.status as AiEmployeeStatus) in counts) {
      counts[e.status as AiEmployeeStatus] += 1;
    }
  }
  return counts;
}
