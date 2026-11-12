import "server-only";
import * as Sentry from "@sentry/nextjs";
import { createAdminClient } from "@/lib/supabase/admin";
import { isWithheldCallerId, phoneSignificantDigits } from "@/lib/phone";
import { LEAD_STAGES_OPEN } from "@/lib/leads/schema";
import {
  decideRecognition,
  type MatchedCustomer,
  type RecognitionDecision,
} from "@/lib/telephony/caller-recognition";

/**
 * Caller recognition — the I/O half (the pure decision lives in
 * `lib/telephony/caller-recognition.ts`).
 *
 * Given an org and the inbound caller's number, look up — ORG-SCOPED — whether the
 * number belongs to a known customer or an open lead, and return the decision the
 * inbound pipeline uses to link (not duplicate) the lead and to safely personalise
 * the conversation.
 *
 * TENANT ISOLATION: runs on the SERVICE-ROLE admin client (the webhook has no
 * signed-in user), so EVERY query pins `org_id` explicitly — the match is scoped to
 * the called tenant and can NEVER surface a customer from another org (a number that
 * exists only in org B is `no_match` for a call to org A). This is the single
 * tenant boundary on this path and is covered by the cross-tenant integration test.
 *
 * BEST-EFFORT / FAIL-SAFE: this never throws. Any failure (bad org, DB error,
 * unexpected shape) degrades to `no_match` — i.e. the exact pre-feature behaviour
 * (a new lead is created as normal), so recognition can never break ingestion or a
 * live call. It also runs NO model and spends NO AI budget — pure DB matching.
 */

/** Cap: we only need to know "one" vs "more than one" customer on a number. */
const CUSTOMER_MATCH_CAP = 3;
/** A signature shorter than this is too weak to match on safely. */
const MIN_SIG_LENGTH = 7;

const NO_MATCH: RecognitionDecision = {
  status: "no_match",
  customer: null,
  reuseLeadId: null,
  ambiguous: false,
};

type Rows<T> = { data: T[] | null; error: { message: string } | null };
type SelectChain = {
  select: (cols: string) => EqChain;
};
type EqChain = {
  eq: (k: string, v: unknown) => EqChain;
  in: (k: string, v: readonly unknown[]) => EqChain;
  order: (k: string, o: { ascending: boolean }) => EqChain;
  limit: (n: number) => Promise<Rows<Record<string, unknown>>>;
};

function from(name: string): SelectChain {
  const admin = createAdminClient();
  return admin.from(name as never) as unknown as SelectChain;
}

export async function recogniseCaller(input: {
  orgId: string | null | undefined;
  callerId: string | null | undefined;
}): Promise<RecognitionDecision> {
  const orgId = input.orgId?.trim();
  if (!orgId) return NO_MATCH;

  // Withheld / anonymous caller id ⇒ never guess (no query, request clarification).
  if (isWithheldCallerId(input.callerId)) {
    return decideRecognition({
      withheld: true,
      customerMatches: [],
      customerOpenLeadId: null,
      phoneOpenLeadId: null,
    });
  }

  const sig = phoneSignificantDigits(input.callerId);
  if (!sig || sig.length < MIN_SIG_LENGTH) return NO_MATCH;

  try {
    // 1. Customers in THIS org with the same phone signature (org-pinned). Capped so
    //    detecting ">1" (ambiguous) is cheap.
    const customersRes = (await from("customers")
      .select("id, name")
      .eq("org_id", orgId)
      .eq("phone_sig", sig)
      .limit(CUSTOMER_MATCH_CAP)) as Rows<{ id: string; name: string | null }>;
    if (customersRes.error) {
      console.error("[telephony] caller recognition: customer lookup failed", {
        orgId,
        message: customersRes.error.message,
      });
      return NO_MATCH;
    }
    const customerMatches: MatchedCustomer[] = (customersRes.data ?? []).map((r) => ({
      id: r.id,
      name: r.name ?? null,
    }));

    let customerOpenLeadId: string | null = null;
    let phoneOpenLeadId: string | null = null;

    const onlyCustomer = customerMatches[0];
    if (customerMatches.length === 1 && onlyCustomer) {
      // The oldest OPEN lead already linked to this customer — the ongoing matter a
      // callback should fold into rather than duplicate (requirement 4). Oldest-first
      // makes the choice deterministic under concurrent/duplicate deliveries.
      const leadRes = (await from("leads")
        .select("id")
        .eq("org_id", orgId)
        .eq("customer_id", onlyCustomer.id)
        .in("status", LEAD_STAGES_OPEN)
        .order("created_at", { ascending: true })
        .limit(1)) as Rows<{ id: string }>;
      if (!leadRes.error) customerOpenLeadId = leadRes.data?.[0]?.id ?? null;
      else
        console.error("[telephony] caller recognition: customer-lead lookup failed", {
          orgId,
          message: leadRes.error.message,
        });
    } else if (customerMatches.length === 0) {
      // No customer: an OPEN lead on the same number is a repeat caller who is not yet
      // a customer — still the same matter, so link rather than duplicate (req 4/6).
      const leadRes = (await from("leads")
        .select("id")
        .eq("org_id", orgId)
        .eq("contact_phone_sig", sig)
        .in("status", LEAD_STAGES_OPEN)
        .order("created_at", { ascending: true })
        .limit(1)) as Rows<{ id: string }>;
      if (!leadRes.error) phoneOpenLeadId = leadRes.data?.[0]?.id ?? null;
      else
        console.error("[telephony] caller recognition: phone-lead lookup failed", {
          orgId,
          message: leadRes.error.message,
        });
    }

    return decideRecognition({
      withheld: false,
      customerMatches,
      customerOpenLeadId,
      phoneOpenLeadId,
    });
  } catch (e) {
    Sentry.captureException(e, { tags: { service: "caller-recognition" } });
    console.error("[telephony] caller recognition failed", {
      orgId,
      message: e instanceof Error ? e.message : String(e),
    });
    return NO_MATCH;
  }
}
