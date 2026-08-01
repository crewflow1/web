import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

/**
 * CrewFlow HQ — Decision Centre security source-contracts (Master-Plan Phase 16 +
 * the HQ Layer-5 gap: the approval engine only did approve/reject/escalate — Delay
 * and Delegate, and a rich-proposal decision model, were missing).
 *
 * The runtime behaviour is proven against real Postgres in
 * __tests__/integration/decisions; these pin the load-bearing rules at the source so
 * a regression fails CI. The Decision Centre reuses the hq_approvals architecture:
 * RLS:hq (enabled, zero policies → service-role only), a DB-enforced state machine no
 * caller can bypass, and an append-only immutable history.
 *
 * TS checks run over `code` (comments stripped) so prose that DOCUMENTS the contract
 * can neither satisfy a positive match nor trip a negative one; the migration checks
 * run over `exec` (SQL line-comments stripped) for the same reason.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

function codeOf(ts: string): string {
  return ts.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}
function execOf(sql: string): string {
  return sql
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("--");
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join("\n");
}

const MIGRATION = "supabase/migrations/20261091000000_hq_decisions.sql";
const SERVICE = "server/services/hq-decisions.ts";
const LIST_PAGE = "app/admin/decisions/page.tsx";
const DETAIL_PAGE = "app/admin/decisions/[id]/page.tsx";
const ACTIONS = "app/admin/decisions/actions.ts";
const LAYOUT = "app/admin/layout.tsx";

const mig = read(MIGRATION);
const exec = execOf(mig);

// =====================================================================
// 1. RLS:hq — enabled, ZERO policies (service-role only), on BOTH tables.
// =====================================================================

describe("decisions migration — RLS enabled with NO policies (service-role/HQ-only)", () => {
  it("enables RLS on hq_decisions and hq_decision_events", () => {
    expect(exec).toMatch(/alter table public\.hq_decisions\s+enable row level security/);
    expect(exec).toMatch(/alter table public\.hq_decision_events\s+enable row level security/);
  });

  it("creates NO policy of any kind — the HQ tables are reached only via service-role", () => {
    expect(exec).not.toMatch(/create policy/i);
    // and no GRANT hands table rights to a JWT role.
    expect(exec).not.toMatch(/grant\s+(select|insert|update|delete|all)\s+on\s+(table\s+)?public\.hq_decision/i);
  });
});

// =====================================================================
// 2. The state machine + invariants are DB-enforced (unbypassable by any caller).
// =====================================================================

describe("decisions migration — the transition guard is the unbypassable enforcer", () => {
  it("has a BEFORE insert/update guard trigger", () => {
    expect(exec).toMatch(/create or replace function public\.hq_decisions_guard\(\)/);
    expect(exec).toMatch(/before insert on public\.hq_decisions/);
    expect(exec).toMatch(/before update on public\.hq_decisions/);
  });

  it("forces a decision to be BORN proposed", () => {
    expect(exec).toMatch(/a new decision must start proposed/);
  });

  it("makes decided decisions terminal + immutable — a terminal decision cannot be re-decided", () => {
    // The terminal-status guard and its raise both live in the UPDATE branch.
    expect(exec).toMatch(
      /old\.status in \('approved','rejected','delayed','delegated'\)[\s\S]{0,1200}terminal and immutable/,
    );
    // …with EXACTLY ONE carve-out: the FK `on delete set null` path (GDPR erasure),
    // proven frozen-otherwise by a whole-row jsonb equality excluding only the two FK
    // columns. This pins that the immutability exception is narrow, not a general edit.
    expect(exec).toMatch(/to_jsonb\(new\)[\s\S]{0,120}to_jsonb\(old\)/);
    expect(exec).toMatch(/on delete set null/);
  });

  it("permits ONLY proposed → {approved,rejected,delayed,delegated} (and a same-status edit)", () => {
    expect(exec).toMatch(
      /old\.status = 'proposed' and new\.status in \('approved','rejected','delayed','delegated'\)/,
    );
    expect(exec).toMatch(/illegal transition/);
  });

  it("enforces the decision invariants each outcome needs", () => {
    expect(exec).toMatch(/requires a decider/);
    expect(exec).toMatch(/requires a reason/);
    expect(exec).toMatch(/a delay requires delay_until/);
    expect(exec).toMatch(/a delegation requires delegate_to/);
  });

  it("keeps provenance write-once (created_by / created_at can never be rewritten)", () => {
    expect(exec).toMatch(/created_by \/ created_at are write-once/);
  });

  it("the status CHECK admits exactly the five states", () => {
    expect(exec).toMatch(
      /check \(status in \('proposed','approved','rejected','delayed','delegated'\)\)/,
    );
  });
});

// =====================================================================
// 3. The decision history is append-only + immutable.
// =====================================================================

describe("decisions migration — hq_decision_events is append-only and immutable", () => {
  it("blocks UPDATE and DELETE even under service-role", () => {
    expect(exec).toMatch(/create or replace function public\.hq_decision_events_block_mutation\(\)/);
    expect(exec).toMatch(/hq_decision_events is append-only/);
    expect(exec).toMatch(/before update on public\.hq_decision_events/);
    expect(exec).toMatch(/before delete on public\.hq_decision_events/);
  });

  it("appends one history row per transition via an AFTER trigger (transactional outbox)", () => {
    expect(exec).toMatch(/create or replace function public\.hq_decisions_emit\(\)/);
    expect(exec).toMatch(/after insert on public\.hq_decisions/);
    expect(exec).toMatch(/after update on public\.hq_decisions/);
    expect(exec).toMatch(/insert into public\.hq_decision_events/);
  });

  it("the emitter is SECURITY DEFINER with a pinned empty search_path", () => {
    expect(exec).toMatch(/create or replace function public\.hq_decisions_emit\(\)[\s\S]{0,160}security definer/);
    expect(exec).toMatch(/set search_path = ''/);
  });
});

// =====================================================================
// 4. Both pages gate on requireHqPage (HQ-only, never tenant auth).
// =====================================================================

describe("decision centre — both pages gate on the single HQ gate", () => {
  for (const page of [LIST_PAGE, DETAIL_PAGE]) {
    const code = codeOf(read(page));
    it(`${page} imports requireHqPage and CALLS it`, () => {
      expect(code).toMatch(/import\s*\{[^}]*requireHqPage[^}]*\}\s*from\s*"@\/server\/auth\/hq"/);
      expect(code).toMatch(/await\s+requireHqPage\(\)/);
    });
    it(`${page} never reaches for tenant auth (no org/membership scoping)`, () => {
      expect(code).not.toMatch(/getActiveOrg|requireOrg|memberships/);
    });
  }
});

// =====================================================================
// 5. The actions are THIN wrappers, super-admin re-gated, touching no table.
// =====================================================================

describe("decision centre — actions wrap the service and re-gate super-admin", () => {
  const raw = read(ACTIONS);
  const code = codeOf(raw);

  it("is a server-action module", () => {
    expect(raw).toMatch(/^"use server";/m);
  });

  it("re-checks the allowlist before every mutation (defence in depth)", () => {
    expect(code).toMatch(/requireUser\(\)/);
    expect(code).toMatch(/isSuperAdminEmail/);
    expect(code).toMatch(/redirect\(/);
  });

  it("drives the service's create + decide entry points and nothing else moves state", () => {
    expect(code).toMatch(/createDecision\(/);
    expect(code).toMatch(/decide\(/);
    expect(code).toMatch(/from\s*"@\/server\/services\/hq-decisions"/);
  });

  it("contains NO direct database access — no admin client, no .from(, no .rpc(", () => {
    expect(code).not.toMatch(/createAdminClient/);
    expect(code).not.toMatch(/\.from\s*\(/);
    expect(code).not.toMatch(/\.rpc\s*\(/);
  });

  it("validates the decision id as a uuid and constrains the outcome to the four verbs", () => {
    expect(code).toMatch(/z\.string\(\)\.uuid\(\)/);
    expect(code).toMatch(/z\.enum\(\["approve",\s*"reject",\s*"delay",\s*"delegate"\]\)/);
  });
});

// =====================================================================
// 6. Single-writer authority: hq_decisions is touched ONLY by its service.
// =====================================================================

describe("decision centre — the service is the ONLY module that touches the tables", () => {
  function walk(dir: string, acc: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) {
        if (name === "node_modules" || name.startsWith(".")) continue;
        walk(p, acc);
      } else if (/\.(ts|tsx)$/.test(name)) {
        acc.push(p);
      }
    }
    return acc;
  }

  it('every .from("hq_decision...") in app/, server/, lib/ lives in the service file', () => {
    const offenders: string[] = [];
    for (const dir of ["app", "server", "lib"]) {
      for (const file of walk(resolve(ROOT, dir))) {
        const rel = relative(ROOT, file);
        if (rel === SERVICE) continue;
        if (readFileSync(file, "utf8").includes('from("hq_decision')) {
          offenders.push(rel);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the service re-gates every mutation on isSuperAdminEmail (human-gated, super-admin only)", () => {
    const code = codeOf(read(SERVICE));
    expect(code).toMatch(/isSuperAdminEmail/);
    expect(code).toMatch(/deciderGate/);
    expect(code).toMatch(/export async function createDecision\(/);
    expect(code).toMatch(/export async function decide\(/);
    expect(code).toMatch(/export async function listDecisions\(/);
  });
});

// =====================================================================
// 7. ai_debate is untrusted — rendered inert, never HTML.
// =====================================================================

describe("decision centre — ai_debate + reasons render inert (never interpreted)", () => {
  for (const page of [LIST_PAGE, DETAIL_PAGE]) {
    it(`${page} never uses dangerouslySetInnerHTML`, () => {
      expect(codeOf(read(page))).not.toMatch(/dangerouslySetInnerHTML/);
    });
  }
  it("the detail page carries the AI-debate empty state and renders entries inside <pre>", () => {
    const raw = read(DETAIL_PAGE);
    expect(raw).toMatch(/AI debate populates once a model tier is bound/);
    expect(raw).toMatch(/<pre[^>]*>\s*\{JSON\.stringify\(entry/);
  });
});

// =====================================================================
// 8. Nav registration.
// =====================================================================

describe("decision centre — registered in the HQ nav", () => {
  it("the layout links to /admin/decisions", () => {
    expect(read(LAYOUT)).toMatch(/href:\s*"\/admin\/decisions"/);
  });
});
