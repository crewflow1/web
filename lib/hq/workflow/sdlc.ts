/**
 * CrewFlow HQ — the governed SDLC LIFECYCLE saga template (the delivery chain).
 *
 * The Task Engine runs one unit of work; the Workflow-Saga engine (migration
 * 20261104000000 + lib/hq/workflow/model.ts) chains units into a dependency-linked
 * GRAPH advanced by the saga-drain cron. The catalogue already carries broad
 * decompositions (product launch, incident response, onboarding). What it did NOT
 * carry is the one lifecycle every internal build actually walks: the software
 * delivery chain —
 *
 *     Spec → Design → Engineering → Test → Documentation → Review → Deployment
 *
 * This module encodes that chain ONCE, as explicit, ordered, typed STAGES, and
 * projects it onto a deterministic `SagaTemplate` the existing `decomposeDirective`
 * consumes. It builds NO second engine: the produced template is dispatched, advanced,
 * deduped and audited entirely by the shipped saga service + drain. Each stage's
 * `department` is the axis the drain reads — it maps (through the service's
 * DEPARTMENT_STAGE) to the distinct Master-Plan pipeline stage a dispatched task is
 * stamped with, and it decides (through `stepRequiresApproval`) whether the drain may
 * auto-dispatch the step or must HALT for a super-admin's manual approval.
 *
 * PURE and DETERMINISTIC — no `server-only`, no Supabase, no SDK, no wall-clock read.
 * The `PipelineStage` reference is a TYPE-only import (erased at runtime), so this file
 * stays client-safe exactly like model.ts and decompose.ts; the pipeline stage is
 * carried here only to make the stage↔pipeline correspondence explicit and testable.
 *
 * THE GOVERNANCE, made explicit and auditable:
 *   • the chain is a single linear DAG — each stage depends on the one before it, so
 *     no stage can start before its predecessor is `done` (the drain honours the edge);
 *   • exactly ONE stage is human-approval gated — DEPLOYMENT — because it reaches
 *     production (irreversible, externally-visible). Its department (`Operations`) is
 *     in the model's APPROVAL_GATED_DEPARTMENTS, so the autonomous drain NEVER deploys
 *     on its own; a super-admin's manual advance is the human approval that releases it;
 *   • every OTHER stage is an internal-build department (Product, Design, Engineering,
 *     QA, Documentation, Review) the drain may dispatch deterministically;
 *   • REVIEW sits immediately before deployment as the final internal checkpoint, so
 *     the whole package (build + tests + docs) is reviewed before a human is asked to
 *     approve the production release.
 */

import type { PipelineStage } from "@/lib/hq/boardroom-cards";
import type { SagaTemplate } from "./decompose";

/** The seven stages of the delivery lifecycle, in order — a closed vocabulary. */
export const SDLC_STAGE_KEYS = [
  "specification",
  "design",
  "engineering",
  "test",
  "documentation",
  "review",
  "deployment",
] as const;
export type SdlcStageKey = (typeof SDLC_STAGE_KEYS)[number];

/**
 * One stage of the SDLC lifecycle. The load-bearing fields:
 *   • `department` — the drain's axis: it selects the pipeline stage a dispatched
 *     task is stamped with AND decides the approval gate;
 *   • `pipelineStage` — the Master-Plan lifecycle stage this stage corresponds to,
 *     carried for provenance and pinned by a test against the service's
 *     DEPARTMENT_STAGE map (so a future edit there cannot silently mis-stamp SDLC);
 *   • `requiresApproval` — the DECLARED expectation of the model's `stepRequiresApproval`
 *     for this stage's department. Deployment is the one gated stage.
 */
export interface SdlcStage {
  key: SdlcStageKey;
  title: string;
  department: string;
  role: string;
  pipelineStage: PipelineStage;
  requiresApproval: boolean;
}

/**
 * The canonical SDLC lifecycle, encoded once. Order IS the graph: the step at index
 * i has ordinal i+1 and depends on the step before it (a single linear chain), so the
 * decomposition is a well-formed acyclic DAG by construction.
 */
export const SDLC_STAGES: ReadonlyArray<SdlcStage> = [
  {
    key: "specification",
    title: "Write the specification",
    department: "Product",
    role: "product_lead",
    pipelineStage: "specification",
    requiresApproval: false,
  },
  {
    key: "design",
    title: "Design the solution",
    department: "Design",
    role: "designer",
    pipelineStage: "design",
    requiresApproval: false,
  },
  {
    key: "engineering",
    title: "Engineer the build",
    department: "Engineering",
    role: "engineer",
    pipelineStage: "engineering",
    requiresApproval: false,
  },
  {
    key: "test",
    title: "Test and verify",
    department: "QA",
    role: "qa_engineer",
    pipelineStage: "testing",
    requiresApproval: false,
  },
  {
    key: "documentation",
    title: "Document the release",
    department: "Documentation",
    role: "tech_writer",
    pipelineStage: "documentation",
    requiresApproval: false,
  },
  {
    key: "review",
    title: "Review before release",
    department: "Review",
    role: "reviewer",
    pipelineStage: "review",
    requiresApproval: false,
  },
  {
    // The one human-approval gate: production is irreversible + externally visible,
    // so the autonomous drain must HALT here and wait for a super-admin's manual
    // advance. `Operations` is in the model's APPROVAL_GATED_DEPARTMENTS.
    key: "deployment",
    title: "Deploy to production",
    department: "Operations",
    role: "ops_lead",
    pipelineStage: "deployment",
    requiresApproval: true,
  },
];

/**
 * The deterministic SDLC lifecycle template — the chain projected onto the shape the
 * catalogue and `decomposeDirective` consume. A single linear dependency chain: each
 * stage depends on the previous one (the first is the root). Built from `SDLC_STAGES`
 * so the two can never drift.
 */
export const SDLC_LIFECYCLE: SagaTemplate = {
  key: "sdlc_lifecycle",
  label: "SDLC lifecycle",
  description:
    "Take an internal build through the full software delivery lifecycle — specification, design, engineering, test, documentation and review — ending at a human-approval-gated production deployment. A single governed chain, one stage per pipeline step, deployment held for a super-admin's manual advance.",
  steps: SDLC_STAGES.map((stage, i) => ({
    title: stage.title,
    department: stage.department,
    role: stage.role,
    // Order is the graph: the first stage is a root; every later stage depends on
    // the one immediately before it (its 1-based ordinal minus one).
    dependsOnOrdinal: i === 0 ? null : i,
  })),
};
