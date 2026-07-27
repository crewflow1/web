import { z } from "zod";

/**
 * CrewFlow HQ — the typed tool registry contract
 * (CEO Directive #014 / D-04, Phase C, increment C1; ADR 0009 Decision 2; Bible Volume XIII §12).
 *
 * A tool is a unit of capability an AI employee may PROPOSE to use. The substrate (Volume XIII
 * §12) names a tool's shape: a typed arg schema, a permission, a cost estimator (§19), and a
 * reversibility/blast-radius classification that feeds the autonomy test (P4). This module is
 * the TYPED CONTRACT for that shape — registered as DATA — and nothing more.
 *
 * DESCRIBES CAPABILITY; IT DOES NOT AUTHORISE IT, AND IT DOES NOT EXECUTE IT (the Executor
 * Boundary Rule + the Tool Registry Principle — Kernel Contract Map §2; ADR 0009 Decision 2).
 * A {@link RegisteredTool} is pure metadata: a label, a permission label, an `argSchema`, a
 * `costEstimator`, and a `reversibilityClass`. It carries NO invocation body. Resolving a tool
 * tells you what a capability LOOKS like — its required permission, the shape of its arguments,
 * what it would cost, whether it can be undone — it grants nothing and runs nothing:
 *
 *   • it never decides whether an employee MAY use a tool — that is the doorman, the pure gate
 *     ({@link import("./gate")}), reading a resolved capability set and posture; capability
 *     HOLDING is sourced by the Capability Registry (#015), authorised at the gate (#014) and,
 *     for external calls, the API gateway (Phase D);
 *   • it never INVOKES a tool — `ctx.tools.invoke(name, args)` (Volume XIII §12) is the
 *     executor, increment C2 (ADR 0009 Decision 13). This contract exists so that executor has
 *     a typed registry to consume LATER; the apply mechanism is not written here;
 *   • it never requests approval and never touches the Task Engine — policy stays with the
 *     gate, approval with the Approval Engine, lifecycle with the Task Engine.
 *
 * The two descriptive properties that feed the autonomy test (P4, substrate README §P4):
 *   • {@link RegisteredTool.reversibilityClass} → P4 atom 1 (reversible). A tool-level fact the
 *     runtime folds into a proposed action's `reversible` flag — see {@link isReversibleTool}
 *     and `gate.ts`'s note that this is "Phase C: a tool property".
 *   • {@link RegisteredTool.costEstimator} → P4 atom 5 (in-budget). A pure estimate the runtime
 *     folds into a proposed action's `estimatedCostMicros` — see {@link estimateToolCostMicros}.
 * The registry only DESCRIBES these facts; the gate still weighs them, and the posture floor
 * still gates every proposed action regardless. Deriving a fact from a tool grants no autonomy.
 *
 * Pure + I/O-free (deliberately NO `server-only`): the only import is `zod`. Like
 * {@link import("./output")} and {@link import("./gate")}, the timeline / Boardroom UI may
 * import these types to render what a tool is. It reaches for no server module, no admin
 * client, no facet, and no approval or task surface — there is nothing here to execute.
 */

// ---------------------------------------------------------------------
// Reversibility — P4 atom 1, as a tool property (ADR 0009 Decision 2)
// ---------------------------------------------------------------------

/**
 * A tool's reversibility/blast-radius classification (Volume XIII §12) — the descriptive fact
 * that feeds P4 atom 1. `reversible`: the tool writes only HQ-internal, append-or-correctable
 * state, so an autonomous application can be undone. `irreversible`: the effect cannot be taken
 * back once applied (a sent communication, an external dispatch), so it biases to approval.
 */
export type ReversibilityClass = "reversible" | "irreversible";

/** The reversibility classes the gate treats as reversible (P4 atom 1) — a single source. */
const REVERSIBLE_CLASSES: ReadonlySet<ReversibilityClass> = new Set<ReversibilityClass>([
  "reversible",
]);

// ---------------------------------------------------------------------
// Cost — P4 atom 5, as a pure tool estimate (Volume XIII §19)
// ---------------------------------------------------------------------

/** A tool's arguments, structurally — the shape an `argSchema` validates and an estimator reads. */
export type ToolArgs = Record<string, unknown>;

/**
 * A pure estimate of what applying a tool with the given arguments would cost, in micros
 * (Volume XIII §19) — the descriptive fact that feeds P4 atom 5. It is an ESTIMATE, computed
 * without I/O; it never charges anything and never meters a real call (cost METERING is the API
 * gateway, Phase D). The runtime weighs the estimate against the run's budget at the gate.
 */
export type ToolCostEstimator = (args: ToolArgs) => number;

// ---------------------------------------------------------------------
// The registered tool — pure descriptive metadata, never an executor
// ---------------------------------------------------------------------

/**
 * A tool, registered as DATA (Volume XIII §12; ADR 0009 Decision 2). Pure metadata describing a
 * unit of capability — it carries NO invocation body, because describing a capability is not the
 * same as authorising it or running it (the Executor Boundary Rule). The executor (C2) consumes
 * this shape; it does not live here.
 */
export interface RegisteredTool {
  /** The tool's stable label — how a proposed action and the executor (C2) name it. */
  readonly label: string;
  /** Human-readable description of what the tool does — documentation, never behaviour. */
  readonly description?: string;
  /**
   * The capability token this tool requires (Volume XIII §12). DESCRIPTIVE only: the gate
   * matches it against the employee's resolved capability set (#015 sources, #014 authorises) —
   * the registry never checks possession and never grants the token.
   */
  readonly permission: string;
  /** The typed schema the tool's arguments must satisfy — validated, never executed. */
  readonly argSchema: z.ZodTypeAny;
  /** A pure estimate of the tool's cost in micros (P4 atom 5) — see {@link ToolCostEstimator}. */
  readonly costEstimator: ToolCostEstimator;
  /** The tool's reversibility classification (P4 atom 1) — see {@link ReversibilityClass}. */
  readonly reversibilityClass: ReversibilityClass;
}

/**
 * The shape {@link defineTool} accepts. It mirrors {@link RegisteredTool} but binds `argSchema`
 * to a concrete `ZodObject`, so the `costEstimator` is typed against the INFERRED argument shape
 * (`z.infer<S>`) — a tool author reads `args.channel` with full type-safety, while the stored
 * estimator is widened to the structural {@link ToolCostEstimator} for the heterogeneous registry.
 */
export interface ToolSpec<S extends z.ZodObject<z.ZodRawShape>> {
  readonly label: string;
  readonly description?: string;
  readonly permission: string;
  readonly argSchema: S;
  readonly costEstimator: (args: z.infer<S>) => number;
  readonly reversibilityClass: ReversibilityClass;
}

/**
 * Define a tool — the ergonomic constructor for a {@link RegisteredTool}. The generic `S` binds
 * the schema so the spec's `costEstimator` is typed against the inferred argument shape; the
 * stored estimator wraps it to accept the structural {@link ToolArgs} (the runtime calls it with
 * args already validated against `argSchema` — see {@link parseToolArgs}). The result is FROZEN:
 * a tool is immutable descriptive data. This constructs metadata only — it wires no execution.
 */
export function defineTool<S extends z.ZodObject<z.ZodRawShape>>(spec: ToolSpec<S>): RegisteredTool {
  const costEstimator: ToolCostEstimator = (args) => spec.costEstimator(args as z.infer<S>);
  return Object.freeze({
    label: spec.label,
    description: spec.description,
    permission: spec.permission,
    argSchema: spec.argSchema,
    costEstimator,
    reversibilityClass: spec.reversibilityClass,
  });
}

// ---------------------------------------------------------------------
// The registry — a read-only, label-keyed index (registered as data)
// ---------------------------------------------------------------------

/**
 * A read-only index of {@link RegisteredTool}s, keyed by label. It RESOLVES and LISTS tools — it
 * never invokes one, never authorises one, and never decides approval. It is the typed catalogue
 * the executor (C2) will consume; here it is pure lookup over immutable data.
 */
export interface ToolRegistry {
  /** The tool with this label, or `undefined` — a lookup, never an invocation. */
  resolve(label: string): RegisteredTool | undefined;
  /** Whether a tool with this label is registered. */
  has(label: string): boolean;
  /** Every registered tool, sorted by label for a stable, comparable listing. */
  list(): readonly RegisteredTool[];
  /** Every registered label, sorted — a stable view for catalogues and tests. */
  labels(): readonly string[];
}

/**
 * Build a {@link ToolRegistry} over the given tools. Labels are unique — a duplicate is a
 * registration error (it throws), because two tools answering to one label would make resolution
 * ambiguous. The index and its listings are FROZEN and label-sorted, so the catalogue is
 * immutable and its order is stable. This composes descriptive data; it wires no execution.
 */
export function createToolRegistry(tools: readonly RegisteredTool[]): ToolRegistry {
  const byLabel = new Map<string, RegisteredTool>();
  for (const tool of tools) {
    if (byLabel.has(tool.label)) {
      throw new Error(`createToolRegistry: duplicate tool label "${tool.label}"`);
    }
    byLabel.set(tool.label, tool);
  }
  const sorted = Object.freeze(
    [...byLabel.values()].sort((a, b) => a.label.localeCompare(b.label)),
  ) as readonly RegisteredTool[];
  const labels = Object.freeze(sorted.map((t) => t.label)) as readonly string[];

  return Object.freeze({
    resolve: (label: string) => byLabel.get(label),
    has: (label: string) => byLabel.has(label),
    list: () => sorted,
    labels: () => labels,
  });
}

// ---------------------------------------------------------------------
// P4-compatibility helpers — derive the gate's facts from a tool
// ---------------------------------------------------------------------

/**
 * Whether a tool is reversible (P4 atom 1). The runtime folds this into a proposed action's
 * `reversible` flag before the gate reads it (`gate.ts`: "Phase C: a tool property"). Deriving the
 * fact grants no autonomy — the gate still weighs it, and the posture floor still gates first.
 */
export function isReversibleTool(tool: RegisteredTool): boolean {
  return REVERSIBLE_CLASSES.has(tool.reversibilityClass);
}

/**
 * The tool's estimated cost in micros for the given arguments (P4 atom 5), normalised to a
 * non-negative integer: a non-finite or negative estimate floors to `0`, and a fractional
 * estimate rounds up (a cost is never understated). The runtime folds the result into a proposed
 * action's `estimatedCostMicros`. This is an ESTIMATE — it charges nothing and meters nothing.
 */
export function estimateToolCostMicros(tool: RegisteredTool, args: ToolArgs): number {
  const raw = tool.costEstimator(args);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return Math.ceil(raw);
}

/** The result of validating a tool's arguments — a discriminated, total outcome. */
export type ToolArgsParse =
  | { readonly ok: true; readonly args: ToolArgs }
  | { readonly ok: false; readonly error: string };

/**
 * Validate arguments against a tool's `argSchema` (the typed target, P4 atom 3) without throwing.
 * On success the parsed arguments are returned; on failure a message is returned. Validation is
 * DESCRIPTIVE — it confirms the arguments fit the declared shape; it does not apply the tool, and
 * a valid parse authorises nothing. The executor (C2) will parse before it applies; the gate and
 * the posture floor still decide whether an application happens at all.
 */
export function parseToolArgs(tool: RegisteredTool, args: unknown): ToolArgsParse {
  const result = tool.argSchema.safeParse(args);
  if (result.success) {
    return { ok: true, args: result.data as ToolArgs };
  }
  return { ok: false, error: result.error.message };
}

// ---------------------------------------------------------------------
// Reference tools — descriptive only (Phase C touches HQ substrate)
// ---------------------------------------------------------------------

/**
 * The reference tools below are DESCRIPTIVE EXAMPLES of the contract — they carry real metadata
 * (schema, permission, cost, reversibility) but NO behaviour, because this module executes
 * nothing (ADR 0009 Decision 12: Phase C's reference surface touches HQ substrate only). They
 * exist so the contract has worked examples to test and so the executor (C2) has tools to apply.
 */

/**
 * `memory.write` — append or correct a memory on an HQ-internal subject. REVERSIBLE (append-or-
 * correctable HQ state), so an autonomous application can be undone; costless to estimate.
 */
export const memoryWriteTool: RegisteredTool = defineTool({
  label: "memory.write",
  description: "Append or correct a memory on an HQ-internal subject — reversible HQ substrate.",
  permission: "memory.write",
  argSchema: z.object({
    verdict: z.string().min(1),
    score: z.number().int().min(0).max(100).optional(),
  }),
  costEstimator: () => 0,
  reversibilityClass: "reversible",
});

/**
 * `comm.send` — send a communication to a subject. IRREVERSIBLE once dispatched (a sent message
 * cannot be unsent), so it biases to approval; an SMS carries a descriptive cost estimate.
 */
export const commSendTool: RegisteredTool = defineTool({
  label: "comm.send",
  description: "Send a communication to a subject — irreversible once dispatched.",
  permission: "comm.send",
  argSchema: z.object({
    channel: z.enum(["email", "sms"]),
    body: z.string().min(1),
  }),
  costEstimator: (args) => (args.channel === "sms" ? 1_000 : 0),
  reversibilityClass: "irreversible",
});

/**
 * The reference registry — the worked catalogue over the reference tools. A descriptive index for
 * tests and for the executor (C2) to consume later; it resolves and lists, it executes nothing.
 */
export const REFERENCE_TOOL_REGISTRY: ToolRegistry = createToolRegistry([
  memoryWriteTool,
  commSendTool,
]);
