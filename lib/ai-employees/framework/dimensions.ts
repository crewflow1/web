/**
 * AI Employee Framework — the six dimension contracts (CEO Directive 007, Phase 1).
 *
 * Every AI employee, regardless of department, exposes the SAME six dimensions.
 * This file is the typed contract for each one. It is PURE (server/client safe):
 * no Supabase, no server-only imports — exactly like `../model` and `../stats`,
 * so the SDK, the service layer, the React pages and the unit tests share one
 * vocabulary.
 *
 * Nothing here is duplicated from the existing data layer: the framework REUSES
 * the live vocabulary (`Department`, `MemoryScope`, `AiEmployeeStatus`,
 * `AiPermissions`, `Accent`, `TaskStatus`) defined in `../model`, then composes
 * the richer "Employee SDK" shape on top of it.
 *
 *   1. Identity        — who the employee is
 *   2. Configuration   — how the employee is wired (model, prompt, tools, perms)
 *   3. Runtime         — what the employee is doing right now
 *   4. Memory          — what the employee remembers
 *   5. Performance     — how well the employee performs
 *   6. Audit           — an immutable trail of everything it did
 *
 * FRAMEWORK ONLY: no model provider is connected and nothing executes. Live
 * runtime / performance bind to the existing `ai_employees` tables where data
 * exists; otherwise every figure renders as an honest "foundation" baseline —
 * never invented.
 */

import type {
  Accent,
  AiEmployeeStatus,
  AiPermissions,
  Department,
  MemoryScope,
  TaskStatus,
} from "../model";

// Re-export the reused vocabulary so framework consumers have one import path.
export type {
  Accent,
  AiEmployeeStatus,
  AiPermissions,
  Department,
  MemoryScope,
  TaskStatus,
};

// =====================================================================
// 1. IDENTITY
// =====================================================================

/** How the employee is portrayed — emoji avatar + lucide icon + accent token. */
export type EmployeeAvatar = {
  /** Display emoji, e.g. "👑". Mirrors the directive's roster glyphs. */
  emoji: string;
  /** Lucide icon key, e.g. "crown" (shared with the boardroom icon mapper). */
  icon: string;
  /** Tailwind accent token, e.g. "violet" (one of `ACCENTS` in ../model). */
  accent: Accent;
};

export type EmployeeIdentity = {
  /** Display name, e.g. "CEO AI". */
  name: string;
  /** URL-safe slug, e.g. "ceo-ai". Stable join key to the `ai_employees` row. */
  slug: string;
  /** Job title / role line, e.g. "Chief Executive — strategy & coordination". */
  role: string;
  department: Department;
  avatar: EmployeeAvatar;
  /** Long-form charter (what this employee is responsible for). */
  description: string;
  /** One-line summary for cards. */
  tagline: string;
};

// =====================================================================
// 2. CONFIGURATION
// =====================================================================

/** Planning-only model selection. Inert in Phase 1 (no provider connected). */
export type ModelConfig = {
  provider: string;
  name: string;
  /** Sampling temperature 0..1 — a planning value until execution is wired. */
  temperature: number;
};

export type KnowledgeSourceKind =
  | "dashboard"
  | "table"
  | "document"
  | "codebase"
  | "memory"
  | "external";

/** A read-only input the employee draws on (no write access implied). */
export type KnowledgeSource = {
  key: string;
  label: string;
  kind: KnowledgeSourceKind;
  detail?: string;
};

/** A memory pool the employee is configured to read from. */
export type MemorySourceRef = {
  scope: MemoryScope;
  label: string;
  detail?: string;
};

export type EmployeeConfiguration = {
  model: ModelConfig;
  /** The role definition / instructions (≤20k chars, mirrors the DB column). */
  systemPrompt: string;
  knowledgeSources: KnowledgeSource[];
  memorySources: MemorySourceRef[];
  /** Capability labels — no executor wired in Phase 1. */
  tools: string[];
  permissions: AiPermissions;
};

// =====================================================================
// Shared — health signal (honest by construction)
// =====================================================================

export type EmployeeHealthTone = "healthy" | "steady" | "attention" | "foundation";

export type EmployeeHealth = {
  tone: EmployeeHealthTone;
  label: string;
  /** Why this tone was chosen — keeps the signal transparent, never a black box. */
  reason: string;
};

// =====================================================================
// 3. RUNTIME
// =====================================================================

/** A lightweight pointer to a task (the full row lives in `ai_employee_tasks`). */
export type TaskRef = {
  id: string | null;
  title: string;
  status: TaskStatus;
  at: string | null;
};

/** A surfaced next-best-action with its confidence. */
export type Recommendation = {
  id: string | null;
  title: string;
  detail: string | null;
  /** 0..100, or null when confidence is genuinely unknown. */
  confidence: number | null;
};

export type EmployeeRuntime = {
  state: AiEmployeeStatus;
  currentTask: TaskRef | null;
  previousTasks: TaskRef[];
  queue: TaskRef[];
  recommendations: Recommendation[];
  /** Confidence in the current work, 0..100 or null. */
  confidence: number | null;
  /** ISO timestamp of expected completion, or null. */
  estimatedCompletion: string | null;
  health: EmployeeHealth;
  lastActivityAt: string | null;
};

// =====================================================================
// 4. MEMORY
// =====================================================================

/** A pointer to a remembered item (conversation turn, decision, output, memory row). */
export type MemoryRef = {
  id: string | null;
  label: string;
  kind: string;
  at: string | null;
};

export type EmployeeMemory = {
  conversationHistory: MemoryRef[];
  decisions: MemoryRef[];
  previousOutputs: MemoryRef[];
  longTerm: {
    scope: MemoryScope;
    entries: MemoryRef[];
  };
  /** Shared company memory the employee can read (refs into `hq_memories`). */
  sharedCompany: MemoryRef[];
};

// =====================================================================
// 5. PERFORMANCE
// =====================================================================

export type EmployeePerformance = {
  tasksCompleted: number;
  /** 0..100, or null when nothing has finished yet. */
  successRate: number | null;
  avgCompletionMs: number | null;
  avgCompletionLabel: string;
  errors: number;
  /** 0..100, or null when no quality signal is measured yet (honest). */
  qualityScore: number | null;
};

// =====================================================================
// 6. AUDIT
// =====================================================================

export type AuditKind = "action" | "decision" | "approval" | "rejection";

export type AuditEntry = {
  id: string | null;
  at: string;
  actor: string | null;
  kind: AuditKind;
  action: string;
  detail: string | null;
};

/** Everything the employee did, bucketed. Nothing ever disappears. */
export type EmployeeAudit = {
  actions: AuditEntry[];
  decisions: AuditEntry[];
  approvals: AuditEntry[];
  rejections: AuditEntry[];
};

// =====================================================================
// Full profile — the composition of all six dimensions
// =====================================================================

export type AIEmployeeProfile = {
  identity: EmployeeIdentity;
  configuration: EmployeeConfiguration;
  runtime: EmployeeRuntime;
  memory: EmployeeMemory;
  performance: EmployeePerformance;
  audit: EmployeeAudit;
  /**
   * True until a live execution backend feeds this employee. An honest flag —
   * the UI uses it to label "foundation" figures rather than pretend they are
   * real measurements.
   */
  foundation: boolean;
};
