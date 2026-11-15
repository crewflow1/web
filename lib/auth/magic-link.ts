import "server-only";

/**
 * Build the magic-link URL we embed in our own (Resend) branded emails.
 *
 * WHY THIS EXISTS — the action_link vs token_hash trap.
 * -----------------------------------------------------
 * `supabase.auth.admin.generateLink({ type: "magiclink", ... })` returns a
 * `properties.action_link` of the form:
 *
 *     {SUPABASE_URL}/auth/v1/verify?token=<hashed>&type=magiclink&redirect_to=<app>
 *
 * That URL points at GoTrue's *hosted* verify endpoint. When a user clicks it,
 * GoTrue verifies (and CONSUMES) the one-time token and 303-redirects to
 * `redirect_to` with the session in the URL **hash fragment**
 * (`#access_token=...&refresh_token=...`) — the implicit flow.
 *
 * A hash fragment is client-only: it is NEVER sent to the server. Our
 * `/auth/callback` is a server Route Handler that reads `?code` / `?token_hash`
 * from the QUERY STRING (see app/auth/callback/route.ts). So embedding the raw
 * `action_link` means:
 *   - the one-time token is burned by GoTrue's verify,
 *   - the browser lands on `<app>#access_token=...` which the server callback
 *     cannot read → it sees neither `code` nor `token_hash` → `missing_code`
 *     → the user is bounced to /login, invite/onboarding never completes.
 *
 * The callback was always built to receive the PKCE-less `token_hash` + `type`
 * shape (it calls `verifyOtp({ token_hash, type })`, which works cross-device
 * with no `code_verifier` cookie). The missing piece was constructing the email
 * link in THAT shape instead of handing over GoTrue's hosted action_link.
 *
 * This helper does exactly that: it takes the `hashed_token` from the
 * generateLink response and returns a link straight at our own callback:
 *
 *     {appUrl}/auth/callback?token_hash=<hashed>&type=<type>[&next=<path>]
 *
 * which the server callback verifyOtp-exchanges and then lands the user. No
 * GoTrue hosted redirect, no hash fragment, no reliance on the project's
 * redirect allow-list (we never hit the hosted verify endpoint at all).
 */

/** The subset of generateLink's `properties` we rely on. */
export type GeneratedLinkProperties = {
  hashed_token?: string | null;
  action_link?: string | null;
} | null | undefined;

export type BuildMagicLinkArgs = {
  /** Origin of the app, e.g. env.NEXT_PUBLIC_APP_URL (trailing slash stripped). */
  appUrl: string;
  /** `properties` from supabase.auth.admin.generateLink(...). */
  properties: GeneratedLinkProperties;
  /** OTP type to verify as. Matches the generateLink `type`. */
  type?: "magiclink" | "invite" | "recovery" | "email";
  /** Optional in-app landing to carry through as ?next=. Must be a local path. */
  next?: string | null;
};

/**
 * Returns a `/auth/callback?token_hash=...&type=...` URL, or `null` when the
 * generateLink response carried no `hashed_token` (callers treat a null link as
 * non-fatal and fall back to /login recovery copy).
 */
export function buildCallbackMagicLink(args: BuildMagicLinkArgs): string | null {
  const hashedToken = args.properties?.hashed_token ?? null;
  if (!hashedToken) return null;

  const base = args.appUrl.replace(/\/$/, "");
  const type = args.type ?? "magiclink";
  const params = new URLSearchParams({
    token_hash: hashedToken,
    type,
  });
  // Only honour a local path for `next` (defence-in-depth; the callback also
  // re-validates). Never let an absolute/protocol-relative URL through.
  if (args.next && args.next.startsWith("/") && !args.next.startsWith("//")) {
    params.set("next", args.next);
  }
  return `${base}/auth/callback?${params.toString()}`;
}
