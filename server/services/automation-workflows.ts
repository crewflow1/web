import "server-only";
import { readFailure } from "@/lib/supabase/read-failure";
import {
  compileWorkflowGraph,
  isWorkflowGraph,
  type WorkflowGraph,
} from "@/lib/automation/workflow-graph";
import type { CustomRuleDefinition } from "@/lib/automation/custom-rules";
import type { AutomationCustomRuleClient } from "@/server/services/automation-custom-rules";

/**
 * Automation OS — the VISUAL WORKFLOW BUILDER service (20261193).
 *
 * Orchestration over the visual node-graph authoring surface. It does exactly ONE
 * novel thing — COMPILE a graph to a `CustomRuleDefinition` — and then rides the
 * EXISTING rails: the compiled rule is stored in automation_custom_rules.definition
 * (the same column the form builder writes) and executed by the ONE dispatcher
 * through the automation_runs / action-registry path. There is no second engine.
 *
 * The compile (lib/automation/workflow-graph.ts) hands its raw definition to the
 * shared validateCustomRuleDefinition, so the visual output can never differ in
 * safety from a form-authored rule: whitelisted actions, sanitised params, bounded
 * conditions, an exposable trigger.
 *
 * SCOPING — the money-table doctrine (identical to automation-custom-rules):
 *   1. RLS (member-read / admin-write) is the OUTER boundary, DB-enforced.
 *   2. `org_id` is PINNED on every read AND write here — the pin is what scopes a
 *      dual-org member's write to the intended company; RLS alone would blend.
 *
 * DRAFT SAFETY. A graph containing a dark node (delay / ai-decision / webhook) has
 * no live primitive, so the compiler marks it a draft and this service FORCES the
 * rule disabled — nothing dark is ever advertised as live, the phantom-rule
 * discipline applied to the visual surface.
 *
 * Reads are LOUD (throw on error) + F-1 paged. The new columns/table are not in the
 * generated Supabase types → the established loose-client cast idiom.
 */

export type WorkflowRuleRecord = {
  id: string;
  org_id: string;
  name: string;
  description: string | null;
  trigger_event: string;
  definition: CustomRuleDefinition | Record<string, unknown>;
  graph: WorkflowGraph | null;
  graph_version: number;
  source: "form" | "visual";
  is_draft: boolean;
  enabled: boolean;
  created_at: string;
  updated_at: string;
};

const WORKFLOW_RULE_COLS =
  "id, org_id, name, description, trigger_event, definition, graph, graph_version, source, is_draft, enabled, created_at, updated_at";

export type WorkflowVersionRecord = {
  id: string;
  org_id: string;
  custom_rule_id: string;
  version: number;
  graph: WorkflowGraph | Record<string, unknown>;
  compiled_definition: CustomRuleDefinition | Record<string, unknown>;
  is_draft: boolean;
  note: string | null;
  created_by: string | null;
  created_at: string;
};

const VERSION_COLS =
  "id, org_id, custom_rule_id, version, graph, compiled_definition, is_draft, note, created_by, created_at";

const VERSION_PAGE_SIZE = 20;

export type Page<T> = { items: T[]; page: number; hasMore: boolean };

export type WorkflowSaveInput = {
  /** Present on edit; absent on create. */
  ruleId?: string;
  name: string;
  description: string | null;
  /** The untrusted graph JSON from the canvas (compiled + validated here). */
  graph: unknown;
  /** Optional note recorded on the version row. */
  note?: string | null;
};

export type WorkflowSaveResult = {
  ruleId: string;
  version: number;
  isDraft: boolean;
  darkKinds: string[];
};

function normaliseName(name: string): string {
  return name.trim().slice(0, 120);
}
function normaliseDescription(d: string | null): string | null {
  if (d === null) return null;
  const t = d.trim();
  return t.length === 0 ? null : t.slice(0, 500);
}

/**
 * Create or update a visual workflow rule.
 *
 * 1. Compile the graph → CustomRuleDefinition (the injection boundary re-runs).
 * 2. Persist to automation_custom_rules — the SAME table + `definition` column the
 *    dispatcher already executes. A draft (dark node present) is forced disabled.
 * 3. Append a version-history row (append-only) carrying the graph + compiled
 *    definition, so the revision can be viewed and restored.
 *
 * Org-pinned on every predicate; RLS admin-write is the real boundary. Throws on a
 * compile error or DB error.
 */
export async function saveWorkflow(
  client: AutomationCustomRuleClient,
  orgId: string,
  input: WorkflowSaveInput,
  userId: string | null,
): Promise<WorkflowSaveResult> {
  const name = normaliseName(input.name);
  if (name.length === 0) throw new Error("workflow name is required");

  const compiled = compileWorkflowGraph(input.graph);
  if (!compiled.ok) throw new Error(`invalid workflow: ${compiled.error}`);
  const graph = input.graph as WorkflowGraph;
  const definition = compiled.definition;
  const isDraft = compiled.isDraft;

  let ruleId: string;
  let nextGraphVersion: number;

  if (input.ruleId) {
    // Update path — org-pinned predicate (id AND org_id) so a crafted id from
    // another org cannot be edited even before RLS.
    const existing = await getWorkflowRule(client, orgId, input.ruleId);
    if (!existing) throw new Error("workflow not found");
    nextGraphVersion = (existing.graph_version || 0) + 1;

    const patch: Record<string, unknown> = {
      name,
      description: normaliseDescription(input.description),
      trigger_event: definition.trigger,
      definition,
      graph,
      graph_version: nextGraphVersion,
      source: "visual",
      is_draft: isDraft,
      updated_by: userId,
    };
    // A draft can never be live: force it off. A non-draft leaves the current
    // enabled state alone (an admin toggles it via the existing control).
    if (isDraft) patch.enabled = false;

    const res = await client
      .from("automation_custom_rules")
      .update(patch)
      .eq("id", input.ruleId)
      .eq("org_id", orgId);
    if (res.error) {
      throw new Error(
        `workflow update failed: ${(res.error as { message?: string }).message ?? String(res.error)}`,
      );
    }
    ruleId = input.ruleId;
  } else {
    // Create path.
    nextGraphVersion = 1;
    const res = await client
      .from("automation_custom_rules")
      .insert({
        org_id: orgId,
        name,
        description: normaliseDescription(input.description),
        trigger_event: definition.trigger,
        definition,
        graph,
        graph_version: nextGraphVersion,
        source: "visual",
        is_draft: isDraft,
        // A draft ships disabled; a clean workflow ships enabled like the form path.
        enabled: !isDraft,
        created_by: userId,
        updated_by: userId,
      })
      .select("id")
      .single();
    if (res.error) {
      throw new Error(
        `workflow create failed: ${(res.error as { message?: string }).message ?? String(res.error)}`,
      );
    }
    ruleId = String((res.data as { id?: string })?.id ?? "");
    if (ruleId.length === 0) throw new Error("workflow create returned no id");
  }

  // Append the version-history row. Integrity is guarded by unique(rule, version);
  // a colliding concurrent save throws and the caller surfaces it.
  const version = await nextVersionNumber(client, orgId, ruleId, nextGraphVersion);
  const vres = await client
    .from("automation_workflow_versions")
    .insert({
      org_id: orgId,
      custom_rule_id: ruleId,
      version,
      graph,
      compiled_definition: definition,
      is_draft: isDraft,
      note: input.note ? input.note.trim().slice(0, 500) : null,
      created_by: userId,
    });
  if (vres.error) {
    throw new Error(
      `workflow version record failed: ${(vres.error as { message?: string }).message ?? String(vres.error)}`,
    );
  }

  return {
    ruleId,
    version,
    isDraft,
    darkKinds: compiled.darkKinds,
  };
}

/**
 * Next version number for a rule = max(existing) + 1, falling back to the rule's
 * graph_version when no history row exists yet. Org-pinned read.
 */
async function nextVersionNumber(
  client: AutomationCustomRuleClient,
  orgId: string,
  ruleId: string,
  fallback: number,
): Promise<number> {
  const res = await client
    .from("automation_workflow_versions")
    .select("version")
    .eq("org_id", orgId)
    .eq("custom_rule_id", ruleId)
    .order("version", { ascending: false })
    .limit(1);
  if (res.error) {
    throw readFailure("automation workflow versions: max", res.error);
  }
  const rows = (res.data ?? []) as unknown as { version: number }[];
  const top = rows[0]?.version;
  return typeof top === "number" && top >= 1 ? top + 1 : Math.max(1, fallback);
}

/** Read one workflow rule (with its graph) by (id, org_id). LOUD, org-pinned. */
export async function getWorkflowRule(
  client: AutomationCustomRuleClient,
  orgId: string,
  id: string,
): Promise<WorkflowRuleRecord | null> {
  const res = await client
    .from("automation_custom_rules")
    .select(WORKFLOW_RULE_COLS)
    .eq("id", id)
    .eq("org_id", orgId)
    .maybeSingle();
  if (res.error) throw readFailure("automation workflow rule: get", res.error);
  const row = res.data as unknown as WorkflowRuleRecord | null;
  if (!row) return null;
  // Normalise the graph: a form-built rule has null; a malformed jsonb reads as null.
  return {
    ...row,
    graph: isWorkflowGraph(row.graph) ? (row.graph as WorkflowGraph) : null,
  };
}

/**
 * List a rule's version history, newest first. LOUD, org-pinned, F-1 paged.
 * Fetches PAGE_SIZE+1 to report hasMore without a second count query.
 */
export async function listWorkflowVersions(
  client: AutomationCustomRuleClient,
  orgId: string,
  ruleId: string,
  page = 0,
): Promise<Page<WorkflowVersionRecord>> {
  const safePage = Number.isInteger(page) && page >= 0 ? page : 0;
  const from = safePage * VERSION_PAGE_SIZE;
  const to = from + VERSION_PAGE_SIZE; // inclusive → fetches PAGE_SIZE + 1
  const res = await client
    .from("automation_workflow_versions")
    .select(VERSION_COLS)
    .eq("org_id", orgId)
    .eq("custom_rule_id", ruleId)
    .order("version", { ascending: false })
    .range(from, to);
  if (res.error) throw readFailure("automation workflow versions: list", res.error);
  const rows = (res.data ?? []) as unknown as WorkflowVersionRecord[];
  return {
    items: rows.slice(0, VERSION_PAGE_SIZE),
    page: safePage,
    hasMore: rows.length > VERSION_PAGE_SIZE,
  };
}

/**
 * Restore a prior version: re-save its graph as the current rule (which appends a
 * fresh version, so history is never rewritten — a restore is just another edit
 * that happens to reuse an old graph). Org-pinned. Throws if the version isn't the
 * org's / rule's, or if the old graph no longer compiles.
 */
export async function restoreWorkflowVersion(
  client: AutomationCustomRuleClient,
  orgId: string,
  ruleId: string,
  versionId: string,
  userId: string | null,
): Promise<WorkflowSaveResult> {
  const res = await client
    .from("automation_workflow_versions")
    .select(VERSION_COLS)
    .eq("id", versionId)
    .eq("org_id", orgId)
    .eq("custom_rule_id", ruleId)
    .maybeSingle();
  if (res.error) throw readFailure("automation workflow versions: restore-read", res.error);
  const version = res.data as unknown as WorkflowVersionRecord | null;
  if (!version) throw new Error("version not found");

  const rule = await getWorkflowRule(client, orgId, ruleId);
  if (!rule) throw new Error("workflow not found");

  return saveWorkflow(
    client,
    orgId,
    {
      ruleId,
      name: rule.name,
      description: rule.description,
      graph: version.graph,
      note: `Restored from v${version.version}`,
    },
    userId,
  );
}
