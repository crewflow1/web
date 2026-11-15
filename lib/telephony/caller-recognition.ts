/**
 * Caller recognition — the PURE decision + the safe AI-personalisation hint + the
 * evidence-based same-project matcher.
 *
 * When an inbound call arrives we normalise the caller's number and look it up,
 * ORG-SCOPED, against the tenant's `customers` and their open `leads`. This module
 * holds the parts with NO I/O so they are exhaustively unit-testable; the DB lookups
 * and the lead wiring live in `server/services/caller-recognition.ts` and the inbound
 * pipeline.
 *
 * SECURITY / CORRECTNESS POSTURE (do not weaken):
 *   - Caller ID is a HINT, never proof of identity (numbers are trivially spoofed),
 *     so a match may personalise a greeting but must NEVER unlock stored personal,
 *     account, job or financial data. `buildRecognitionContext` encodes exactly that.
 *   - Ambiguity (more than one customer) or a withheld number ⇒ DO NOT GUESS. We ask
 *     the caller to identify themselves and link NOTHING.
 *   - A phone-number match ALONE is NOT grounds to reuse an existing enquiry. We reuse
 *     an open lead ONLY when there is sufficient evidence the caller is discussing the
 *     SAME project (`selectReusableLead`); otherwise we create a NEW lead linked to the
 *     existing customer. This prevents two different jobs for one customer collapsing
 *     into a single lead just because they share a number.
 *   - This module runs no model and spends no AI budget — pure matching.
 */

export type RecognitionStatus =
  | "withheld" // caller id withheld/anonymous ⇒ request clarification, link nothing
  | "no_match" // a usable number that matched no customer ⇒ new lead as normal
  | "single_customer" // exactly one customer ⇒ link + safely personalise
  | "multiple_customers"; // >1 customer ⇒ request clarification, link nothing

export type MatchedCustomer = { id: string; name: string | null };

/** An existing OPEN lead of the matched customer, a candidate for same-project reuse. */
export type CandidateLead = {
  id: string;
  service: string | null;
  postcode: string | null;
};

export type RecognitionDecision = {
  status: RecognitionStatus;
  /** The matched customer (single_customer only), else null. */
  customer: MatchedCustomer | null;
  /**
   * The matched customer's OPEN leads — the ONLY leads eligible for same-project
   * reuse (never a non-customer's, never when the identity is ambiguous). Empty
   * unless `status === "single_customer"`. The reuse decision itself is made by
   * `selectReusableLead` against the call's extracted project — NOT here, because a
   * phone match alone is not evidence of the same project.
   */
  candidateLeads: CandidateLead[];
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
  /** The single matched customer's open leads (empty unless exactly one customer). */
  candidateLeads: CandidateLead[];
};

/**
 * The single identity decision (requirements 3, 6, 7). Deterministic + side-effect
 * free. It resolves WHO the caller is and which leads are even eligible for reuse; it
 * does NOT decide reuse (that needs the project — see `selectReusableLead`).
 */
export function decideRecognition(input: RecognitionInputs): RecognitionDecision {
  // (7) Withheld / anonymous ⇒ never guess.
  if (input.withheld) {
    return { status: "withheld", customer: null, candidateLeads: [], ambiguous: true };
  }

  // (7) More than one customer on the same number ⇒ never guess which one.
  if (input.customerMatches.length > 1) {
    return { status: "multiple_customers", customer: null, candidateLeads: [], ambiguous: true };
  }

  // (3) Exactly one customer ⇒ link, and expose their open leads as reuse candidates.
  const onlyCustomer = input.customerMatches[0];
  if (input.customerMatches.length === 1 && onlyCustomer) {
    return {
      status: "single_customer",
      customer: onlyCustomer,
      candidateLeads: input.candidateLeads,
      ambiguous: false,
    };
  }

  // (6) No customer ⇒ a brand-new lead, exactly as before this feature. We do NOT reuse
  //     a lead for a non-customer on a phone match alone (that is the very behaviour the
  //     same-project rule removes).
  return { status: "no_match", customer: null, candidateLeads: [], ambiguous: false };
}

/** Normalise a free-text service/job type for comparison (case/space-insensitive). */
function normService(s: string | null | undefined): string | null {
  const t = (s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  return t || null;
}

/** Normalise a postcode the same way the SQL postcode_normalized column does. */
function normPostcode(s: string | null | undefined): string | null {
  const t = (s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  return t || null;
}

/**
 * The SAME-PROJECT reuse decision (requirements 4 & 5). Returns the id of the ONE
 * existing open lead the caller is evidently discussing, or null ⇒ create a new lead.
 *
 * "Sufficient evidence" is deliberately STRICT: the call's extracted project must
 * carry BOTH a specific service AND a postcode, and must match EXACTLY ONE candidate
 * on both. This means:
 *   - an ambiguous / sparse enquiry (no service, or no postcode — e.g. a voice call
 *     whose transcript has not been extracted yet, which carries NO service) ⇒ null ⇒
 *     a NEW lead linked to the customer. We never reuse on a weak signal.
 *   - a customer with several open projects ⇒ we reuse only the one that matches on
 *     service AND postcode; if two candidates both match (genuinely ambiguous) ⇒ null.
 */
export function selectReusableLead(
  project: { service: string | null; postcode: string | null },
  candidates: CandidateLead[],
): string | null {
  const svc = normService(project.service);
  const pc = normPostcode(project.postcode);
  if (!svc || !pc) return null; // insufficient evidence ⇒ new lead
  const hits = candidates.filter(
    (c) => normService(c.service) === svc && normPostcode(c.postcode) === pc,
  );
  // Exactly one ⇒ same project; zero ⇒ new project; more than one ⇒ ambiguous (don't guess).
  return hits.length === 1 && hits[0] ? hits[0].id : null;
}

/** The spoken first name, derived conservatively from a stored customer name. */
function firstNameOf(name: string | null | undefined): string | null {
  const trimmed = (name ?? "").trim();
  if (!trimmed) return null;
  const first = trimmed.split(/\s+/)[0];
  if (!first || first.length > 40 || first.includes("@")) return null;
  return first;
}

/**
 * The SAFE, injection-framed personalisation hint for the AI spoken turn, or null
 * when there is nothing to add. Passed as the voice turn's `context` (reference data,
 * never instructions). It NEVER contains stored personal data beyond a first name, and
 * it always forbids the model from disclosing account details on a caller-id match.
 */
export function buildRecognitionContext(decision: RecognitionDecision): string | null {
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
