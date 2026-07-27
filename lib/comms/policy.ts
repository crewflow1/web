/**
 * CrewFlow HQ — Communication Layer: pure delivery policy (Directive 010, Phase 4).
 *
 * The deterministic decisions the layer makes WITHOUT touching the network or the
 * database: how to normalise a recipient address, whether an address is on the
 * do-not-contact list, when (and whether) a failed attempt may be retried, and how
 * to lift a plaintext draft body into the HTML the transport needs. Pure functions —
 * NO `server-only`, NO I/O — exhaustively unit-pinned, exactly as the Draft Engine's
 * prompt construction and fallback are. The service composes these; it never
 * re-derives them.
 *
 * The hard safety rules live here as code, not comments: a `bounced`, `complained`,
 * or `suppressed` attempt is NEVER retried, and a suppressed address is NEVER sent
 * to. The service and the database trigger both honour them; this is the one place
 * they are defined.
 */

import type { CommState } from "./state";

// ---------------------------------------------------------------------
// Addresses. One canonical form so suppression matching and self-loop checks are
// stable: the bare address out of `"Display Name <addr@host>"` (or a plain
// `addr@host`), trimmed and lower-cased. Mirrors lib/email/send.ts's extractAddress.
// ---------------------------------------------------------------------

/** Canonicalise a recipient field to its bare, lower-cased address. */
export function normalizeAddress(field: string): string {
  const m = field.match(/<([^>]+)>/);
  const bare = m && m[1] ? m[1] : field;
  return bare.trim().toLowerCase();
}

/** A deliberately conservative shape check — a single `@`, a dotted domain, no spaces. */
export function isValidEmail(field: string): boolean {
  const addr = normalizeAddress(field);
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr);
}

// ---------------------------------------------------------------------
// Suppression. The do-not-contact list, keyed by normalised address. A bounce or a
// complaint adds to it; a manual addition is the operator's. The policy refuses any
// send to a suppressed address — the boundary that stops repeat contact.
// ---------------------------------------------------------------------

export const SUPPRESSION_REASONS = ["bounce", "complaint", "manual"] as const;
export type SuppressionReason = (typeof SUPPRESSION_REASONS)[number];

/** Is this address on the supplied do-not-contact set? Normalises both sides first. */
export function isSuppressed(address: string, suppressed: ReadonlySet<string>): boolean {
  return suppressed.has(normalizeAddress(address));
}

/**
 * The suppression reason a terminal outcome implies, or `null` when the outcome does
 * not suppress. A bounce and a spam complaint both add the address to the list; a
 * delivery does not. The single mapping from "what the provider reported" to "should
 * we stop contacting this address".
 */
export function suppressionReasonForOutcome(state: CommState): SuppressionReason | null {
  if (state === "bounced") return "bounce";
  if (state === "complained") return "complaint";
  return null;
}

// ---------------------------------------------------------------------
// Retry. A failed TRANSPORT attempt may be retried a bounded number of times with a
// deterministic exponential backoff. A bounce/complaint/suppression is a hard stop —
// retrying it would be exactly the repeat-contact the suppression list prevents.
// Retry mints a NEW attempt (supersedes); it never mutates the failed row.
// ---------------------------------------------------------------------

/** The most attempts a single message is ever delivered with (the first + retries). */
export const MAX_DELIVERY_ATTEMPTS = 5;

const RETRY_BASE_MS = 60_000; // 1 minute before the first retry
const RETRY_CAP_MS = 6 * 60 * 60_000; // capped at 6 hours

/**
 * Deterministic backoff before the Nth attempt (N ≥ 1): 1m, 2m, 4m, 8m, … capped at
 * 6h. Same attempt number in → same delay out (no jitter — determinism over
 * thundering-herd avoidance, which a real queue would own).
 */
export function retryDelayMs(attempt: number): number {
  if (attempt <= 1) return RETRY_BASE_MS;
  const exp = RETRY_BASE_MS * 2 ** (attempt - 1);
  return Math.min(exp, RETRY_CAP_MS);
}

/**
 * May a row in `status` at attempt `attempt` be retried? ONLY a transport `failed`
 * row qualifies, and only under the attempt cap. A `bounced`/`complained`/
 * `suppressed` row is a permanent stop; a `sent` row is still in flight; a
 * `delivered` row succeeded. The hard "never retry a bounce" rule, as code.
 */
export function canRetry(status: CommState, attempt: number): boolean {
  if (status !== "failed") return false;
  return attempt < MAX_DELIVERY_ATTEMPTS;
}

// ---------------------------------------------------------------------
// Rendering. A draft body is plaintext; an email needs an HTML alternative. The lift
// is deterministic and escapes first, so the same body always yields the same HTML
// and no draft text is ever interpreted as markup.
// ---------------------------------------------------------------------

/** Escape HTML-significant characters so draft prose is never interpreted as markup. */
function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Lift a plaintext body to a minimal, deterministic HTML document: blank-line-
 * separated blocks become `<p>`, single newlines become `<br>`. Escapes first.
 * Same body in → byte-identical HTML out.
 */
export function plaintextToHtml(text: string): string {
  return escapeHtml(text)
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter((block) => block.length > 0)
    .map((block) => `<p>${block.replace(/\n/g, "<br>")}</p>`)
    .join("\n");
}
