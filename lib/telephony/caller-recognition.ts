/**
 * Caller recognition — the PURE decision + the safe AI-personalisation hint.
 *
 * When an inbound call arrives we normalise the caller's number and look it up,
 * ORG-SCOPED, against the tenant's `customers` and open `leads`. This module holds
 * the parts with NO I/O so they are exhaustively unit-testable; the DB lookups and
 * the lead wiring live in `server/services/caller-recognition.ts` and the inbound
 * pipeline. See docs comments there.
 *
 * SECURITY POSTURE (do not weaken):
 *   - Caller ID is a HINT, never proof of identity (numbers are trivially spoofed),
 *     so a match may personalise a greeting but must NEVER unlock stored personal,
 *     account, job or financial data. `buildRecognitionContext` encodes exactly that
 *     instruction for the model.
 *   - Ambiguity (more than one match) or a withheld number ⇒ DO NOT GUESS. We ask the
 *     caller to identify themselves and link NOTHING.
 *   - This module runs no model and spends no AI budget — it is pure matching.
 */

export type RecognitionStatus =
  | "withheld" // caller id withheld/anonymous ⇒ request clarification, link nothing
  | "no_match" // a usable number that matched no customer ⇒ new lead as normal
  | "single_customer" // exactly one customer ⇒ link + safely personalise
  | "multiple_customers"; // >1 customer ⇒ request clarification, link nothing

export type MatchedCustomer = { id: string; name: string | null };

export type RecognitionDecision = {
  status: RecognitionStatus;
  /** The matched customer (single_customer only), else null. */
  customer: MatchedCustomer | null;
  /**
   * An existing OPEN lead to LINK this contact to instead of creating a duplicate
   * (requirement 4 — same ongoing matter / repeat callback). Null ⇒ create a new
   * lead. Only ever set when the identity is UNAMBIGUOUS.
   */
  reuseLeadId: string | null;
  /**
   * True when the caller could not be uniquely identified (withheld or multiple
   * matches) ⇒ the AI must request clarification and MUST NOT assume who it is
   * speaking to. Never set for a single confident match.
   */
  ambiguous: boolean;
};

/** Inputs for the pure decision — the already-executed, org-scoped lookup results. */
export type RecognitionInputs = {
  /** Whether the caller id is withheld/anonymous/unusable. */
  withheld: boolean;
  /** Customers in THIS org whose phone signature equals the caller's (capped). */
  customerMatches: MatchedCustomer[];
  /** Oldest OPEN lead already linked to the single matched customer, if any. */
  customerOpenLeadId: string | null;
  /** Oldest OPEN lead in THIS org whose contact phone signature equals the caller's. */
  phoneOpenLeadId: string | null;
};

/**
 * The single decision table (requirements 3–7). Deterministic and side-effect free.
 */
export function decideRecognition(input: RecognitionInputs): RecognitionDecision {
  // (7) Withheld / anonymous ⇒ never guess.
  if (input.withheld) {
    return { status: "withheld", customer: null, reuseLeadId: null, ambiguous: true };
  }

  // (7) More than one customer on the same number ⇒ never guess which one.
  if (input.customerMatches.length > 1) {
    return {
      status: "multiple_customers",
      customer: null,
      reuseLeadId: null,
      ambiguous: true,
    };
  }

  // (3,4,5) Exactly one customer ⇒ link, and reuse their open matter if one exists.
  const onlyCustomer = input.customerMatches[0];
  if (input.customerMatches.length === 1 && onlyCustomer) {
    return {
      status: "single_customer",
      customer: onlyCustomer,
      // (4) same ongoing matter ⇒ link to it; (5) otherwise a new lead is created
      //     for the existing customer by the caller (reuseLeadId null).
      reuseLeadId: input.customerOpenLeadId,
      ambiguous: false,
    };
  }

  // (6) No customer. A prior OPEN lead on the same number (a repeat caller who is
  //     not yet a customer) is still the SAME matter ⇒ link rather than duplicate.
  if (input.phoneOpenLeadId) {
    return {
      status: "no_match",
      customer: null,
      reuseLeadId: input.phoneOpenLeadId,
      ambiguous: false,
    };
  }

  // (6) Genuinely new caller ⇒ a brand-new lead, exactly as before this feature.
  return { status: "no_match", customer: null, reuseLeadId: null, ambiguous: false };
}

/** The spoken first name, derived conservatively from a stored customer name. */
function firstNameOf(name: string | null | undefined): string | null {
  const trimmed = (name ?? "").trim();
  if (!trimmed) return null;
  const first = trimmed.split(/\s+/)[0];
  // Guard against odd data (emails, very long tokens) leaking into speech.
  if (!first || first.length > 40 || first.includes("@")) return null;
  return first;
}

/**
 * The SAFE, injection-framed personalisation hint for the AI spoken turn, or null
 * when there is nothing to add. Passed as the voice turn's `context` (reference
 * data, never instructions). It NEVER contains stored personal data beyond a first
 * name, and it always forbids the model from disclosing account details on the
 * strength of a caller-id match alone.
 */
export function buildRecognitionContext(
  decision: RecognitionDecision,
): string | null {
  switch (decision.status) {
    case "single_customer": {
      const first = firstNameOf(decision.customer?.name ?? null);
      const greet = first
        ? `The caller's number matches an existing customer (first name: ${first}); you may greet them warmly by that first name.`
        : "The caller's number matches an existing customer; you may acknowledge them as a returning customer.";
      return (
        `${greet} Caller ID is NOT proof of identity, so do not disclose any stored ` +
        "personal, address, job, quote, invoice or account details, and politely confirm " +
        "who you are speaking to before discussing anything specific to their account."
      );
    }
    case "multiple_customers":
      return (
        "The caller's number matches more than one record, so their identity is not " +
        "certain. Do not assume who they are or reveal any account details; politely ask " +
        "for their name and what the call is about."
      );
    case "withheld":
      return (
        "The caller's number is withheld or unavailable, so you cannot identify them. " +
        "Politely ask for their name and the best number to reach them on, and do not " +
        "reveal any account details."
      );
    case "no_match":
    default:
      return null;
  }
}
