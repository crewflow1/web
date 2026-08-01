import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, relative, join } from "node:path";

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * AI GOVERNANCE CLOSURE — the ratchet, and the dark-path proof.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * WHAT WAS WRONG
 * --------------
 * The AI Cost Governor (lib/ai/governor.ts) enforces a HARD £100/org/month
 * ceiling and writes the invocation ledger — but only for calls that pass
 * through it. An audit found three that did and five that did not. Sweeping for
 * provider-SDK CONSTRUCTIONS rather than for `isAiConfigured()` GATES found two
 * more, so the real figure was three governed and SEVEN ungoverned:
 *
 *   lib/ai/insight-narrative.ts      — /insights prose            TENANT-FACING
 *   server/services/ai-question.ts   — /insights answer box       TENANT-FACING
 *   server/services/lead-summary.ts  — lead summaries             TENANT-FACING  ← not in the audit
 *   lib/imports/ocr.ts               — import OCR (own SDK)
 *   server/services/hq-drafts.ts     — HQ Draft Engine
 *   server/services/memory-lifecycle.ts — memory summarisation
 *   server/services/research-llm.ts  — HQ research (own SDKs)                    ← not in the audit
 *
 * Every one gated on a BARE VENDOR CREDENTIAL — `isAiConfigured()`, a direct
 * `process.env.ANTHROPIC_API_KEY` read, or `getTextProvider()`, which was the
 * same question in a nicer voice. So setting `ANTHROPIC_API_KEY` on a deploy
 * would have switched all seven on with no ceiling and no ledger row.
 *
 * AND THE THREE GOVERNED ONES WERE NOT SAFE EITHER, which is the part the audit
 * missed: `invokeWithGovernor` runs the caller's function IMMEDIATELY when no
 * cost tier is bound (the dark short-circuit, by design). A credential with no
 * binding therefore produced real spend through the governed paths too. Wrapping
 * alone would have closed nothing; it is the GATE that had to change.
 *
 * WHAT THIS FILE PINS
 * -------------------
 *   A. THE RATCHET. Both facts are DERIVED FROM SOURCE TEXT, not asserted:
 *      every provider-SDK construction in the build, and every bare-credential
 *      gate. New ones fail this test. The derived count is compared against
 *      `AI_UNGOVERNED_INFERENCE_ENTRY_POINTS`, which the readiness surface uses
 *      to decide the amber warning on /admin/ai-costs — so source drift and the
 *      operator-facing green light cannot disagree.
 *
 *   B. THE DARK-PATH PROOF. With no tier bound, the newly-wrapped paths must
 *      return their existing degraded values and NEVER CONSTRUCT THE SUPABASE
 *      ADMIN CLIENT. That is an assertion about I/O that did not happen, which
 *      is easy to write and hard to keep true — so the mock COUNTS constructions
 *      rather than trusting a reviewer's reading.
 *
 * Source checks run over `code` (comments stripped), so the prose that documents
 * a removal can neither satisfy a positive match nor trip a negative one. That
 * matters more than usual here: nearly every file in the sweep now contains a
 * comment explaining the bare-credential gate it used to have.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

/** Strip block and line comments. Prose must not satisfy or trip a pin. */
function codeOf(ts: string): string {
  return ts.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/** Every .ts/.tsx under the application roots, as repo-relative paths. */
function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry.startsWith(".")) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry)) out.push(relative(ROOT, full));
    }
  };
  for (const root of ["app", "lib", "server"]) walk(resolve(ROOT, root));
  return out.sort();
}

const FILES = sourceFiles();
const CODE = new Map(FILES.map((f) => [f, codeOf(read(f))]));

// ---------------------------------------------------------------------------
// The two doors. THE only modules allowed to turn a credential into a client.
// ---------------------------------------------------------------------------

const TEXT_DOOR = "lib/ai/text/index.ts";
const VISION_DOOR = "lib/ai/vision/index.ts";

/**
 * Provider TRANSPORT: the vendor implementations behind the two doors. These do
 * not decide WHETHER to call a model — they are handed a key by a factory that
 * has already asked the governor — so an SDK construction here is not an entry
 * point.
 */
const TRANSPORT = new Set([
  "lib/ai/text/anthropic.ts",
  "lib/ai/text/openai.ts",
  "lib/ai/vision/anthropic.ts",
]);

/**
 * THE THIRD DOOR: embeddings — the former documented exception, now CLOSED.
 *
 * `lib/ai/embeddings/index.ts` used to be named here as the one path allowed
 * to select a paid provider on `OPENAI_API_KEY` alone, because the ledger's
 * `task_class` CHECK could not admit an embedding. Migration 20261080 widened
 * both CHECKs, and the door now mirrors the text/vision pattern exactly:
 * `index.ts` refuses the paid branch without a bound `embedding` tier
 * (`isEmbeddingActivated()`), `openai.ts` is transport behind it, and every
 * call site embeds through `lib/ai/embeddings/governed.ts` →
 * `invokeWithGovernor`. The one DELIBERATE exemption is the deterministic
 * (zero-egress, zero-cost) provider, identified by its own `info.provider`
 * tag inside `governed.ts` — pinned in "the embedding modality" block below.
 */
const EMBEDDING_DOOR = "lib/ai/embeddings/index.ts";
const EMBEDDING_GOVERNED_DOOR = "lib/ai/embeddings/governed.ts";
const EMBEDDINGS = new Set([EMBEDDING_DOOR, "lib/ai/embeddings/openai.ts"]);

/** Where `isAiConfigured` may be DEFINED (it may no longer be a gate anywhere). */
const CREDENTIAL_PROBE = "lib/ai/safety.ts";

// ---------------------------------------------------------------------------
// A. THE RATCHET
// ---------------------------------------------------------------------------

const SDK_CONSTRUCTION =
  /@anthropic-ai\/sdk|\bnew\s+Anthropic\b|\bnew\s+OpenAI\b|import\(\s*["']openai["']\s*\)|from\s+["']openai["']/;
const CREDENTIAL_READ = /process\.env\.(?:ANTHROPIC_API_KEY|OPENAI_API_KEY)\b/;
const GOVERNED = /invokeWithGovernor/;
const ACTIVATION_GATE = /isGovernorActivated|getTextProvider|getVisionProvider/;
const OPENS_A_DOOR = /\bgetTextProvider\s*\(|\bgetVisionProvider\s*\(/;

const sdkFiles = FILES.filter((f) => SDK_CONSTRUCTION.test(CODE.get(f)!));
const credentialFiles = FILES.filter((f) => CREDENTIAL_READ.test(CODE.get(f)!));

/**
 * The derived figure: modules that can reach an inference provider WITHOUT the
 * governor, or that decide to on the strength of a credential alone.
 *
 * Three ways in, because there are three ways a path can escape:
 *   1. it constructs a vendor SDK and is not a door, not transport, not
 *      embeddings, and does not pass through the governor + an activation gate;
 *   2. it opens one of the two doors but never reaches `invokeWithGovernor`;
 *   3. it calls `isAiConfigured()` — the bare key check — anywhere outside the
 *      module that defines it.
 */
function ungovernedEntryPoints(): string[] {
  const out = new Set<string>();

  for (const f of sdkFiles) {
    if (TRANSPORT.has(f) || EMBEDDINGS.has(f) || f === TEXT_DOOR || f === VISION_DOOR) continue;
    const code = CODE.get(f)!;
    if (!GOVERNED.test(code) || !ACTIVATION_GATE.test(code)) out.add(f);
  }

  for (const f of FILES) {
    const code = CODE.get(f)!;
    if (f === TEXT_DOOR || f === VISION_DOOR) continue;
    if (OPENS_A_DOOR.test(code) && !GOVERNED.test(code)) out.add(f);
  }

  for (const f of FILES) {
    if (f === CREDENTIAL_PROBE) continue;
    if (/\bisAiConfigured\s*\(/.test(CODE.get(f)!)) out.add(f);
  }

  return [...out].sort();
}

describe("THE RATCHET — no ungoverned inference path may return", () => {
  it("derives ZERO ungoverned inference entry points from source", () => {
    // If this fails, the failure message names the file. Either route it through
    // `invokeWithGovernor` with a registered feature key, or — if it genuinely
    // belongs outside the governor — raise
    // AI_UNGOVERNED_INFERENCE_ENTRY_POINTS deliberately, which turns the amber
    // warning on /admin/ai-costs back on for every deploy carrying a credential.
    expect(ungovernedEntryPoints()).toEqual([]);
  });

  it("agrees with the constant the READINESS SURFACE reports to operators", () => {
    // The pin that stops the green light drifting from the code. The readiness
    // field is derived from this number, so a source regression makes the HQ page
    // go amber on its own rather than staying green by assertion.
    expect(ungovernedEntryPoints().length).toBe(AI_UNGOVERNED_INFERENCE_ENTRY_POINTS);
    expect(AI_UNGOVERNED_INFERENCE_ENTRY_POINTS).toBe(0);

    // And the operator-facing consequence, with both credentials present — the
    // worst case an operator can create without touching the build.
    vi.stubEnv("ANTHROPIC_API_KEY", "present");
    vi.stubEnv("OPENAI_API_KEY", "present");
    const r = getAiGovernorReadiness();
    expect(r.credentialsPresent.length).toBe(2);
    expect(r.activated).toBe(false);
    expect(r.ungovernedCredentialRisk).toBe(false);
    vi.unstubAllEnvs();
  });

  it("pins the SDK-construction allowlist by COUNT and by name", () => {
    // pin-COUNT: growth fails even if a new file's name looks innocuous. The
    // three service entries are governed and activation-gated, so they are not
    // holes — but their transport still belongs behind a door, which is a stated
    // follow-up rather than a silent tolerance.
    const expected = [
      "lib/ai/embeddings/openai.ts", // embedding-door transport — see EMBEDDINGS
      "lib/ai/text/anthropic.ts", // door transport
      "lib/ai/text/openai.ts", // door transport
      "lib/ai/vision/anthropic.ts", // door transport
      "server/services/lead-summary.ts", // governed + activation-gated
      "server/services/receptionist.ts", // governed + activation-gated
      "server/services/research-llm.ts", // governed + activation-gated
    ];
    expect(sdkFiles).toEqual(expected);
    expect(sdkFiles).toHaveLength(7);
  });

  it("pins the CREDENTIAL-READ allowlist by COUNT and by name", () => {
    const expected = [
      "lib/ai/embeddings/index.ts", // the embedding door
      "lib/ai/safety.ts", // defines the probe; gates nothing
      "lib/ai/text/index.ts", // the text door
      "lib/ai/vision/index.ts", // the vision door
      "server/services/lead-summary.ts", // inside a governed, activation-gated leg
      "server/services/receptionist.ts", // inside a governed, activation-gated leg
      "server/services/research-llm.ts", // inside a governed, activation-gated leg
    ];
    expect(credentialFiles).toEqual(expected);
    expect(credentialFiles).toHaveLength(7);
  });

  it("`isAiConfigured()` is called NOWHERE — it is a probe, not a gate", () => {
    // The specific regression the audit named. It stays exported (it is a
    // truthful env probe, and the ops env snapshot's sibling of it is used by
    // launch readiness), but nothing may decide to spend money on it.
    const callers = FILES.filter(
      (f) => f !== CREDENTIAL_PROBE && /\bisAiConfigured\s*\(/.test(CODE.get(f)!),
    );
    expect(callers).toEqual([]);
  });

  it("BOTH generative doors gate on THEIR OWN modality's activation, before any key", () => {
    // Per-tier since the embeddings governance train: the global
    // `isGovernorActivated()` became the wrong gate the moment a second
    // modality joined the registry — binding an embedding model must not open
    // a generative door on a bare key.
    for (const door of [TEXT_DOOR, VISION_DOOR]) {
      const code = CODE.get(door)!;
      expect(code, `${door} must import the per-modality activation predicate`).toMatch(
        /isInferenceTierActivated/,
      );
      // Ordering is the load-bearing part: a provider object that exists for a
      // call which must never happen is a provider object someone will use.
      const idxGate = code.indexOf("if (!isInferenceTierActivated())");
      const idxKey = code.search(CREDENTIAL_READ);
      expect(idxGate, `${door} must refuse before it resolves a vendor`).toBeGreaterThan(-1);
      expect(idxKey).toBeGreaterThan(-1);
      expect(idxGate).toBeLessThan(idxKey);
      // And neither door may fall back to the global predicate.
      expect(code).not.toMatch(/\bisGovernorActivated\s*\(/);
    }
  });

  it("every module that OPENS a door also passes through the governor", () => {
    const openers = FILES.filter(
      (f) => f !== TEXT_DOOR && f !== VISION_DOOR && OPENS_A_DOOR.test(CODE.get(f)!),
    );
    // Sanity: the sweep is actually finding the call sites it claims to check.
    expect(openers.length).toBeGreaterThanOrEqual(7);
    for (const f of openers) {
      expect(CODE.get(f)!, `${f} opens a model door without the governor`).toMatch(GOVERNED);
    }
  });

  it("the EMBEDDING door gates its paid branch on the embedding tier, before any key", () => {
    // The same shape as the generative-door pin above, for the third door: a
    // key is transport, a bound `embedding` tier is authorisation. The
    // deterministic branch sits AFTER the gate check inside the `openai` case
    // only in the sense that it is a different case entirely — it reads no key.
    const code = CODE.get(EMBEDDING_DOOR)!;
    expect(code, `${EMBEDDING_DOOR} must import the embedding activation predicate`).toMatch(
      /isEmbeddingActivated/,
    );
    const idxGate = code.indexOf("if (!isEmbeddingActivated())");
    const idxKey = code.search(CREDENTIAL_READ);
    expect(idxGate, "the paid branch must refuse before it reads a key").toBeGreaterThan(-1);
    expect(idxKey).toBeGreaterThan(-1);
    expect(idxGate).toBeLessThan(idxKey);
    expect(code).not.toMatch(/\bisGovernorActivated\s*\(/);
  });

  it("the vision door is the ONLY vision transport — the two OCR paths converged", () => {
    // lib/imports/ocr.ts imported `@anthropic-ai/sdk` at MODULE SCOPE and
    // hard-coded a dated model while expense-drafts hard-coded an undated one —
    // already drifted. Neither may construct an SDK again.
    for (const f of ["lib/imports/ocr.ts", "server/services/expense-drafts.ts"]) {
      const code = CODE.get(f)!;
      expect(code, `${f} must not construct a vendor SDK`).not.toMatch(SDK_CONSTRUCTION);
      expect(code, `${f} must not read a vendor credential`).not.toMatch(CREDENTIAL_READ);
      expect(code, `${f} must use the shared vision door`).toMatch(/getVisionProvider/);
      expect(code, `${f} must be governed`).toMatch(GOVERNED);
    }
  });
});

// ---------------------------------------------------------------------------
// A2. THE EMBEDDING MODALITY — the same ratchet, for the third door.
// ---------------------------------------------------------------------------

describe("the embedding modality is closed — derived from source, like the rest", () => {
  const insideEmbeddings = (f: string) => f.startsWith("lib/ai/embeddings/");

  it("NO file outside lib/ai/embeddings/** calls .embed( on a provider", () => {
    // The transport method is reachable only through the governed door. Before
    // this train, BOTH call sites (the memory worker and HQ recall's query
    // embed) called provider.embed() directly — no ceiling, no ledger.
    const callers = FILES.filter(
      (f) => !insideEmbeddings(f) && /\.embed\s*\(/.test(CODE.get(f)!),
    );
    expect(callers).toEqual([]);
  });

  it("NO file outside lib/ai/embeddings/** constructs the paid provider", () => {
    const constructors = FILES.filter(
      (f) => !insideEmbeddings(f) && /\bcreateOpenAiEmbeddingProvider\s*\(/.test(CODE.get(f)!),
    );
    expect(constructors).toEqual([]);
  });

  it("getEmbeddingProvider() callers outside the module are EXACTLY the pinned allowlist", () => {
    // Both remaining callers use the handle for information and gating only —
    // "is there a provider", "is it the deterministic one", version strings
    // for the SQL accounting rows. The .embed()-is-unreachable pin above is
    // what makes "info/gate only" a derived fact rather than a comment.
    const callers = FILES.filter(
      (f) => !insideEmbeddings(f) && /\bgetEmbeddingProvider\s*\(/.test(CODE.get(f)!),
    ).sort();
    expect(callers).toEqual([
      "server/services/hq-memory.ts",
      "server/services/memory-embedder.ts",
    ]);
    for (const f of callers) {
      // Each embeds ONLY through the governed door, and each resolves the HQ
      // budget org rather than spending unattributed.
      expect(CODE.get(f)!, `${f} must embed through governedEmbed`).toMatch(/\bgovernedEmbed\s*\(/);
      expect(CODE.get(f)!, `${f} must resolve the HQ budget org`).toMatch(/hqBudgetOrgId\(\)/);
    }
  });

  it("the governed door itself passes through invokeWithGovernor under the 'embedding' class", () => {
    const code = CODE.get(EMBEDDING_GOVERNED_DOOR)!;
    expect(code).toMatch(GOVERNED);
    expect(code).toMatch(/"memory\.embedding_write"\s*\|\s*"memory\.embedding_query"/);
    // The task class travels as the literal the registry authorises.
    expect(code).toMatch(/invokeWithGovernor<EmbeddingResult>\(/);
    expect(code).toMatch(/"embedding"/);
  });

  it("the deterministic exemption is keyed on the PROVIDER'S OWN TAG, and there are exactly two .embed( sites", () => {
    const code = CODE.get(EMBEDDING_GOVERNED_DOOR)!;
    // A caller cannot opt into the exemption — the branch tests the provider's
    // self-declared identity, nothing from the input.
    expect(code).toMatch(/provider\.info\.provider\s*===\s*"deterministic"/);
    // Site count is the ratchet: one exempt direct call, one inside the
    // governed fn. A third would be a new ungoverned path.
    const embedCalls = code.match(/\.embed\s*\(/g) ?? [];
    expect(embedCalls).toHaveLength(2);
  });

  it("the dedupe identity is the \\u0000 ESCAPE — no raw NUL byte in the module", () => {
    const rawBytes = readFileSync(resolve(ROOT, EMBEDDING_GOVERNED_DOOR));
    expect(rawBytes.includes(0)).toBe(false);
    expect(rawBytes.toString("utf8")).toContain('.join("\\u0000")');
  });
});

// ---------------------------------------------------------------------------
// The registry — every newly-wrapped key is registered, with a task class
// ---------------------------------------------------------------------------

describe("the registry is once again the COMPLETE list of what may spend", () => {
  it("registers all seven closed paths, with the reviewed task class", () => {
    const expected = {
      // Tenant-facing prose a customer reads ⇒ `drafting`, the class whose cost
      // tier exists for exactly that. Not `complex`: the model is handed finished
      // deterministic facts and forbidden from reasoning past them.
      "insights.narrative": "drafting",
      "insights.question": "drafting",
      "lead.summary": "drafting",
      // Prose a human approves before it reaches a customer — the textbook case.
      "hq.draft": "drafting",
      // Internal, short, low-stakes compression that no customer ever sees, so
      // the mid tier's premium would buy quality nobody reads ⇒ `classification`.
      "memory.summarise": "classification",
      // Structured extraction of a fixed JSON schema from a document — the same
      // work `expense.receipt_extraction` already is, so the same class.
      "imports.ocr": "classification",
      // Genuinely multi-step reasoning over a fetched evidence corpus at ~3k
      // output tokens ⇒ `complex`, the only keys in the registry that earn it.
      "research.analysis": "complex",
      "research.sales_prep": "complex",
    } as const;

    for (const [key, taskClass] of Object.entries(expected)) {
      const def = featureDefinition(key);
      expect(def, `${key} must be registered`).not.toBeNull();
      expect(def!.taskClass, `${key} task class`).toBe(taskClass);
      // `degradesTo` is prose for reviewers; an empty one is a registry entry
      // that has not been thought about.
      expect(def!.degradesTo.length).toBeGreaterThan(20);
    }
    // No key is registered as `deterministic`: the ledger's CHECK refuses it, so
    // such an entry would be a call site that can only ever throw.
    for (const def of Object.values(AI_FEATURES)) {
      expect(def.taskClass).not.toBe("deterministic");
    }
  });

  it("every registered key is actually WIRED at a call site", () => {
    // The inverse of the ratchet: a registry entry with no call site is a
    // permission granted to nothing, which is how a registry stops describing
    // the system.
    const all = FILES.map((f) => CODE.get(f)!).join("\n");
    for (const key of [
      "insights.narrative",
      "insights.question",
      "lead.summary",
      "hq.draft",
      "memory.summarise",
      "imports.ocr",
      "research.analysis",
      "research.sales_prep",
      // The embeddings-governance train's two keys.
      "memory.embedding_write",
      "memory.embedding_query",
    ]) {
      expect(all, `${key} is registered but never invoked`).toContain(`"${key}"`);
    }
  });

  it("HQ attribution is FAIL-CLOSED, and introduces no credential", () => {
    // HQ has no tenant, and the ledger's org_id is NOT NULL. Attribution to
    // CrewFlow's own org row is the honest answer; `null` must refuse, never
    // default to "some org".
    const code = CODE.get("lib/ai/governor/attribution.ts")!;
    expect(code).toMatch(/CREWFLOW_INTERNAL_ORG_ID/);
    expect(code).not.toMatch(/API_KEY|SECRET|TOKEN|PASSWORD/);
    expect(code).toMatch(/return trimmed\.length > 0 \? trimmed : null/);
    // Each HQ caller must REFUSE on null rather than proceed.
    for (const f of [
      "server/services/hq-drafts.ts",
      "server/services/memory-lifecycle.ts",
      "server/services/research-llm.ts",
    ]) {
      expect(CODE.get(f)!, `${f} must resolve the HQ budget org`).toMatch(/hqBudgetOrgId\(\)/);
    }
    expect(CODE.get("server/services/hq-drafts.ts")!).toMatch(/no_budget_org/);
    expect(CODE.get("server/services/research-llm.ts")!).toMatch(
      /if \(!budgetOrgId\) return null;/,
    );
  });
});

// ---------------------------------------------------------------------------
// B. THE DARK-PATH PROOF — no database contact, no changed return value
// ---------------------------------------------------------------------------

/**
 * The counter that makes "no I/O happened" a measurement.
 *
 * Every governor write path goes through `createAdminClient()`. On the dark path
 * — no tier bound — not one of them may be reached: no budget read, no
 * reservation, no ledger row. The mock therefore counts constructions and the
 * tests assert zero, rather than a reviewer asserting it in a comment.
 */
const adminConstructions = { count: 0 };
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    adminConstructions.count += 1;
    return {
      from: () => ({ insert: async () => ({ error: null }) }),
      rpc: async () => ({ data: [], error: null }),
    };
  },
}));

/**
 * The two doors are mocked so the GOVERNOR'S dark short-circuit is the thing
 * under test.
 *
 * With the real doors, a dark build hands back `null` and each caller degrades
 * before the governor is reached — true in production, and a weaker proof. By
 * returning a live fake provider we force execution INTO
 * `invokeWithGovernor` with no tier bound, which is where the claim
 * "wiring the governor changed nothing" actually has to hold.
 */
const { textGenerate, visionExtract, getTextProviderMock, getVisionProviderMock } = vi.hoisted(
  () => ({
    textGenerate: vi.fn(),
    visionExtract: vi.fn(),
    getTextProviderMock: vi.fn(),
    getVisionProviderMock: vi.fn(),
  }),
);
vi.mock("@/lib/ai/text", () => ({
  getTextProvider: getTextProviderMock,
  textCostUsd: () => 0.00042,
}));
vi.mock("@/lib/ai/vision", () => ({ getVisionProvider: getVisionProviderMock }));

const buildSnapshotMock = vi.hoisted(() => vi.fn());
vi.mock("@/server/services/retention-snapshot", () => ({
  buildRetentionSnapshot: buildSnapshotMock,
}));

/**
 * STATIC imports, deliberately — `vi.mock` is hoisted above them by the vitest
 * transform, so the doors and the admin client are already mocked by the time
 * these modules load. They were `await import(...)` inside each test at first,
 * which paid a cold module-graph load (the governor pulls in the Supabase client)
 * on the FIRST assertion of the file and made that one test the slowest thing in
 * the suite — enough to trip the default 5s timeout on a loaded machine. Moving
 * the cost to collection removes the flake without weakening an assertion.
 */
import { AI_UNGOVERNED_INFERENCE_ENTRY_POINTS, getAiGovernorReadiness } from "@/lib/ai/governor/readiness";
import { AI_FEATURES, featureDefinition, isAnyTierBound } from "@/lib/ai/governor/registry";
import { isGovernorActivated } from "@/lib/ai/governor";
import { generateInsightNarrative } from "@/lib/ai/insight-narrative";
import { askAi } from "@/server/services/ai-question";
import { ocrFileToSheet, OcrUnavailableError } from "@/lib/imports/ocr";

const SNAP = {
  now: "2026-07-10T00:00:00.000Z",
  last_activity_at: "2026-07-08T00:00:00.000Z",
  onboarding: {
    counts: { customers: 12, quotes: 7, invoices: 5, staffMembers: 3, importsCommitted: 1 },
  },
  overdue_invoice_count: 2,
  support_open_count: 1,
  unresolved_alerts_count: 0,
  invoiced_total_gbp: 42000,
  windows: {
    last_7d: {
      customers_added: 1,
      quotes_created: 0,
      quotes_accepted: 0,
      invoices_sent: 2,
      invoiced_gbp: 3000,
      payments_received_gbp: 1500,
    },
  },
};

describe("THE DARK-PATH PROOF — the admin client is never constructed", () => {
  beforeEach(() => {
    adminConstructions.count = 0;
    textGenerate.mockReset();
    visionExtract.mockReset();
    getTextProviderMock.mockReset();
    getVisionProviderMock.mockReset();
    buildSnapshotMock.mockReset();
    buildSnapshotMock.mockResolvedValue(SNAP);
    getTextProviderMock.mockReturnValue({
      info: { provider: "anthropic", model: "fake-model" },
      generate: textGenerate,
    });
    getVisionProviderMock.mockReturnValue({
      info: { provider: "anthropic", model: "fake-model" },
      extract: visionExtract,
    });
  });

  it("the build really is dark — otherwise every assertion below is vacuous", () => {
    expect(isAnyTierBound()).toBe(false);
    expect(isGovernorActivated()).toBe(false);
  });

  it("insights.narrative — returns the prose, touches NO database", async () => {
    textGenerate.mockResolvedValue({
      text: "  Steady pipeline this month.  ",
      model: "fake-model",
      inputTokens: 300,
      outputTokens: 40,
    });

    const out = await generateInsightNarrative(
      "activity",
      { org_id: "ORG-SECRET", key_metrics: { total_events: 5 } },
      { orgId: "ORG-1", userId: null },
    );

    expect(out?.text).toBe("Steady pipeline this month.");
    expect(textGenerate).toHaveBeenCalledTimes(1);
    expect(adminConstructions.count).toBe(0);
  });

  it("insights.question — returns the model answer, touches NO database", async () => {
    textGenerate.mockResolvedValue({
      text: JSON.stringify({
        answer: "Quotes are converting steadily.",
        confidence: "high",
        sources: [{ label: "Quotes last 7d" }],
      }),
      model: "fake-model",
      inputTokens: 200,
      outputTokens: 30,
    });

    const out = await askAi({ orgId: "ORG-1", question: "How is the pipeline?" });

    expect(out.generated_by).toBe("anthropic");
    expect(out.answer).toBe("Quotes are converting steadily.");
    expect(adminConstructions.count).toBe(0);
  });

  it("imports.ocr — returns the parsed sheet, touches NO database", async () => {
    visionExtract.mockResolvedValue({
      text: JSON.stringify({
        kind: "invoice",
        customer_name: "Acme Ltd",
        document_number: "INV-1",
        document_date: "2026-07-01",
        total: 1200,
        line_items: [],
      }),
      model: "fake-model",
      inputTokens: 900,
      outputTokens: 120,
    });

    const sheet = await ocrFileToSheet({
      filename: "invoice.pdf",
      mimeType: "application/pdf",
      bytes: new Uint8Array([1, 2, 3]),
      actor: { orgId: "ORG-1", userId: "USER-1" },
    });

    expect(sheet.rows[0]).toContain("Acme Ltd");
    expect(visionExtract).toHaveBeenCalledTimes(1);
    expect(adminConstructions.count).toBe(0);
  });

  it("a provider FAILURE on the dark path still records nothing and still rethrows", async () => {
    // The governor settles failures as spend when activated. Dark, there is
    // nothing to settle — but the caller's own catch must behave exactly as
    // before, which is what preserves every degraded path.
    textGenerate.mockRejectedValue(new Error("429 Too Many Requests"));

    const out = await generateInsightNarrative("activity", {}, { orgId: "ORG-1", userId: null });

    expect(out).toBeNull();
    expect(adminConstructions.count).toBe(0);
  });

  it("with the REAL doors shut, no provider is called at all", async () => {
    // Production today: no credential, no binding. The degraded leg runs before
    // the governor is even reached, so neither the provider nor the database is
    // touched. This is the state the £100 ceiling protects nothing from — and the
    // state a stray credential must not be able to leave.
    getTextProviderMock.mockReturnValue(null);
    getVisionProviderMock.mockReturnValue(null);

    expect(
      await generateInsightNarrative("activity", {}, { orgId: "ORG-1", userId: null }),
    ).toBeNull();
    expect((await askAi({ orgId: "ORG-1", question: "hi" })).generated_by).toBe("deterministic");
    await expect(
      ocrFileToSheet({
        filename: "x.pdf",
        mimeType: "application/pdf",
        bytes: new Uint8Array([1]),
        actor: { orgId: "ORG-1" },
      }),
    ).rejects.toBeInstanceOf(OcrUnavailableError);

    expect(textGenerate).not.toHaveBeenCalled();
    expect(visionExtract).not.toHaveBeenCalled();
    expect(adminConstructions.count).toBe(0);
  });
});
