import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  compileWorkflowGraph,
  validateWorkflowGraph,
  hasCycle,
  emptyWorkflowGraph,
  DARK_NODE_KINDS,
  type WorkflowGraph,
} from "@/lib/automation/workflow-graph";
import {
  validateCustomRuleDefinition,
  immediateActions,
  downstreamActions,
} from "@/lib/automation/custom-rules";
import { evaluateConditions } from "@/lib/automation/conditions";
import {
  saveWorkflow,
  listWorkflowVersions,
  restoreWorkflowVersion,
  getWorkflowRule,
} from "@/server/services/automation-workflows";
import type { AutomationCustomRuleClient } from "@/server/services/automation-custom-rules";

/**
 * Visual workflow builder (20261193) — the graph compiles INTO the existing
 * engine, never beside it.
 *
 * These pin the mandated properties: graph→rule compilation EQUIVALENCE (the
 * compiled definition is byte-identical to the form path's validated output),
 * cycle rejection, DAG/structural guards, versioning, the disabled/draft state for
 * dark nodes, admin permission gating, and that the compiled output drives the
 * SAME engine primitives (evaluateConditions + immediate/downstream actions).
 */

// ── Graph helpers for the tests ─────────────────────────────────────────────────

function linkedGraph(overrides?: Partial<WorkflowGraph>): WorkflowGraph {
  // trigger → condition(amount>1000) → action(notify high) → approval →
  // communication(email) → end
  const g: WorkflowGraph = {
    version: 1,
    combinator: "and",
    nodes: [
      { id: "t", kind: "trigger", x: 0, y: 0, data: { trigger: "quote.accepted" } },
      {
        id: "c",
        kind: "condition",
        x: 0,
        y: 0,
        data: { field: "amount", operator: "gt", value: "1000" },
      },
      {
        id: "a1",
        kind: "action",
        x: 0,
        y: 0,
        data: { actionType: "create_notification", params: { priority: "high" } },
      },
      { id: "ap", kind: "approval", x: 0, y: 0, data: {} },
      {
        id: "a2",
        kind: "communication",
        x: 0,
        y: 0,
        data: { channel: "email", params: { audience: "customer" } },
      },
      { id: "end", kind: "end", x: 0, y: 0, data: {} },
    ],
    edges: [
      { id: "e1", from: "t", to: "c" },
      { id: "e2", from: "c", to: "a1" },
      { id: "e3", from: "a1", to: "ap" },
      { id: "e4", from: "ap", to: "a2" },
      { id: "e5", from: "a2", to: "end" },
    ],
    ...overrides,
  };
  return g;
}

// ── 1. Compilation equivalence ──────────────────────────────────────────────────

describe("graph → rule compilation equivalence", () => {
  it("compiles to the SAME definition the form builder would validate", () => {
    const res = compileWorkflowGraph(linkedGraph());
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    // The hand-authored equivalent, passed through the SAME injection boundary.
    const handAuthored = validateCustomRuleDefinition({
      trigger: "quote.accepted",
      conditions: {
        combinator: "and",
        conditions: [{ field: "amount", operator: "gt", value: "1000" }],
      },
      actions: [
        { type: "create_notification", params: { priority: "high" } },
        { type: "send_email_queue", params: { audience: "customer" } },
      ],
      requiresApproval: true,
      approvalPosition: 1,
    });
    expect(handAuthored.ok).toBe(true);
    if (!handAuthored.ok) return;

    // Byte-identical — the visual output is indistinguishable from a form rule.
    expect(res.definition).toEqual(handAuthored.value);
    expect(res.isDraft).toBe(false);
  });

  it("maps a communication(notification) node to create_notification", () => {
    const g = emptyWorkflowGraph("lead.created");
    g.nodes.push({
      id: "comm",
      kind: "communication",
      x: 0,
      y: 0,
      data: { channel: "notification", params: { audience: "hq" } },
    });
    g.edges = [
      { id: "e1", from: "trigger", to: "comm" },
      { id: "e2", from: "comm", to: "end" },
    ];
    const res = compileWorkflowGraph(g);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.definition.actions).toEqual([
      { type: "create_notification", params: { audience: "hq" } },
    ]);
  });
});

// ── 2. Cycle rejection + DAG guard ──────────────────────────────────────────────

describe("cycle rejection", () => {
  it("hasCycle detects a back-edge", () => {
    const g = linkedGraph({
      edges: [
        { id: "e1", from: "t", to: "c" },
        { id: "e2", from: "c", to: "a1" },
        { id: "e3", from: "a1", to: "c" }, // back-edge → cycle
      ],
    });
    expect(hasCycle(g)).toBe(true);
  });

  it("compile rejects a cyclic graph", () => {
    const g = linkedGraph({
      edges: [
        { id: "e1", from: "t", to: "c" },
        { id: "e2", from: "c", to: "a1" },
        { id: "e3", from: "a1", to: "c" },
      ],
    });
    const res = compileWorkflowGraph(g);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/loop/i);
  });

  it("a clean linked graph is acyclic", () => {
    expect(hasCycle(linkedGraph())).toBe(false);
  });
});

describe("structural / DAG validation", () => {
  it("rejects a graph with no trigger", () => {
    const g = linkedGraph();
    g.nodes = g.nodes.filter((n) => n.kind !== "trigger");
    g.edges = g.edges.filter((e) => e.from !== "t");
    const v = validateWorkflowGraph(g);
    expect(v.ok).toBe(false);
    expect(v.errors.join(" ")).toMatch(/trigger/i);
  });

  it("rejects a disconnected step", () => {
    const g = linkedGraph();
    g.nodes.push({ id: "orphan", kind: "end", x: 0, y: 0, data: {} });
    const v = validateWorkflowGraph(g);
    expect(v.ok).toBe(false);
    expect(v.errors.join(" ")).toMatch(/not connected/i);
  });

  it("rejects a non-branch step with two outgoing paths", () => {
    const g = linkedGraph();
    g.nodes.push({ id: "extra", kind: "end", x: 0, y: 0, data: {} });
    g.edges.push({ id: "e6", from: "a1", to: "extra" }); // a1 now has 2 outputs
    const res = compileWorkflowGraph(g);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/more than one|branch/i);
  });

  it("rejects a branch whose ✗ path does not end", () => {
    const g: WorkflowGraph = {
      version: 1,
      combinator: "and",
      nodes: [
        { id: "t", kind: "trigger", x: 0, y: 0, data: { trigger: "lead.created" } },
        { id: "b", kind: "branch", x: 0, y: 0, data: { field: "score", operator: "gt", value: "5" } },
        { id: "a1", kind: "action", x: 0, y: 0, data: { actionType: "create_alert", params: {} } },
        { id: "a2", kind: "action", x: 0, y: 0, data: { actionType: "add_internal_note", params: {} } },
        { id: "end", kind: "end", x: 0, y: 0, data: {} },
      ],
      edges: [
        { id: "e1", from: "t", to: "b" },
        { id: "e2", from: "b", to: "a1", branch: "true" },
        { id: "e3", from: "b", to: "a2", branch: "false" }, // ✗ → action, not end
        { id: "e4", from: "a1", to: "end" },
      ],
    };
    const res = compileWorkflowGraph(g);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/End step|separate rules/i);
  });

  it("rejects a non-exposable trigger", () => {
    const g = emptyWorkflowGraph("invoice.created" as never);
    g.nodes.push({ id: "a", kind: "action", x: 0, y: 0, data: { actionType: "create_alert", params: {} } });
    g.edges = [
      { id: "e1", from: "trigger", to: "a" },
      { id: "e2", from: "a", to: "end" },
    ];
    const res = compileWorkflowGraph(g);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/not available/i);
  });

  it("rejects a workflow with no action step", () => {
    const g = emptyWorkflowGraph("lead.created");
    const res = compileWorkflowGraph(g);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/at least one action/i);
  });
});

// ── 3. Disabled / draft state (dark nodes) ──────────────────────────────────────

describe("dark nodes → draft (disabled) state", () => {
  it("a graph with a delay node compiles as a draft, keeping live actions", () => {
    const g = emptyWorkflowGraph("payment.recorded");
    g.nodes.push({ id: "d", kind: "delay", x: 0, y: 0, data: { seconds: 3600 } });
    g.nodes.push({
      id: "a",
      kind: "action",
      x: 0,
      y: 0,
      data: { actionType: "create_notification", params: {} },
    });
    g.edges = [
      { id: "e1", from: "trigger", to: "d" },
      { id: "e2", from: "d", to: "a" },
      { id: "e3", from: "a", to: "end" },
    ];
    const res = compileWorkflowGraph(g);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.isDraft).toBe(true);
    expect(res.darkKinds).toContain("delay");
    // The delay emits NO action; the live action still compiles.
    expect(res.definition.actions).toEqual([
      { type: "create_notification", params: {} },
    ]);
  });

  it("the dark-kind set is exactly delay, ai_decision, webhook", () => {
    expect([...DARK_NODE_KINDS].sort()).toEqual(
      ["ai_decision", "delay", "webhook"].sort(),
    );
  });
});

// ── 4. The compiled output drives the EXISTING engine primitives ────────────────

describe("compiled definition executes via the existing engine", () => {
  it("its condition tree + action split feed evaluateConditions / immediate / downstream", () => {
    const res = compileWorkflowGraph(linkedGraph());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const def = res.definition;

    // The dispatcher gates on evaluateConditions(def.conditions, payload).
    expect(evaluateConditions(def.conditions, { amount: 5000 })).toBe(true);
    expect(evaluateConditions(def.conditions, { amount: 10 })).toBe(false);

    // The dispatcher splits actions at the approval gate exactly this way.
    expect(immediateActions(def).map((a) => a.type)).toEqual(["create_notification"]);
    expect(downstreamActions(def).map((a) => a.type)).toEqual(["send_email_queue"]);
  });

  it("re-validating the compiled definition is a fixed point", () => {
    const res = compileWorkflowGraph(linkedGraph());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const round = validateCustomRuleDefinition(res.definition);
    expect(round.ok).toBe(true);
    if (round.ok) expect(round.value).toEqual(res.definition);
  });
});

// ── 5. Service: persistence, versioning, draft, restore ─────────────────────────

/** A tiny in-memory Supabase-shaped client for the two tables the service uses. */
type FakeTables = {
  automation_custom_rules: Record<string, unknown>[];
  automation_workflow_versions: Record<string, unknown>[];
  [k: string]: Record<string, unknown>[];
};

function makeFakeClient(): {
  client: AutomationCustomRuleClient;
  tables: FakeTables;
} {
  const tables: FakeTables = {
    automation_custom_rules: [],
    automation_workflow_versions: [],
  };
  let idSeq = 1;

  function from(table: string) {
    const rows = tables[table] ?? (tables[table] = []);
    const filters: Array<[string, unknown]> = [];
    let mode: "select" | "insert" | "update" | "delete" = "select";
    let payload: Record<string, unknown> | null = null;
    let selectCols = "";
    let orderKey: string | null = null;
    let orderAsc = true;

    const applyFilters = (r: Record<string, unknown>) =>
      filters.every(([k, v]) => r[k] === v);

    function resolveRows(): Record<string, unknown>[] {
      let out = rows.filter(applyFilters);
      if (orderKey) {
        const k = orderKey;
        out = [...out].sort((a, b) => {
          const av = a[k] as number | string;
          const bv = b[k] as number | string;
          if (av === bv) return 0;
          return (av < bv ? -1 : 1) * (orderAsc ? 1 : -1);
        });
      }
      return out;
    }

    function terminalResult(): { data: unknown; error: unknown } {
      if (mode === "insert" && payload) {
        const row = { id: `id_${idSeq++}`, ...payload };
        rows.push(row);
        return { data: row, error: null };
      }
      if (mode === "update" && payload) {
        for (const r of rows) if (applyFilters(r)) Object.assign(r, payload);
        return { data: null, error: null };
      }
      if (mode === "delete") {
        for (let i = rows.length - 1; i >= 0; i--) if (applyFilters(rows[i]!)) rows.splice(i, 1);
        return { data: null, error: null };
      }
      return { data: resolveRows(), error: null };
    }

    const builder: Record<string, unknown> = {
      select(cols: string) {
        selectCols = cols;
        return builder;
      },
      insert(r: Record<string, unknown>) {
        mode = "insert";
        payload = r;
        return builder;
      },
      update(r: Record<string, unknown>) {
        mode = "update";
        payload = r;
        return builder;
      },
      delete() {
        mode = "delete";
        return builder;
      },
      eq(k: string, v: unknown) {
        filters.push([k, v]);
        return builder;
      },
      order(k: string, o: { ascending: boolean }) {
        orderKey = k;
        orderAsc = o.ascending;
        return builder;
      },
      limit(_n: number) {
        return Promise.resolve(terminalResult());
      },
      range(from: number, to: number) {
        const all = resolveRows();
        return Promise.resolve({ data: all.slice(from, to + 1), error: null });
      },
      single() {
        const res = terminalResult();
        const data = Array.isArray(res.data) ? res.data[0] ?? null : res.data;
        return Promise.resolve({ data, error: null });
      },
      maybeSingle() {
        const res = terminalResult();
        const data = Array.isArray(res.data) ? res.data[0] ?? null : res.data;
        return Promise.resolve({ data, error: null });
      },
      then(onF: (v: { data: unknown; error: unknown }) => unknown) {
        // `await client.from(t).update(...).eq(...)` resolves here.
        return Promise.resolve(terminalResult()).then(onF);
      },
    };
    return builder;
  }

  return { client: { from } as unknown as AutomationCustomRuleClient, tables };
}

describe("saveWorkflow — persistence + versioning through the existing rule table", () => {
  const ORG = "org-1";
  const USER = "user-1";

  it("creates a visual rule in automation_custom_rules with version 1", async () => {
    const { client, tables } = makeFakeClient();
    const out = await saveWorkflow(
      client,
      ORG,
      { name: "Big quote", description: null, graph: linkedGraph() },
      USER,
    );
    expect(out.version).toBe(1);
    expect(out.isDraft).toBe(false);

    const rule = tables.automation_custom_rules[0]!;
    expect(rule.source).toBe("visual");
    expect(rule.enabled).toBe(true); // clean workflow ships enabled
    expect(rule.is_draft).toBe(false);
    expect(rule.trigger_event).toBe("quote.accepted");
    expect(rule.org_id).toBe(ORG);
    // The compiled definition — the runnable artifact — is stored on the rule.
    expect((rule.definition as { actions: unknown[] }).actions.length).toBe(2);

    expect(tables.automation_workflow_versions.length).toBe(1);
    expect(tables.automation_workflow_versions[0]!.version).toBe(1);
  });

  it("update bumps graph_version and appends version 2", async () => {
    const { client, tables } = makeFakeClient();
    const created = await saveWorkflow(
      client,
      ORG,
      { name: "Rule", description: null, graph: linkedGraph() },
      USER,
    );
    const updated = await saveWorkflow(
      client,
      ORG,
      { ruleId: created.ruleId, name: "Rule v2", description: "changed", graph: linkedGraph() },
      USER,
    );
    expect(updated.version).toBe(2);
    const rule = tables.automation_custom_rules.find((r) => r.id === created.ruleId)!;
    expect(rule.name).toBe("Rule v2");
    expect(rule.graph_version).toBe(2);
    expect(tables.automation_workflow_versions.length).toBe(2);

    const page = await listWorkflowVersions(client, ORG, created.ruleId, 0);
    expect(page.items.map((v) => v.version)).toEqual([2, 1]); // newest first
  });

  it("a dark-node graph persists disabled (is_draft true)", async () => {
    const { client, tables } = makeFakeClient();
    const g = emptyWorkflowGraph("payment.recorded");
    g.nodes.push({ id: "wh", kind: "webhook", x: 0, y: 0, data: {} });
    g.nodes.push({ id: "a", kind: "action", x: 0, y: 0, data: { actionType: "create_alert", params: {} } });
    g.edges = [
      { id: "e1", from: "trigger", to: "wh" },
      { id: "e2", from: "wh", to: "a" },
      { id: "e3", from: "a", to: "end" },
    ];
    const out = await saveWorkflow(client, ORG, { name: "Dark", description: null, graph: g }, USER);
    expect(out.isDraft).toBe(true);
    const rule = tables.automation_custom_rules[0]!;
    expect(rule.enabled).toBe(false); // never live
    expect(rule.is_draft).toBe(true);
  });

  it("restore appends a new version from an older graph", async () => {
    const { client, tables } = makeFakeClient();
    const created = await saveWorkflow(
      client,
      ORG,
      { name: "Rule", description: null, graph: linkedGraph() },
      USER,
    );
    // second edit
    await saveWorkflow(
      client,
      ORG,
      { ruleId: created.ruleId, name: "Rule", description: null, graph: emptyWorkflowGraphWithAction() },
      USER,
    );
    const versionsBefore = await listWorkflowVersions(client, ORG, created.ruleId, 0);
    const v1 = versionsBefore.items.find((v) => v.version === 1)!;

    const restored = await restoreWorkflowVersion(client, ORG, created.ruleId, v1.id, USER);
    expect(restored.version).toBe(3);
    expect(tables.automation_workflow_versions.length).toBe(3);

    // The rule's graph is now the restored (v1) graph — a two-action rule again.
    const rule = await getWorkflowRule(client, ORG, created.ruleId);
    expect((rule!.definition as { actions: unknown[] }).actions.length).toBe(2);
  });

  it("rejects a rule id from another org on update (org-pinned)", async () => {
    const { client } = makeFakeClient();
    const created = await saveWorkflow(
      client,
      ORG,
      { name: "Rule", description: null, graph: linkedGraph() },
      USER,
    );
    await expect(
      saveWorkflow(
        client,
        "org-OTHER",
        { ruleId: created.ruleId, name: "hijack", description: null, graph: linkedGraph() },
        USER,
      ),
    ).rejects.toThrow(/not found/i);
  });
});

function emptyWorkflowGraphWithAction(): WorkflowGraph {
  const g = emptyWorkflowGraph("quote.accepted");
  g.nodes.push({
    id: "a",
    kind: "action",
    x: 0,
    y: 0,
    data: { actionType: "create_alert", params: {} },
  });
  g.edges = [
    { id: "e1", from: "trigger", to: "a" },
    { id: "e2", from: "a", to: "end" },
  ];
  return g;
}

// ── 6. Permission gating + RLS (hermetic text proofs) ───────────────────────────

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

describe("admin gating + RLS on the visual builder", () => {
  it("both workflow server actions gate on isManager and requireOrgContext", () => {
    const actions = read("app/(app)/settings/automations/actions.ts");
    for (const fn of ["saveWorkflowAction", "restoreWorkflowVersionAction"]) {
      const idx = actions.indexOf(`export async function ${fn}`);
      expect(idx, `${fn} present`).toBeGreaterThan(-1);
      const body = actions.slice(idx, idx + 900);
      expect(body, `${fn} calls requireOrgContext`).toMatch(/requireOrgContext/);
      expect(body, `${fn} checks isManager`).toMatch(/isManager\(ctx\.membership\.role\)/);
    }
  });

  it("the new version table has admin-write / member-read RLS, org-pinned + cascade", () => {
    const sql = read("supabase/migrations/20261193000000_automation_workflow_graphs.sql")
      .split("\n")
      .map((l) => {
        const i = l.indexOf("--");
        return i === -1 ? l : l.slice(0, i);
      })
      .join("\n");
    expect(sql).toMatch(
      /alter table public\.automation_workflow_versions enable row level security/i,
    );
    expect(sql).toMatch(/members can select[\s\S]*?for select[\s\S]*?current_org_ids\(\)/i);
    for (const verb of ["insert", "update", "delete"]) {
      expect(sql, `admin ${verb} policy`).toMatch(
        new RegExp(`admins can ${verb}[\\s\\S]*?for ${verb}[\\s\\S]*?is_org_admin`, "i"),
      );
    }
    expect(sql).toMatch(/org_id[\s\S]*?references public\.organizations\(id\) on delete cascade/i);
  });

  it("the new org-scoped table is registered in the GDPR census", () => {
    const orgTables = JSON.parse(read("lib/gdpr/org-tables.json")) as { known: string[] };
    expect(orgTables.known).toContain("automation_workflow_versions");
  });
});
