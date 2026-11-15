import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { isVoiceProviderConfigured } from "./config";

/**
 * Twilio number PROVISIONING service (Twilio receptionist PR 4).
 *
 * The automated side of "give a CrewFlow customer a phone number": SEARCH the
 * available UK inventory (read-only, safe, non-billable), look up live PRICING,
 * BUY a number (behind an explicit approval + credentials — never automatic),
 * wire its voice webhooks, record the org↔number ownership in `phone_numbers`,
 * and RELEASE a number. It also backs Option A (keep your number) by provisioning
 * a dedicated Twilio RECEIVING number the customer forwards to.
 *
 * SAFETY / DARK POSTURE (mirrors the rest of lib/telephony):
 *   - The Twilio SDK is imported LAZILY and the REST client is built from env at
 *     CALL TIME (API key preferred, else Account SID + Auth Token). No credential
 *     ⇒ a safe null / "not configured" result, never a throw at import.
 *   - SEARCH + PRICING are read-only and cost nothing.
 *   - BUY + RELEASE are side-effectful + billable, so they REQUIRE `approved:true`
 *     AND resolvable credentials. Without approval they refuse with a clear reason.
 *     The caller (a server action) is responsible for org-admin authorisation
 *     BEFORE calling; writes here are org-pinned on the admin client.
 */

/** A UK E.164 validator — the only number shape we provision/record. */
const E164 = /^\+[1-9]\d{6,14}$/;

export type UkNumberType = "local" | "national" | "mobile" | "tollfree";

/** A candidate number from the available-inventory search (read-only). */
export type AvailableNumber = {
  e164: string;
  friendlyName: string | null;
  locality: string | null;
  region: string | null;
  type: UkNumberType;
  capabilities: { voice: boolean; sms: boolean; mms: boolean };
};

/** Live monthly rental price per number type, in pence (from the Pricing API). */
export type NumberPricing = {
  country: string;
  currency: string;
  monthlyPence: Partial<Record<UkNumberType, number>>;
};

export type ProvisionResult =
  | { ok: true; e164: string; providerNumberSid: string; phoneNumberId: string }
  | { ok: false; error: string; reason: "not_approved" | "no_credentials" | "invalid_input" | "provider_error" };

export type ReleaseResult =
  | { ok: true }
  | { ok: false; error: string; reason: "not_approved" | "no_credentials" | "not_found" | "provider_error" };

// ── Lazy, credential-resolved Twilio REST client ────────────────────────────

/** Minimal structural type for the bits of the Twilio REST client we use. */
type TwilioRest = {
  availablePhoneNumbers: (country: string) => Record<
    "local" | "national" | "mobile" | "tollFree",
    { list: (opts: Record<string, unknown>) => Promise<RawAvailable[]> }
  >;
  incomingPhoneNumbers: {
    (sid: string): {
      update: (opts: Record<string, unknown>) => Promise<unknown>;
      remove: () => Promise<boolean>;
    };
    create: (opts: Record<string, unknown>) => Promise<{ sid: string; phoneNumber: string }>;
  };
  pricing: {
    v1: { phoneNumbers: { countries: (c: string) => { fetch: () => Promise<RawPricing> } } };
  };
};

type RawAvailable = {
  phoneNumber?: string;
  friendlyName?: string;
  locality?: string;
  region?: string;
  capabilities?: { voice?: boolean; SMS?: boolean; sms?: boolean; MMS?: boolean; mms?: boolean };
};
type RawPricing = {
  priceUnit?: string;
  phoneNumberPrices?: Array<{ number_type?: string; numberType?: string; current_price?: string; currentPrice?: string; base_price?: string }>;
};

/**
 * Build a Twilio REST client from env at call time, or null if no credential is
 * resolvable. Prefers a restricted API key (TWILIO_API_KEY_SID/SECRET, scoped to
 * the account via TWILIO_ACCOUNT_SID) over the Account SID + Auth Token.
 */
async function getTwilioRestClient(): Promise<TwilioRest | null> {
  const accountSid = process.env.TWILIO_ACCOUNT_SID?.trim();
  const apiKeySid = process.env.TWILIO_API_KEY_SID?.trim();
  const apiKeySecret = process.env.TWILIO_API_KEY_SECRET?.trim();
  const authToken = process.env.TWILIO_AUTH_TOKEN?.trim();
  try {
    const { default: twilio } = await import("twilio");
    if (apiKeySid && apiKeySecret && accountSid) {
      return twilio(apiKeySid, apiKeySecret, { accountSid }) as unknown as TwilioRest;
    }
    if (accountSid && authToken) {
      return twilio(accountSid, authToken) as unknown as TwilioRest;
    }
    return null;
  } catch (e) {
    console.error("[telephony/provisioning] twilio client build failed", {
      message: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}

/** Map our number type onto the Twilio SDK's availablePhoneNumbers sub-resource. */
function typeResource(t: UkNumberType): "local" | "national" | "mobile" | "tollFree" {
  switch (t) {
    case "national":
      return "national";
    case "mobile":
      return "mobile";
    case "tollfree":
      return "tollFree";
    default:
      return "local";
  }
}

// ── Read-only: search + pricing ─────────────────────────────────────────────

/**
 * Search the available UK inventory for a number type (read-only, non-billable).
 * Returns [] when no credential is resolvable or on any provider error — a search
 * must never throw into a UI.
 */
export async function searchAvailableNumbers(opts: {
  country?: string;
  type?: UkNumberType;
  areaCode?: string;
  contains?: string;
  limit?: number;
}): Promise<AvailableNumber[]> {
  const country = (opts.country ?? "GB").toUpperCase();
  const type = opts.type ?? "local";
  const limit = Math.max(1, Math.min(30, opts.limit ?? 10));
  const client = await getTwilioRestClient();
  if (!client) return [];
  try {
    const params: Record<string, unknown> = { voiceEnabled: true, limit };
    if (opts.areaCode) params.areaCode = opts.areaCode;
    if (opts.contains) params.contains = opts.contains;
    const rows = await client.availablePhoneNumbers(country)[typeResource(type)].list(params);
    return rows
      .filter((r) => typeof r.phoneNumber === "string" && E164.test(r.phoneNumber))
      .map((r) => ({
        e164: r.phoneNumber as string,
        friendlyName: r.friendlyName ?? null,
        locality: r.locality ?? null,
        region: r.region ?? null,
        type,
        capabilities: {
          voice: r.capabilities?.voice ?? true,
          sms: r.capabilities?.SMS ?? r.capabilities?.sms ?? false,
          mms: r.capabilities?.MMS ?? r.capabilities?.mms ?? false,
        },
      }));
  } catch (e) {
    console.error("[telephony/provisioning] search failed", {
      country,
      type,
      message: e instanceof Error ? e.message : String(e),
    });
    return [];
  }
}

/** Look up live monthly rental pricing per number type (read-only). Null on failure. */
export async function getNumberPricing(country = "GB"): Promise<NumberPricing | null> {
  const client = await getTwilioRestClient();
  if (!client) return null;
  try {
    const data = await client.pricing.v1.phoneNumbers.countries(country.toUpperCase()).fetch();
    const monthlyPence: Partial<Record<UkNumberType, number>> = {};
    for (const p of data.phoneNumberPrices ?? []) {
      const rawType = (p.number_type ?? p.numberType ?? "").toLowerCase();
      const priceStr = p.current_price ?? p.currentPrice ?? p.base_price;
      const price = priceStr != null ? Number(priceStr) : NaN;
      if (!Number.isFinite(price)) continue;
      const pence = Math.round(price * 100);
      if (rawType === "local") monthlyPence.local = pence;
      else if (rawType === "national") monthlyPence.national = pence;
      else if (rawType === "mobile") monthlyPence.mobile = pence;
      else if (rawType === "toll free" || rawType === "tollfree" || rawType === "toll-free")
        monthlyPence.tollfree = pence;
    }
    return { country: country.toUpperCase(), currency: data.priceUnit ?? "GBP", monthlyPence };
  } catch (e) {
    console.error("[telephony/provisioning] pricing failed", {
      message: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}

// ── Side-effectful: provision / configure / release (approval-gated) ─────────

/** Build the voice webhook URLs for a public app base URL. */
export function voiceWebhookUrls(baseUrl: string): {
  voiceUrl: string;
  voiceFallbackUrl: string;
  statusCallback: string;
} {
  const b = baseUrl.replace(/\/+$/, "");
  return {
    voiceUrl: `${b}/api/webhooks/twilio/voice`,
    voiceFallbackUrl: `${b}/api/webhooks/twilio/voice`,
    statusCallback: `${b}/api/webhooks/twilio/voice/status`,
  };
}

/**
 * BUY a number and assign it to an org. Billable + side-effectful, so it REFUSES
 * unless `approved:true` AND Twilio credentials are resolvable. On success it
 * configures the voice webhooks, attaches the UK RC bundle + emergency address
 * when supplied, and records the org↔number ownership in `phone_numbers`
 * (active, org-pinned). `onboardingMode` 'existing_number_forward' records a
 * forwarding RECEIVER (Option A) with the org's original number in `forwardingFrom`.
 */
export async function provisionNumber(opts: {
  orgId: string;
  e164: string;
  type: UkNumberType;
  appBaseUrl: string;
  approved: boolean;
  bundleSid?: string | null;
  emergencyAddressSid?: string | null;
  monthlyCostPence?: number | null;
  onboardingMode?: "new_number" | "existing_number_forward";
  forwardingFrom?: string | null;
  label?: string | null;
  createdBy?: string | null;
}): Promise<ProvisionResult> {
  if (!opts.approved) {
    return { ok: false, error: "Provisioning requires explicit approval.", reason: "not_approved" };
  }
  if (!opts.orgId?.trim() || !E164.test(opts.e164)) {
    return { ok: false, error: "A valid org id and E.164 number are required.", reason: "invalid_input" };
  }
  if (!isVoiceProviderConfigured("twilio")) {
    return { ok: false, error: "Twilio credentials are not configured.", reason: "no_credentials" };
  }
  const client = await getTwilioRestClient();
  if (!client) {
    return { ok: false, error: "Twilio credentials are not configured.", reason: "no_credentials" };
  }

  const urls = voiceWebhookUrls(opts.appBaseUrl);
  try {
    const createOpts: Record<string, unknown> = {
      phoneNumber: opts.e164,
      voiceUrl: urls.voiceUrl,
      voiceMethod: "POST",
      voiceFallbackUrl: urls.voiceFallbackUrl,
      voiceFallbackMethod: "POST",
      statusCallback: urls.statusCallback,
      statusCallbackMethod: "POST",
    };
    if (opts.bundleSid) createOpts.bundleSid = opts.bundleSid;
    if (opts.emergencyAddressSid) createOpts.emergencyAddressSid = opts.emergencyAddressSid;
    if (opts.label) createOpts.friendlyName = opts.label;

    const bought = await client.incomingPhoneNumbers.create(createOpts);
    if (!bought?.sid) {
      return { ok: false, error: "Twilio returned no number SID.", reason: "provider_error" };
    }

    // Record the org↔number ownership (org-pinned, admin client). active=true is
    // allowed because provider_number_sid is now present (the DB CHECK).
    const admin = createAdminClient();
    const { data, error } = await (
      admin.from("phone_numbers" as never) as unknown as {
        insert: (row: unknown) => {
          select: (cols: string) => {
            single: () => Promise<{ data: { id: string } | null; error: { message: string } | null }>;
          };
        };
      }
    )
      .insert({
        org_id: opts.orgId,
        provider: "twilio",
        e164: bought.phoneNumber ?? opts.e164,
        provider_number_sid: bought.sid,
        number_type: opts.onboardingMode === "existing_number_forward" ? "forwarding" : opts.type,
        monthly_cost_pence: opts.monthlyCostPence ?? null,
        regulatory_bundle_sid: opts.bundleSid ?? null,
        emergency_address_sid: opts.emergencyAddressSid ?? null,
        onboarding_mode: opts.onboardingMode ?? "new_number",
        forwarding_from: opts.forwardingFrom ?? null,
        label: opts.label ?? null,
        active: true,
        provisioned_at: new Date().toISOString(),
        created_by: opts.createdBy ?? null,
      })
      .select("id")
      .single();

    if (error || !data) {
      // The number was bought but the ownership record failed — surface loudly so
      // an operator can reconcile (the number exists on Twilio).
      console.error("[telephony/provisioning] ownership record failed after purchase", {
        sid: bought.sid,
        message: error?.message,
      });
      return {
        ok: false,
        error: "Number purchased but recording ownership failed — reconcile manually.",
        reason: "provider_error",
      };
    }

    return { ok: true, e164: bought.phoneNumber ?? opts.e164, providerNumberSid: bought.sid, phoneNumberId: data.id };
  } catch (e) {
    console.error("[telephony/provisioning] purchase failed", {
      message: e instanceof Error ? e.message : String(e),
    });
    return { ok: false, error: e instanceof Error ? e.message : "Provider error.", reason: "provider_error" };
  }
}

/**
 * Re-point an EXISTING provisioned number's voice webhooks at this app (e.g. after
 * a domain change, or to repair config). Read-modify on Twilio only — does not
 * touch the DB. Approval-gated + credential-gated.
 */
export async function configureNumberWebhooks(opts: {
  providerNumberSid: string;
  appBaseUrl: string;
  approved: boolean;
}): Promise<{ ok: boolean; error?: string }> {
  if (!opts.approved) return { ok: false, error: "Configuration requires explicit approval." };
  const client = await getTwilioRestClient();
  if (!client) return { ok: false, error: "Twilio credentials are not configured." };
  const urls = voiceWebhookUrls(opts.appBaseUrl);
  try {
    await client.incomingPhoneNumbers(opts.providerNumberSid).update({
      voiceUrl: urls.voiceUrl,
      voiceMethod: "POST",
      voiceFallbackUrl: urls.voiceFallbackUrl,
      voiceFallbackMethod: "POST",
      statusCallback: urls.statusCallback,
      statusCallbackMethod: "POST",
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Provider error." };
  }
}

/**
 * RELEASE a number: remove it from Twilio (stops the monthly charge) and
 * deactivate the `phone_numbers` row (active=false, released_at). Billable-impact
 * + destructive, so it REQUIRES `approved:true`. Org-pinned.
 */
export async function releaseNumber(opts: {
  orgId: string;
  providerNumberSid: string;
  approved: boolean;
}): Promise<ReleaseResult> {
  if (!opts.approved) return { ok: false, error: "Release requires explicit approval.", reason: "not_approved" };
  const client = await getTwilioRestClient();
  if (!client) return { ok: false, error: "Twilio credentials are not configured.", reason: "no_credentials" };
  try {
    await client.incomingPhoneNumbers(opts.providerNumberSid).remove();
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Provider error.", reason: "provider_error" };
  }
  try {
    const admin = createAdminClient();
    await (
      admin.from("phone_numbers" as never) as unknown as {
        update: (row: unknown) => {
          eq: (k: string, v: unknown) => { eq: (k: string, v: unknown) => Promise<{ error: unknown }> };
        };
      }
    )
      .update({ active: false, released_at: new Date().toISOString() })
      .eq("org_id", opts.orgId)
      .eq("provider_number_sid", opts.providerNumberSid);
    return { ok: true };
  } catch (e) {
    // The number IS released on Twilio; the row deactivation failed. Surface it.
    console.error("[telephony/provisioning] row deactivation failed after release", {
      message: e instanceof Error ? e.message : String(e),
    });
    return { ok: false, error: "Released on Twilio but row update failed — reconcile.", reason: "provider_error" };
  }
}
