import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { getTextProvider } from "@/lib/ai/text";
import { textCostUsd } from "@/lib/ai/text/cost";
import { DEDUPE_COSINE_THRESHOLD, SUMMARY_MAX_RATIO } from "@/lib/memory/lifecycle";

/**
 * Shared Memory — the lifecycle worker (CEO Directive 009 Module 1, PR5).
 *
 * The dedicated background worker that keeps the company brain coherent and
 * bounded (Bible Volume X §9–§10). The atomic mechanics live in SQL (the
 * hq_memory_* lifecycle primitives, PR5b) — supabase-js has no client
 * transaction and, per the spine's D1, we don't invent one. What CANNOT live in
 * SQL is the LLM call that refines a summary: an external provider call must
 * never run inside a Postgres transaction. So this worker is the seam:
 *
 *   expire sweep (SQL)                                  — TTL + decay archival
 *   dedupe detect (SQL) → supersede each (SQL)          — near-duplicate merges
 *   summary detect (SQL) → generate (provider, in TS) → set summary (SQL)
 *
 * It NEVER throws — a provider hiccup or one bad row must not break the cron
 * run; failures are isolated per item and the run reports what it did.
 *
 * DARK by default + graceful degradation, exactly like the embedding worker:
 *   - gate off (memory_lifecycle.worker_enabled = false) → a single cheap RPC,
 *     no work. The gate is the PRIMARY control: the dedupe/supersede/summary
 *     primitives are deliberately ungated in SQL (so the SDK can call them
 *     directly), so this worker must self-gate before touching them.
 *   - no text provider configured (getTextProvider() === null) → summarisation
 *     is skipped; expiry, decay archival, and dedup still run. The deterministic
 *     SQL state is left in place and the app cannot tell the difference.
 *   - no embeddings → hq_memory_dedupe_pairs returns [] (no vectors to compare),
 *     so dedup is a no-op; everything else is unaffected.
 *
 * CONSOLIDATION is intentionally NOT in the autonomous tick: it needs a THEME,
 * and theme discovery (clustering) is a separate future capability. The stable
 * entry point is exposed here as `consolidateTheme()` for the SDK / a manual
 * trigger / future clustering to call — "expose the interface, complete later".
 */

// The lifecycle RPCs aren't in the generated Supabase types; cast past the
// typed client exactly as the embedder + spine + memory services do.
type Rpc = (
  fn: string,
  args?: Record<string, unknown>,
) => Promise<{ data: unknown; error: { message: string } | null }>;

function rpc(): Rpc {
  const admin = createAdminClient();
  return admin.rpc.bind(admin) as unknown as Rpc;
}

// --- Types -------------------------------------------------------------------

type DedupePair = { keep_id: string; drop_id: string; cos_sim: number };
type SummaryCandidate = {
  id: string;
  title: string;
  body: string;
  body_chars: number;
  summary_chars: number;
};

export type LifecycleRunSummary = {
  ok: boolean;
  /** Whether the worker kill-switch was on for this run. */
  enabled: boolean;
  /** Working/episodic memories archived because they passed their hard TTL. */
  ttlExpired: number;
  /** Consolidated episodes archived because they decayed below the floor. */
  decayedArchived: number;
  /** Near-duplicate pairs the detector proposed this run. */
  duplicatePairs: number;
  /** Duplicates actually merged into their keeper. */
  superseded: number;
  /** Memories detected as needing a (re)generated summary. */
  summaryCandidates: number;
  /** Summaries successfully generated + stored via the text provider. */
  summarised: number;
  /** The active text provider "provider:model", or null when none configured. */
  textProvider: string | null;
  /** Total USD spent on LLM summarisation this run (unknown pricing counts 0). */
  costUsd: number;
  /** Why the run stopped: 'ok' | 'disabled' | 'deadline' | 'cost_cap' | 'error'. */
  stopped: string;
  /** Set only when the run could not even start (never thrown). */
  error?: string;
};

export type LifecycleRunOptions = {
  /** Max rows each SQL pass (expire/dedupe/summary detect) may scan. Default 200. */
  scanLimit?: number;
  /** Max duplicate pairs to supersede this run. Default 50. */
  maxSupersedes?: number;
  /** Max summaries to (re)generate this run. Default 20. */
  maxSummaries?: number;
  /** Cosine threshold for near-duplicate detection. Default DEDUPE_COSINE_THRESHOLD. */
  dedupeThreshold?: number;
  /** Stop summarising once this run's spend reaches this (USD). Default 5. */
  maxCostUsd?: number;
  /** Wall-clock budget for the run (ms); leaves headroom under maxDuration. Default 50_000. */
  maxRunMs?: number;
  /** Per-LLM-call timeout (ms). Default: the provider's own. */
  callTimeoutMs?: number;
};

// --- Summarisation prompt (lifecycle-specific; the text seam stays generic) ---

const SUMMARY_SYSTEM =
  "You compress a single internal company-memory note into a faithful, self-contained summary. " +
  "Output ONLY the summary prose — no preamble, no markdown, no headings, no bullet points.";

function buildSummaryPrompt(title: string, body: string): string {
  return [
    "Summarise the following company memory in 2 to 4 sentences.",
    "Preserve concrete facts, names, numbers, decisions, and any lesson learned.",
    "Do not add information that is not in the note, and do not editorialise.",
    "",
    title ? `Title: ${title}` : "",
    "Body:",
    body,
  ]
    .filter((l) => l !== "")
    .join("\n");
}

// --- Gate + signals ----------------------------------------------------------

/** True iff the worker kill-switch is on. Fail-dark on any error. */
export async function isLifecycleWorkerEnabled(): Promise<boolean> {
  try {
    const { data, error } = await rpc()("hq_memory_lifecycle_enabled");
    if (error) return false;
    return data === true;
  } catch {
    return false;
  }
}

/** Read the lifecycle golden signals (status mix, backlog, 24h transitions). */
export async function getMemoryGoldenSignals(): Promise<Record<string, unknown> | null> {
  try {
    const { data, error } = await rpc()("hq_memory_golden_signals");
    if (error || data == null) return null;
    return data as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Roll a themed cluster of an employee's own episodes into one long_term lesson.
 * Thin wrapper over hq_memory_consolidate — the stable entry point for the SDK /
 * a manual trigger / future theme-clustering. Returns the new memory id, or null
 * when the worker is disabled, fewer than the minimum sources match, or on any
 * error (never throws). NOT called by the autonomous tick (no theme source yet).
 */
export async function consolidateTheme(
  employeeId: string,
  theme: string,
): Promise<string | null> {
  try {
    const { data, error } = await rpc()("hq_memory_consolidate", {
      p_employee_id: employeeId,
      p_theme: theme,
    });
    if (error || typeof data !== "string") return null;
    return data;
  } catch {
    return null;
  }
}

// --- The worker --------------------------------------------------------------

function disabledSummary(over: Partial<LifecycleRunSummary> = {}): LifecycleRunSummary {
  return {
    ok: true,
    enabled: false,
    ttlExpired: 0,
    decayedArchived: 0,
    duplicatePairs: 0,
    superseded: 0,
    summaryCandidates: 0,
    summarised: 0,
    textProvider: null,
    costUsd: 0,
    stopped: "disabled",
    ...over,
  };
}

/**
 * Run one lifecycle pass. The cron's entry point. Never throws.
 *
 * Short-circuits (a single cheap RPC) when the gate is off, so a dark
 * deployment is nearly free and the ungated apply-primitives are never reached
 * while disabled.
 */
export async function runMemoryLifecycleWorker(
  opts: LifecycleRunOptions = {},
): Promise<LifecycleRunSummary> {
  const scanLimit = Math.max(1, opts.scanLimit ?? 200);
  const maxSupersedes = Math.max(0, opts.maxSupersedes ?? 50);
  const maxSummaries = Math.max(0, opts.maxSummaries ?? 20);
  const dedupeThreshold = opts.dedupeThreshold ?? DEDUPE_COSINE_THRESHOLD;
  const maxCostUsd = opts.maxCostUsd ?? 5;
  const maxRunMs = Math.max(1_000, opts.maxRunMs ?? 50_000);
  const deadline = Date.now() + maxRunMs;

  try {
    // (1) Gate. Off → no work. This is the ONLY gate protecting the ungated
    //     supersede/set_summary primitives, so it must come first.
    if (!(await isLifecycleWorkerEnabled())) {
      return disabledSummary();
    }

    const call = rpc();
    // Resolve the text provider once — cheap + network-free — so we can both
    // report it and use it for summarisation. null = none configured (summaries
    // simply won't run; everything else still does).
    const provider = getTextProvider();
    const textProvider = provider ? `${provider.info.provider}:${provider.info.model}` : null;

    let ttlExpired = 0;
    let decayedArchived = 0;
    let duplicatePairs = 0;
    let superseded = 0;
    let summaryCandidates = 0;
    let summarised = 0;
    let costUsd = 0;
    let stopped = "ok";

    // (2) Expiry + decay archival (one bounded, idempotent SQL sweep). Cheap +
    //     the most important reducer, so it always runs first.
    {
      const { data } = await call("hq_memory_expire_sweep", { p_limit: scanLimit });
      if (data && typeof data === "object") {
        const d = data as { ttl_expired?: unknown; decayed_archived?: unknown };
        ttlExpired = typeof d.ttl_expired === "number" ? d.ttl_expired : 0;
        decayedArchived = typeof d.decayed_archived === "number" ? d.decayed_archived : 0;
      }
    }

    // (3) Deduplication: detect near-duplicate pairs (read-only), then merge
    //     each into its keeper. With no embeddings the detector returns [].
    if (maxSupersedes > 0) {
      if (Date.now() > deadline) {
        stopped = "deadline";
      } else {
        const { data } = await call("hq_memory_dedupe_pairs", {
          p_limit: scanLimit,
          p_threshold: dedupeThreshold,
        });
        const pairs = parsePairs(data);
        duplicatePairs = pairs.length;
        for (const pair of pairs.slice(0, maxSupersedes)) {
          if (Date.now() > deadline) {
            stopped = "deadline";
            break;
          }
          const ok = await supersedeOne(call, pair.keep_id, pair.drop_id);
          if (ok) superseded++;
        }
      }
    }

    // (4) Summarisation: detect long bodies with no usable summary, then have
    //     the text provider compress each. Skipped entirely when no provider is
    //     configured (graceful — the deterministic state stays in place), or when
    //     a prior phase already exhausted the run's wall-clock budget.
    if (provider && maxSummaries > 0 && stopped === "ok") {
      const { data } = await call("hq_memory_summary_candidates", { p_limit: maxSummaries });
      // p_limit already bounds the detector to maxSummaries; the slice is
      // belt-and-suspenders (symmetric with the supersede cap) so the run can
      // never exceed its budget even if the detector returns more than asked.
      const candidates = parseCandidates(data).slice(0, maxSummaries);
      summaryCandidates = candidates.length;

      for (const c of candidates) {
        if (Date.now() > deadline) {
          stopped = "deadline";
          break;
        }
        if (costUsd >= maxCostUsd) {
          stopped = "cost_cap";
          break;
        }
        if (!c.body || c.body.trim().length === 0) continue;

        let text = "";
        try {
          const signal = opts.callTimeoutMs ? AbortSignal.timeout(opts.callTimeoutMs) : undefined;
          const res = await provider.generate(buildSummaryPrompt(c.title, c.body), {
            system: SUMMARY_SYSTEM,
            ...(signal ? { signal } : {}),
          });
          text = res.text;
          costUsd += textCostUsd(provider.info, res) ?? 0;
        } catch {
          // One bad generation must not break the run — skip this memory; it
          // stays a candidate and is retried next tick.
          continue;
        }

        // Only persist a genuine summary: non-empty AND meaningfully shorter
        // than the TRUE body length (the policy ratio). Otherwise it would just
        // re-trip needsSummary next tick — wasted writes.
        if (text.length === 0) continue;
        if (text.length >= c.body_chars * SUMMARY_MAX_RATIO) continue;

        const ok = await setSummaryOne(call, c.id, text);
        if (ok) summarised++;
      }
    }

    return {
      ok: true,
      enabled: true,
      ttlExpired,
      decayedArchived,
      duplicatePairs,
      superseded,
      summaryCandidates,
      summarised,
      textProvider,
      costUsd,
      stopped,
    };
  } catch (e) {
    // Absolute backstop — the worker must never throw into the cron.
    return {
      ok: false,
      enabled: true,
      ttlExpired: 0,
      decayedArchived: 0,
      duplicatePairs: 0,
      superseded: 0,
      summaryCandidates: 0,
      summarised: 0,
      textProvider: null,
      costUsd: 0,
      stopped: "error",
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

// --- Internals ---------------------------------------------------------------

function parsePairs(data: unknown): DedupePair[] {
  if (!Array.isArray(data)) return [];
  return data.filter(
    (p): p is DedupePair =>
      !!p &&
      typeof (p as DedupePair).keep_id === "string" &&
      typeof (p as DedupePair).drop_id === "string",
  );
}

function parseCandidates(data: unknown): SummaryCandidate[] {
  if (!Array.isArray(data)) return [];
  return data.filter(
    (c): c is SummaryCandidate =>
      !!c &&
      typeof (c as SummaryCandidate).id === "string" &&
      typeof (c as SummaryCandidate).body === "string" &&
      typeof (c as SummaryCandidate).body_chars === "number",
  );
}

async function supersedeOne(call: Rpc, keepId: string, dropId: string): Promise<boolean> {
  try {
    const { data, error } = await call("hq_memory_supersede", {
      p_keep_id: keepId,
      p_drop_id: dropId,
      p_reason: "dedupe",
    });
    if (error || !data || typeof data !== "object") return false;
    return (data as { ok?: boolean }).ok === true;
  } catch {
    return false;
  }
}

async function setSummaryOne(call: Rpc, memoryId: string, summary: string): Promise<boolean> {
  try {
    const { data, error } = await call("hq_memory_set_summary", {
      p_memory_id: memoryId,
      p_summary: summary,
    });
    if (error || !data || typeof data !== "object") return false;
    return (data as { ok?: boolean }).ok === true;
  } catch {
    return false;
  }
}
