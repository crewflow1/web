import { computeCommercialCash, type CashQuote } from "@/lib/commercial/cash";
import { round2, toPounds } from "@/lib/money";
import { formatVariationLabel } from "@/lib/variations/schema";
import { daysBetweenIso } from "@/lib/warranties/schedule";

/**
 * The customer-safe variation approval view (Phase 7).
 *
 * A variation IS a quote row (20260520180000), so the customer could always
 * accept one — but the page they accepted it on told them nothing a variation
 * decision actually turns on. This builder assembles the three facts it does:
 * the SCOPE (rendered from the line items already on the page), the VALUE in
 * contract terms, and the PROGRAMME — the extension of time, which until
 * 20261073 was misfiled into `quotes.valid_until` and printed to the customer
 * under the label "Valid until".
 *
 * SECURITY BY CONSTRUCTION. 20261073 also added the priced COST BASIS
 * (cost_labour / cost_materials / cost_subcontractors / cost_misc / cost_total)
 * to the very same `quotes` row this view is built from. Those four numbers plus
 * their generated total are the margin the business priced the job at — the most
 * commercially damaging thing on the record, sitting one `...quote` spread away
 * from the customer's screen.
 *
 * So: no row is ever spread. This builder takes named, customer-safe arguments
 * and returns a shape it assembles field by field, and it never accepts a cost
 * argument at all — there is no parameter a cost figure could be passed through.
 * A security test serialises the result with sentinel cost values planted on the
 * source row and asserts they are ABSENT FROM THE JSON, not merely unrendered.
 *
 * Pure + server/client-safe.
 */

export type PortalVariationProgramme = {
  /** The completion date this variation asks the customer to agree. */
  requested_completion_date: string | null;
  /** The date actually agreed afterwards, once someone records it. */
  agreed_completion_date: string | null;
  /** True once an agreement exists — the requested date is then historic. */
  is_agreed: boolean;
  /**
   * The most recent completion date already agreed on an EARLIER variation for
   * this job, i.e. the programme date in force before this one. Null when no
   * extension has ever been agreed — which is the usual case on a first
   * variation, and is why `days_added` is so often null.
   */
  previous_agreed_completion_date: string | null;
  /**
   * Days this variation adds, ONLY when there is an agreed baseline to measure
   * from. Null otherwise: CrewFlow holds no contractual "original completion
   * date" (see 20261073 §2 — nothing re-dates the job), and subtracting a
   * scheduled or actual date from a contractual one would be a fabricated
   * number on a document the customer signs.
   */
  days_added: number | null;
};

export type PortalVariationView = {
  variation_number: number;
  label: string;
  status: string;
  /** This variation alone. */
  value: { subtotal: number; vat_total: number; total: number };
  /**
   * Contract context, gross. `before` is the agreed contract sum EXCLUDING this
   * variation; `after` is what it becomes if the customer approves. Computed by
   * `computeCommercialCash` from this customer's own quotes for this job, so the
   * taxonomy (original + accepted variations = revised) has exactly one owner.
   */
  contract: { before: number; after: number; approved_variations_count: number };
  programme: PortalVariationProgramme;
  decided_at: string | null;
  decision: "accepted" | "declined" | "open";
};

export const VARIATION_PORTAL_KEYS: ReadonlyArray<keyof PortalVariationView> = [
  "variation_number",
  "label",
  "status",
  "value",
  "contract",
  "programme",
  "decided_at",
  "decision",
];

/**
 * @param siblingQuotes every OTHER quote/variation for the same job that belongs
 *        to the same customer and org. The caller must have scoped them; this
 *        function trusts the set it is handed and reads only status / total /
 *        variation_number from it.
 */
export function buildPortalVariationView(input: {
  variationNumber: number;
  status: string;
  subtotal: number | string | null;
  vatTotal: number | string | null;
  total: number | string | null;
  eotRequestedCompletionDate: string | null;
  eotAgreedCompletionDate: string | null;
  acceptedAt: string | null;
  declinedAt: string | null;
  siblingQuotes: CashQuote[];
  /** Agreed completion dates from earlier accepted variations on this job. */
  priorAgreedCompletionDates: string[];
}): PortalVariationView {
  const total = toPounds(input.total);

  // Contract BEFORE this variation: the same rules the internal commercial
  // position uses, fed only the siblings. Invoices/payments are empty because
  // this view is about the contract, not the cash — nothing from that half of
  // the result is read.
  const position = computeCommercialCash({
    quotes: input.siblingQuotes,
    invoices: [],
    payments: [],
  });
  const before = position.revised;

  const agreed = input.eotAgreedCompletionDate;
  const requested = input.eotRequestedCompletionDate;
  const effective = agreed ?? requested;
  // The latest date already agreed on an earlier variation is the only
  // contractual baseline in the system. Anything else would be invented.
  const previousAgreed =
    input.priorAgreedCompletionDates.length > 0
      ? input.priorAgreedCompletionDates.slice().sort().at(-1) ?? null
      : null;

  return {
    variation_number: input.variationNumber,
    label: formatVariationLabel(input.variationNumber),
    status: input.status,
    value: {
      subtotal: toPounds(input.subtotal),
      vat_total: toPounds(input.vatTotal),
      total,
    },
    contract: {
      before,
      after: round2(before + total),
      approved_variations_count: position.counts.approvedVariations,
    },
    programme: {
      requested_completion_date: requested,
      agreed_completion_date: agreed,
      is_agreed: Boolean(agreed),
      previous_agreed_completion_date: previousAgreed,
      days_added:
        previousAgreed && effective ? daysBetweenIso(previousAgreed, effective) : null,
    },
    decided_at: input.acceptedAt ?? input.declinedAt ?? null,
    decision: input.acceptedAt ? "accepted" : input.declinedAt ? "declined" : "open",
  };
}
