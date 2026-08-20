"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { saveWorkflowAction } from "./actions";
import { CustomRuleBuilder, type BuilderInitial } from "./CustomRuleBuilder";
import {
  EXPOSABLE_AUTOMATION_TRIGGERS,
  AUTOMATION_TRIGGER_LABELS,
} from "@/lib/automation/events";
import {
  CONDITION_OPERATORS,
  VALUELESS_OPERATORS,
  type ConditionOperator,
} from "@/lib/automation/conditions";
import {
  CUSTOM_ACTION_REGISTRY,
  actionSpec,
} from "@/lib/automation/action-registry";
import {
  compileWorkflowGraph,
  validateWorkflowGraph,
  emptyWorkflowGraph,
  DARK_NODE_KINDS,
  type WorkflowGraph,
  type WorkflowNode,
  type WorkflowNodeKind,
} from "@/lib/automation/workflow-graph";

/**
 * The VISUAL workflow builder (client) — a hand-built SVG/DOM node-graph editor.
 *
 * It composes a WorkflowGraph on a pan-free canvas (drag nodes, click ports to
 * connect) and mirrors the graph into a hidden `graph` input submitted to
 * saveWorkflowAction. The SERVER re-compiles + re-validates the graph
 * (compileWorkflowGraph → validateCustomRuleDefinition — the injection boundary);
 * this canvas previews that exact compile so the author sees what will run, but it
 * is never the security gate.
 *
 * No external graph library — pure React + SVG, so it can't break the CSP or the
 * build. On small screens the canvas is impractical, so the existing stacked FORM
 * builder is rendered as the mobile path (it writes a form-authored rule through
 * the same engine).
 */

const NODE_W = 172;
const NODE_H = 62;

const KIND_META: Record<
  WorkflowNodeKind,
  { label: string; hint: string; accent: string; addable: boolean }
> = {
  trigger: { label: "Trigger", hint: "When this happens", accent: "#4f46e5", addable: false },
  condition: { label: "Condition", hint: "Only if…", accent: "#0891b2", addable: true },
  branch: { label: "Branch", hint: "Yes / no split", accent: "#0d9488", addable: true },
  delay: { label: "Delay", hint: "Wait (dark)", accent: "#a16207", addable: true },
  action: { label: "Action", hint: "Do something", accent: "#7c3aed", addable: true },
  communication: { label: "Communication", hint: "Notify / email", accent: "#c026d3", addable: true },
  approval: { label: "Approval", hint: "Human sign-off", accent: "#d97706", addable: true },
  ai_decision: { label: "AI decision", hint: "Governed AI (dark)", accent: "#be123c", addable: true },
  webhook: { label: "Webhook", hint: "Call out (dark)", accent: "#475569", addable: true },
  end: { label: "End", hint: "Stop", accent: "#334155", addable: true },
};

const CUSTOM_ACTIONS = CUSTOM_ACTION_REGISTRY.filter((s) => s.availableToCustom);

const OPERATOR_LABELS: Record<ConditionOperator, string> = {
  eq: "equals",
  neq: "does not equal",
  gt: "greater than",
  gte: "greater than or equal",
  lt: "less than",
  lte: "less than or equal",
  contains: "contains",
  not_contains: "does not contain",
  starts_with: "starts with",
  ends_with: "ends with",
  exists: "is present",
  not_exists: "is empty",
  in: "is one of (comma-separated)",
  not_in: "is not one of (comma-separated)",
  is_true: "is true",
  is_false: "is false",
};

function uid(prefix: string): string {
  const rand =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `${prefix}_${rand}`;
}

function defaultData(kind: WorkflowNodeKind): Record<string, unknown> {
  switch (kind) {
    case "condition":
    case "branch":
      return { field: "", operator: "eq", value: "" };
    case "action":
      return { actionType: CUSTOM_ACTIONS[0]?.type ?? "", params: {} };
    case "communication":
      return { channel: "notification", params: {} };
    case "delay":
      return { seconds: 3600 };
    case "ai_decision":
      return { note: "" };
    case "webhook":
      return { note: "" };
    default:
      return {};
  }
}

function portOut(n: WorkflowNode): { x: number; y: number } {
  return { x: n.x + NODE_W, y: n.y + NODE_H / 2 };
}
function portIn(n: WorkflowNode): { x: number; y: number } {
  return { x: n.x, y: n.y + NODE_H / 2 };
}

export type WorkflowCanvasProps = {
  ruleId?: string;
  initialName?: string;
  initialDescription?: string | null;
  initialGraph?: WorkflowGraph | null;
  /** For the mobile form fallback when editing a rule. */
  mobileInitial?: BuilderInitial;
};

export function WorkflowCanvas({
  ruleId,
  initialName,
  initialDescription,
  initialGraph,
  mobileInitial,
}: WorkflowCanvasProps) {
  const seed = useMemo<WorkflowGraph>(
    () => initialGraph ?? emptyWorkflowGraph(),
    [initialGraph],
  );

  const [name, setName] = useState(initialName ?? "");
  const [description, setDescription] = useState(initialDescription ?? "");
  const [combinator, setCombinator] = useState<"and" | "or">(seed.combinator ?? "and");
  const [nodes, setNodes] = useState<WorkflowNode[]>(seed.nodes);
  const [edges, setEdges] = useState<WorkflowGraph["edges"]>(seed.edges);
  const [selected, setSelected] = useState<string | null>(null);
  const [connectFrom, setConnectFrom] = useState<
    { id: string; branch?: "true" | "false" } | null
  >(null);

  const canvasRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ id: string; dx: number; dy: number } | null>(null);

  const graph = useMemo<WorkflowGraph>(
    () => ({ version: seed.version ?? 1, combinator, nodes, edges }),
    [seed.version, combinator, nodes, edges],
  );

  const structural = useMemo(() => validateWorkflowGraph(graph), [graph]);
  const compiled = useMemo(() => compileWorkflowGraph(graph), [graph]);
  const graphJson = useMemo(() => JSON.stringify(graph), [graph]);

  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);

  // ── Node ops ────────────────────────────────────────────────────────────────
  const addNode = useCallback(
    (kind: WorkflowNodeKind) => {
      const id = uid(kind);
      setNodes((ns) => [
        ...ns,
        {
          id,
          kind,
          x: 260 + ((ns.length * 24) % 200),
          y: 40 + ((ns.length * 40) % 260),
          data: defaultData(kind),
        },
      ]);
      setSelected(id);
    },
    [],
  );

  const patchNode = useCallback((id: string, patch: Partial<WorkflowNode>) => {
    setNodes((ns) => ns.map((n) => (n.id === id ? { ...n, ...patch } : n)));
  }, []);
  const patchNodeData = useCallback(
    (id: string, dataPatch: Record<string, unknown>) => {
      setNodes((ns) =>
        ns.map((n) =>
          n.id === id ? { ...n, data: { ...n.data, ...dataPatch } } : n,
        ),
      );
    },
    [],
  );
  const removeNode = useCallback((id: string) => {
    setNodes((ns) => ns.filter((n) => n.id !== id));
    setEdges((es) => es.filter((e) => e.from !== id && e.to !== id));
    setSelected((s) => (s === id ? null : s));
  }, []);
  const removeEdge = useCallback((id: string) => {
    setEdges((es) => es.filter((e) => e.id !== id));
  }, []);

  // ── Connecting ────────────────────────────────────────────────────────────────
  const startConnect = useCallback(
    (id: string, branch?: "true" | "false") => {
      setConnectFrom({ id, branch });
    },
    [],
  );
  const finishConnect = useCallback(
    (toId: string) => {
      if (!connectFrom || connectFrom.id === toId) {
        setConnectFrom(null);
        return;
      }
      setEdges((es) => {
        // Replace an existing edge from the same (source, port) — a port has one wire.
        const filtered = es.filter(
          (e) =>
            !(
              e.from === connectFrom.id &&
              (e.branch ?? "true") === (connectFrom.branch ?? "true")
            ),
        );
        return [
          ...filtered,
          {
            id: uid("e"),
            from: connectFrom.id,
            to: toId,
            ...(connectFrom.branch ? { branch: connectFrom.branch } : {}),
          },
        ];
      });
      setConnectFrom(null);
    },
    [connectFrom],
  );

  // ── Dragging ─────────────────────────────────────────────────────────────────
  const onNodePointerDown = useCallback(
    (e: React.PointerEvent, id: string) => {
      const n = byId.get(id);
      if (!n) return;
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return;
      dragRef.current = {
        id,
        dx: e.clientX - rect.left - n.x,
        dy: e.clientY - rect.top - n.y,
      };
      (e.target as Element).setPointerCapture?.(e.pointerId);
      setSelected(id);
    },
    [byId],
  );
  const onCanvasPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return;
      const x = Math.max(0, Math.min(e.clientX - rect.left - d.dx, 1200));
      const y = Math.max(0, Math.min(e.clientY - rect.top - d.dy, 900));
      patchNode(d.id, { x, y });
    },
    [patchNode],
  );
  const onCanvasPointerUp = useCallback(() => {
    dragRef.current = null;
  }, []);

  const selectedNode = selected ? byId.get(selected) ?? null : null;

  return (
    <div>
      {/* ── Mobile fallback: the stacked form builder (small-screen path) ──── */}
      <div className="md:hidden">
        <div className="mb-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
          The visual canvas needs a larger screen. On mobile, build your rule with
          the simple form below — it runs through the same automation engine.
        </div>
        <CustomRuleBuilder initial={mobileInitial} />
      </div>

      {/* ── Desktop: the node-graph canvas ─────────────────────────────────── */}
      <form action={saveWorkflowAction} className="hidden md:block">
        {ruleId ? <input type="hidden" name="rule_id" value={ruleId} /> : null}
        <input type="hidden" name="graph" value={graphJson} />

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
            Workflow name
            <input
              name="name"
              required
              maxLength={120}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Big quote accepted → alert + approval"
              className="rounded-md border border-slate-300 px-2 py-1 text-sm text-slate-900"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
            Description (optional)
            <input
              name="description"
              maxLength={500}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="rounded-md border border-slate-300 px-2 py-1 text-sm text-slate-900"
            />
          </label>
        </div>

        {/* Palette */}
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
            Add step
          </span>
          {(Object.keys(KIND_META) as WorkflowNodeKind[])
            .filter((k) => KIND_META[k].addable)
            .map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => addNode(k)}
                className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
                style={{ borderLeft: `3px solid ${KIND_META[k].accent}` }}
              >
                + {KIND_META[k].label}
                {DARK_NODE_KINDS.has(k) ? (
                  <span className="ml-1 text-[9px] text-amber-600">dark</span>
                ) : null}
              </button>
            ))}
          <label className="ml-auto flex items-center gap-1 text-[11px] text-slate-600">
            Conditions match
            <select
              value={combinator}
              onChange={(e) => setCombinator(e.target.value as "and" | "or")}
              className="rounded-md border border-slate-300 px-1 py-0.5 text-xs"
            >
              <option value="and">ALL</option>
              <option value="or">ANY</option>
            </select>
          </label>
        </div>

        {connectFrom ? (
          <div className="mt-2 rounded-md border border-indigo-200 bg-indigo-50 px-3 py-1.5 text-xs text-indigo-800">
            Connecting from{" "}
            <strong>{KIND_META[byId.get(connectFrom.id)?.kind ?? "end"].label}</strong>
            {connectFrom.branch ? ` (${connectFrom.branch === "true" ? "✓ yes" : "✗ no"})` : ""} —
            click a step&apos;s left dot to connect, or{" "}
            <button
              type="button"
              onClick={() => setConnectFrom(null)}
              className="underline"
            >
              cancel
            </button>
            .
          </div>
        ) : null}

        <div className="mt-3 grid gap-4 lg:grid-cols-[1fr_260px]">
          {/* Canvas */}
          <div
            ref={canvasRef}
            onPointerMove={onCanvasPointerMove}
            onPointerUp={onCanvasPointerUp}
            onPointerLeave={onCanvasPointerUp}
            className="relative h-[440px] overflow-auto rounded-lg border border-slate-200 bg-[radial-gradient(circle,#e2e8f0_1px,transparent_1px)] [background-size:18px_18px]"
            style={{ touchAction: "none" }}
          >
            {/* Edges */}
            <svg
              className="pointer-events-none absolute inset-0 h-full w-full"
              style={{ overflow: "visible" }}
            >
              {edges.map((e) => {
                const from = byId.get(e.from);
                const to = byId.get(e.to);
                if (!from || !to) return null;
                const p1 = portOut(from);
                const p2 = portIn(to);
                const midX = (p1.x + p2.x) / 2;
                const stroke = e.branch === "false" ? "#dc2626" : "#6366f1";
                return (
                  <g key={e.id}>
                    <path
                      d={`M ${p1.x} ${p1.y} C ${midX} ${p1.y}, ${midX} ${p2.y}, ${p2.x} ${p2.y}`}
                      fill="none"
                      stroke={stroke}
                      strokeWidth={2}
                    />
                    <circle
                      cx={midX}
                      cy={(p1.y + p2.y) / 2}
                      r={7}
                      fill="#fff"
                      stroke={stroke}
                      className="pointer-events-auto cursor-pointer"
                      onClick={() => removeEdge(e.id)}
                    >
                      <title>Remove connection</title>
                    </circle>
                  </g>
                );
              })}
            </svg>

            {/* Nodes */}
            {nodes.map((n) => {
              const meta = KIND_META[n.kind];
              const isSel = selected === n.id;
              return (
                <div
                  key={n.id}
                  className={`absolute rounded-lg border bg-white shadow-sm ${
                    isSel ? "ring-2 ring-indigo-400" : ""
                  }`}
                  style={{
                    left: n.x,
                    top: n.y,
                    width: NODE_W,
                    minHeight: NODE_H,
                    borderColor: meta.accent,
                  }}
                  onClick={() => {
                    if (connectFrom) finishConnect(n.id);
                    else setSelected(n.id);
                  }}
                >
                  {/* input port */}
                  {n.kind !== "trigger" ? (
                    <button
                      type="button"
                      title="Connect into this step"
                      onClick={(ev) => {
                        ev.stopPropagation();
                        if (connectFrom) finishConnect(n.id);
                      }}
                      className="absolute -left-2 top-1/2 h-4 w-4 -translate-y-1/2 rounded-full border-2 border-slate-400 bg-white hover:border-indigo-500"
                    />
                  ) : null}

                  <div
                    onPointerDown={(ev) => onNodePointerDown(ev, n.id)}
                    className="cursor-move rounded-t-lg px-2 py-1 text-[11px] font-semibold text-white"
                    style={{ background: meta.accent }}
                  >
                    {meta.label}
                    {DARK_NODE_KINDS.has(n.kind) ? " · dark" : ""}
                  </div>
                  <div className="px-2 py-1 text-[11px] text-slate-600">
                    {nodeSummary(n)}
                  </div>

                  {/* output port(s) */}
                  {n.kind === "end" ? null : n.kind === "branch" ? (
                    <>
                      <button
                        type="button"
                        title="Yes path"
                        onClick={(ev) => {
                          ev.stopPropagation();
                          startConnect(n.id, "true");
                        }}
                        className="absolute -right-2 top-[38%] h-4 w-4 rounded-full border-2 border-teal-500 bg-white hover:bg-teal-100"
                      />
                      <button
                        type="button"
                        title="No path (must end)"
                        onClick={(ev) => {
                          ev.stopPropagation();
                          startConnect(n.id, "false");
                        }}
                        className="absolute -right-2 top-[70%] h-4 w-4 rounded-full border-2 border-red-500 bg-white hover:bg-red-100"
                      />
                    </>
                  ) : (
                    <button
                      type="button"
                      title="Connect out of this step"
                      onClick={(ev) => {
                        ev.stopPropagation();
                        startConnect(n.id);
                      }}
                      className="absolute -right-2 top-1/2 h-4 w-4 -translate-y-1/2 rounded-full border-2 border-indigo-500 bg-white hover:bg-indigo-100"
                    />
                  )}
                </div>
              );
            })}
          </div>

          {/* Inspector */}
          <aside className="rounded-lg border border-slate-200 bg-slate-50 p-3">
            {selectedNode ? (
              <NodeInspector
                node={selectedNode}
                onPatchData={(p) => patchNodeData(selectedNode.id, p)}
                onRemove={() => removeNode(selectedNode.id)}
              />
            ) : (
              <p className="text-xs text-slate-500">
                Select a step to edit it. Drag a step&apos;s header to move it; click
                the right dot then a left dot to connect two steps.
              </p>
            )}
          </aside>
        </div>

        {/* Validation + compile preview */}
        <div className="mt-4 rounded-lg border border-slate-200 p-3">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Validation
          </h4>
          {!structural.ok ? (
            <ul className="mt-1 list-disc pl-5 text-xs text-red-700">
              {structural.errors.map((err, i) => (
                <li key={i}>{err}</li>
              ))}
            </ul>
          ) : compiled.ok ? (
            <div className="mt-1 text-xs text-emerald-700">
              Compiles cleanly to {compiled.definition.actions.length} action(s)
              {compiled.definition.conditions ? ", gated by conditions" : ""}
              {compiled.definition.requiresApproval ? ", with an approval gate" : ""}.
              {compiled.isDraft ? (
                <div className="mt-1 text-amber-700">
                  Contains a dark step ({compiled.darkKinds.join(", ")}) with no live
                  engine yet — this rule will be saved as a DRAFT (disabled) so
                  nothing dark runs.
                </div>
              ) : null}
            </div>
          ) : (
            <p className="mt-1 text-xs text-red-700">{compiled.error}</p>
          )}
        </div>

        <div className="mt-4 flex gap-2">
          <button
            type="submit"
            disabled={!compiled.ok}
            className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-slate-800 disabled:opacity-40"
          >
            {ruleId ? "Save workflow" : "Create workflow"}
          </button>
        </div>
      </form>
    </div>
  );
}

function nodeSummary(n: WorkflowNode): string {
  switch (n.kind) {
    case "trigger":
      return String(n.data.trigger ?? "—");
    case "condition":
    case "branch":
      return `${n.data.field || "field"} ${String(n.data.operator ?? "eq")} ${
        VALUELESS_OPERATORS.has(n.data.operator as ConditionOperator)
          ? ""
          : String(n.data.value ?? "")
      }`.trim();
    case "action":
      return actionSpec(n.data.actionType as never)?.label ?? "action";
    case "communication":
      return n.data.channel === "email" ? "Queue an email" : "In-app notification";
    case "delay":
      return `Wait ${n.data.seconds ?? 0}s`;
    case "approval":
      return "Wait for a human decision";
    case "ai_decision":
      return "Governed AI decision";
    case "webhook":
      return "Call an external URL";
    case "end":
      return "Stop here";
    default:
      return "";
  }
}

function NodeInspector({
  node,
  onPatchData,
  onRemove,
}: {
  node: WorkflowNode;
  onPatchData: (p: Record<string, unknown>) => void;
  onRemove: () => void;
}) {
  const inputCls =
    "w-full rounded-md border border-slate-300 px-2 py-1 text-xs text-slate-900";
  const meta = KIND_META[node.kind];

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span
          className="rounded px-1.5 py-0.5 text-[10px] font-semibold text-white"
          style={{ background: meta.accent }}
        >
          {meta.label}
        </span>
        {node.kind !== "trigger" ? (
          <button
            type="button"
            onClick={onRemove}
            className="rounded border border-red-200 px-2 py-0.5 text-[11px] text-red-700 hover:bg-red-50"
          >
            Delete step
          </button>
        ) : null}
      </div>

      {node.kind === "trigger" ? (
        <label className="block text-[11px] text-slate-600">
          Trigger event
          <select
            value={String(node.data.trigger ?? EXPOSABLE_AUTOMATION_TRIGGERS[0])}
            onChange={(e) => onPatchData({ trigger: e.target.value })}
            className={inputCls}
          >
            {EXPOSABLE_AUTOMATION_TRIGGERS.map((t) => (
              <option key={t} value={t}>
                {AUTOMATION_TRIGGER_LABELS[t]}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      {node.kind === "condition" || node.kind === "branch" ? (
        <>
          <label className="block text-[11px] text-slate-600">
            Payload field
            <input
              value={String(node.data.field ?? "")}
              onChange={(e) => onPatchData({ field: e.target.value })}
              placeholder="e.g. amount or customer.email"
              className={`${inputCls} font-mono`}
            />
          </label>
          <label className="block text-[11px] text-slate-600">
            Operator
            <select
              value={String(node.data.operator ?? "eq")}
              onChange={(e) => onPatchData({ operator: e.target.value })}
              className={inputCls}
            >
              {CONDITION_OPERATORS.map((op) => (
                <option key={op} value={op}>
                  {OPERATOR_LABELS[op]}
                </option>
              ))}
            </select>
          </label>
          {!VALUELESS_OPERATORS.has(node.data.operator as ConditionOperator) ? (
            <label className="block text-[11px] text-slate-600">
              Value
              <input
                value={String(node.data.value ?? "")}
                onChange={(e) => onPatchData({ value: e.target.value })}
                className={inputCls}
              />
            </label>
          ) : null}
          {node.kind === "branch" ? (
            <p className="text-[10px] text-slate-500">
              The ✗ (no) path must lead to an End step.
            </p>
          ) : null}
        </>
      ) : null}

      {node.kind === "action" ? (
        <ActionParams
          actionType={String(node.data.actionType ?? "")}
          params={(node.data.params as Record<string, unknown>) ?? {}}
          onChangeType={(t) => onPatchData({ actionType: t, params: {} })}
          onChangeParams={(p) => onPatchData({ params: p })}
        />
      ) : null}

      {node.kind === "communication" ? (
        <>
          <label className="block text-[11px] text-slate-600">
            Channel
            <select
              value={String(node.data.channel ?? "notification")}
              onChange={(e) => onPatchData({ channel: e.target.value, params: {} })}
              className={inputCls}
            >
              <option value="notification">In-app notification</option>
              <option value="email">Queue an email</option>
            </select>
          </label>
          <ActionParams
            actionType={
              node.data.channel === "email"
                ? "send_email_queue"
                : "create_notification"
            }
            params={(node.data.params as Record<string, unknown>) ?? {}}
            onChangeParams={(p) => onPatchData({ params: p })}
          />
        </>
      ) : null}

      {node.kind === "approval" ? (
        <p className="text-[11px] text-slate-600">
          Steps before this run immediately; everything after waits for an admin to
          approve. Only one approval step is allowed.
        </p>
      ) : null}

      {node.kind === "delay" ? (
        <label className="block text-[11px] text-slate-600">
          Wait (seconds)
          <input
            type="number"
            min={0}
            value={Number(node.data.seconds ?? 0)}
            onChange={(e) => onPatchData({ seconds: Number(e.target.value) })}
            className={inputCls}
          />
          <span className="mt-1 block text-[10px] text-amber-700">
            Dark: no in-rule timer engine yet. Saving keeps the workflow a draft.
          </span>
        </label>
      ) : null}

      {node.kind === "ai_decision" || node.kind === "webhook" ? (
        <label className="block text-[11px] text-slate-600">
          Note
          <input
            value={String(node.data.note ?? "")}
            onChange={(e) => onPatchData({ note: e.target.value })}
            className={inputCls}
          />
          <span className="mt-1 block text-[10px] text-amber-700">
            Dark:{" "}
            {node.kind === "ai_decision"
              ? "routes through the AI governor (tiers null, not activated)"
              : "outbound integration not wired"}
            . Saving keeps the workflow a draft.
          </span>
        </label>
      ) : null}

      {node.kind === "end" ? (
        <p className="text-[11px] text-slate-600">Terminates this path.</p>
      ) : null}
    </div>
  );
}

function ActionParams({
  actionType,
  params,
  onChangeType,
  onChangeParams,
}: {
  actionType: string;
  params: Record<string, unknown>;
  onChangeType?: (t: string) => void;
  onChangeParams: (p: Record<string, unknown>) => void;
}) {
  const inputCls =
    "w-full rounded-md border border-slate-300 px-2 py-1 text-xs text-slate-900";
  const spec = actionSpec(actionType as never);
  return (
    <div className="space-y-2">
      {onChangeType ? (
        <label className="block text-[11px] text-slate-600">
          Action
          <select
            value={actionType}
            onChange={(e) => onChangeType(e.target.value)}
            className={inputCls}
          >
            {CUSTOM_ACTIONS.map((s) => (
              <option key={s.type} value={s.type}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {spec?.params.map((p) => (
        <label key={p.key} className="block text-[11px] text-slate-600">
          {p.label}
          {p.type === "enum" ? (
            <select
              value={String(params[p.key] ?? "")}
              onChange={(e) => onChangeParams({ ...params, [p.key]: e.target.value })}
              className={inputCls}
            >
              <option value="">(default)</option>
              {(p.options ?? []).map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          ) : p.type === "boolean" ? (
            <select
              value={String(params[p.key] ?? "")}
              onChange={(e) => onChangeParams({ ...params, [p.key]: e.target.value })}
              className={inputCls}
            >
              <option value="">(default)</option>
              <option value="true">Yes</option>
              <option value="false">No</option>
            </select>
          ) : (
            <input
              value={String(params[p.key] ?? "")}
              maxLength={p.maxLength ?? 500}
              onChange={(e) => onChangeParams({ ...params, [p.key]: e.target.value })}
              className={inputCls}
            />
          )}
        </label>
      ))}
    </div>
  );
}
