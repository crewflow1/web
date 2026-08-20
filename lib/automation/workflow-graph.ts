/**
 * Automation OS — the VISUAL WORKFLOW GRAPH model + compiler.
 *
 * WHAT THIS IS (and is emphatically NOT)
 * --------------------------------------
 * This module lets a tenant author an automation as a NODE GRAPH — trigger →
 * conditions/branches → actions → an optional approval gate → end — on a visual
 * canvas. It is a NEW AUTHORING SURFACE, not a new engine. Its one job is to
 * COMPILE a graph down to the existing `CustomRuleDefinition`
 * (lib/automation/custom-rules.ts) — the exact shape the existing dispatcher loads,
 * re-validates and runs. The compiled rule is stored in the existing
 * `automation_custom_rules.definition` and executed by the existing
 * automation_runs / action-registry path. There is ONE engine; this is more input
 * to it, expressed differently.
 *
 * THE COMPILE IS THE CONTRACT. `compileWorkflowGraph` produces a raw definition and
 * hands it to `validateCustomRuleDefinition` — the SAME injection boundary the form
 * builder uses. So a graph can never compile to anything the form builder couldn't
 * also have produced: whitelisted actions only, params sanitised, condition tree
 * bounded, trigger proven exposable. The graph adds a canvas; it adds ZERO new
 * execution authority.
 *
 * HONESTY ABOUT DARK NODES (delay, ai-decision, webhook). The palette offers node
 * kinds the underlying linear engine has NO live primitive for yet (there is no
 * "wait 2h" scheduler-in-a-rule, no governed AI-decision action, no outbound
 * webhook action in the registry). Rather than fake them, a graph that CONTAINS one
 * compiles to a DRAFT: the live actions still compile and validate, but the rule is
 * forced disabled so nothing dark ever silently runs — the same "never advertise as
 * live what cannot fire" discipline the phantom-rule guard enforces for the
 * catalogue. Activation of a dark kind is a future config flip (a real producer /
 * governed action), never a lie told here.
 *
 * PURE + client-safe. Types + pure functions only (no I/O, no `server-only`), so
 * the canvas previews the exact compile the server will re-run, and the whole thing
 * is unit-testable as a function.
 */

import {
  isExposableAutomationTrigger,
  type AutomationActionType,
} from "./events";
import {
  CONDITION_OPERATORS,
  VALUELESS_OPERATORS,
  ARRAY_VALUE_OPERATORS,
  type ConditionCombinator,
  type ConditionOperator,
  type ConditionGroup,
  type LeafCondition,
} from "./conditions";
import { isCustomAvailableAction } from "./action-registry";
import {
  validateCustomRuleDefinition,
  type CustomRuleDefinition,
} from "./custom-rules";

// ── Node kinds ────────────────────────────────────────────────────────────────

export const WORKFLOW_NODE_KINDS = [
  "trigger",
  "condition",
  "branch",
  "delay",
  "action",
  "communication",
  "approval",
  "ai_decision",
  "webhook",
  "end",
] as const;

export type WorkflowNodeKind = (typeof WORKFLOW_NODE_KINDS)[number];

/**
 * DARK kinds — representable on the canvas, but with NO live execution primitive
 * in the current engine. A graph containing any of these compiles to a DRAFT
 * (forced disabled) so the dark step can never silently run. Listed here so the
 * canvas, the compiler and the tests agree on exactly one set.
 */
export const DARK_NODE_KINDS: ReadonlySet<WorkflowNodeKind> = new Set([
  "delay",
  "ai_decision",
  "webhook",
]);

/** Kinds that contribute a live ACTION step to the compiled rule. */
const ACTION_KINDS: ReadonlySet<WorkflowNodeKind> = new Set([
  "action",
  "communication",
]);

/** Communication channel → the wired registry action it compiles to. */
const COMMUNICATION_CHANNEL_ACTION: Readonly<Record<string, AutomationActionType>> =
  {
    notification: "create_notification",
    email: "send_email_queue",
  };

// ── Graph shape ───────────────────────────────────────────────────────────────

export type WorkflowNode = {
  id: string;
  kind: WorkflowNodeKind;
  /** Canvas position (persisted so the layout round-trips). */
  x: number;
  y: number;
  /** Per-kind config. Loose JSON; every field is re-checked at compile time. */
  data: Record<string, unknown>;
};

/**
 * A directed edge. `branch` labels which port of a BRANCH node it leaves; it is
 * ignored for every other node kind (which have a single implicit output).
 */
export type WorkflowEdge = {
  id: string;
  from: string;
  to: string;
  branch?: "true" | "false";
};

export type WorkflowGraph = {
  /** Bumped every save; the version history table stores each snapshot. */
  version: number;
  /** How the condition leaves along the path combine. Default "and". */
  combinator: ConditionCombinator;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
};

// ── Bounds (kept modest — a comprehensible, cheap-to-evaluate rule) ─────────────

export const MAX_GRAPH_NODES = 40;
export const MAX_GRAPH_EDGES = 80;

// ── Structural validation (+ the DAG / cycle guard) ─────────────────────────────

export type GraphValidation = { ok: boolean; errors: string[] };

function isNodeKind(v: unknown): v is WorkflowNodeKind {
  return (
    typeof v === "string" &&
    (WORKFLOW_NODE_KINDS as readonly string[]).includes(v)
  );
}

/**
 * Directed-cycle detector (DFS three-colour). The graph MUST be acyclic — a cycle
 * would make the compiled action sequence non-terminating and is meaningless in the
 * linear rule model. Exposed + tested independently of compile.
 */
export function hasCycle(graph: {
  nodes: { id: string }[];
  edges: { from: string; to: string }[];
}): boolean {
  const adj = new Map<string, string[]>();
  for (const n of graph.nodes) adj.set(n.id, []);
  for (const e of graph.edges) {
    if (adj.has(e.from)) adj.get(e.from)!.push(e.to);
  }
  const WHITE = 0,
    GREY = 1,
    BLACK = 2;
  const colour = new Map<string, number>();
  for (const n of graph.nodes) colour.set(n.id, WHITE);

  const visit = (id: string): boolean => {
    colour.set(id, GREY);
    for (const next of adj.get(id) ?? []) {
      const c = colour.get(next);
      if (c === undefined) continue; // edge to a missing node — structural, not a cycle
      if (c === GREY) return true; // back-edge → cycle
      if (c === WHITE && visit(next)) return true;
    }
    colour.set(id, BLACK);
    return false;
  };

  for (const n of graph.nodes) {
    if (colour.get(n.id) === WHITE && visit(n.id)) return true;
  }
  return false;
}

/**
 * Validate the STRUCTURE of a graph (shape, one trigger, well-formed edges, no
 * cycle, connectivity). Does NOT check per-node config completeness — that is the
 * compiler's job, which produces the actual definition. Returns every error found
 * so the canvas can list them.
 */
export function validateWorkflowGraph(graph: unknown): GraphValidation {
  const errors: string[] = [];
  if (graph === null || typeof graph !== "object") {
    return { ok: false, errors: ["Workflow is empty."] };
  }
  const g = graph as Partial<WorkflowGraph>;
  const nodes = Array.isArray(g.nodes) ? g.nodes : [];
  const edges = Array.isArray(g.edges) ? g.edges : [];

  if (nodes.length === 0) errors.push("Add a trigger to start the workflow.");
  if (nodes.length > MAX_GRAPH_NODES)
    errors.push(`Too many steps (max ${MAX_GRAPH_NODES}).`);
  if (edges.length > MAX_GRAPH_EDGES)
    errors.push(`Too many connections (max ${MAX_GRAPH_EDGES}).`);

  const ids = new Set<string>();
  for (const n of nodes) {
    if (!n || typeof n !== "object") {
      errors.push("A step is malformed.");
      continue;
    }
    if (typeof n.id !== "string" || n.id.length === 0) {
      errors.push("A step is missing an id.");
      continue;
    }
    if (ids.has(n.id)) errors.push(`Duplicate step id "${n.id}".`);
    ids.add(n.id);
    if (!isNodeKind(n.kind)) errors.push(`Unknown step type on "${n.id}".`);
  }

  const triggers = nodes.filter((n) => n && n.kind === "trigger");
  if (triggers.length === 0) errors.push("Add exactly one trigger step.");
  if (triggers.length > 1) errors.push("A workflow can have only one trigger.");

  for (const e of edges) {
    if (!e || typeof e !== "object") {
      errors.push("A connection is malformed.");
      continue;
    }
    if (!ids.has(e.from) || !ids.has(e.to)) {
      errors.push("A connection points to a missing step.");
    }
    if (e.from === e.to) errors.push("A step cannot connect to itself.");
  }

  if (hasCycle({ nodes: nodes as { id: string }[], edges: edges as WorkflowEdge[] })) {
    errors.push("Workflow has a loop — steps must flow forwards only.");
  }

  // Connectivity: every non-trigger node must be reachable from the trigger, so
  // no orphaned step is silently dropped at compile.
  if (triggers.length === 1 && errors.length === 0) {
    const reachable = new Set<string>();
    const adj = new Map<string, string[]>();
    for (const n of nodes) adj.set(n.id, []);
    for (const e of edges) adj.get(e.from)?.push(e.to);
    const stack = [triggers[0]!.id];
    while (stack.length) {
      const cur = stack.pop()!;
      if (reachable.has(cur)) continue;
      reachable.add(cur);
      for (const nx of adj.get(cur) ?? []) stack.push(nx);
    }
    for (const n of nodes) {
      if (!reachable.has(n.id)) {
        errors.push(`Step "${nodeLabel(n)}" is not connected to the trigger.`);
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

function nodeLabel(n: WorkflowNode): string {
  const name = typeof n.data?.label === "string" ? n.data.label : "";
  return name || n.kind;
}

// ── Compilation: graph → CustomRuleDefinition ───────────────────────────────────

export type CompileResult =
  | {
      ok: true;
      definition: CustomRuleDefinition;
      /** True when the graph contains a dark node → rule must ship disabled. */
      isDraft: boolean;
      /** Which dark kinds are present (for the UI's honest warning). */
      darkKinds: WorkflowNodeKind[];
    }
  | { ok: false; error: string };

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function coerceLeafValue(
  operator: ConditionOperator,
  raw: unknown,
): string | number | boolean | Array<string | number | boolean> | undefined {
  if (VALUELESS_OPERATORS.has(operator)) return undefined;
  if (ARRAY_VALUE_OPERATORS.has(operator)) {
    if (Array.isArray(raw)) {
      return raw
        .filter((x) => ["string", "number", "boolean"].includes(typeof x))
        .map((x) => x as string | number | boolean);
    }
    // Accept a comma-separated string (the canvas stores it that way).
    return asString(raw)
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  if (typeof raw === "number" || typeof raw === "boolean") return raw;
  return asString(raw);
}

function leafFromNode(n: WorkflowNode): LeafCondition | { error: string } {
  const field = asString(n.data.field).trim();
  const opRaw = asString(n.data.operator);
  if (field.length === 0) {
    return { error: `A ${n.kind} step is missing its field.` };
  }
  if (!(CONDITION_OPERATORS as readonly string[]).includes(opRaw)) {
    return { error: `A ${n.kind} step has an unknown operator.` };
  }
  const operator = opRaw as ConditionOperator;
  const value = coerceLeafValue(operator, n.data.value);
  const leaf: LeafCondition = { field, operator };
  if (value !== undefined) leaf.value = value as LeafCondition["value"];
  return leaf;
}

/**
 * Walk the graph from the trigger down its single forward spine, collecting the
 * ordered live steps. A non-branch step may have at most ONE outgoing edge; a
 * BRANCH step follows its `true` port as the spine and requires its `false` port
 * (if wired) to terminate at an `end` step — the expressible subset of the linear
 * rule model. Returns the ordered node list (excluding the trigger) or an error.
 */
function walkSpine(
  graph: WorkflowGraph,
): { trigger: WorkflowNode; spine: WorkflowNode[] } | { error: string } {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const outEdges = new Map<string, WorkflowEdge[]>();
  for (const n of graph.nodes) outEdges.set(n.id, []);
  for (const e of graph.edges) outEdges.get(e.from)?.push(e);

  const trigger = graph.nodes.find((n) => n.kind === "trigger");
  if (!trigger) return { error: "Add exactly one trigger step." };

  const spine: WorkflowNode[] = [];
  const seen = new Set<string>([trigger.id]);
  let current = trigger;

  for (;;) {
    const outs = outEdges.get(current.id) ?? [];
    if (current.kind === "end") break;

    let nextEdge: WorkflowEdge | undefined;
    if (current.kind === "branch") {
      const trueEdge = outs.find((e) => e.branch !== "false");
      const falseEdge = outs.find((e) => e.branch === "false");
      if (falseEdge) {
        const target = byId.get(falseEdge.to);
        if (!target || target.kind !== "end") {
          return {
            error:
              "A branch's ✗ (no) path must lead to an End step. Split divergent action paths into separate rules.",
          };
        }
      }
      nextEdge = trueEdge;
    } else {
      if (outs.length > 1) {
        return {
          error: `Step "${nodeLabel(current)}" has more than one outgoing path — use a Branch step to split.`,
        };
      }
      nextEdge = outs[0];
    }

    if (!nextEdge) break; // reached a dangling end of the spine
    const next = byId.get(nextEdge.to);
    if (!next) return { error: "A connection points to a missing step." };
    if (seen.has(next.id)) {
      return { error: "Workflow has a loop — steps must flow forwards only." };
    }
    seen.add(next.id);
    spine.push(next);
    current = next;
  }

  return { trigger, spine };
}

/**
 * Compile a workflow graph into a runnable `CustomRuleDefinition`.
 *
 * The output is produced by handing a RAW definition to the shared
 * `validateCustomRuleDefinition` — so the visual path and the form path converge on
 * byte-identical, equally-safe definitions. Dark nodes contribute no action and
 * flag the rule as a draft.
 */
export function compileWorkflowGraph(graph: unknown): CompileResult {
  const structural = validateWorkflowGraph(graph);
  if (!structural.ok) {
    return { ok: false, error: structural.errors[0] ?? "Invalid workflow." };
  }
  const g = graph as WorkflowGraph;

  const walked = walkSpine(g);
  if ("error" in walked) return { ok: false, error: walked.error };
  const { trigger, spine } = walked;

  const triggerVerb = asString(trigger.data.trigger);
  if (!isExposableAutomationTrigger(triggerVerb)) {
    return {
      ok: false,
      error: `Trigger "${triggerVerb || "(none)"}" is not available for custom rules.`,
    };
  }

  const leaves: LeafCondition[] = [];
  const rawActions: { type: string; params: Record<string, unknown> }[] = [];
  const darkKinds: WorkflowNodeKind[] = [];
  let approvalPosition: number | null = null;

  for (const n of spine) {
    if (n.kind === "condition" || n.kind === "branch") {
      const leaf = leafFromNode(n);
      if ("error" in leaf) return { ok: false, error: leaf.error };
      leaves.push(leaf);
      continue;
    }
    if (n.kind === "approval") {
      // The gate sits at the current action count. Only ONE gate is meaningful in
      // the linear model; a second one just moves the boundary — last wins, which
      // we forbid to avoid ambiguity.
      if (approvalPosition !== null) {
        return { ok: false, error: "A workflow can have only one approval step." };
      }
      approvalPosition = rawActions.length;
      continue;
    }
    if (n.kind === "action") {
      const type = asString(n.data.actionType);
      if (!isCustomAvailableAction(type)) {
        return {
          ok: false,
          error: `Action step "${nodeLabel(n)}" uses an action that isn't allowed in custom rules.`,
        };
      }
      const params =
        n.data.params && typeof n.data.params === "object"
          ? (n.data.params as Record<string, unknown>)
          : {};
      rawActions.push({ type, params });
      continue;
    }
    if (n.kind === "communication") {
      const channel = asString(n.data.channel) || "notification";
      const type = COMMUNICATION_CHANNEL_ACTION[channel];
      if (!type) {
        return {
          ok: false,
          error: `Communication step "${nodeLabel(n)}" has an unknown channel.`,
        };
      }
      const params =
        n.data.params && typeof n.data.params === "object"
          ? (n.data.params as Record<string, unknown>)
          : {};
      rawActions.push({ type, params });
      continue;
    }
    if (DARK_NODE_KINDS.has(n.kind)) {
      if (!darkKinds.includes(n.kind)) darkKinds.push(n.kind);
      continue; // dark → no live action emitted
    }
    if (n.kind === "end") break;
    // trigger already consumed; any other kind is inert.
  }

  if (rawActions.length === 0) {
    return {
      ok: false,
      error: "Add at least one action step (the workflow does nothing yet).",
    };
  }

  const requiresApproval = approvalPosition !== null;
  const rawDefinition = {
    trigger: triggerVerb,
    conditions:
      leaves.length > 0
        ? ({ combinator: g.combinator ?? "and", conditions: leaves } as ConditionGroup)
        : null,
    actions: rawActions,
    requiresApproval,
    approvalPosition: requiresApproval ? approvalPosition! : rawActions.length,
  };

  // THE CONVERGENCE POINT: the same validator the form builder uses. If it accepts,
  // the visual output is indistinguishable from a hand-authored rule.
  const validated = validateCustomRuleDefinition(rawDefinition);
  if (!validated.ok) {
    return { ok: false, error: validated.error };
  }

  return {
    ok: true,
    definition: validated.value,
    isDraft: darkKinds.length > 0,
    darkKinds,
  };
}

// ── Starter graphs / helpers for the canvas ─────────────────────────────────────

/** A fresh graph: a trigger wired to an end, ready to have steps inserted. */
export function emptyWorkflowGraph(
  trigger: string = "quote.accepted",
): WorkflowGraph {
  return {
    version: 1,
    combinator: "and",
    nodes: [
      {
        id: "trigger",
        kind: "trigger",
        x: 60,
        y: 160,
        data: { trigger, label: "When this happens" },
      },
      { id: "end", kind: "end", x: 620, y: 160, data: { label: "End" } },
    ],
    edges: [{ id: "e_trigger_end", from: "trigger", to: "end" }],
  };
}

/**
 * Is `graph` a plausibly-shaped WorkflowGraph object? A cheap guard for the read
 * path (a stored `graph` column may be null for a form-built rule).
 */
export function isWorkflowGraph(value: unknown): value is WorkflowGraph {
  if (value === null || typeof value !== "object") return false;
  const g = value as Partial<WorkflowGraph>;
  return Array.isArray(g.nodes) && Array.isArray(g.edges);
}
