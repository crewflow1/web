import type { BrowserContext, Page, Request } from "@playwright/test";

/**
 * Consent network-proof harness (shared by playwright.consent.config.ts and
 * e2e/consent-network.spec.ts).
 *
 * Trackers in this app only load when their public env IDs are configured, so a
 * consent test against an un-configured build proves nothing — a missing gate
 * would simply have nothing to fire. The ARMED run therefore boots the app with
 * DUMMY tracker IDs that point at hosts under the reserved `.invalid` TLD
 * (RFC 2606 — guaranteed never to resolve). A missing or broken consent gate
 * then really does issue a request to the tracker host, which this harness
 * records and answers itself: every non-first-party request is intercepted and
 * fulfilled locally, never continued, so nothing can leave the machine — and
 * even if interception were bypassed the host cannot resolve.
 */

export const DUMMY_POSTHOG_KEY = "phc_e2e_consent_dummy";
export const DUMMY_POSTHOG_HOST = "posthog.e2e.invalid";
export const DUMMY_SENTRY_HOST = "sentry.e2e.invalid";
export const DUMMY_SENTRY_DSN = `https://e2econsentdummy@${DUMMY_SENTRY_HOST}/1`;

/** Env the armed dev server is started with (see playwright.consent.config.ts). */
export const ARMED_TRACKER_ENV: Record<string, string> = {
  NEXT_PUBLIC_POSTHOG_KEY: DUMMY_POSTHOG_KEY,
  NEXT_PUBLIC_POSTHOG_HOST: `https://${DUMMY_POSTHOG_HOST}`,
  NEXT_PUBLIC_SENTRY_DSN: DUMMY_SENTRY_DSN,
  // The browser Sentry SDK stays silent in "development"; a non-dev public env
  // name is what arms it. Server/edge Sentry key off VERCEL_ENV/NODE_ENV and so
  // stay silent — only the browser side is under test here.
  NEXT_PUBLIC_VERCEL_ENV: "preview",
};

/** True when the spec is running against a server started with the dummy IDs. */
export const ARMED = process.env.E2E_CONSENT_ARMED === "1";

export type TrackerHit = {
  /** Which consent category the request belongs to, or why it is allowed. */
  kind: "analytics" | "performance" | "error-report" | "unknown-third-party";
  host: string;
  path: string;
  /** Sentry envelope item types, when the request is a Sentry envelope. */
  itemTypes?: string[];
};

/** Item types of a Sentry envelope body (newline-delimited JSON). */
function sentryItemTypes(body: string | null): string[] {
  if (!body) return [];
  const types: string[] = [];
  for (const line of body.split("\n")) {
    try {
      const json = JSON.parse(line) as { type?: unknown };
      if (typeof json.type === "string") types.push(json.type);
    } catch {
      /* binary / non-JSON payload line */
    }
  }
  return types;
}

/** Item types Sentry may send with no consent: error reports only. */
const SENTRY_ERROR_TYPES = new Set(["event", "attachment", "feedback", "user_report"]);

export type NetworkWatch = {
  /** Every third-party request seen so far (first-party traffic is not listed). */
  hits: TrackerHit[];
  /** Hits that need consent: analytics, performance, or an unknown third party. */
  consentRequired: () => TrackerHit[];
  byKind: (kind: TrackerHit["kind"]) => TrackerHit[];
  /** Forget everything seen so far (start of a new phase). */
  reset: () => void;
  /** Every distinct first-party host that was contacted. */
  firstPartyHosts: Set<string>;
};

/**
 * Record + neutralise every request a browser context makes.
 *
 * First-party = the app origin and the Supabase API origin the app is
 * configured with (auth/session refresh — the service itself). Everything else
 * is third-party: it is classified, recorded, and FULFILLED locally with an
 * empty 200 so the SDK behaves as if its backend answered (and keeps going,
 * which is what makes later assertions meaningful) while nothing leaves.
 */
export async function watchNetwork(
  context: BrowserContext,
  appOrigin: string,
): Promise<NetworkWatch> {
  const firstParty = new Set<string>([new URL(appOrigin).host]);
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (supabaseUrl) firstParty.add(new URL(supabaseUrl).host);

  const hits: TrackerHit[] = [];
  const firstPartyHosts = new Set<string>();

  function classify(request: Request): TrackerHit | null {
    let url: URL;
    try {
      url = new URL(request.url());
    } catch {
      return null;
    }
    if (!/^(https?|wss?):$/.test(url.protocol)) return null; // data:, blob:, about:
    if (firstParty.has(url.host)) {
      firstPartyHosts.add(url.host);
      return null;
    }
    const base = { host: url.host, path: url.pathname };
    if (url.host === DUMMY_POSTHOG_HOST || /(^|\.)posthog\.com$/.test(url.host)) {
      return { kind: "analytics", ...base };
    }
    if (url.host === DUMMY_SENTRY_HOST || /(^|\.)sentry\.io$/.test(url.host)) {
      const itemTypes = sentryItemTypes(request.postData());
      const onlyErrors =
        itemTypes.length > 0 && itemTypes.every((t) => SENTRY_ERROR_TYPES.has(t));
      return { kind: onlyErrors ? "error-report" : "performance", ...base, itemTypes };
    }
    return { kind: "unknown-third-party", ...base };
  }

  await context.route(
    (url) => /^https?:$/.test(url.protocol) && !firstParty.has(url.host),
    async (route) => {
      const type = route.request().resourceType();
      await route.fulfill({
        status: 200,
        contentType: type === "script" ? "application/javascript" : "application/json",
        body: type === "script" ? "" : "{}",
      });
    },
  );
  // `request` fires for every request, including intercepted ones and
  // sendBeacon — so the record does not depend on the route handler running.
  context.on("request", (request) => {
    const hit = classify(request);
    if (hit) hits.push(hit);
  });
  // WebSockets do not surface as `request` events; record any third-party one.
  const watchSockets = (page: Page) =>
    page.on("websocket", (socket) => {
      try {
        const url = new URL(socket.url());
        if (!firstParty.has(url.host)) {
          hits.push({ kind: "unknown-third-party", host: url.host, path: url.pathname });
        }
      } catch {
        /* unparseable socket URL */
      }
    });
  context.pages().forEach(watchSockets);
  context.on("page", watchSockets);

  return {
    hits,
    firstPartyHosts,
    consentRequired: () => hits.filter((h) => h.kind !== "error-report"),
    byKind: (kind) => hits.filter((h) => h.kind === kind),
    reset: () => {
      hits.length = 0;
    },
  };
}

export type DeviceState = {
  cookies: string[];
  localStorage: string[];
  sessionStorage: string[];
  indexedDB: string[];
};

/** Every cookie / storage key currently on the device for this page's origin. */
export async function deviceState(page: Page): Promise<DeviceState> {
  const cookies = (await page.context().cookies()).map((c) => c.name).sort();
  const storage = await page.evaluate(async () => {
    const idb =
      typeof indexedDB.databases === "function"
        ? (await indexedDB.databases()).map((d) => d.name ?? "")
        : [];
    return {
      localStorage: Object.keys(window.localStorage).sort(),
      sessionStorage: Object.keys(window.sessionStorage).sort(),
      indexedDB: idb.sort(),
    };
  });
  return { cookies, ...storage };
}

/**
 * Keys written by `next dev` tooling (HMR / dev overlay), present only because
 * the armed run uses the dev server. They do not exist in a production build
 * and are excluded from the cookie register. Kept as an explicit, reviewed
 * list — never a wildcard — so a new unknown key still fails the spec.
 */
const DEV_TOOLING_KEYS: readonly RegExp[] = [
  /^__next_hmr_refresh_hash__$/,
  /^__nextjs-/,
  /^__next_/,
  /^nextjs-/,
];

const isDevTooling = (key: string) => DEV_TOOLING_KEYS.some((re) => re.test(key));

/**
 * The CONSENT-EXEMPT device storage — every key the app may write without
 * asking, each one registered and justified individually in
 * docs/programme/consent/COOKIE-REGISTER.md. Anything not matched here is, by
 * definition, either consent-required or unregistered — and the spec fails on
 * it until it is added to the register with a reason.
 */
export const EXEMPT_COOKIES: readonly RegExp[] = [
  /^sb-.+-auth-token(\.\d+)?$/, // Supabase session (chunked)
  /^sb-.+-auth-token-code-verifier$/, // Supabase PKCE verifier during sign-in
  /^active_org_id$/, // which workspace the signed-in user is in
  /^cf_impersonation_session$/, // HQ support-access session
  /^cf_cookie_consent$/, // the consent record itself
  // Short-lived (10 min) CSRF/PKCE state for a connect / SSO flow the user starts.
  /^(acct|cal|telem|bank|hmrc)_oauth_(state|verifier|vrn)_.+$/,
  /^cf_oidc_(state|nonce|verifier)_.+$/,
];

export const EXEMPT_LOCAL_STORAGE: readonly RegExp[] = [
  /^cf-nav-expanded$/, // sidebar groups the user expanded
  /^cf-hq-nav-expanded$/, // same, HQ console
  /^cf-cmd-recents$/, // command-palette recent destinations
  /^crewflow-offline-identity$/, // whose offline data is on this device
];

export const EXEMPT_INDEXED_DB: readonly RegExp[] = [
  /^crewflow-offline-(reads|writes|photos)$/,
  /^crewflow-blueprints-offline$/,
];

function unexpected(keys: string[], allowed: readonly RegExp[]): string[] {
  return keys.filter((k) => !isDevTooling(k) && !allowed.some((re) => re.test(k)));
}

/** Keys on the device that are NOT strictly necessary (should be [] pre-consent). */
export function nonEssential(state: DeviceState): DeviceState {
  return {
    cookies: unexpected(state.cookies, EXEMPT_COOKIES),
    localStorage: unexpected(state.localStorage, EXEMPT_LOCAL_STORAGE),
    sessionStorage: unexpected(state.sessionStorage, []),
    indexedDB: unexpected(state.indexedDB, EXEMPT_INDEXED_DB),
  };
}

/** The same state with dev-server tooling keys removed (for exact assertions). */
export function withoutDevTooling(state: DeviceState): DeviceState {
  const strip = (keys: string[]) => keys.filter((k) => !isDevTooling(k));
  return {
    cookies: strip(state.cookies),
    localStorage: strip(state.localStorage),
    sessionStorage: strip(state.sessionStorage),
    indexedDB: strip(state.indexedDB),
  };
}

export const EMPTY_STATE: DeviceState = {
  cookies: [],
  localStorage: [],
  sessionStorage: [],
  indexedDB: [],
};
