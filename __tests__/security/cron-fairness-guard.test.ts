import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * SYSTEMIC CRON-FAIRNESS GUARD — the class-eliminating pin (C71).
 *
 * The class: a cron whose service reads a PERSISTENT candidate set (rows that
 * survive their own success and are re-selected every tick — a connected feed, a
 * watched district) and iterates ALL of it in one loop, using a TICK-STABLE order
 * (`id` / `created_at` / lexicographic `.sort()`) and NO wall-clock budget. At
 * scale the pass is killed mid-loop by the function's maxDuration, and the same
 * head is re-serviced every tick while the identical TAIL is never reached — those
 * rows silently never sync. C39 (webhook-dispatch) and C70-D (bank-sync) fixed two
 * instances; C71 fixed telematics-sync + weather-fetch. This guard makes the class
 * un-reintroducible: EVERY cron entrypoint must be classified, and every cron whose
 * service runs a persistent-candidate loop MUST order by a fairness cursor AND have
 * a wall-clock pass budget — or be ALLOWLISTED with a written reason proving it
 * cannot starve a tail (a bounded/self-draining/lease-claim set, or a network-free
 * loop that finishes in one pass).
 *
 * NON-VACUOUS: reverting telematics-sync's `.order("last_sync_at", … nullsFirst)`
 * to `.order("id")`, or dropping its pass budget, turns the "telematics-sync"
 * case below RED (see the delete-the-fix proof documented in the C71 PR).
 *
 * A NEW cron added under app/api/cron (a dir with route.ts) that is neither classified as a
 * fair-loop cron nor allowlisted fails the completeness test — so the next author
 * MUST make the fairness decision consciously. The whack-a-mole ends here.
 */

const ROOT = resolve(__dirname, "..", "..");
const CRON_DIR = resolve(ROOT, "app/api/cron");
const read = (p: string) => readFileSync(p, "utf8");
/** Strip block + line comments so pins match CODE, never prose in a comment. */
const codeOf = (ts: string) =>
  ts.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

/** Every cron entrypoint = a directory under app/api/cron holding a route.ts. */
function enumerateCrons(): string[] {
  return readdirSync(CRON_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(resolve(CRON_DIR, e.name, "route.ts")))
    .map((e) => e.name)
    .sort();
}

/** Resolve the module a route imports a given symbol from → a filesystem path. */
function resolveServiceFile(routeSrc: string, symbol: string): string {
  const re = new RegExp(
    `import\\s*(?:type\\s*)?\\{[^}]*\\b${symbol}\\b[^}]*\\}\\s*from\\s*["']([^"']+)["']`,
  );
  const m = routeSrc.match(re);
  if (!m) throw new Error(`could not resolve import of ${symbol} in the route`);
  const mod = m[1]!.replace(/^@\//, "");
  for (const ext of [".ts", ".tsx", "/index.ts"]) {
    const p = resolve(ROOT, mod + ext);
    if (existsSync(p)) return p;
  }
  throw new Error(`resolved module ${mod} for ${symbol} does not exist on disk`);
}

/**
 * FAIR-LOOP CRONS — services that iterate a PERSISTENT candidate set with per-item
 * external cost. Each MUST prove a fairness cursor AND a wall-clock pass budget,
 * checked in the SERVICE the route drives (resolved from the route's own import).
 */
type FairLoop = {
  cron: string;
  driver: string; // the service function the route calls
  fairness: RegExp[]; // ordering by a recency cursor / lease-claim dequeue
  budget: RegExp[]; // a PASS-budget constant + a clock-gated break
  forbid?: RegExp[]; // the tick-stable shapes that MUST be gone
  orderBefore?: [RegExp, RegExp]; // [primary, tiebreak] — primary must precede tiebreak
};

const FAIR_LOOP: FairLoop[] = [
  {
    cron: "telematics-sync",
    driver: "runTelematicsSync",
    fairness: [
      /\.order\(\s*["']last_sync_at["']\s*,\s*\{[^}]*ascending:\s*true[^}]*nullsFirst:\s*true[^}]*\}\s*\)/,
    ],
    budget: [/PASS_BUDGET_MS/, /-\s*startedAt\s*\+\s*perOrgBudgetMs\s*>\s*passBudgetMs\)\s*break/],
    forbid: [
      // The pre-fix tick-stable primary order on the connected read.
      /telematics_connections[\s\S]{0,300}?\.order\(\s*["']id["']\s*,\s*\{\s*ascending:\s*true\s*\}\s*\)\s*\.range/,
    ],
    orderBefore: [/\.order\(\s*["']last_sync_at["']/, /\.order\(\s*["']id["']/],
  },
  {
    cron: "bank-sync",
    driver: "runBankSync",
    fairness: [
      /\.order\(\s*["']last_sync_at["']\s*,\s*\{[^}]*ascending:\s*true[^}]*nullsFirst:\s*true[^}]*\}\s*\)/,
    ],
    budget: [/PASS_BUDGET_MS/, /-\s*startedAt\s*\+\s*perOrgBudgetMs\s*>\s*passBudgetMs\)\s*break/],
    orderBefore: [/\.order\(\s*["']last_sync_at["']/, /\.order\(\s*["']org_id["']/],
  },
  {
    cron: "weather-fetch",
    driver: "runWeatherFetch",
    // Fairness is an IN-MEMORY sort of the district list by each district's most-
    // recent fetched_at (the cursor lives in the `latestByDistrict` map).
    fairness: [/latestByDistrict/, /fetched_at/],
    budget: [/PASS_BUDGET_MS/, /-\s*startedAt\s*\+\s*PER_DISTRICT_BUDGET_MS\s*>\s*passBudgetMs\)\s*break/],
    forbid: [
      // The pre-fix lexicographic `.sort().slice(` that froze the cap on a prefix.
      /\.sort\(\)\s*\.slice\(/,
    ],
  },
  {
    cron: "webhook-dispatch",
    driver: "runDeliveryPass",
    // Fairness is a DB-side atomic claim/lease dequeue (ordered server-side by
    // next_attempt_at) — a claimed delivery is leased, never re-served this pass.
    fairness: [/webhook_claim_deliveries/],
    budget: [/PASS_BUDGET_MS/, /Date\.now\(\)\s*-\s*startedAt\s*\+\s*WEBHOOK_FETCH_TIMEOUT_MS\s*>\s*PASS_BUDGET_MS\)\s*break/],
  },
];

/**
 * ALLOWLIST — crons that provably cannot starve a tail, each with the reason found
 * by READING the cron + its service. Categories: (B)ounded by LIMIT/claim per pass,
 * (S)elf-draining (a processed item leaves the candidate set), (L)ease-claim
 * dequeue, (I)nternal/network-free per-item work that finishes in one pass, or an
 * already-budgeted worker. NONE reads a persistent external feed in an unbudgeted
 * all-rows loop.
 */
const ALLOWLIST: Record<string, string> = {
  "alerts-poll":
    "Evaluates a FIXED rule set over ONE in-memory snapshot; per-alert work is a single notify guarded by admin_alert_state.notified_at (self-excluding). No persistent external candidate set, no per-item network round-trips — a bounded closed set in one pass.",
  "approvals-expire":
    "LIMIT-bounded (≤200) per pass, ordered by expires_at ASC (stalest deadline first); expiry is a TERMINAL transition, so a processed approval leaves the due set — a stable order cannot re-service the same head.",
  "automation-schedules-drain":
    "LIMIT-bounded (≤1000) and ordered by next_run_at ASC (a recency cursor); each fired schedule advances next_run_at via an optimistic claim, rotating it to the back. Work is a light claim+advance, not a multi-round-trip external feed.",
  "compliance-expiry":
    "Bounded to docs expiring within a 31-day horizon; each reminder stage is guarded by a reminded_*_at marker (self-excluding). Per-item work is an internal notification insert, no external per-item I/O.",
  "health-recompute":
    "Idempotent per-org recompute is a single INTERNAL aggregate (no external I/O, no token refresh, no paginated vendor API) that writes nothing when unchanged; ordered oldest-first. A bounded internal set completing in one invocation — not an external-feed loop.",
  "hq-apply-drain":
    "LIMIT-bounded (≤500) reads of APPROVED items; each apply is exactly-once via a partial-unique idempotency key, so an applied item leaves the candidate set. Ships DARK (unbound authority applies nothing).",
  "hq-cadence-tick":
    "LIMIT-bounded (≤1000) and ordered by next_run_at ASC (recency cursor); each fired cadence advances next_run_at via an optimistic CAS claim, rotating it to the back.",
  "hq-ceo-briefing":
    "Composes and records exactly ONE deterministic CEO briefing per tick from a single in-memory board aggregate plus one idempotent per-day RPC insert (on conflict (briefing_date) do nothing). No persistent external candidate set, no per-item loop, and no per-item network I/O — a bounded single-pass job that finishes in one invocation, like health-recompute.",
  "inspections-due":
    "LIMIT-bounded (BATCH) and ordered by next_due ASC (recency cursor); the INSERT-is-the-claim idempotency makes a generated cycle self-excluding.",
  "invoice-reminders":
    "Self-draining send queue: a reminder row is created per (invoice, stage) and the candidate filter excludes any (invoice, stage) that already has one, so a sent reminder leaves the candidate set — a stable id order cannot re-service the same head. Reads paged in full (F-1).",
  "lead-followups":
    "Self-draining: a follow-up row / status advance excludes a processed lead from the next pass's candidates, so a stable id order cannot re-service the same head. Reads paged in full (F-1).",
  "maintenance-due":
    "LIMIT-bounded (BATCH) and ordered by next_due ASC (recency cursor); the (schedule_id, cycle_key) INSERT-is-the-claim makes a generated cycle self-excluding.",
  "maintenance-reminders-drain":
    "Lease-claim drain (claim_due_maintenance_reminders flips pending→sending … RETURNING under a lock), so a claimed reminder is not re-returned to an overlapping pass — leased dequeue rotates work.",
  "memory-embed":
    "Lease-claim queue with its OWN wall-clock budget (~50s) + spend cap; each batch is claimed under a lease (claimed_by guard), so processed memories are not re-claimed. Already budget-bounded.",
  "memory-lifecycle":
    "Bounded by p_limit RPCs and its OWN wall-clock deadline (Date.now() + maxRunMs); sweeps are terminal/idempotent, so processed rows leave the candidate set.",
  "notifications-drain":
    "LIMIT-bounded (DRAIN_BATCH_SIZE=50); a sent row leaves the queue and a failed row reschedules via backoff (scheduled_for moves forward = recency rotation) — self-draining.",
  "outreach-drain":
    "Claim-N-and-exit off an atomic FOR UPDATE SKIP LOCKED task lease, bounded by `limit`; a claimed task takes a lease so overlapping passes never re-serve it.",
  "overdue-invoices":
    "Self-draining idempotent scan: per-invoice dispatch is guarded by an automation_runs claim (skipped_already), and payment/status flips exclude an invoice from future scans. Reads paged in full (F-1).",
  "qualification-drain":
    "Claim-N-and-exit off an atomic FOR UPDATE SKIP LOCKED task lease, bounded by `limit`; leased tasks are never re-served by an overlapping pass.",
  "quote-followup":
    "Self-draining send queue: a follow-up marker excludes a processed quote from the next pass's candidates. Reads paged in full (F-1).",
  "report-delivery":
    "Self-draining daily delivery: candidates are ordered by last_run_on ASC NULLS FIRST (stalest/never-run first — a recency cursor) and each processed subscription's last_run_on advances to today, so a delivered subscription LEAVES the day's candidate set and a pass killed mid-list resumes from the tail on the next tick rather than re-servicing the head. Single-pass daily; reads paged in full (F-1).",
  "research-drain":
    "Claim-N-and-exit off an atomic FOR UPDATE SKIP LOCKED task lease, bounded by `limit`; leased tasks are never re-served.",
  "review-requests":
    "Self-draining: ordered by send_at ASC and a sent marker excludes a processed request from the next pass. Reads paged in full (F-1).",
  "spine-backfill":
    "Bounded by p_max_rows per source over a FIXED, closed source list (BACKFILL_SOURCES); each backfill advances a per-source cursor, so processed rows leave the candidate set.",
  "spine-drain":
    "Bounded by p_max_events per pass; the consumer advances a monotonic spine offset, so processed events are never re-read (cursor-advancing drain).",
  "spine-partitions":
    "Loops a FIXED small horizon (m=0..monthsAhead) creating partitions idempotently — a bounded closed set in one pass, no external feed.",
  "task-reaper":
    "A single LIMIT-bounded RPC (hq_ai_task_reap p_limit); the iteration is in SQL over expired leases, not a TS loop over a persistent external candidate set.",
  "weather-watch-sync":
    "Network-free reconciliation: pure district derivation + internal upsert/update, NO external provider call per item; processes the complete paged live-job set in one pass — nothing goes on any wire, so no per-item latency can blow a budget.",
};

const CRONS = enumerateCrons();
const FAIR_NAMES = new Set(FAIR_LOOP.map((f) => f.cron));

describe("cron-fairness guard — completeness (every cron is classified)", () => {
  it("every cron entrypoint is either a fair-loop cron or allowlisted, never both", () => {
    for (const cron of CRONS) {
      const inFair = FAIR_NAMES.has(cron);
      const inAllow = cron in ALLOWLIST;
      // A NEW cron that is neither classified nor allowlisted fails HERE — forcing
      // the author to make the fairness decision consciously.
      expect(inFair || inAllow, `cron "${cron}" is unclassified: add it to FAIR_LOOP (with a fairness cursor + pass budget) or to the ALLOWLIST (with a written reason)`).toBe(true);
      expect(inFair && inAllow, `cron "${cron}" is in BOTH FAIR_LOOP and ALLOWLIST — pick one`).toBe(false);
    }
  });

  it("no stale registry entries (every classified name is a real cron)", () => {
    const real = new Set(CRONS);
    for (const f of FAIR_LOOP) {
      expect(real.has(f.cron), `FAIR_LOOP names "${f.cron}" which is not a cron dir`).toBe(true);
    }
    for (const name of Object.keys(ALLOWLIST)) {
      expect(real.has(name), `ALLOWLIST names "${name}" which is not a cron dir`).toBe(true);
    }
  });

  it("every allowlist reason is a substantive written justification", () => {
    for (const [name, reason] of Object.entries(ALLOWLIST)) {
      expect(reason.length, `allowlist reason for "${name}" is too thin`).toBeGreaterThan(60);
    }
  });
});

describe("cron-fairness guard — fair-loop crons order by a cursor AND bound the pass", () => {
  for (const f of FAIR_LOOP) {
    it(`${f.cron} orders by a fairness cursor and has a wall-clock pass budget`, () => {
      const routeSrc = read(resolve(CRON_DIR, f.cron, "route.ts"));
      const serviceFile = resolveServiceFile(routeSrc, f.driver);
      const code = codeOf(read(serviceFile));

      // (a) FAIRNESS: a recency-cursor order (or a lease-claim dequeue) — NOT a
      // tick-stable id/created_at/lexicographic order as the primary rotation.
      for (const re of f.fairness) {
        expect(re.test(code), `${f.cron}: missing fairness-cursor proof ${re}`).toBe(true);
      }
      // (b) PASS BUDGET: a wall-clock budget constant and a clock-gated break.
      for (const re of f.budget) {
        expect(re.test(code), `${f.cron}: missing pass-budget proof ${re}`).toBe(true);
      }
      // (c) the pre-fix tick-stable shapes must be GONE.
      for (const re of f.forbid ?? []) {
        expect(re.test(code), `${f.cron}: a tick-stable order regressed — ${re} is present`).toBe(false);
      }
      // (d) where the cursor is a SQL order, it must be the PRIMARY sort (before any
      // unique tiebreak), not a tiebreak behind a tick-stable column.
      if (f.orderBefore) {
        const [primary, tiebreak] = f.orderBefore;
        const pIdx = code.search(primary);
        const tIdx = code.search(tiebreak);
        expect(pIdx, `${f.cron}: fairness order ${primary} not found`).toBeGreaterThan(-1);
        if (tIdx > -1) {
          expect(pIdx, `${f.cron}: the fairness cursor must precede the tiebreak`).toBeLessThan(tIdx);
        }
      }
    });
  }
});
