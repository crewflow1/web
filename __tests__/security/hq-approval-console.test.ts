import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, relative, resolve } from "node:path";

/**
 * CrewFlow HQ — Approval Console + executor-shadow observability trust boundary
 * (Train 11; closes the write-only approvals hole left after Directive 010 Phase 2).
 *
 * The Observe→Draft→Approve→Execute substrate was complete EXCEPT the human
 * decision surface: producers wrote hq_approvals rows, the service implemented
 * every transition, and nothing let a human decide (and nothing swept expiry, and
 * nothing read the executor-shadow evidence). Train 11 adds exactly the missing
 * READ/DECIDE surfaces — and this file pins that it added NOTHING else.
 *
 * The load-bearing facts, and what breaks if one silently flips:
 *   • Both pages gate on requireHqPage() — HQ permissions never mix with tenant
 *     auth. If a page dropped the call it would ride the layout alone, and a
 *     future layout refactor could expose the queue to tenants.
 *   • The decision actions are THIN: they call the service's transitions and
 *     touch NO table. The service (which re-gates on isSuperAdminEmail) plus the
 *     DB trigger are the one authority; a direct hq_approvals write in the UI
 *     tier would be a second, ungated authority.
 *   • Approval payloads are UNTRUSTED model output. They render as React-escaped
 *     text; dangerouslySetInnerHTML anywhere on these surfaces would let a
 *     proposal attack its reviewer.
 *   • The expiry sweep is Bearer-gated and registered in vercel.json — without
 *     the registration, pending rows would silently accumulate forever again.
 *   • The executor-shadow surface is READ-ONLY: the CEO's live-execution
 *     evidence base must never itself become an execution (or mutation) path.
 *
 * TS checks run over `code` (// + block comments stripped) so prose that
 * DOCUMENTS the contract can neither satisfy a positive match nor trip a
 * negative one; raw text is used only where the check is about markup.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

function codeOf(ts: string): string {
  return ts
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const APPROVALS_PAGE = "app/admin/approvals/page.tsx";
const APPROVALS_ACTIONS = "app/admin/approvals/actions.ts";
const SHADOW_PAGE = "app/admin/executor-shadow/page.tsx";
const SHADOW_READ_SERVICE = "server/services/executor-shadow-observations.ts";
const APPROVALS_SERVICE = "server/services/hq-approvals.ts";
const CRON_ROUTE = "app/api/cron/approvals-expire/route.ts";
const LAYOUT = "app/admin/layout.tsx";

// =====================================================================
// 1. Both pages are superadmin-gated with the EXACT HQ gate call.
// =====================================================================

describe("approval console — both pages gate on requireHqPage (HQ-only, never tenant auth)", () => {
  for (const page of [APPROVALS_PAGE, SHADOW_PAGE]) {
    const code = codeOf(read(page));

    it(`${page} imports the single HQ gate and CALLS it`, () => {
      expect(code).toMatch(/import\s*\{\s*requireHqPage\s*\}\s*from\s*"@\/server\/auth\/hq"/);
      expect(code).toMatch(/await\s+requireHqPage\(\)/);
    });

    it(`${page} never reaches for tenant auth (no org/membership scoping on an HQ surface)`, () => {
      expect(code).not.toMatch(/getActiveOrg|requireOrg|memberships/);
    });
  }
});

// =====================================================================
// 2. The decision actions are THIN wrappers over the service — the one authority.
// =====================================================================

describe("approval console — actions wrap the service transitions and touch no table", () => {
  const raw = read(APPROVALS_ACTIONS);
  const code = codeOf(raw);

  it("is a server-action module", () => {
    expect(raw).toMatch(/^"use server";/m);
  });

  it("re-checks the allowlist before every decision (defence in depth, boardroom-style)", () => {
    expect(code).toMatch(/requireUser\(\)/);
    expect(code).toMatch(/isSuperAdminEmail/);
    expect(code).toMatch(/redirect\(/);
  });

  it("calls the service's transitions — approve, reject, escalate, edit — and nothing else moves state", () => {
    expect(code).toMatch(/approveApproval\(\{/);
    expect(code).toMatch(/rejectApproval\(\{/);
    expect(code).toMatch(/escalateApproval\(\{/);
    expect(code).toMatch(/editApproval\(\{/);
    expect(code).toMatch(
      /from\s*"@\/server\/services\/hq-approvals"/,
    );
  });

  it("contains NO direct database access — no admin client, no .from(, no .rpc(", () => {
    expect(code).not.toMatch(/createAdminClient/);
    expect(code).not.toMatch(/\.from\s*\(/);
    expect(code).not.toMatch(/\.rpc\s*\(/);
  });

  it("validates the edited payload through the strict JSON-object helper before it reaches the service", () => {
    expect(code).toMatch(/parseEditedPayloadJson/);
    expect(code).toMatch(/z\.string\(\)\.uuid\(\)/);
  });

  it("a rejection carries a non-empty reason (the service enforces it again)", () => {
    expect(code).toMatch(/reason:\s*z\.string\(\)\.trim\(\)\.min\(1\)/);
  });
});

// =====================================================================
// 3. Single-writer authority: .from("hq_approvals") exists NOWHERE outside the service.
// =====================================================================

describe("approval console — the service is the ONLY module that touches hq_approvals", () => {
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

  it('every .from("hq_approvals") in app/, server/, lib/ lives in the service file', () => {
    const offenders: string[] = [];
    for (const dir of ["app", "server", "lib"]) {
      for (const file of walk(resolve(ROOT, dir))) {
        const rel = relative(ROOT, file);
        if (rel === APPROVALS_SERVICE) continue;
        // Raw scan on purpose: even a commented-out direct write is a loaded gun.
        if (readFileSync(file, "utf8").includes('from("hq_approvals')) {
          offenders.push(rel);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the service itself still reaches the table through the one accessor", () => {
    const code = codeOf(read(APPROVALS_SERVICE));
    expect(code).toMatch(/from\("hq_approvals"\s+as\s+never\)/);
  });
});

// =====================================================================
// 4. Payloads render as TEXT — never interpreted, never HTML.
// =====================================================================

describe("approval console — untrusted payloads render inert on every Train-11 surface", () => {
  for (const page of [APPROVALS_PAGE, SHADOW_PAGE]) {
    it(`${page} never uses dangerouslySetInnerHTML`, () => {
      // Comment-stripped: the prose that DOCUMENTS the rule names the token.
      expect(codeOf(read(page))).not.toMatch(/dangerouslySetInnerHTML/);
    });
  }

  it("the approvals page displays payloads through the plain-text formatter inside <pre>", () => {
    const raw = read(APPROVALS_PAGE);
    expect(raw).toMatch(/formatPayloadForDisplay\(/);
    expect(raw).toMatch(/<pre[^>]*>\s*\{formatPayloadForDisplay/);
  });

  it("the shadow page shows the detail payload as escaped text inside <pre>", () => {
    expect(read(SHADOW_PAGE)).toMatch(/<pre[^>]*>\s*\{o\.detail\}/);
  });
});

// =====================================================================
// 5. The expiry cron: Bearer-gated, wraps the primitive, registered in vercel.json.
// =====================================================================

describe("approvals-expire cron — secret-gated sweep over the existing primitive", () => {
  const code = codeOf(read(CRON_ROUTE));

  it("requires the cron secret and answers 401 otherwise", () => {
    expect(code).toMatch(/isCronAuthorised\(request\)/);
    expect(code).toMatch(/status:\s*401/);
  });

  it("drives the service primitive — no inline expiry logic, no table access", () => {
    expect(code).toMatch(/expireDueApprovals\(/);
    expect(code).not.toMatch(/\.from\s*\(/);
    expect(code).not.toMatch(/\.rpc\s*\(/);
  });

  it("bounds its work per invocation", () => {
    expect(code).toMatch(/Math\.min\(limitRaw,\s*200\)/);
  });

  it("vercel.json registers the sweep on a schedule", () => {
    const vercel = JSON.parse(read("vercel.json")) as {
      crons: Array<{ path: string; schedule: string }>;
    };
    const entry = vercel.crons.find((c) => c.path === "/api/cron/approvals-expire");
    expect(entry).toBeDefined();
    expect(entry?.schedule).toBe("*/15 * * * *");
  });
});

// =====================================================================
// 6. Executor-shadow observability is READ-ONLY — evidence, never a mutation path.
// =====================================================================

describe("executor-shadow page — strictly read-only observability", () => {
  const raw = read(SHADOW_PAGE);
  const code = codeOf(raw);

  it("carries no actions: no server-action module, no forms, no action= handlers", () => {
    expect(raw).not.toMatch(/"use server"/);
    expect(raw).not.toMatch(/<form/i);
    expect(raw).not.toMatch(/action=\{/);
    expect(existsSync(resolve(ROOT, "app/admin/executor-shadow/actions.ts"))).toBe(false);
  });

  it("reads through the read service only — no admin client in the page", () => {
    expect(code).toMatch(/getExecutorShadowFeed/);
    expect(code).not.toMatch(/createAdminClient/);
  });
});

describe("executor-shadow read service — SELECT-only over the append-only store", () => {
  const code = codeOf(read(SHADOW_READ_SERVICE));

  it("issues nothing but selects — no insert/update/delete/upsert and no write RPC", () => {
    expect(code).toMatch(/\.select\(/);
    expect(code).not.toMatch(/\.insert\s*\(/);
    expect(code).not.toMatch(/\.update\s*\(/);
    expect(code).not.toMatch(/\.delete\s*\(/);
    expect(code).not.toMatch(/\.upsert\s*\(/);
    expect(code).not.toMatch(/\.rpc\s*\(/);
    expect(code).not.toMatch(/hq_record_executor_shadow/);
  });

  it("reads LOUDLY — a failed select throws via readFailure, never degrades to []", () => {
    expect(code).toMatch(/import\s*\{\s*readFailure\s*\}\s*from\s*"@\/lib\/supabase\/read-failure"/);
    expect(code).toMatch(/throw readFailure\("executor-shadow: observations"/);
    expect(code).toMatch(/throw readFailure\("executor-shadow: task meta"/);
    expect(code).toMatch(/throw readFailure\("executor-shadow: employee meta"/);
  });

  it("is server-only and never touches the executor itself (observability, not execution)", () => {
    expect(code).toMatch(/import\s+"server-only"/);
    expect(code).not.toMatch(/executor\.apply|executor\.execute|Executor\b/);
  });
});

// =====================================================================
// 7. The history read model + nav wiring shipped with the console.
// =====================================================================

describe("approval console — history read model and nav registration", () => {
  it("the service's decided read selects TERMINAL states only (an archive, not a queue)", () => {
    const code = codeOf(read(APPROVALS_SERVICE));
    expect(code).toMatch(
      /listDecidedApprovals[\s\S]{0,400}\.in\("state",\s*TERMINAL_STATES/,
    );
  });

  it("both pages are registered in the HQ nav", () => {
    const layout = read(LAYOUT);
    expect(read("app/admin/_nav/hq-nav-model.ts")).toMatch(/href:\s*"\/admin\/approvals"/);
    expect(read("app/admin/_nav/hq-nav-model.ts")).toMatch(/href:\s*"\/admin\/executor-shadow"/);
  });
});
