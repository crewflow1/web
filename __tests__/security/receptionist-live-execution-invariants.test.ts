import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, relative, sep } from "node:path";

/**
 * Voice Receptionist AI — CONTROLLED LIVE EXECUTION enforcement invariants
 * (the AI Receptionist Programme, R6 — controlled live execution).
 *
 * R5 built the ONE outbound pipeline (Compose → Enforce → Audit → Transport) and proved
 * it, but left it a callable primitive — nothing triggered it from a real inbound event.
 * R6 arms exactly ONE real customer-facing behaviour, the missed-call SMS text-back,
 * behind a feature flag that DEFAULTS OFF, wired into the existing inbound processor. The
 * directive's law is absolute: "No new execution path may be introduced. The live path
 * must reuse the existing canonical pipeline." This suite proves that law as a matter of
 * SOURCE, not discipline (the house bar of receptionist-transport-invariants.test.ts):
 *
 *   • DEFAULT OFF, IN THE SCHEMA — the flag is `z.enum(["true","false"]).default("false")`,
 *     so a deploy that sets nothing sends nothing.
 *   • FLAG-GATED, PHONE-ONLY, NEVER-THROW — the wiring checks the runtime gate FIRST and
 *     the channel (missed-call `phone`) SECOND, both before any dispatch is considered,
 *     and wraps the whole delegation in try/catch so an outbound failure can never
 *     corrupt inbound ingestion.
 *   • NO NEW DOOR TO A PROVIDER — the live send REUSES `dispatchReceptionistReply`
 *     verbatim; across the whole service the provider factory (`getSmsProvider`) and the
 *     vendor send (`provider.send`) are each still named EXACTLY ONCE, inside the one
 *     gated transport helper. The wiring added neither.
 *   • THE LIVE SEND IS CAPTIVE — `dispatchReceptionistReply` and the wiring
 *     `maybeTextBackMissedCall` are named by EXACTLY ONE module, the canonical service.
 *     No route, action, or component can arm live execution or reach the pipeline around
 *     `processInboundEnquiry`.
 *   • DELIVERY CONFIRMATION IS ADDITIVE + CORRELATED — the provider surfaces its
 *     synchronous acceptance status, which the sent transport records (`provider_status`)
 *     against the same message id; no new ingress surface is introduced.
 *
 * The OFF/ON runtime behaviour (zero SMS off; one audit + one transport on; the complete
 * inbound → audit → transport chain; no duplicate on a replayed missed call) is pinned
 * against real Postgres in __tests__/integration/receptionist/live-execution-pipeline.test.ts.
 * This tier is HERMETIC — a filesystem scan over comment-stripped source — so the prose
 * documenting the contract can neither satisfy a positive match nor trip a negative.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

/** Strip block + line comments so only executable TS source is matched. */
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
const ENV = "lib/env.ts";
const ROUTE = "app/api/receptionist/inbound/route.ts";
const TWILIO_PROVIDER = "lib/comms/providers/twilio.ts";
const COMMS_TYPES = "lib/comms/types.ts";

const FLAG = "NEXT_PUBLIC_FEATURE_MISSED_CALL_TEXTBACK";
const SOURCE_ROOTS = ["app", "server", "lib"] as const;

/** The live dispatch — the SAME callable primitive R5 shipped; the only door to a send. */
const LIVE_DISPATCH = /\bdispatchReceptionistReply\b/;
/** The R6 wiring that arms a missed-call text-back. */
const WIRING = /\bmaybeTextBackMissedCall\b/;

// =====================================================================
// 0. The live path ships — a flag gate, the wiring, and its call site.
// =====================================================================

describe("receptionist live execution — the flag-gated live path ships", () => {
  const code = codeOf(read(SERVICE));

  it("exports the runtime gate isMissedCallTextbackLive, reading the missed-call flag", () => {
    expect(code).toMatch(/export function isMissedCallTextbackLive\(/);
    expect(code).toMatch(new RegExp(`process\\.env\\.${FLAG}\\s*===\\s*["']true["']`));
  });

  it("processInboundEnquiry (the one inbound entry point) invokes the wiring", () => {
    expect(code).toMatch(
      /export async function processInboundEnquiry\([\s\S]*?maybeTextBackMissedCall\(/,
    );
  });

  it("surfaces the text-back outcome on the inbound result type", () => {
    expect(code).toMatch(/textback:\s*MissedCallTextbackResult/);
  });
});

// =====================================================================
// 1. DEFAULT OFF — the flag is off unless a deploy explicitly sets "true".
// =====================================================================

describe("receptionist live execution — the flag defaults OFF in the env schema", () => {
  it("declares NEXT_PUBLIC_FEATURE_MISSED_CALL_TEXTBACK as enum(true|false).default(false)", () => {
    const code = codeOf(read(ENV));
    expect(code).toMatch(
      new RegExp(`${FLAG}:\\s*z\\.enum\\(\\[["']true["'],\\s*["']false["']\\]\\)\\.default\\(["']false["']\\)`),
    );
  });
});

// =====================================================================
// 2. FLAG-GATED, PHONE-ONLY, NEVER-THROW — the wiring's shape, in source.
// =====================================================================

describe("receptionist live execution — the wiring is gated, phone-only and never-throw", () => {
  const code = codeOf(read(SERVICE));

  // NOTE (R15): the live wiring no longer calls `dispatchReceptionistReply` directly — it delegates
  // to the single orchestration layer `runConversationTurn`, which performs GENERATE → POLICY →
  // AUDIT → ROUTE via that same canonical dispatch. So each gate below is faithfully re-anchored to
  // `runConversationTurn(` (the thing that now dispatches). The intent is unchanged: the send is
  // flag-gated, phone-only, and wrapped so an outbound failure never breaks ingestion.
  it("checks the live-execution flag BEFORE it would ever dispatch", () => {
    expect(code).toMatch(
      /async function maybeTextBackMissedCall\([\s\S]*?isMissedCallTextbackLive\(\)[\s\S]*?runConversationTurn\(/,
    );
  });

  it("activates ONLY the missed-call (phone) channel — every other channel is inert", () => {
    expect(code).toMatch(
      /async function maybeTextBackMissedCall\([\s\S]*?channel\s*!==\s*["']phone["'][\s\S]*?runConversationTurn\(/,
    );
  });

  it("wraps the dispatch in try/catch so an outbound failure NEVER breaks ingestion", () => {
    expect(code).toMatch(
      /async function maybeTextBackMissedCall\([\s\S]*?try\s*\{[\s\S]*?runConversationTurn\([\s\S]*?\}\s*catch/,
    );
  });
});

// =====================================================================
// 3. NO NEW DOOR — the live send reuses the canonical dispatch; the wiring
//    adds neither a provider factory call nor a vendor send.
// =====================================================================

describe("receptionist live execution — the live path introduces no new execution path", () => {
  const code = codeOf(read(SERVICE));

  it("reaches a provider factory in EXACTLY ONE place — unchanged by the wiring", () => {
    expect((code.match(/getSmsProvider\s*\(/g) ?? []).length).toBe(1);
  });

  it("reaches a vendor send in EXACTLY ONE place — unchanged by the wiring", () => {
    expect((code.match(/provider\.send\s*\(/g) ?? []).length).toBe(1);
  });

  it("the service still does not import a vendor SDK — the provider factory stays captive", () => {
    const specs = importSpecifiers(code);
    expect(specs).not.toContain("twilio");
    expect(specs.some((s) => /providers\/twilio$/.test(s))).toBe(false);
  });
});

// =====================================================================
// 4. CAPTIVE — the live send and its wiring are named by exactly one module.
// =====================================================================

describe("receptionist live execution — the live send is captive to the canonical service", () => {
  const dispatchReachers = walkSources(SOURCE_ROOTS)
    .filter((full) => LIVE_DISPATCH.test(codeOf(read(rel(full)))))
    .map(rel)
    .sort();
  const wiringReachers = walkSources(SOURCE_ROOTS)
    .filter((full) => WIRING.test(codeOf(read(rel(full)))))
    .map(rel)
    .sort();

  it("dispatchReceptionistReply is named by EXACTLY ONE module — the canonical service", () => {
    // If this list ever grows, a second surface can arm the live send directly.
    expect(dispatchReachers).toEqual([SERVICE]);
  });

  it("the wiring maybeTextBackMissedCall lives ONLY in the canonical service", () => {
    expect(wiringReachers).toEqual([SERVICE]);
  });

  it("no app/ route, action, or component arms live execution directly", () => {
    expect(dispatchReachers.filter((p) => p.startsWith("app/"))).toEqual([]);
    expect(wiringReachers.filter((p) => p.startsWith("app/"))).toEqual([]);
  });

  it("the inbound route reaches the pipeline ONLY through processInboundEnquiry", () => {
    // The one public ingress calls the processor and nothing lower — no dispatch, no
    // provider, no transport write around it.
    const route = codeOf(read(ROUTE));
    expect(route).toMatch(/processInboundEnquiry\(/);
    expect(route).not.toMatch(LIVE_DISPATCH);
    expect(route).not.toMatch(/getSmsProvider\s*\(/);
    expect(route).not.toMatch(/record_ai_reply_transport/);
  });
});

// =====================================================================
// 5. DELIVERY CONFIRMATION — additive, and correlated by the message id.
// =====================================================================

describe("receptionist live execution — delivery confirmation is additive and correlated", () => {
  it("the SMS acceptance carries an optional synchronous provider status", () => {
    const code = codeOf(read(COMMS_TYPES));
    expect(code).toMatch(/export type SmsAcceptance\s*=\s*\{[\s\S]*?status\?:/);
  });

  it("the Twilio adapter surfaces the provider's synchronous status alongside the message id", () => {
    const code = codeOf(read(TWILIO_PROVIDER));
    expect(code).toMatch(/providerMessageId:\s*res\.sid,\s*status:\s*res\.status/);
  });

  it("the sent transport records the provider status against the message id", () => {
    const code = codeOf(read(SERVICE));
    // In the sent branch, provider_message_id and provider_status are recorded together —
    // the async terminal receipt (a public webhook) is a later increment, not R6.
    expect(code).toMatch(/provider_status:\s*acceptance\.status/);
    expect(code).toMatch(/provider_message_id:\s*acceptance\.providerMessageId/);
  });
});
