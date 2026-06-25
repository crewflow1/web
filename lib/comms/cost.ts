/**
 * CrewFlow HQ — Communication Layer: delivery cost accounting (Directive 010, Phase 4).
 *
 * "Costs measurable" (a CEO success criterion): every delivery attempt records what
 * it cost. As with the text and embedding seams, pricing is PROVIDER METADATA, not a
 * constant of the layer — adding a provider/channel adds a row here and never touches
 * the service. Pure functions, no SDK, no `server-only`, deterministic, unit-tested in
 * isolation. Mirrors `lib/ai/text/cost.ts` exactly.
 *
 * Per the seam's doctrine, cost is OBSERVABILITY, never a correctness gate: an
 * unpriced provider still sends; its cost is simply recorded as unknown (`null`).
 */

/**
 * "Version 1" per-message delivery pricing — USD per accepted message, keyed by
 * `${provider}:${channel}`. Transactional email is billed by monthly volume tier,
 * not per message, so the marginal cost of one send is ~0; the column exists for
 * parity and for the metered channels (SMS, voice) that will reuse this ledger.
 * Values current as of 2026-06.
 */
const PRICE_PER_MESSAGE_USD: Readonly<Record<string, number>> = {
  "resend:email": 0,
};

/**
 * Cost in USD for one accepted delivery against a provider/channel. Returns `null`
 * when the pairing's price is unknown — cost is OBSERVABILITY, never a gate, so an
 * unpriced provider still delivers; its cost is recorded as unknown. Mirrors
 * `textCostUsd` exactly.
 */
export function emailCostUsd(info: { provider: string; channel: string }): number | null {
  const price = PRICE_PER_MESSAGE_USD[`${info.provider}:${info.channel}`];
  return price ?? null;
}
