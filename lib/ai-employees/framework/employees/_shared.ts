/**
 * Employee-definition helpers (CEO Directive 007, Phase 1).
 *
 * Tiny, pure builders that centralise the invariants every employee
 * definition shares — so the "Phase 1 locked" posture and the inert
 * model identifiers live in exactly ONE place, never copy-pasted across
 * eleven files. The definitions themselves stay 100% declarative.
 *
 * PURE: types only, no runtime deps beyond the dimension contracts.
 */

import type { AiPermissions, ModelConfig } from "../dimensions";

// Inert planning model identifiers — mirror the seeded `model_name`
// column exactly. No code reads these to make an API call in Phase 1;
// they are configuration intent, surfaced read-only in the UI.
export const OPUS = "claude-opus-4-7";
export const SONNET = "claude-sonnet-4-6";
export const HAIKU = "claude-haiku-4-5";

/** Build an Anthropic planning model config (provider is always "anthropic"). */
export function anthropic(name: string, temperature: number): ModelConfig {
  return { provider: "anthropic", name, temperature };
}

/**
 * The locked-down Phase 1 permission posture: every employee is
 * advisory-only. `can_execute` is forced false and `requires_approval`
 * true — no employee may act autonomously until execution is granted.
 * Only the read/draft scopes differ per role.
 */
export function locked(scopes: string[]): AiPermissions {
  return { can_execute: false, requires_approval: true, scopes };
}
