/**
 * CrewFlow HQ — Voice Receptionist AI: the conversational guardrail
 * (the AI Receptionist Programme, R2 — the harvest; employee #26, Tier-T3).
 *
 * The pure policy layer that decides the fate of an AI-DRAFTED customer reply:
 * may it auto-send, must a human send it, or is it refused outright. This is the
 * code where the Receptionist's T3 contract — "captures and routes; never
 * commits, quotes or books" — stops being prose and becomes a mechanical verdict
 * a human can audit. A spoken/sent word to a caller is external and irreversible;
 * the guardrail is the seam that guarantees the AI never says a binding one
 * without a human behind it.
 *
 * PROVENANCE. Harvested verbatim (behaviour-preserving) from the earlier
 * comms-platform guardrail (REC-29, `lib/channels/guardrail.ts`) and re-homed
 * onto the canonical receptionist domain. The transport plumbing it grew up
 * beside — the `ai_reply_audits` ledger, the outbound send seams — is deferred to
 * a later increment; ONLY the pure arbiter re-homes here. Nothing about the rules,
 * the verdict shape, or the redaction changed: the ported unit + security suites
 * pin that the behaviour is identical to the harvested original.
 *
 * A shared, PURE module (NOT server-only, NO I/O, no clock, no RNG) — the exact
 * discipline of {@link import("@/lib/comms/policy")} and {@link
 * import("@/server/sdk/gate")}: the canonical server orchestrator (`server/
 * services/receptionist.ts`) and the SDK `ctx.comms` facet compose it; the future
 * inbox UI and the tests import it; the same draft always yields the same verdict,
 * so a reply's fate is reconstructable from named rules alone (the "no black box"
 * bar), never an opaque model sample.
 *
 * SIBLING TO THE DOORMAN, NOT A DUPLICATE. `server/sdk/gate.ts` is the doorman
 * over an HQ-internal PROPOSED ACTION (a two-valued `autonomous | needs_approval`
 * verdict); this is the arbiter over an OUTBOUND CUSTOMER REPLY, whose codomain
 * is three-valued by necessity — `allow` (auto-send), `review` (a human sends the
 * draft), `block` (refused, never sent). Both are deny-by-default policy, pure and
 * source-provable; they classify different subjects and are deliberately kept
 * distinct rather than one folded into the other.
 *
 * ── What it enforces (Bible, Operating-System Volume XV — the constitution) ──
 *
 *   §9  Customer-impact limits. ANY outbound customer communication is
 *       human-gated (autonomy A4), with ONE narrow exception: a pre-approved,
 *       narrowly-scoped acknowledgement that makes no commitment (A1). And any
 *       COMMITMENT to a customer — a price, a date, a promise — is A4: "Voice /
 *       WhatsApp / Email / Scheduler never commit; the human does."
 *
 *   §12 Ethical prohibitions (ABSOLUTE — no authority may grant them). Chief
 *       among them: never deceive a customer with a false or misleading claim
 *       about price, capability, timing, SAFETY, or status; never fabricate a
 *       compliance or safety record; never make a discriminatory decision.
 *
 * The guardrail turns that policy into a mechanical verdict over one draft:
 *
 *   • `allow`  — a bounded acknowledgement, no commitment, no prohibited claim.
 *                Auto-send permitted (the §9 A1 exception).
 *   • `review` — a customer COMMITMENT (price / booking / legal / guarantee) or
 *                a substantive reply beyond the acknowledgement envelope. The AI
 *                may DRAFT it; a human must send it (§9 A4).
 *   • `block`  — an ABSOLUTE prohibition (a safety/compliance claim, or
 *                discriminatory language). Never sent as drafted — refused (§12).
 *
 * This module DECIDES; it never transmits. Sending is an outbound seam's job;
 * recording the verdict is the server orchestrator's job. The classifier here is
 * the arbiter, and only that.
 */

/** The three fates of an AI-drafted reply, in ascending severity. */
export const GUARDRAIL_VERDICTS = ["allow", "review", "block"] as const;
export type GuardrailVerdict = (typeof GUARDRAIL_VERDICTS)[number];

/** The classes of concern the guardrail detects in a draft. */
export const GUARDRAIL_CATEGORIES = [
  "price", // a monetary / price commitment (§9)
  "booking", // a date / appointment commitment (§9)
  "legal", // a contractual / legal commitment (§11)
  "guarantee", // an unconditional guarantee or promise (§9)
  "safety_claim", // an absolute safety / compliance assertion (§12 — deception / fabrication)
  "discrimination", // a decision on a protected characteristic (§12)
] as const;
export type GuardrailCategory = (typeof GUARDRAIL_CATEGORIES)[number];

/**
 * ABSOLUTE prohibitions (§12) — a match forces `block`. These claims are never
 * safe to send, not even by a human via this path: they deceive or fabricate.
 */
export const PROHIBITED_CATEGORIES: readonly GuardrailCategory[] = [
  "safety_claim",
  "discrimination",
];

/**
 * Human-gated COMMITMENTS (§9 / §11) — a match forces `review`. The AI may draft
 * these; a human owns the send. Never auto-committed.
 */
export const COMMITMENT_CATEGORIES: readonly GuardrailCategory[] = [
  "price",
  "booking",
  "legal",
  "guarantee",
];

/**
 * The narrow-acknowledgement envelope: a clean draft at or under this length is
 * eligible for `allow` (the §9 A1 exception). ≈ two SMS segments — a
 * proportionate proxy for "narrowly-scoped". A clean draft LONGER than this is
 * a substantive reply and defaults to `review` (the §9 conservative default:
 * "ship with the allow-list empty — all sends A4 — and widen deliberately").
 */
export const ACK_MAX_LENGTH = 320;

/** One detected concern: which category, the offending text, and why. */
export type GuardrailFinding = {
  category: GuardrailCategory;
  match: string;
  reason: string;
};

/** The verdict over one draft, plus the safe remainder (if any). */
export type GuardrailResult = {
  verdict: GuardrailVerdict;
  categories: GuardrailCategory[];
  findings: GuardrailFinding[];
  reason: string;
  /**
   * The auto-sendable remainder: the draft (trimmed) when `allow`, or the
   * redacted body when it independently clears the guardrail, else `null`.
   */
  safeText: string | null;
};

type Rule = {
  category: GuardrailCategory;
  pattern: RegExp;
  reason: string;
};

/**
 * The detection rules — deterministic, case-insensitive, and conservative
 * (tuned to catch a real commitment / claim, not to trip on a hedge). Each is a
 * global regex so every offending span is surfaced, not just the first.
 */
const RULES: readonly Rule[] = [
  // ── §12 ABSOLUTE — safety / compliance claims (deception, fabrication) ──
  {
    category: "safety_claim",
    pattern:
      /\b(?:100%|completely|totally|fully|perfectly|absolutely)\s+safe\b|\bno\s+risk\b|\brisk-free\b|\bguaranteed\s+safe\b/gi,
    reason: "asserts an absolute safety claim (§12 — never deceive on safety)",
  },
  {
    category: "safety_claim",
    pattern:
      /\b(?:fully|100%|guaranteed)\s+compliant\b|\bmeets\s+all\s+(?:the\s+)?(?:regulations|safety|building)\b|\bfully\s+certified\b|\bcertified\s+(?:safe|compliant)\b/gi,
    reason:
      "asserts an absolute compliance claim (§12 — never fabricate a compliance record)",
  },
  // ── §12 ABSOLUTE — discriminatory decisioning on a protected characteristic ──
  {
    category: "discrimination",
    pattern:
      /\b(?:because(?:\s+of)?|due\s+to|on\s+account\s+of|based\s+on)\s+(?:your|their|his|her|the\s+customer'?s)\s+(?:age|race|religion|gender|sex|disability|nationality|ethnicity|colour|color)\b/gi,
    reason: "conditions service on a protected characteristic (§12 — no discrimination)",
  },
  {
    category: "discrimination",
    pattern:
      /\bwe\s+(?:don'?t|do\s+not|can'?t|cannot|won'?t|will\s+not|refuse\s+to)\s+(?:serve|work\s+with|help|deal\s+with)\b[^.!?]*\b(?:because|due\s+to|based\s+on)\b/gi,
    reason: "refuses service on a stated ground (§12 — no discrimination)",
  },
  // ── §9 COMMITMENT — price ──
  {
    category: "price",
    pattern: /(?:£|\bgbp\b)\s?\d[\d,]*(?:\.\d+)?/gi,
    reason: "states a specific price (§9 — a price commitment is human-gated)",
  },
  {
    category: "price",
    pattern:
      /\b(?:it'?ll|it\s+will|that'?ll|that\s+will|this\s+will)\s+cost\b|\bthe\s+(?:price|cost|fee|charge|rate)\s+(?:is|will\s+be)\b|\bwe(?:'ll|\s+will)?\s+charge\b|\bi(?:'ll|\s+will)?\s+quote\s+you\b/gi,
    reason: "commits to a cost or quote (§9 — a price commitment is human-gated)",
  },
  // ── §9 COMMITMENT — booking / a date ──
  {
    category: "booking",
    pattern:
      /\bbooked\s+you\s+in\b|\byou'?re\s+booked\b|\bconfirmed\s+(?:for|your\s+(?:booking|appointment|slot|visit))\b|\b(?:appointment|booking|visit|slot)\s+(?:is\s+)?(?:confirmed|booked|scheduled)\b|\bi'?ve\s+(?:booked|scheduled)\b|\bsee\s+you\s+(?:on|at)\b/gi,
    reason: "confirms a booking or a date (§9 — a date commitment is human-gated)",
  },
  {
    category: "booking",
    pattern:
      /\b(?:on\s+)?(?:mon|tues|wednes|thurs|fri|satur|sun)day\b[^.!?]*\b(?:at\s+)?\d{1,2}(?::\d{2})?\s?(?:am|pm)\b|\b\d{1,2}(?::\d{2})?\s?(?:am|pm)\b[^.!?]*\b(?:mon|tues|wednes|thurs|fri|satur|sun)day\b/gi,
    reason: "names a specific day and time (§9 — a date commitment is human-gated)",
  },
  // ── §11 COMMITMENT — contractual / legal ──
  {
    category: "legal",
    pattern:
      /\blegally\s+binding\b|\bbinding\s+contract\b|\benter\s+into\s+a\s+contract\b|\bterms\s+and\s+conditions\s+(?:apply|below)\b|\bwe\s+accept\s+liability\b|\bwe(?:'ll|\s+will)?\s+indemnif/gi,
    reason: "makes a contractual or legal commitment (§11 — human-gated)",
  },
  // ── §9 COMMITMENT — unconditional guarantee / promise ──
  {
    category: "guarantee",
    pattern:
      /\bwe\s+guarantee\b|\bi\s+guarantee\b|\bguaranteed\b|\bwe\s+promise\b|\bi\s+promise\b|\bpromise\s+you\b|\bfully\s+guaranteed\b|\bmoney-back\s+guarantee\b/gi,
    reason: "makes an unconditional guarantee (§9 — a promise is human-gated)",
  },
];

/** Split a draft into sentence-ish spans for redaction. */
function sentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+/).filter((s) => s.trim().length > 0);
}

/** All detected concerns in a draft, in rule order (deterministic). */
function findFindings(text: string): GuardrailFinding[] {
  const findings: GuardrailFinding[] = [];
  for (const rule of RULES) {
    const matches = text.match(rule.pattern);
    if (!matches) continue;
    for (const match of matches) {
      findings.push({ category: rule.category, match: match.trim(), reason: rule.reason });
    }
  }
  return findings;
}

function severityOf(categories: readonly GuardrailCategory[]): GuardrailVerdict | null {
  if (categories.some((c) => PROHIBITED_CATEGORIES.includes(c))) return "block";
  if (categories.some((c) => COMMITMENT_CATEGORIES.includes(c))) return "review";
  return null;
}

function uniqueCategories(findings: readonly GuardrailFinding[]): GuardrailCategory[] {
  const seen = new Set<GuardrailCategory>();
  for (const f of findings) seen.add(f.category);
  // Preserve the canonical GUARDRAIL_CATEGORIES order for a stable output.
  return GUARDRAIL_CATEGORIES.filter((c) => seen.has(c));
}

/**
 * Remove every sentence that carries a flagged span — the redacted remainder is
 * what could survive review. A caller may auto-send it only if it independently
 * clears the guardrail (which `evaluateReply` checks before offering it).
 */
export function redactReply(draft: string): string {
  return sentences(draft)
    .filter((s) => findFindings(s).length === 0)
    .join(" ")
    .trim();
}

/** The whole arbiter: classify one AI-drafted reply into its verdict. */
export function evaluateReply(draft: string): GuardrailResult {
  const trimmed = draft.trim();
  const findings = findFindings(draft);
  const categories = uniqueCategories(findings);

  const severity = severityOf(categories);
  let verdict: GuardrailVerdict;
  let reason: string;

  if (severity === "block") {
    verdict = "block";
    reason = `Blocked: an absolute prohibition (${categories
      .filter((c) => PROHIBITED_CATEGORIES.includes(c))
      .join(", ")}) — refused, never sent.`;
  } else if (severity === "review") {
    verdict = "review";
    reason = `Held for a human: a customer commitment (${categories
      .filter((c) => COMMITMENT_CATEGORIES.includes(c))
      .join(", ")}) — the AI drafts, a human sends.`;
  } else if (trimmed.length === 0) {
    verdict = "review";
    reason = "Held for a human: empty draft — nothing to auto-send.";
  } else if (trimmed.length <= ACK_MAX_LENGTH) {
    verdict = "allow";
    reason = "Auto-send permitted: a bounded acknowledgement, no commitment detected.";
  } else {
    verdict = "review";
    reason =
      "Held for a human: a substantive reply beyond the acknowledgement envelope (§9 default).";
  }

  let safeText: string | null = null;
  if (verdict === "allow") {
    safeText = trimmed;
  } else {
    const redacted = redactReply(draft);
    if (
      redacted.length > 0 &&
      redacted.length <= ACK_MAX_LENGTH &&
      findFindings(redacted).length === 0
    ) {
      safeText = redacted;
    }
  }

  return { verdict, categories, findings, reason, safeText };
}

/** True only when a result may be sent without a human in the loop (A1). */
export function isAutoSendable(result: GuardrailResult): boolean {
  return result.verdict === "allow";
}
