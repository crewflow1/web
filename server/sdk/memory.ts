import "server-only";
import {
  recallMemory,
  rememberMemory,
  forgetMemory,
  type RecallItem,
} from "@/server/services/hq-memory";
import type { MemoryClass } from "@/lib/memory/model";
import type { MemoryScope } from "@/lib/ai-employees/model";
import type { AssemblyResult } from "@/lib/memory/retrieval";

/**
 * CrewFlow HQ — the `ctx.memory` SDK facet
 * (CEO Directive 009 Module 1, PR6 — SDK Integration).
 *
 * Bible Volume X §12.2 (`interface Memory`) + Volume XIII §11 (Memory, the 6th
 * dimension of the employee ABI). This is the SINGLE memory surface an AI
 * employee ever touches. It does not re-implement anything — it BINDS the
 * already-built service layer (recallMemory / rememberMemory / forgetMemory,
 * PR2–PR6) to one employee's identity and stamps that identity onto every call,
 * so the employee can never read or write as anyone else.
 *
 * Why a bound facet and not the loose service functions. The service functions
 * each take an `employee: { id }` by hand — which means the caller chooses the
 * actor on every call (spoofable), re-passes the token budget and scope every
 * time, and has nowhere to accumulate "which memories did I use". The SDK closes
 * all three: identity is captured ONCE at construction and is the only actor any
 * verb can run as (XIII §8: "no API to set actor_id by hand — no spoofing");
 * working-memory writes auto-bind to the running task; and recalled ids are
 * accumulated so the future RunContext (XIII §9) can drain them into the output
 * envelope's `evidence[]` (§10) with zero handler code.
 *
 * SCOPE IS ENFORCED SERVER-SIDE, NOT HERE. The permission filter (X §7 stage 1)
 * runs inside `hq_memory_recall`/`hq_memory_write`/`hq_memory_forget`, keyed off
 * the employee id (→ its department + `memory_scope`). The SDK therefore CANNOT
 * widen what an employee may read or write — it only narrows the ergonomics. The
 * `memory_scope` on the identity below is informational/forward-looking; the SQL
 * `SECURITY DEFINER` guard is the real boundary (defence in depth, P5).
 *
 * This is deliberately a standalone facet, not a whole `ctx`. The full RunContext
 * (identity · memory · comms · events · tasks · tools · api) is Volume XIII — a
 * separate, mostly-unbuilt module. PR6 builds the memory facet to its stable
 * contract so a future `createContext()` can expose it AS `ctx.memory` with no
 * change here ("expose a stable interface, complete later").
 *
 * Errors throw. The five verbs return resolved values, never a result union: the
 * handler ABI is throw-based (a denied write or a bad recall aborts the handler,
 * which the Task Engine records as a failure). The underlying service functions
 * return `{ ok: false }`; this facet converts that into a thrown `Error`.
 */

// ---------------------------------------------------------------------
// Public types (the Bible §12.2 vocabulary, in TypeScript)
// ---------------------------------------------------------------------

export type MemoryId = string;
export type TaskId = string;

/** Visibilities an employee may author. `system` is engine-internal and refused. */
export type WritableVisibility =
  | "public_hq"
  | "department"
  | "private"
  | "restricted";

/**
 * A context reference handed across the seams (IX message, a task payload, a
 * relationship edge). `kind`/`id` match `hq_memory_relationships`
 * (entity_type / entity_id); `label` is an optional human hint.
 */
export type Ref = { kind: string; id: string; label?: string };

/** One memory the employee read, in the SDK's clean vocabulary. */
export type RecalledMemory = {
  id: MemoryId;
  class: MemoryClass;
  type: string;
  title: string;
  summary: string;
  visibility: string;
  department: string | null;
  ownerEmployeeId: string | null;
  importance: string;
  salience: number;
  pinned: boolean;
  /** Blended §7.3 relevance (higher = more relevant). */
  score: number;
  /** How the §8 knapsack placed it: full body, or summary-only under pressure. */
  form: "full" | "summary";
};

/** The token accounting + inclusion decisions from the §8 assembly. */
export type ContextManifest = AssemblyResult;

/**
 * The recalled, ranked, budgeted memory — ready to drop into a reasoning prompt.
 * `text` renders the assembled set (score-desc, provenance-tagged); `manifest`
 * (on the recall result) carries the precise token/inclusion accounting.
 */
export type AssembledContext = {
  text: string;
  memoryCount: number;
  tokensUsed: number;
  budget: number;
};

export type RecallResult = {
  context: AssembledContext;
  items: RecalledMemory[];
  manifest: ContextManifest;
};

/** What `resolve(ref)` returns: the permitted memories about an entity. */
export type ResolvedContext = {
  ref: Ref;
  items: RecalledMemory[];
  found: boolean;
};

export type RecallOpts = {
  query: string;
  /** Bias retrieval toward the task's subject (structural channel, §7.2). */
  subject?: Ref;
  /** Restrict to specific cognitive classes (default: all the employee may read). */
  classes?: MemoryClass[];
  /** Candidate cap fetched before ranking. */
  limit?: number;
};

export type RememberOpts = {
  class: MemoryClass;
  type: string;
  title: string;
  summary?: string;
  body: string;
  visibility?: WritableVisibility;
  salience?: number;
  expiresAt?: Date;
  /** Override the auto-bound task (working/episodic bind to the running task by default). */
  boundTask?: TaskId;
};

export type SearchOpts = {
  limit?: number;
  classes?: MemoryClass[];
  subject?: Ref;
};

/**
 * The identity the facet is bound to. Captured once; every verb runs as this
 * employee and nobody else. `currentTaskId` is the running task working-memory
 * writes auto-bind to (XIII §11: "working memory is auto-bound to the running
 * task"); `department`/`memoryScope` are informational (enforcement is server-side).
 */
export type MemoryIdentity = {
  employeeId: string;
  department?: string | null;
  memoryScope?: MemoryScope;
  currentTaskId?: string | null;
};

/** The Bible §12.2 contract — the five verbs, identity supplied by the SDK. */
export interface Memory {
  recall(opts: RecallOpts): Promise<RecallResult>;
  remember(
    opts: RememberOpts,
  ): Promise<{ id: MemoryId | null; approvalRequired: boolean }>;
  resolve(ref: Ref): Promise<ResolvedContext>;
  forget(id: MemoryId, reason: string): Promise<void>;
  /** Raw ranked search — no §8 assembly, no reinforcement, no evidence capture. */
  search(query: string, opts?: SearchOpts): Promise<RecalledMemory[]>;
}

/**
 * The bound facet `createMemory` returns. A superset of {@link Memory}: it also
 * exposes the accumulated evidence and the identity it is bound to — the seam a
 * future RunContext reads to auto-populate the output envelope (XIII §9/§10).
 */
export interface BoundMemory extends Memory {
  /** The distinct memory ids recall()/resolve() have surfaced this session. */
  evidence(): MemoryId[];
  readonly identity: Readonly<MemoryIdentity>;
}

// ---------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------

/**
 * Search uses the recall pipeline with the budget wide open, so ranking +
 * diversification still apply but the §8 knapsack drops nothing ("raw search,
 * no assembly"). This is the service-layer cap on `tokenBudget`.
 */
const SEARCH_BUDGET = 200_000;

/** Map a service `RecallItem` (snake-ish, recall-internal) → the SDK vocabulary. */
function toRecalled(it: RecallItem): RecalledMemory {
  return {
    id: it.id,
    class: it.memoryClass,
    type: it.memoryType,
    title: it.title,
    summary: it.summary,
    visibility: it.visibility,
    department: it.department,
    ownerEmployeeId: it.ownerEmployeeId,
    importance: it.importance,
    salience: it.salience,
    pinned: it.pinned,
    score: it.score,
    form: it.form,
  };
}

/** Render the assembled set into a prompt-ready, provenance-tagged block. */
function renderContext(items: RecalledMemory[], manifest: ContextManifest): AssembledContext {
  const text = items
    .map((m) => `[${m.type} · ${m.visibility}] ${m.title}\n${m.summary}`.trim())
    .join("\n\n");
  return {
    text,
    memoryCount: items.length,
    tokensUsed: manifest.tokensUsed,
    budget: manifest.budget,
  };
}

// ---------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------

/**
 * Bind the memory surface to one employee. The returned object is the only way
 * the employee should ever touch memory: identity is stamped on every call, and
 * there is no parameter anywhere to act as a different employee.
 */
export function createMemory(identity: MemoryIdentity): BoundMemory {
  const actor = { id: identity.employeeId };
  // Distinct ids recall()/resolve() have surfaced — the evidence seam (§10).
  const evidenceIds = new Set<MemoryId>();

  function captureEvidence(items: RecalledMemory[]): void {
    for (const m of items) evidenceIds.add(m.id);
  }

  return {
    identity: Object.freeze({ ...identity }),

    async recall(opts: RecallOpts): Promise<RecallResult> {
      const res = await recallMemory(
        {
          query: opts.query,
          subjectKind: opts.subject?.kind ?? null,
          subjectId: opts.subject?.id ?? null,
          classFilter: opts.classes ?? null,
          candidateLimit: opts.limit,
          reinforce: true,
        },
        actor,
      );
      if (!res.ok) throw new Error(`memory.recall failed: ${res.error}`);

      const items = res.items.map(toRecalled);
      captureEvidence(items);
      return { context: renderContext(items, res.manifest), items, manifest: res.manifest };
    },

    async remember(opts: RememberOpts) {
      // Working/episodic experience auto-binds to the running task unless the
      // caller overrides — so a handler never threads the task id by hand, and
      // the lifecycle worker can expire the scratchpad when the task ends (§11).
      const ephemeral = opts.class === "working" || opts.class === "episodic";
      const boundTaskId =
        opts.boundTask ?? (ephemeral ? identity.currentTaskId ?? null : null);

      const res = await rememberMemory(
        {
          memoryClass: opts.class,
          memoryType: opts.type,
          title: opts.title,
          summary: opts.summary,
          body: opts.body,
          visibility: opts.visibility,
          salience: opts.salience,
          expiresAt: opts.expiresAt ? opts.expiresAt.toISOString() : null,
          boundTaskId,
        },
        actor,
      );
      if (!res.ok) throw new Error(`memory.remember failed: ${res.error}`);
      return { id: res.id, approvalRequired: res.approvalRequired };
    },

    async resolve(ref: Ref): Promise<ResolvedContext> {
      // Structural recall fully biased to the entity (no free-text query): the
      // permitted memories about this subject, recency-ranked. Permission is
      // enforced in SQL, so an employee only resolves what it may read.
      const res = await recallMemory(
        {
          query: null,
          subjectKind: ref.kind,
          subjectId: ref.id,
          reinforce: true,
        },
        actor,
      );
      if (!res.ok) throw new Error(`memory.resolve failed: ${res.error}`);

      const items = res.items.map(toRecalled);
      captureEvidence(items);
      return { ref, items, found: items.length > 0 };
    },

    async forget(id: MemoryId, reason: string): Promise<void> {
      const res = await forgetMemory(id, reason, actor);
      if (!res.ok) throw new Error(`memory.forget failed: ${res.error}`);
    },

    async search(query: string, opts?: SearchOpts): Promise<RecalledMemory[]> {
      // Raw lookup: ranked, but the budget is wide open (no assembly drops) and
      // it does NOT reinforce or feed evidence — search is for checking, not for
      // the work product (e.g. a dedupe probe), so it leaves no audit footprint.
      const res = await recallMemory(
        {
          query,
          subjectKind: opts?.subject?.kind ?? null,
          subjectId: opts?.subject?.id ?? null,
          classFilter: opts?.classes ?? null,
          candidateLimit: opts?.limit,
          tokenBudget: SEARCH_BUDGET,
          reinforce: false,
        },
        actor,
      );
      if (!res.ok) throw new Error(`memory.search failed: ${res.error}`);
      return res.items.map(toRecalled);
    },

    evidence(): MemoryId[] {
      return [...evidenceIds];
    },
  };
}
