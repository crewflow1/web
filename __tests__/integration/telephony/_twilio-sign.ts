/**
 * Twilio webhook request signer for SANDBOX integration tests.
 *
 * Builds a Request whose `X-Twilio-Signature` is a REAL, valid Twilio signature
 * over the reconstructed callback URL + form params, computed with the SAME SDK
 * (`twilio.getExpectedTwilioSignature`) the production verifier accepts via
 * `twilio.validateRequest`. This lets a test drive the ACTUAL route POST handler
 * through its fail-closed signature gate without any network to Twilio.
 *
 * SANDBOX, NOT LIVE: the signature is locally computed with a TEST auth token —
 * no real Twilio call, no real number, no telephony provider contacted. A real
 * Twilio round-trip (a genuine inbound PSTN call) remains LIVE-only.
 */

/** A test Twilio auth token — never a real credential. */
export const TEST_TWILIO_AUTH_TOKEN = "test_twilio_auth_token_sandbox_only";
export const TEST_TWILIO_ACCOUNT_SID = "ACsandboxtestaccountsid00000000000";

/**
 * The host + proto the route's `callbackUrl()` will reconstruct from headers.
 * We sign against this exact URL so `validateRequest` matches.
 */
const SIGN_HOST = "127.0.0.1";
const SIGN_PROTO = "http";

export function callbackUrlFor(path: string): string {
  return `${SIGN_PROTO}://${SIGN_HOST}${path}`;
}

/**
 * Build a signed (or deliberately mis-signed) Twilio webhook POST Request for a
 * given route path + form params.
 *
 * @param path       route pathname, e.g. "/api/webhooks/twilio/voice"
 * @param params     the Twilio form-POST params (CallSid, From, To, CallStatus…)
 * @param authToken  the token to sign with (defaults to the test token)
 * @param sign       when false, send NO signature header (unsigned)
 * @param tamper     when true, send a structurally-valid-but-WRONG signature
 */
export async function buildSignedTwilioRequest(opts: {
  path: string;
  params: Record<string, string>;
  authToken?: string;
  sign?: boolean;
  tamper?: boolean;
}): Promise<Request> {
  const { path, params } = opts;
  const authToken = opts.authToken ?? TEST_TWILIO_AUTH_TOKEN;
  const sign = opts.sign ?? true;
  const tamper = opts.tamper ?? false;

  const url = callbackUrlFor(path);
  const rawBody = new URLSearchParams(params).toString();

  const { default: twilio } = await import("twilio");
  const headers: Record<string, string> = {
    host: SIGN_HOST,
    "x-forwarded-proto": SIGN_PROTO,
    "content-type": "application/x-www-form-urlencoded",
  };

  if (sign) {
    const expected = twilio.getExpectedTwilioSignature(authToken, url, params);
    headers["x-twilio-signature"] = tamper
      ? // flip the signature to a valid-shaped but wrong value
        Buffer.from("not-the-right-signature-at-all").toString("base64")
      : expected;
  }

  // The route builds the URL from headers (host + x-forwarded-proto + pathname),
  // so the Request URL's own host is irrelevant beyond its pathname.
  return new Request(`http://${SIGN_HOST}${path}`, {
    method: "POST",
    headers,
    body: rawBody,
  });
}
