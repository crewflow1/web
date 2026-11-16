/**
 * Content-Security-Policy — the single source of truth for every CSP header
 * CrewFlow emits. Pure and Edge-safe (no Node imports): consumed by
 * `middleware.ts` (per-request, nonce-bearing policy) and by
 * `lib/security/headers.ts` → `next.config.ts` (the build-time fallback policy
 * on responses the middleware does not see). Unit-tested in
 * `__tests__/security/csp.test.ts`; browser-verified in `e2e/csp.spec.ts`.
 *
 * ---------------------------------------------------------------------------
 * Two policies, chosen by HOW the route's HTML is produced
 * ---------------------------------------------------------------------------
 * 1. NONCE policy — every dynamically rendered route (the authenticated app,
 *    HQ/admin, customer + worker portals, public quote pages, auth flows,
 *    developer docs, API responses). Middleware mints a fresh 128-bit nonce per
 *    request and forwards the policy on the REQUEST so Next.js stamps the
 *    nonce onto every framework/inline script it renders
 *    (next/dist/server/app-render reads it from the request CSP header):
 *        script-src 'self' 'nonce-…' 'strict-dynamic' 'wasm-unsafe-eval'
 *    No 'unsafe-inline' and no 'unsafe-eval': an injected <script> or inline
 *    event handler (onerror=…) does not run. 'strict-dynamic' lets the trusted
 *    (nonced) webpack runtime load its own chunks and lazy imports.
 *
 * 2. STATIC policy — routes whose HTML is PRERENDERED at build time (the
 *    marketing/SEO pages, legal pages, the password-reset request page, the
 *    PWA offline shell). That HTML is generated once, before any request
 *    exists, so it cannot carry a per-request nonce; it is served from the
 *    CDN. Forcing those ~85 pages to render per request purely to carry a
 *    nonce would trade away their static/CDN delivery (TTFB → LCP, crawl
 *    budget, a function invocation per page view) for little gain: their
 *    content is repo-authored and identical for every visitor, with no user
 *    data and no request input reflected (a prerendered page cannot echo a
 *    query string). They therefore get:
 *        script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'
 *    which still forbids eval and every third-party script origin, plugins,
 *    <base> hijacking, framing, and exfiltration to unlisted origins.
 *    Next's own static HTML relies on inline flight-data scripts, so
 *    'unsafe-inline' is unavoidable there (hashes are per-page and unknown
 *    until after the build; Next 15 has no inline-hash support).
 *
 *    Soft (client-side) navigation keeps the policy of the document that was
 *    first loaded. To stop an app session from running under the static
 *    policy after a soft navigation from a marketing page, middleware answers
 *    a static-document → nonce-route RSC navigation with a non-RSC response,
 *    which makes the Next router fall back to a full document load (see
 *    `isCspClassBoundaryCrossing`). Every sign-in path already ends in a full
 *    navigation (`window.location.assign`, OAuth and magic-link redirects).
 *
 * Unknown paths default to the NONCE class, so the 404 for an unmatched URL
 * must be rendered per request: app/global-not-found.tsx (enabled by
 * `experimental.globalNotFound`) calls `connection()`. app/not-found.tsx must
 * stay free of dynamic APIs — it is embedded in every page's payload, and a
 * dynamic API there turns every prerendered page dynamic.
 *
 * The prerendered set is pinned against the real build output by
 * `e2e/csp.spec.ts` (it reads `.next/prerender-manifest.json`): a new static
 * page that is not listed in STATIC_POLICY_PREFIXES fails the E2E tier,
 * because under the nonce policy its un-nonced scripts would be blocked.
 * Misclassifying in the other direction (a dynamic route listed as static)
 * only weakens that page to the static policy — it never breaks it.
 *
 * ---------------------------------------------------------------------------
 * Origin allow-list (everything else is denied by default-src 'self')
 * ---------------------------------------------------------------------------
 *   - Supabase: the project's EXACT origin from NEXT_PUBLIC_SUPABASE_URL (REST,
 *     Auth, Storage signed URLs) plus its ws/wss twin (Realtime). Not the
 *     `*.supabase.co` wildcard — that would let injected code post data to
 *     any attacker-owned Supabase project.
 *   - Sentry: the exact ingest origin parsed from NEXT_PUBLIC_SENTRY_DSN, and
 *     only when a DSN is configured (monitoring is dark otherwise).
 *   - PostHog: NEXT_PUBLIC_POSTHOG_HOST (+ its `-assets` CDN for the EU/US
 *     clouds), only when NEXT_PUBLIC_POSTHOG_KEY is configured. Whether the
 *     SDK actually loads is decided by the consent gate in lib/analytics —
 *     the CSP only permits the endpoints once analytics is configured.
 *   - Vercel toolbar (vercel.live + Pusher websockets): preview deployments
 *     only (VERCEL_ENV=preview); absent in production.
 *   - Stripe: hosted Checkout / Billing Portal are top-level redirects, never
 *     embedded — there is no Stripe.js in this app. They appear only in
 *     form-action (a no-JS server-action POST answers with a 303 to Stripe,
 *     and browsers check form-action on every redirect hop). Google and
 *     Microsoft sign-in, and the Supabase authorize endpoint in front of them,
 *     are listed for the same reason (the login page's OAuth buttons are
 *     server-action forms that redirect).
 *
 * 'wasm-unsafe-eval' is kept for the Blueprint pdf.js viewer's WebAssembly
 * image codecs: it permits WebAssembly compilation only, NOT string→JS eval.
 * pdf.js runs with `isEvalSupported:false`.
 *
 * style-src keeps 'unsafe-inline' (documented residual): React/SSR emit
 * ~110 `style={{…}}` attributes, framer-motion animates via inline styles and
 * the maintenance page is inline-styled. Style attributes cannot carry a
 * nonce, and CSS injection is a far weaker primitive than script execution.
 *
 * Rollout safety: CSP_MODE=report-only (env, then redeploy — no code change)
 * downgrades every policy to `Content-Security-Policy-Report-Only`. Anything
 * else, including unset, ENFORCES.
 */

export type CspMode = "enforce" | "report-only";
export type CspClass = "nonce" | "static";

/** Same-origin endpoint that receives violation reports (app/api/csp-report). */
export const CSP_REPORT_PATH = "/api/csp-report";
/** Reporting API group name used by `report-to` + `Reporting-Endpoints`. */
export const CSP_REPORT_GROUP = "csp-endpoint";
/** Request header carrying the per-request nonce to server components. */
export const NONCE_HEADER = "x-nonce";

/**
 * Path prefixes whose HTML is prerendered at build time (see the module doc).
 * Segment-aware: "/tools" matches "/tools" and "/tools/vat-calculator", never
 * "/toolbox". "/" matches the home page exactly. Keep in sync with the build
 * (○/● routes) — enforced by e2e/csp.spec.ts.
 */
export const STATIC_POLICY_PREFIXES: readonly string[] = [
  "/blog",
  "/compare",
  "/construction-software",
  "/features",
  "/industries",
  "/product",
  "/pricing",
  "/tools",
  "/privacy",
  "/terms",
  "/reset-password",
  "/offline",
];

/** Which policy class a request path belongs to. Unknown paths → "nonce". */
export function cspClassForPath(pathname: string): CspClass {
  if (pathname === "/" || pathname === "") return "static";
  for (const prefix of STATIC_POLICY_PREFIXES) {
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) return "static";
  }
  return "nonce";
}

/** CSP_MODE → mode. Only an explicit "report-only" relaxes; default enforces. */
export function resolveCspMode(raw: string | undefined = process.env.CSP_MODE): CspMode {
  return (raw ?? "").trim().toLowerCase() === "report-only" ? "report-only" : "enforce";
}

export function cspHeaderName(mode: CspMode): string {
  return mode === "report-only"
    ? "Content-Security-Policy-Report-Only"
    : "Content-Security-Policy";
}

/**
 * A fresh base64 nonce from 16 CSPRNG bytes (128 bits). Web Crypto only, so it
 * runs unchanged in the Edge middleware runtime and in Node.
 */
export function generateNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** base64 / base64url, as accepted by Next's nonce parser. */
export const NONCE_PATTERN = /^[A-Za-z0-9+/_-]{22,}={0,2}$/;

export type CspSources = {
  /** e.g. "https://abc.supabase.co" (http://127.0.0.1:54321 locally). */
  supabaseOrigin: string | null;
  sentryOrigin: string | null;
  posthogOrigins: { api: string; assets: string | null } | null;
  vercelPreview: boolean;
};

function originOf(raw: string | undefined | null): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return u.origin;
  } catch {
    return null;
  }
}

/** The ws(s) twin of an http(s) origin (Supabase Realtime). */
function wsOriginOf(origin: string): string {
  return origin.replace(/^http/, "ws");
}

type CspEnv = Record<string, string | undefined>;

/**
 * Resolve the third-party origins the policy must allow from the environment.
 * Every NEXT_PUBLIC_* value is build-time inlined, so the policy always
 * matches what the client bundle actually talks to.
 */
export function resolveCspSources(env: CspEnv = process.env): CspSources {
  const supabaseOrigin = originOf(env.NEXT_PUBLIC_SUPABASE_URL);

  const sentryOrigin = originOf(env.NEXT_PUBLIC_SENTRY_DSN);

  let posthogOrigins: CspSources["posthogOrigins"] = null;
  if ((env.NEXT_PUBLIC_POSTHOG_KEY ?? "").trim()) {
    const api = originOf(env.NEXT_PUBLIC_POSTHOG_HOST) ?? "https://eu.i.posthog.com";
    const cloud = /^https:\/\/(eu|us)\.i\.posthog\.com$/.exec(api);
    posthogOrigins = { api, assets: cloud ? `https://${cloud[1]}-assets.i.posthog.com` : null };
  }

  const vercelEnv = env.VERCEL_ENV ?? env.NEXT_PUBLIC_VERCEL_ENV;
  return { supabaseOrigin, sentryOrigin, posthogOrigins, vercelPreview: vercelEnv === "preview" };
}

export type BuildCspOptions = {
  /** Present → nonce policy. Absent → static policy. */
  nonce?: string;
  sources: CspSources;
  /** Emit upgrade-insecure-requests (only when served over https). */
  upgradeInsecureRequests: boolean;
};

const join = (parts: Array<string | null | false | undefined>) =>
  parts.filter(Boolean).join(" ");

/** Build the policy string. See the module doc for every directive's reason. */
export function buildCsp({ nonce, sources, upgradeInsecureRequests }: BuildCspOptions): string {
  if (nonce !== undefined && !NONCE_PATTERN.test(nonce)) {
    throw new Error("buildCsp: malformed nonce");
  }
  const { supabaseOrigin, sentryOrigin, posthogOrigins, vercelPreview } = sources;
  const supabase = supabaseOrigin ? [supabaseOrigin] : [];
  const supabaseWs = supabaseOrigin ? [wsOriginOf(supabaseOrigin)] : [];
  const vercel = vercelPreview ? "https://vercel.live" : null;

  const scriptSrc = nonce
    ? join(["script-src 'self'", `'nonce-${nonce}'`, "'strict-dynamic'", "'wasm-unsafe-eval'", posthogOrigins?.assets, vercel])
    : join(["script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'", posthogOrigins?.assets, vercel]);

  const directives = [
    "default-src 'self'",
    scriptSrc,
    "style-src 'self' 'unsafe-inline'",
    join(["img-src 'self' data: blob:", ...supabase, posthogOrigins?.api, vercelPreview && "https://vercel.com"]),
    "font-src 'self' data:",
    join([
      "connect-src 'self'",
      ...supabase,
      ...supabaseWs,
      sentryOrigin,
      posthogOrigins?.api,
      posthogOrigins?.assets,
      vercel,
      vercelPreview && "wss://*.pusher.com",
    ]),
    join(["media-src 'self' data: blob:", ...supabase]),
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    join(["frame-src 'self'", vercel]),
    "object-src 'none'",
    "base-uri 'self'",
    join([
      "form-action 'self'",
      ...supabase,
      "https://accounts.google.com https://login.microsoftonline.com",
      "https://checkout.stripe.com https://billing.stripe.com",
    ]),
    "frame-ancestors 'none'",
    upgradeInsecureRequests && "upgrade-insecure-requests",
    `report-uri ${CSP_REPORT_PATH}`,
    `report-to ${CSP_REPORT_GROUP}`,
  ];
  return directives.filter(Boolean).join("; ");
}

/** `Reporting-Endpoints` value pairing with `report-to` (absolute when known). */
export function reportingEndpointsValue(origin?: string | null): string {
  const url = origin ? `${origin}${CSP_REPORT_PATH}` : CSP_REPORT_PATH;
  return `${CSP_REPORT_GROUP}="${url}"`;
}

/**
 * True when a client-side (RSC) navigation would carry a document that was
 * loaded under the STATIC policy onto a NONCE-class route. Middleware answers
 * those with a non-RSC response so the Next router performs a full document
 * load and the destination runs under its own nonce policy.
 *
 * Signal: the `Next-Url` request header. The Next client router sends it on
 * its RSC navigation + prefetch fetches (it is the router's current path) and
 * a browser never sends it on a document request. (The `RSC` header itself
 * is NOT usable here: Next strips the flight headers — and the `_rsc` query —
 * from the request middleware sees; next/dist/server/web/adapter.js.)
 * `Next-Action` marks a server action, which posts to the CURRENT page and is
 * never intercepted. Lazy segment fetches that omit `Next-Url` only happen
 * after a successful (i.e. un-intercepted) prefetch, so intercepting the
 * prefetch / navigation fetch is sufficient.
 */
export function isCspClassBoundaryCrossing(args: {
  method: string;
  pathname: string;
  nextUrlHeader: string | null;
  nextActionHeader: string | null;
}): boolean {
  if (args.method !== "GET" || args.nextActionHeader) return false;
  if (!args.nextUrlHeader) return false;
  let from: string;
  try {
    from = new URL(args.nextUrlHeader, "http://x").pathname;
  } catch {
    return false;
  }
  return cspClassForPath(from) === "static" && cspClassForPath(args.pathname) === "nonce";
}
