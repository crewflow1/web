import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * CrewFlow HQ — the apply-on-approval runtime, trust-boundary invariants proven from SOURCE
 * (CEO Directive #014 / D-04, Phase C, C3 rollout; ADR 0009 Decisions 5, 6, 9).
 *
 * The runtime completes the approve → act loop. Its whole safety posture must be a matter of source,
 * not discipline: default-DARK, approved-only, apply-once, and never a bare tenant write. Each pin
 * below states one of those guarantees and what silently breaks if it flips.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");
/** Strip block + line comments so prose can neither satisfy nor trip a pin. */
const codeOf = (ts: string) => ts.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

const DRAIN = "server/services/hq-apply-drain.ts";
const STORE = "server/services/hq-application.ts";
const ROUTE = "app/api/cron/hq-apply-drain/route.ts";
const MIGRATION = "supabase/migrations/20261106000000_hq_application_records.sql";

const drain = codeOf(read(DRAIN));
const store = codeOf(read(STORE));
const route = codeOf(read(ROUTE));
const migration = read(MIGRATION);
/** SQL DDL with `--` comments stripped, so migration prose can't satisfy or trip a pin. */
const migrationCode = migration.replace(/--[^\n]*/g, "");

describe("the kill-switch is default-OFF (dark)", () => {
  it("the switch reads the exact literal 'on' and nothing else", () => {
    // === "on" — not >, not truthy, not "true". A typo or a truthy default would go live silently.
    expect(drain).toMatch(/CREWFLOW_HQ_APPLY_ON_APPROVAL\s*===\s*"on"/);
    // The check is the FIRST thing the drain does — it short-circuits before any read or apply.
    const idxSwitch = drain.indexOf("if (!hqApplyOnApprovalEnabled(");
    const idxRead = drain.indexOf("readApproved(");
    expect(idxSwitch).toBeGreaterThan(-1);
    expect(idxRead).toBeGreaterThan(-1);
    expect(idxSwitch, "the kill-switch must be checked before anything is read").toBeLessThan(idxRead);
  });

  it("when disabled the drain returns enabled:false and touches nothing", () => {
    // The disabled branch returns a zeroed summary; the store/authority defaults are constructed
    // only AFTER the switch passes (below the early return), so a dark run does no I/O.
    expect(drain).toMatch(/enabled:\s*false/);
    const idxReturn = drain.indexOf("enabled: false");
    const idxStore = drain.indexOf("createDurableApplicationStore()");
    expect(idxStore).toBeGreaterThan(idxReturn); // the durable store is built only past the gate
  });
});

describe("the sweep applies ONLY approved items", () => {
  it("reads approved items THROUGH the sanctioned service accessors, never a raw table read", () => {
    // The drain reads approvals + decisions only through their single-writer services, and only the
    // approved reader — never a direct hq_approvals / hq_decisions table access (the encapsulation
    // ratchets), and never a pending/rejected/etc. reader.
    expect(drain).toMatch(/listApprovedApprovals\(/);
    expect(drain).toMatch(/listDecisions\(\{\s*status:\s*"approved"/);
    expect(drain).not.toMatch(/\.from\(\s*"hq_approvals/);
    expect(drain).not.toMatch(/\.from\(\s*"hq_decision/);
    expect(drain).not.toMatch(/listPendingApprovals|listDecidedApprovals/);
  });
});

describe("apply-once — the durable idempotency ground truth", () => {
  it("the sweep applies through applyOnce (never a bare apply)", () => {
    expect(drain).toMatch(/\bapplyOnce\s*\(/);
  });
  it("the store is append-only + latest-wins, and NOT best-effort (it throws on a hard fault)", () => {
    // get reads the latest row by id desc; put throws on error (a lost put would let a re-apply).
    expect(store).toMatch(/\.order\(\s*"id",\s*\{\s*ascending:\s*false\s*\}\s*\)/);
    expect(store).toMatch(/throw new Error\(`hq-application: put/);
    expect(store).toMatch(/throw new Error\(`hq-application: get/);
  });
  it("a PARTIAL unique index enforces at most one 'applied' row per key (attempts stay append-only history)", () => {
    // The exactly-once guard: at most one `applied` marker per key, so two concurrent drains can never
    // both file `applied` (the loser is refused with 23505 and reconciled to already_applied).
    expect(migrationCode).toMatch(/create unique index[\s\S]*?\(key\)\s*where status = 'applied'/i);
    // It MUST stay partial — an UNQUALIFIED unique on `(key)` would forbid the append-only failed /
    // escalated attempt history. (Any `unique ... (key)` must carry a WHERE before its `;`.)
    expect(migrationCode).not.toMatch(/unique[^;]*\(key\)(?![^;]*where)/i);
    // UPDATE/DELETE are blocked even under service-role.
    expect(migrationCode).toMatch(/before update on public\.hq_application_records/);
    expect(migrationCode).toMatch(/before delete on public\.hq_application_records/);
    expect(migrationCode).toMatch(/is append-only/);
  });
});

describe("no bare tenant write — the only effect is the injected sanctioned authority", () => {
  it("the drain never touches a tenant table or a raw write; the authority is the sole effect", () => {
    // The drain reads only HQ tables + records markers. It performs no direct table insert/update
    // and constructs no raw SQL — the single boundary crossing is authority.resolve(item)().
    expect(drain).toMatch(/authority\.resolve\(/);
    // No tenant-domain service imports (the sweep is HQ-only).
    expect(drain).not.toMatch(/from\s+"@\/server\/services\/(jobs|invoices|quotes|customers|stock|expenses)/);
    // The drain does not itself insert/update rows — it reads (select/eq) and delegates writes to
    // the injected store's applyOnce. No `.insert(` / `.update(` / raw `.rpc(` in the drain.
    expect(drain).not.toMatch(/\.insert\s*\(/);
    expect(drain).not.toMatch(/\.update\s*\(/);
  });
  it("the production authority is UNBOUND — every item resolves to null until the CEO cut-over", () => {
    expect(drain).toMatch(/createUnboundApplyAuthority/);
    expect(drain).toMatch(/resolve:\s*\(\)\s*=>\s*null/);
    // The route wires production deps with no authority override (defaults to unbound/dark).
    expect(route).toMatch(/runApplyOnApprovalDrain\(\)/);
  });
});

describe("the cron route is CRON_SECRET-gated and telemetry-wrapped", () => {
  it("refuses without a valid Bearer CRON_SECRET and wraps the run in telemetry", () => {
    expect(route).toMatch(/isCronAuthorised\(request\)/);
    expect(route).toMatch(/status:\s*401/);
    expect(route).toMatch(/withCronTelemetry\(\s*"hq-apply-drain"/);
    // The 401 guard is the first thing the handler does (compare the call sites, not the imports).
    const idxAuth = route.indexOf("isCronAuthorised(request)");
    const idxRun = route.indexOf("runApplyOnApprovalDrain()");
    expect(idxAuth).toBeGreaterThan(-1);
    expect(idxRun).toBeGreaterThan(-1);
    expect(idxAuth).toBeLessThan(idxRun);
  });
});

describe("HQ-global scoping + service-role-only writer (consistent with other hq_* tables)", () => {
  it("RLS enabled with zero policies; the write RPC is SECURITY DEFINER, service_role-only", () => {
    expect(migrationCode).toMatch(/alter table public\.hq_application_records enable row level security/);
    expect(migrationCode).not.toMatch(/create policy/i);
    expect(migrationCode).toMatch(/security definer/i);
    expect(migrationCode).toMatch(/revoke all on function public\.hq_record_application[\s\S]*from public, anon, authenticated/);
    expect(migrationCode).toMatch(/grant execute on function public\.hq_record_application[\s\S]*to service_role/);
  });
  it("introduces NO new AI governor tier key (this train adds no inference call site)", () => {
    for (const src of [drain, store, route]) {
      expect(src).not.toMatch(/invokeWithGovernor|isTierActivated|ANTHROPIC_API_KEY|OPENAI_API_KEY|isAiConfigured/);
    }
  });
});
