/**
 * AI Employee Framework — the reusable base abstraction (CEO Directive 007, Phase 1).
 *
 * This is the "Employee SDK". Every AI employee — CEOAI, CTOAI, SalesAI, … —
 * extends the single `AIEmployee` base class and supplies nothing but a typed
 * `AIEmployeeDefinition` (pure configuration). All shared behaviour lives here
 * exactly once:
 *
 *   • exposing the six dimensions (identity / configuration / runtime / memory
 *     / performance / audit) through one consistent contract,
 *   • deriving an honest "foundation" baseline when no live data exists yet,
 *   • binding live `ai_employees` rows + workforce telemetry onto the runtime /
 *     performance dimensions when data IS present (REUSE, not duplication),
 *   • deriving a transparent health signal, and
 *   • projecting the definition back onto the `ai_employees` row shape for
 *     seeding / reconciliation with the existing data layer.
 *
 * Adding a new employee therefore requires only a new definition (and a thin
 * subclass for a nominal type) — never another system. That is the whole point.
 *
 * PURE: no Supabase / server-only imports. The service layer passes already-read
 * rows + stats into `profile()`; the SDK itself never touches the database.
 */

import {
  AI_EMPLOYEE_STATUSES,
  normalizePermissions,
  type AiEmployee,
  type AiEmployeeStatus,
} from "../model";
import type { EmployeeStats } from "../stats";
import type {
  AIEmployeeProfile,
  EmployeeAudit,
  EmployeeConfiguration,
  EmployeeHealth,
  EmployeeIdentity,
  EmployeeMemory,
  EmployeePerformance,
  EmployeeRuntime,
} from "./dimensions";

/**
 * The pure, declarative definition of one AI employee. "Every AI employee is
 * simply a configuration built on top of the same architecture."
 */
export type AIEmployeeDefinition = {
  identity: EmployeeIdentity;
  configuration: EmployeeConfiguration;
  /** Plain-language responsibilities — what this employee owns. */
  responsibilities: string[];
  /** Deterministic roster ordering (mirrors `ai_employees.sort_order`). */
  sortOrder: number;
};

/** Optional live data the service layer can bind onto a profile. */
export type ProfileBinding = {
  /** The live `ai_employees` row, if this employee is seeded in the DB. */
  row?: AiEmployee | null;
  /** Derived workforce telemetry for this employee, if available. */
  stats?: EmployeeStats | null;
};

/** Narrow an arbitrary status string to a known `AiEmployeeStatus`. */
function coerceStatus(status: string | null | undefined): AiEmployeeStatus {
  return AI_EMPLOYEE_STATUSES.includes(status as AiEmployeeStatus)
    ? (status as AiEmployeeStatus)
    : "idle";
}

/**
 * The base class every specialised AI employee extends. Abstract by intent:
 * you never instantiate a generic employee — you instantiate a role (CEOAI…)
 * or use `defineEmployee()` for a one-off config.
 */
export abstract class AIEmployee {
  readonly definition: AIEmployeeDefinition;

  constructor(definition: AIEmployeeDefinition) {
    this.definition = definition;
  }

  // ---- Identity shortcuts ------------------------------------------
  get slug(): string {
    return this.definition.identity.slug;
  }
  get name(): string {
    return this.definition.identity.name;
  }
  get department(): EmployeeIdentity["department"] {
    return this.definition.identity.department;
  }
  get sortOrder(): number {
    return this.definition.sortOrder;
  }

  identity(): EmployeeIdentity {
    return this.definition.identity;
  }
  configuration(): EmployeeConfiguration {
    return this.definition.configuration;
  }
  responsibilities(): string[] {
    return this.definition.responsibilities;
  }

  // ---- Runtime ------------------------------------------------------
  /** Honest baseline: idle, empty, "foundation" health — never invented. */
  protected foundationRuntime(): EmployeeRuntime {
    return {
      state: "idle",
      currentTask: null,
      previousTasks: [],
      queue: [],
      recommendations: [],
      confidence: null,
      estimatedCompletion: null,
      health: {
        tone: "foundation",
        label: "Foundation",
        reason: "No execution backend is connected yet.",
      },
      lastActivityAt: null,
    };
  }

  /** Bind a live `ai_employees` row onto the runtime dimension. */
  runtimeFrom(row?: AiEmployee | null): EmployeeRuntime {
    const base = this.foundationRuntime();
    if (!row) return base;
    const state = coerceStatus(row.status);
    const currentTask = row.current_task
      ? {
          id: null,
          title: row.current_task,
          status: "in_progress" as const,
          at: row.last_activity_at,
        }
      : null;
    return {
      ...base,
      state,
      currentTask,
      lastActivityAt: row.last_activity_at,
      health: this.deriveHealth(state, null),
    };
  }

  // ---- Performance --------------------------------------------------
  foundationPerformance(): EmployeePerformance {
    return {
      tasksCompleted: 0,
      successRate: null,
      avgCompletionMs: null,
      avgCompletionLabel: "—",
      errors: 0,
      qualityScore: null,
    };
  }

  /** Map already-derived workforce telemetry onto the performance dimension. */
  performanceFrom(stats?: EmployeeStats | null): EmployeePerformance {
    if (!stats) return this.foundationPerformance();
    return {
      tasksCompleted: stats.completed,
      successRate: stats.successRatePct,
      avgCompletionMs: stats.avgCompletionMs,
      avgCompletionLabel: stats.avgCompletionLabel,
      errors: stats.failed,
      // No quality-scoring signal is wired in Phase 1 — stays honestly null.
      qualityScore: null,
    };
  }

  // ---- Memory / Audit (foundation in Phase 1) ----------------------
  foundationMemory(): EmployeeMemory {
    const primaryScope =
      this.definition.configuration.memorySources[0]?.scope ?? "isolated";
    return {
      conversationHistory: [],
      decisions: [],
      previousOutputs: [],
      longTerm: { scope: primaryScope, entries: [] },
      sharedCompany: [],
    };
  }

  foundationAudit(): EmployeeAudit {
    return { actions: [], decisions: [], approvals: [], rejections: [] };
  }

  // ---- Health -------------------------------------------------------
  /** Transparent health derivation — every tone carries its reason. */
  deriveHealth(
    state: AiEmployeeStatus,
    performance: EmployeePerformance | null,
  ): EmployeeHealth {
    if (state === "error") {
      return {
        tone: "attention",
        label: "Attention",
        reason: "Employee is in an error state.",
      };
    }
    if (state === "blocked") {
      return {
        tone: "attention",
        label: "Attention",
        reason: "Employee is blocked awaiting input.",
      };
    }
    if (
      performance &&
      performance.errors > 0 &&
      (performance.successRate ?? 100) < 80
    ) {
      return {
        tone: "attention",
        label: "Attention",
        reason: "Recent task failures detected.",
      };
    }
    if (state === "working" || state === "waiting_approval") {
      return { tone: "healthy", label: "Healthy", reason: "Actively working." };
    }
    if (performance && performance.tasksCompleted > 0) {
      return {
        tone: "steady",
        label: "Steady",
        reason: "Completed work; currently idle.",
      };
    }
    return {
      tone: "foundation",
      label: "Foundation",
      reason: "No execution backend is connected yet.",
    };
  }

  // ---- Full profile -------------------------------------------------
  /** Compose all six dimensions, binding live data where the caller supplies it. */
  profile(binding: ProfileBinding = {}): AIEmployeeProfile {
    const runtime = this.runtimeFrom(binding.row);
    const performance = this.performanceFrom(binding.stats);
    const health = this.deriveHealth(runtime.state, performance);
    return {
      identity: this.identity(),
      configuration: this.configuration(),
      runtime: { ...runtime, health },
      memory: this.foundationMemory(),
      performance,
      audit: this.foundationAudit(),
      // Honest: "foundation" until execution is granted (can_execute === true).
      foundation: !this.configuration().permissions.can_execute,
    };
  }

  /**
   * Project the definition onto the `ai_employees` row shape, so a definition
   * can seed or reconcile with the existing data layer (no duplicate model).
   */
  toEmployeeRowShape(): Pick<
    AiEmployee,
    | "name"
    | "slug"
    | "role"
    | "department"
    | "description"
    | "icon"
    | "accent"
    | "model_provider"
    | "model_name"
    | "system_prompt"
    | "tools_allowed"
    | "permissions"
    | "memory_scope"
    | "sort_order"
  > {
    const id = this.identity();
    const cfg = this.configuration();
    return {
      name: id.name,
      slug: id.slug,
      role: id.role,
      department: id.department,
      description: id.description,
      icon: id.avatar.icon,
      accent: id.avatar.accent,
      model_provider: cfg.model.provider,
      model_name: cfg.model.name,
      system_prompt: cfg.systemPrompt,
      tools_allowed: cfg.tools,
      permissions: normalizePermissions(cfg.permissions),
      memory_scope: cfg.memorySources[0]?.scope ?? "isolated",
      sort_order: this.sortOrder,
    };
  }
}

/**
 * Concrete employee built straight from a definition — no bespoke subclass
 * required. Proves the "config, not code" promise: a brand-new employee can be
 * added with a single object literal.
 */
class ConfiguredAIEmployee extends AIEmployee {}

/** Factory for a one-off / config-only employee. */
export function defineEmployee(definition: AIEmployeeDefinition): AIEmployee {
  return new ConfiguredAIEmployee(definition);
}
