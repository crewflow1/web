import { describe, it, expect } from "vitest";
import {
  AI_EMPLOYEE_REGISTRY,
  listEmployees,
  getEmployeeBySlug,
  getEmployeesByDepartment,
  employeeSlugs,
  defineEmployee,
  AIEmployee,
  type AIEmployeeDefinition,
  type EmployeePerformance,
} from "@/lib/ai-employees/framework";
import {
  normalizePermissions,
  type AiEmployee,
  type AiEmployeeStatus,
} from "@/lib/ai-employees/model";
import type { EmployeeStats } from "@/lib/ai-employees/stats";

/**
 * AI Employee Framework — the "Employee SDK" contract (CEO Directive 007,
 * Phase 1).
 *
 * The directive's architecture: one reusable `AIEmployee` base, and every
 * specialised employee is "simply a configuration built on top of the same
 * architecture." These tests prove that promise without a database:
 *
 *   • the registry is the single source of truth for the 11-strong roster,
 *   • every employee exposes the SAME six dimensions through one contract,
 *   • each definition aligns EXACTLY with the seeded `ai_employees` row
 *     (so the SDK and the DB are one source of truth, not two),
 *   • figures are an honest "foundation" baseline until live data binds,
 *   • live rows + telemetry bind onto runtime/performance with no new code,
 *   • health is derived transparently (every tone carries a reason), and
 *   • a brand-new employee needs only a config object (defineEmployee).
 *
 * PURE: the SDK has no Supabase imports, so this suite is fast + deterministic.
 */

// ---- Test fixtures (pure row / stats builders) ----------------------

function makeRow(overrides: Partial<AiEmployee> = {}): AiEmployee {
  return {
    id: "emp-1",
    name: "Fixture",
    slug: "fixture",
    role: "Fixture role",
    department: "sales",
    description: "Fixture description",
    icon: "circle",
    accent: "emerald",
    status: "idle",
    model_provider: "anthropic",
    model_name: "claude-sonnet-4-6",
    system_prompt: "Fixture prompt",
    tools_allowed: [],
    permissions: { can_execute: false, requires_approval: true, scopes: [] },
    memory_scope: "department",
    current_task: null,
    last_activity_at: null,
    sort_order: 1,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeStats(overrides: Partial<EmployeeStats> = {}): EmployeeStats {
  return {
    tasksToday: 0,
    tasksTotal: 0,
    completed: 0,
    failed: 0,
    inProgress: 0,
    successRatePct: null,
    avgCompletionMs: null,
    avgCompletionLabel: "—",
    lastCompletedTitle: null,
    lastCompletedAt: null,
    knowledgeVersion: 1,
    memoryEntries: 0,
    memoryChars: 0,
    memoryUsageLabel: "0 B",
    ...overrides,
  };
}

/**
 * The canonical roster contract — mirrors the seed migration
 * (20260712000100_ai_employees_seed.sql) verbatim. Pinning it here proves
 * the SDK config and the DB row are a SINGLE source of truth: drift in
 * either direction fails the build.
 */
const EXPECTED = [
  { slug: "ceo-ai", name: "CEO AI", emoji: "👑", icon: "crown", accent: "violet", department: "executive", model: "claude-opus-4-7", scope: "global", sortOrder: 10 },
  { slug: "cto-ai", name: "CTO AI", emoji: "💻", icon: "cpu", accent: "sky", department: "engineering", model: "claude-opus-4-7", scope: "organization", sortOrder: 20 },
  { slug: "sales-ai", name: "Sales AI", emoji: "📈", icon: "trending-up", accent: "emerald", department: "sales", model: "claude-sonnet-4-6", scope: "department", sortOrder: 30 },
  { slug: "marketing-ai", name: "Marketing AI", emoji: "📣", icon: "megaphone", accent: "pink", department: "marketing", model: "claude-sonnet-4-6", scope: "department", sortOrder: 40 },
  { slug: "design-ai", name: "Design AI", emoji: "🎨", icon: "palette", accent: "fuchsia", department: "design", model: "claude-sonnet-4-6", scope: "department", sortOrder: 50 },
  { slug: "qa-ai", name: "QA AI", emoji: "🧪", icon: "shield-check", accent: "amber", department: "quality", model: "claude-sonnet-4-6", scope: "organization", sortOrder: 60 },
  { slug: "documentation-ai", name: "Documentation AI", emoji: "📚", icon: "book-open", accent: "cyan", department: "documentation", model: "claude-sonnet-4-6", scope: "organization", sortOrder: 70 },
  { slug: "product-ai", name: "Product AI", emoji: "📊", icon: "compass", accent: "indigo", department: "product", model: "claude-opus-4-7", scope: "organization", sortOrder: 80 },
  { slug: "finance-ai", name: "Finance AI", emoji: "💰", icon: "banknote", accent: "green", department: "finance", model: "claude-sonnet-4-6", scope: "organization", sortOrder: 90 },
  { slug: "support-ai", name: "Support AI", emoji: "📞", icon: "life-buoy", accent: "blue", department: "support", model: "claude-haiku-4-5", scope: "department", sortOrder: 100 },
  { slug: "operations-ai", name: "Operations AI", emoji: "⚙️", icon: "settings-2", accent: "slate", department: "operations", model: "claude-sonnet-4-6", scope: "global", sortOrder: 110 },
] as const;

// =====================================================================
// 1. Registry — the single source of truth
// =====================================================================

describe("Directive 007 — registry completeness", () => {
  it("holds exactly the 11 directive employees, in roster order", () => {
    expect(listEmployees()).toHaveLength(11);
    expect(employeeSlugs()).toEqual(EXPECTED.map((e) => e.slug));
  });

  it("is sorted by sortOrder (deterministic display order)", () => {
    const orders = listEmployees().map((e) => e.sortOrder);
    expect(orders).toEqual([...orders].sort((a, b) => a - b));
  });

  it("has unique slugs and unique sortOrders", () => {
    const slugs = employeeSlugs();
    expect(new Set(slugs).size).toBe(slugs.length);
    const orders = listEmployees().map((e) => e.sortOrder);
    expect(new Set(orders).size).toBe(orders.length);
  });

  it("is frozen — consumers cannot mutate the shared roster", () => {
    expect(Object.isFrozen(AI_EMPLOYEE_REGISTRY)).toBe(true);
  });

  it("getEmployeeBySlug resolves known slugs and rejects unknown", () => {
    expect(getEmployeeBySlug("ceo-ai")?.name).toBe("CEO AI");
    expect(getEmployeeBySlug("not-real")).toBeUndefined();
  });

  it("getEmployeesByDepartment filters to the right roster slice", () => {
    expect(getEmployeesByDepartment("executive").map((e) => e.slug)).toEqual([
      "ceo-ai",
    ]);
    expect(getEmployeesByDepartment("sales").map((e) => e.slug)).toEqual([
      "sales-ai",
    ]);
  });

  it("every specialised employee is an AIEmployee (one shared base)", () => {
    for (const e of listEmployees()) expect(e).toBeInstanceOf(AIEmployee);
  });
});

// =====================================================================
// 2. Config ↔ seed alignment (SDK and DB are one source of truth)
// =====================================================================

describe("Directive 007 — definitions mirror the seeded ai_employees row", () => {
  for (const exp of EXPECTED) {
    it(`${exp.slug}: identity + model + scope + sortOrder match the seed`, () => {
      const e = getEmployeeBySlug(exp.slug);
      expect(e, exp.slug).toBeTruthy();
      const id = e!.identity();
      const cfg = e!.configuration();
      expect(id.name).toBe(exp.name);
      expect(id.department).toBe(exp.department);
      expect(id.avatar.emoji).toBe(exp.emoji);
      expect(id.avatar.icon).toBe(exp.icon);
      expect(id.avatar.accent).toBe(exp.accent);
      expect(cfg.model.provider).toBe("anthropic");
      expect(cfg.model.name).toBe(exp.model);
      expect(cfg.memorySources[0]?.scope).toBe(exp.scope);
      expect(e!.sortOrder).toBe(exp.sortOrder);
    });
  }

  it("projects back onto the ai_employees row shape for seed/reconcile", () => {
    const ceo = getEmployeeBySlug("ceo-ai")!;
    const row = ceo.toEmployeeRowShape();
    expect(row).toMatchObject({
      name: "CEO AI",
      slug: "ceo-ai",
      department: "executive",
      icon: "crown",
      accent: "violet",
      model_provider: "anthropic",
      model_name: "claude-opus-4-7",
      memory_scope: "global",
      sort_order: 10,
    });
    expect(row.tools_allowed).toContain("draft_strategy");
    expect(row.system_prompt.length).toBeGreaterThan(0);
  });
});

// =====================================================================
// 3. Six-dimension contract — every employee, same shape
// =====================================================================

describe("Directive 007 — every employee exposes all six dimensions", () => {
  for (const e of AI_EMPLOYEE_REGISTRY) {
    it(`${e.slug}: identity / configuration / runtime / memory / performance / audit`, () => {
      const p = e.profile();

      // 1. Identity
      expect(p.identity.slug).toBe(e.slug);
      expect(p.identity.name.length).toBeGreaterThan(0);
      expect(p.identity.tagline.length).toBeGreaterThan(0);
      expect(p.identity.description.length).toBeGreaterThan(0);

      // 2. Configuration — model, prompt, knowledge, memory, tools, perms
      expect(p.configuration.model.temperature).toBeGreaterThanOrEqual(0);
      expect(p.configuration.model.temperature).toBeLessThanOrEqual(1);
      expect(p.configuration.systemPrompt.length).toBeGreaterThan(0);
      expect(p.configuration.systemPrompt.length).toBeLessThanOrEqual(20_000);
      expect(p.configuration.knowledgeSources.length).toBeGreaterThan(0);
      expect(p.configuration.memorySources.length).toBeGreaterThan(0);
      expect(p.configuration.tools.length).toBeGreaterThan(0);
      // Phase 1 locked posture — no employee may execute autonomously.
      expect(p.configuration.permissions.can_execute).toBe(false);
      expect(p.configuration.permissions.requires_approval).toBe(true);

      // 3. Runtime
      expect(p.runtime.state).toBe("idle");
      expect(p.runtime.health.reason.length).toBeGreaterThan(0);

      // 4. Memory
      expect(p.memory.longTerm.scope).toBe(
        e.configuration().memorySources[0]?.scope,
      );

      // 5. Performance
      expect(p.performance.tasksCompleted).toBe(0);

      // 6. Audit
      expect(Array.isArray(p.audit.actions)).toBe(true);
      expect(Array.isArray(p.audit.decisions)).toBe(true);
      expect(Array.isArray(p.audit.approvals)).toBe(true);
      expect(Array.isArray(p.audit.rejections)).toBe(true);

      // Responsibilities — what this employee owns.
      expect(e.responsibilities().length).toBeGreaterThan(0);
    });
  }
});

// =====================================================================
// 4. Honest foundation baseline (no live data bound)
// =====================================================================

describe("Directive 007 — unbound profiles are an honest foundation", () => {
  it("idle, empty, foundation health, foundation flag true, never invented", () => {
    const p = getEmployeeBySlug("finance-ai")!.profile();
    expect(p.foundation).toBe(true); // can_execute === false
    expect(p.runtime.state).toBe("idle");
    expect(p.runtime.currentTask).toBeNull();
    expect(p.runtime.previousTasks).toEqual([]);
    expect(p.runtime.queue).toEqual([]);
    expect(p.runtime.health.tone).toBe("foundation");
    expect(p.performance.tasksCompleted).toBe(0);
    expect(p.performance.successRate).toBeNull();
    expect(p.performance.qualityScore).toBeNull();
    expect(p.performance.avgCompletionLabel).toBe("—");
  });

  it("foundation is true for the whole roster (Phase 1, no executor)", () => {
    for (const e of listEmployees()) {
      expect(e.profile().foundation, e.slug).toBe(true);
    }
  });
});

// =====================================================================
// 5. Live binding — rows + telemetry, no bespoke code per employee
// =====================================================================

describe("Directive 007 — live data binds onto runtime + performance", () => {
  it("binds a working row: state, current task, last activity, health", () => {
    const e = getEmployeeBySlug("sales-ai")!;
    const row = makeRow({
      status: "working",
      current_task: "Qualify inbound demo",
      last_activity_at: "2026-06-19T09:00:00.000Z",
    });
    const p = e.profile({ row });
    expect(p.runtime.state).toBe("working");
    expect(p.runtime.currentTask?.title).toBe("Qualify inbound demo");
    expect(p.runtime.currentTask?.status).toBe("in_progress");
    expect(p.runtime.lastActivityAt).toBe("2026-06-19T09:00:00.000Z");
    expect(p.runtime.health.tone).toBe("healthy");
  });

  it("coerces an unknown status to idle (never throws on bad data)", () => {
    const e = getEmployeeBySlug("sales-ai")!;
    const p = e.profile({ row: makeRow({ status: "wat" as AiEmployeeStatus }) });
    expect(p.runtime.state).toBe("idle");
  });

  it("maps workforce telemetry onto the performance dimension", () => {
    const e = getEmployeeBySlug("sales-ai")!;
    const stats = makeStats({
      completed: 7,
      failed: 1,
      successRatePct: 88,
      avgCompletionMs: 90_000,
      avgCompletionLabel: "2m",
    });
    const p = e.profile({ stats });
    expect(p.performance.tasksCompleted).toBe(7);
    expect(p.performance.errors).toBe(1);
    expect(p.performance.successRate).toBe(88);
    expect(p.performance.avgCompletionLabel).toBe("2m");
    // No quality signal is wired in Phase 1 — stays honestly null.
    expect(p.performance.qualityScore).toBeNull();
  });

  it("a steady employee (work done, now idle) reads as 'steady'", () => {
    const e = getEmployeeBySlug("sales-ai")!;
    const p = e.profile({
      row: makeRow({ status: "idle" }),
      stats: makeStats({ completed: 3, successRatePct: 100 }),
    });
    expect(p.runtime.health.tone).toBe("steady");
  });
});

// =====================================================================
// 6. Transparent health derivation (every tone carries a reason)
// =====================================================================

describe("Directive 007 — deriveHealth is transparent", () => {
  const ceo = AI_EMPLOYEE_REGISTRY[0]!;
  const perf = (over: Partial<EmployeePerformance> = {}): EmployeePerformance => ({
    tasksCompleted: 0,
    successRate: null,
    avgCompletionMs: null,
    avgCompletionLabel: "—",
    errors: 0,
    qualityScore: null,
    ...over,
  });

  it("error → attention", () => {
    const h = ceo.deriveHealth("error", null);
    expect(h.tone).toBe("attention");
    expect(h.reason.length).toBeGreaterThan(0);
  });

  it("blocked → attention", () => {
    expect(ceo.deriveHealth("blocked", null).tone).toBe("attention");
  });

  it("recent failures with low success rate → attention", () => {
    const h = ceo.deriveHealth(
      "idle",
      perf({ tasksCompleted: 5, errors: 3, successRate: 50 }),
    );
    expect(h.tone).toBe("attention");
  });

  it("working → healthy", () => {
    expect(ceo.deriveHealth("working", null).tone).toBe("healthy");
  });

  it("completed work, now idle → steady", () => {
    expect(
      ceo.deriveHealth("idle", perf({ tasksCompleted: 4, successRate: 100 }))
        .tone,
    ).toBe("steady");
  });

  it("nothing done yet → foundation", () => {
    expect(ceo.deriveHealth("idle", null).tone).toBe("foundation");
  });

  it("every tone always carries a non-empty reason", () => {
    const states: AiEmployeeStatus[] = [
      "idle",
      "working",
      "waiting_approval",
      "blocked",
      "error",
      "disabled",
    ];
    for (const s of states) {
      expect(ceo.deriveHealth(s, null).reason.length).toBeGreaterThan(0);
    }
  });
});

// =====================================================================
// 7. "Config, not code" — a new employee needs only a definition
// =====================================================================

describe("Directive 007 — defineEmployee proves the config-only promise", () => {
  const definition: AIEmployeeDefinition = {
    identity: {
      name: "Legal AI",
      slug: "legal-ai",
      role: "Legal — contract review",
      department: "operations",
      avatar: { emoji: "⚖️", icon: "scale", accent: "indigo" },
      description: "Reviews contracts and flags risk for human counsel.",
      tagline: "Contract review and risk flagging.",
    },
    configuration: {
      model: { provider: "anthropic", name: "claude-sonnet-4-6", temperature: 0.2 },
      systemPrompt: "You are the Legal AI. You review and advise only.",
      knowledgeSources: [
        { key: "contracts", label: "Contracts", kind: "document" },
      ],
      memorySources: [{ scope: "organization", label: "Legal memory" }],
      tools: ["read_contract", "flag_risk"],
      permissions: { can_execute: false, requires_approval: true, scopes: ["read"] },
    },
    responsibilities: ["Review contracts.", "Flag legal risk."],
    sortOrder: 999,
  };

  it("builds a fully-working employee from a single config object", () => {
    const legal = defineEmployee(definition);
    expect(legal).toBeInstanceOf(AIEmployee);
    const p = legal.profile();
    expect(p.identity.slug).toBe("legal-ai");
    expect(p.configuration.tools).toContain("flag_risk");
    expect(p.foundation).toBe(true);
    expect(p.runtime.health.tone).toBe("foundation");
  });

  it("the new employee inherits the SAME six-dimension contract", () => {
    const legal = defineEmployee(definition);
    const p = legal.profile({
      row: makeRow({ slug: "legal-ai", status: "working" }),
      stats: makeStats({ completed: 2, successRatePct: 100 }),
    });
    expect(p.runtime.state).toBe("working");
    expect(p.performance.tasksCompleted).toBe(2);
    expect(p.runtime.health.tone).toBe("healthy");
    // Same projection path as every built-in employee.
    expect(normalizePermissions(legal.toEmployeeRowShape().permissions).can_execute).toBe(
      false,
    );
  });
});
