import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  evaluateReply,
  isAutoSendable,
  GUARDRAIL_VERDICTS,
  PROHIBITED_CATEGORIES,
  COMMITMENT_CATEGORIES,
} from "@/lib/receptionist/policy";
import {
  detectBookingIntent,
  composeBookingConfirmation,
} from "@/lib/receptionist/intent";

/**
 * Voice Receptionist AI — reply-safety policy invariants
 * (the AI Receptionist Programme, R2 — the harvest; employee #26, Tier-T3).
 *
 * The conversational guardrail (lib/receptionist/policy.ts) and the booking-intent
 * detector (lib/receptionist/intent.ts) are the pure keystone of the Receptionist's
 * T3 contract: "captures and routes; never commits, quotes or books." Their live
 * behaviour is pinned exhaustively in the unit tier; THIS suite pins the
 * refactor-proof CONTRACT — the properties that must never silently regress:
 *
 *   • both layers are PURE — no `server-only`, no I/O, no clock, no RNG, no model —
 *     so a verdict / an intent is reconstructable from named rules, never a sample
 *     (the "no black box" bar, and the reason these re-home into `lib/`, not
 *     `server/`, importable by the SDK, the future inbox UI, and the tests alike);
 *   • the guardrail's verdict vocabulary is the bounded allow / review / block, and
 *     it splits ABSOLUTE prohibitions (block) from human-gated COMMITMENTS (review);
 *   • THE LOAD-BEARING PROPERTY: a composed booking confirmation is a customer
 *     commitment BY CONSTRUCTION, so it is a guardrail `review` — never `allow`. A
 *     booking is structurally impossible to auto-send.
 *
 * SQL/TS static checks run over `code` (block + line comments stripped) so the prose
 * documenting the contract can neither satisfy a positive match nor trip a negative
 * one — the house discipline of tool-registry-describes-not-authorises.test.ts.
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

const POLICY = "lib/receptionist/policy.ts";
const INTENT = "lib/receptionist/intent.ts";

// The server/facet/transport boundaries a pure policy leaf must never reach for.
const FORBIDDEN_IMPORTS = [
  "server-only",
  "supabase",
  "/admin",
  "/facets",
  "server/",
  "@/server",
] as const;

// =====================================================================
// 0. The harvested contract files exist in the canonical home.
// =====================================================================

describe("receptionist policy — the harvested modules re-home into lib/receptionist", () => {
  it(`ships ${POLICY}`, () => {
    expect(existsSync(resolve(ROOT, POLICY)), POLICY).toBe(true);
  });
  it(`ships ${INTENT}`, () => {
    expect(existsSync(resolve(ROOT, INTENT)), INTENT).toBe(true);
  });
});

// =====================================================================
// 1. The guardrail policy layer is a PURE, reconstructable arbiter.
// =====================================================================

describe("receptionist policy — the guardrail is pure and reconstructable", () => {
  const code = codeOf(read(POLICY));

  it("is a shared pure module (NOT server-only — the SDK, the UI, and the tests import it)", () => {
    expect(code).not.toMatch(/import\s+["'`]server-only["'`]/);
  });

  it("reaches for no server, facet, or transport module", () => {
    const specs = importSpecifiers(code);
    for (const spec of specs) {
      for (const forbidden of FORBIDDEN_IMPORTS) {
        expect(spec, `unexpected import: ${spec}`).not.toContain(forbidden);
      }
    }
  });

  it("touches no I/O — no admin client, no supabase, no network", () => {
    expect(code).not.toMatch(/createAdminClient/);
    expect(code).not.toMatch(/supabase/i);
    expect(code).not.toMatch(/\bfetch\(/);
  });

  it("has no clock and no RNG (a deterministic verdict is reconstructable)", () => {
    expect(code).not.toMatch(/Math\.random/);
    expect(code).not.toMatch(/Date\.now/);
    expect(code).not.toMatch(/new Date\(/);
  });

  it("pins the bounded verdict + category vocabulary and the pure entry points", () => {
    expect(code).toMatch(/export const GUARDRAIL_VERDICTS = \[\s*"allow",\s*"review",\s*"block"\s*\]/);
    expect(code).toMatch(/export const GUARDRAIL_CATEGORIES = \[/);
    expect(code).toMatch(/export function evaluateReply\(/);
    expect(code).toMatch(/export function redactReply\(/);
  });

  it("splits absolute prohibitions (block) from human-gated commitments (review)", () => {
    // §12 absolutes force a block; §9/§11 commitments force a review.
    expect(code).toMatch(/PROHIBITED_CATEGORIES[\s\S]*?"safety_claim"[\s\S]*?"discrimination"/);
    expect(code).toMatch(
      /COMMITMENT_CATEGORIES[\s\S]*?"price"[\s\S]*?"booking"[\s\S]*?"legal"[\s\S]*?"guarantee"/,
    );
  });
});

// =====================================================================
// 2. The booking-intent layer is a PURE detect/compose mapper.
// =====================================================================

describe("receptionist policy — the booking-intent layer is pure", () => {
  const code = codeOf(read(INTENT));

  it("is a shared pure module (NOT server-only — the SDK + tests import it)", () => {
    expect(code).not.toMatch(/import\s+["'`]server-only["'`]/);
  });

  it("reaches for no server, facet, or transport module", () => {
    const specs = importSpecifiers(code);
    for (const spec of specs) {
      for (const forbidden of FORBIDDEN_IMPORTS) {
        expect(spec, `unexpected import: ${spec}`).not.toContain(forbidden);
      }
    }
  });

  it("touches no I/O and calls no model — it detects and composes, it does not generate", () => {
    expect(code).not.toMatch(/createAdminClient/);
    expect(code).not.toMatch(/supabase/i);
    expect(code).not.toMatch(/\bfetch\(/);
    expect(code).not.toMatch(/@\/lib\/ai\//);
    expect(code).not.toMatch(/Anthropic/);
  });

  it("has no clock and no RNG (deterministic detection + composition)", () => {
    expect(code).not.toMatch(/Math\.random/);
    expect(code).not.toMatch(/Date\.now/);
    expect(code).not.toMatch(/new Date\(/);
  });

  it("exports the detector, both composers, and the bounded kinds", () => {
    expect(code).toMatch(/export function detectBookingIntent\(/);
    expect(code).toMatch(/export function composeBookingConfirmation\(/);
    expect(code).toMatch(/export function composeBookingSummary\(/);
    expect(code).toMatch(/export const BOOKING_KINDS/);
  });

  it("hard-bounds the captured free text (defends the columns)", () => {
    expect(code).toMatch(/slice\(0,\s*MAX_BOOKING_WINDOW\)/);
    expect(code).toMatch(/slice\(0,\s*MAX_BOOKING_SUMMARY\)/);
  });
});

// =====================================================================
// 3. THE LOAD-BEARING PROPERTY — a booking is structurally never auto-sendable,
//    and the guardrail is deny-by-default (only a clean, bounded ack `allow`s).
// =====================================================================

describe("receptionist policy — a booking confirmation can never auto-send", () => {
  it("every detected-intent confirmation is a guardrail `review`, never `allow`", () => {
    const messages = [
      "please book me in for Monday morning",
      "can you call me back this afternoon",
      "are you free next week?",
      "could you come Tuesday at 2pm",
      "I'd like a callback tomorrow morning",
    ];
    for (const message of messages) {
      const intent = detectBookingIntent(message);
      expect(intent, `expected a booking intent for: ${message}`).not.toBeNull();
      if (!intent) continue;
      const result = evaluateReply(composeBookingConfirmation(intent));
      expect(result.verdict).toBe("review");
      expect(result.categories).toContain("booking");
      expect(isAutoSendable(result)).toBe(false);
    }
  });

  it("the verdict codomain is exactly allow / review / block", () => {
    expect([...GUARDRAIL_VERDICTS]).toEqual(["allow", "review", "block"]);
  });

  it("no category is both an absolute prohibition and a human-gated commitment", () => {
    for (const c of COMMITMENT_CATEGORIES) {
      expect(PROHIBITED_CATEGORIES).not.toContain(c);
    }
  });

  it("an absolute safety claim is refused (block), never merely held", () => {
    const r = evaluateReply("Don't worry, your boiler is completely safe.");
    expect(r.verdict).toBe("block");
    expect(isAutoSendable(r)).toBe(false);
  });
});
