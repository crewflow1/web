import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve, relative, sep } from "node:path";

/**
 * Voice Receptionist AI — reply-safety ENFORCEMENT invariants
 * (the AI Receptionist Programme, R3 — canonical policy enforcement; employee #26, Tier-T3).
 *
 * R2 harvested the pure guardrail (`lib/receptionist/policy.ts`) and pinned that it is a
 * reconstructable arbiter. R3 makes it LOAD-BEARING: there is exactly ONE canonical
 * enforcement path — `enforceReceptionistReply` in `server/services/receptionist.ts` — and
 * EVERY AI-generated customer-facing reply (Voice, SMS, WhatsApp, Email, Customer Portal, any
 * future channel) must pass through it before it can proceed. No transport, adapter, service,
 * workflow, or future feature may bypass the policy; there is never a second enforcement path.
 *
 * This suite proves that CONTRACT as a matter of SOURCE, not discipline — the house bar of
 * tool-registry-describes-not-authorises.test.ts:
 *
 *   • SINGLE PATH — across all non-test source (app/, server/, lib/), the harvested policy's
 *     decision surface (`@/lib/receptionist/policy` / `evaluateReply` / `isAutoSendable` /
 *     `redactReply`) is reached by EXACTLY ONE module: the canonical receptionist service. No
 *     other file imports or calls it — so there is no alternative code path capable of bypass.
 *   • DELEGATES, NEVER DUPLICATES — the seam obtains its verdict by CALLING the harvested
 *     `evaluateReply`; it re-implements no rule and re-declares no vocabulary (do not duplicate,
 *     do not weaken the policy).
 *   • DENY BY DEFAULT, ENCODED IN SOURCE — the seam derives `allowed` from `isAutoSendable(…)`,
 *     never a hard-coded `true`: only a policy `allow` can clear.
 *   • SERVER-ONLY CHOKEPOINT — the enforcement seam is `server-only`, so no client bundle can
 *     call it to manufacture an `allowed` verdict and sidestep the server boundary.
 *   • SINGLE SOURCE OF TRUTH — the policy's definitions live in exactly one file repo-wide; the
 *     guardrail is nowhere copied.
 *
 * The seam's runtime deny-by-default behaviour (allow → allowed; review / block / empty → not)
 * is pinned in the unit tier (__tests__/receptionist/reply-enforcement.test.ts); the policy's own
 * runtime arbitration is pinned in receptionist-policy-invariants.test.ts. This tier is HERMETIC
 * — a filesystem scan over comment-stripped source — so the prose documenting the contract can
 * neither satisfy a positive match nor trip a negative one.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

/** Strip block + line comments so only executable source is matched. */
function codeOf(ts: string): string {
  return ts
    .replace(/\/\*[\s\S]*?\*\//g, "") // block comments
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1"); // line comments (keep `://` in URLs)
}

/** Every module specifier the source imports — `from "x"` and bare `import "x"`. */
function importSpecifiers(code: string): string[] {
  const specs: string[] = [];
  const fromRe = /\bfrom\s*["']([^"']+)["']/g;
  const bareRe = /\bimport\s+["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = fromRe.exec(code))) {
    if (m[1]) specs.push(m[1]);
  }
  while ((m = bareRe.exec(code))) {
    if (m[1]) specs.push(m[1]);
  }
  return specs;
}

/** Recursively collect every non-test .ts/.tsx source file under the given roots. */
function walkSources(roots: readonly string[]): string[] {
  const out: string[] = [];
  const visit = (dir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return; // a root that does not exist is simply skipped
    }
    for (const entry of entries) {
      const full = resolve(dir, entry);
      if (statSync(full).isDirectory()) {
        if (entry === "node_modules" || entry === ".next" || entry === "__tests__") continue;
        visit(full);
      } else if (/\.tsx?$/.test(entry)) {
        out.push(full);
      }
    }
  };
  for (const r of roots) visit(resolve(ROOT, r));
  return out;
}

/** A repo-relative, POSIX-style path for stable assertions across platforms. */
const rel = (full: string) => relative(ROOT, full).split(sep).join("/");

const SERVICE = "server/services/receptionist.ts";
const POLICY = "lib/receptionist/policy.ts";

/** The harvested policy's decision surface — the functions an enforcer would reach for. */
const DECISION_FNS = /\b(?:evaluateReply|isAutoSendable|redactReply)\b/;
const POLICY_SPEC = "@/lib/receptionist/policy";

const SOURCE_ROOTS = ["app", "server", "lib"] as const;

// =====================================================================
// 0. The single enforcement chokepoint ships in the canonical service.
// =====================================================================

describe("receptionist enforcement — the canonical reply gate ships", () => {
  it(`ships ${SERVICE}`, () => {
    expect(existsSync(resolve(ROOT, SERVICE)), SERVICE).toBe(true);
  });

  it("exports the enforcement seam and its decision type", () => {
    const code = codeOf(read(SERVICE));
    expect(code).toMatch(/export function enforceReceptionistReply\(/);
    expect(code).toMatch(/export type ReceptionistReplyDecision = \{/);
  });
});

// =====================================================================
// 1. THE LOAD-BEARING PROPERTY — exactly one enforcement path, no bypass.
// =====================================================================

describe("receptionist enforcement — exactly one path reaches the policy", () => {
  // Every non-test module whose EXECUTABLE source reaches the guardrail's decision
  // surface — by importing the policy module or by naming one of its decision functions.
  const reachers = walkSources(SOURCE_ROOTS)
    .filter((full) => rel(full) !== POLICY) // the policy DEFINES the surface; it is not a reacher
    .filter((full) => {
      const code = codeOf(read(rel(full)));
      return importSpecifiers(code).includes(POLICY_SPEC) || DECISION_FNS.test(code);
    })
    .map(rel)
    .sort();

  it("the ONLY module that reaches the harvested policy is the canonical service", () => {
    // If this list ever grows, a second enforcement path (or a bypass) has appeared.
    expect(reachers).toEqual([SERVICE]);
  });

  it("no app/ route, action, or component reaches the policy directly", () => {
    expect(reachers.filter((p) => p.startsWith("app/"))).toEqual([]);
  });

  it("no other server/ module reaches the policy directly", () => {
    expect(reachers.filter((p) => p !== SERVICE && p.startsWith("server/"))).toEqual([]);
  });
});

// =====================================================================
// 2. The seam DELEGATES to the harvested policy — it never re-implements it.
// =====================================================================

describe("receptionist enforcement — the seam delegates, it does not duplicate", () => {
  const code = codeOf(read(SERVICE));

  it("imports the harvested policy as the single source of truth", () => {
    expect(importSpecifiers(code)).toContain(POLICY_SPEC);
  });

  it("obtains its verdict by CALLING evaluateReply (reuse, not re-implementation)", () => {
    expect(code).toMatch(/\bevaluateReply\s*\(/);
  });

  it("re-declares no verdict vocabulary and inlines no guardrail rule", () => {
    // The seam may reference the policy's TYPES; it must not re-DEFINE its data or rules.
    expect(code).not.toMatch(/GUARDRAIL_VERDICTS\s*=/);
    expect(code).not.toMatch(/PROHIBITED_CATEGORIES\s*[:=]/);
    expect(code).not.toMatch(/COMMITMENT_CATEGORIES\s*[:=]/);
    expect(code).not.toMatch(/"allow"\s*,\s*"review"\s*,\s*"block"/);
  });
});

// =====================================================================
// 3. Deny-by-default is encoded in the source (not a hard-coded pass).
// =====================================================================

describe("receptionist enforcement — deny by default, in source", () => {
  const code = codeOf(read(SERVICE));

  it("derives `allowed` from isAutoSendable(…) — only a policy `allow` clears", () => {
    expect(code).toMatch(/allowed:\s*isAutoSendable\(/);
  });

  it("never hard-codes an affirmative send decision", () => {
    expect(code).not.toMatch(/allowed:\s*true/);
  });
});

// =====================================================================
// 4. The enforcement chokepoint is server-only (not client-reachable).
// =====================================================================

describe("receptionist enforcement — the chokepoint is server-only", () => {
  const code = codeOf(read(SERVICE));

  it("is a server-only module — no client bundle can manufacture an `allowed` verdict", () => {
    expect(importSpecifiers(code)).toContain("server-only");
  });
});

// =====================================================================
// 5. Single source of truth — the policy is defined once, nowhere copied.
// =====================================================================

describe("receptionist enforcement — the policy is defined exactly once", () => {
  const sources = walkSources(SOURCE_ROOTS).map((full) => ({
    path: rel(full),
    code: codeOf(read(rel(full))),
  }));

  const definersOf = (re: RegExp) => sources.filter((s) => re.test(s.code)).map((s) => s.path).sort();

  it("defines evaluateReply in exactly one file — the harvested policy", () => {
    expect(definersOf(/export function evaluateReply\(/)).toEqual([POLICY]);
  });

  it("defines isAutoSendable in exactly one file — the harvested policy", () => {
    expect(definersOf(/export function isAutoSendable\(/)).toEqual([POLICY]);
  });

  it("declares the verdict vocabulary in exactly one file — the harvested policy", () => {
    expect(definersOf(/GUARDRAIL_VERDICTS\s*=\s*\[/)).toEqual([POLICY]);
  });
});
