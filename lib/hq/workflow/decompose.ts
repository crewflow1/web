/**
 * CrewFlow HQ — DETERMINISTIC saga decomposition (the substrate).
 *
 * Given a directive and a template key, produce an ordered, dependency-linked step
 * GRAPH — with ZERO model calls. This is the deterministic core the whole feature
 * rests on: the templates encode how CrewFlow actually decomposes a directive across
 * departments, so a saga can be planned, dispatched and tracked long before any
 * AI-assisted decomposition is armed (that seam is dark — see ./ai-decompose.ts).
 *
 * PURE and DETERMINISTIC — same directive + template → byte-identical graph, every
 * time. No `server-only`, no Supabase, no SDK, no wall-clock read. The optional
 * `now` a caller may thread is INJECTED and used only where a timestamp default is
 * needed; nothing here reads `Date.now()`.
 *
 * Every template is validated against the pure model at authoring time (the unit
 * suite proves each template yields a well-formed, acyclic graph), so a malformed
 * template cannot reach the service.
 */

import {
  validateStepGraph,
  type SagaStatus,
  type SagaStep,
  type StepStatus,
} from "./model";

/** A step as a TEMPLATE declares it — no status yet (steps are born 'pending'). */
type StepSpec = {
  title: string;
  department: string;
  role: string;
  /** The ordinal of the earlier step this one waits on; null ⇒ a root step. */
  dependsOnOrdinal: number | null;
};

/** A deterministic decomposition template — an ordered list of step specs. */
export interface SagaTemplate {
  key: string;
  label: string;
  description: string;
  /** In graph order. The step's ordinal is its 1-based index in this list. */
  steps: ReadonlyArray<StepSpec>;
}

// ---------------------------------------------------------------------
// The template catalogue. Each is a real cross-department decomposition —
// a linear-with-branch chain where each step names the department/role that
// owns it. Ordinals are assigned by position (1-based); dependencies point at
// an EARLIER ordinal, so every graph is acyclic by construction.
// ---------------------------------------------------------------------

const PRODUCT_LAUNCH: SagaTemplate = {
  key: "product_launch",
  label: "Product launch",
  description:
    "Take a product idea from research through engineering, QA and go-to-market — the eleven-stage Master-Plan pipeline, collapsed to the departments that own each phase.",
  steps: [
    { title: "Research the opportunity", department: "Research", role: "researcher", dependsOnOrdinal: null },
    { title: "Write the specification", department: "Product", role: "product_lead", dependsOnOrdinal: 1 },
    { title: "Design the experience", department: "Design", role: "designer", dependsOnOrdinal: 2 },
    { title: "Engineer the build", department: "Engineering", role: "engineer", dependsOnOrdinal: 3 },
    { title: "Test and verify", department: "QA", role: "qa_engineer", dependsOnOrdinal: 4 },
    { title: "Prepare go-to-market", department: "Marketing", role: "marketer", dependsOnOrdinal: 5 },
    { title: "Enable sales", department: "Sales", role: "sales_lead", dependsOnOrdinal: 6 },
    { title: "Deploy and review", department: "Operations", role: "ops_lead", dependsOnOrdinal: 7 },
  ],
};

const INCIDENT_RESPONSE: SagaTemplate = {
  key: "incident_response",
  label: "Incident response",
  description:
    "Triage, contain and resolve a production incident, then close the loop with a review — the branch after triage lets comms and fix proceed from the same containment.",
  steps: [
    { title: "Triage the incident", department: "Engineering", role: "on_call", dependsOnOrdinal: null },
    { title: "Contain the blast radius", department: "Engineering", role: "engineer", dependsOnOrdinal: 1 },
    { title: "Communicate to stakeholders", department: "Support", role: "support_lead", dependsOnOrdinal: 2 },
    { title: "Engineer the fix", department: "Engineering", role: "engineer", dependsOnOrdinal: 2 },
    { title: "Verify the fix", department: "QA", role: "qa_engineer", dependsOnOrdinal: 4 },
    { title: "Post-incident review", department: "Operations", role: "ops_lead", dependsOnOrdinal: 5 },
  ],
};

const CUSTOMER_ONBOARDING: SagaTemplate = {
  key: "customer_onboarding",
  label: "Customer onboarding",
  description:
    "Bring a new customer live — data migration, configuration, training and a health check — across success, engineering and support.",
  steps: [
    { title: "Kick-off and scope", department: "Customer Success", role: "csm", dependsOnOrdinal: null },
    { title: "Migrate their data", department: "Engineering", role: "migration_engineer", dependsOnOrdinal: 1 },
    { title: "Configure the account", department: "Customer Success", role: "csm", dependsOnOrdinal: 2 },
    { title: "Train the team", department: "Customer Success", role: "csm", dependsOnOrdinal: 3 },
    { title: "First-week health check", department: "Support", role: "support_lead", dependsOnOrdinal: 4 },
  ],
};

export const SAGA_TEMPLATES: ReadonlyArray<SagaTemplate> = [
  PRODUCT_LAUNCH,
  INCIDENT_RESPONSE,
  CUSTOMER_ONBOARDING,
];

const TEMPLATE_BY_KEY: ReadonlyMap<string, SagaTemplate> = new Map(
  SAGA_TEMPLATES.map((t) => [t.key, t]),
);

export function getTemplate(key: string): SagaTemplate | null {
  return TEMPLATE_BY_KEY.get(key) ?? null;
}

// ---------------------------------------------------------------------
// The decomposition itself.
// ---------------------------------------------------------------------

/** The plan a decomposition produces — a saga title + template key + step graph. */
export interface SagaPlan {
  title: string;
  templateKey: string;
  status: SagaStatus;
  steps: SagaStep[];
}

export type DecomposeResult =
  | { ok: true; plan: SagaPlan }
  | { ok: false; error: string };

/**
 * Decompose a directive into a saga plan using a DETERMINISTIC template. PURE.
 *
 *   • an unknown template key is refused (`unknown_template`);
 *   • the step graph is materialised with 1-based ordinals from template order,
 *     every step born 'pending', and the saga born 'planned';
 *   • the result is validated against the pure model before it is returned — a
 *     malformed template can never yield a plan (`invalid_graph`).
 *
 * `now` is accepted for signature symmetry with the dark AI seam and future
 * timestamp defaults; the deterministic decomposition does not consult it, which
 * is why the result is byte-identical regardless of when it runs.
 */
export function decomposeDirective(
  input: { title: string; templateKey: string },
  _now: Date,
): DecomposeResult {
  const title = (input.title ?? "").trim();
  if (!title) return { ok: false, error: "title_required" };

  const template = getTemplate(input.templateKey);
  if (!template) return { ok: false, error: "unknown_template" };

  const bornPending: StepStatus = "pending";
  const steps: SagaStep[] = template.steps.map((spec, i) => ({
    ordinal: i + 1,
    title: spec.title,
    department: spec.department,
    role: spec.role,
    dependsOnOrdinal: spec.dependsOnOrdinal,
    status: bornPending,
  }));

  const validation = validateStepGraph(steps);
  if (!validation.ok) {
    return { ok: false, error: `invalid_graph: ${validation.errors.join("; ")}` };
  }

  return {
    ok: true,
    plan: { title, templateKey: template.key, status: "planned", steps },
  };
}
