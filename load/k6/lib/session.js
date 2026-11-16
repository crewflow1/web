// load/k6/lib/session.js — real sessions for virtual users.
//
// The product authenticates with Supabase Auth via @supabase/ssr: the session
// (access token + refresh token + user) is a JSON blob stored in the cookie
//   sb-<first label of the Supabase host>-auth-token = "base64-" + base64url(JSON)
// split into `.0`, `.1`, … chunks of 3180 characters when it is too long.
// Middleware validates it against Supabase Auth on EVERY matched request and,
// when the access token has expired, refreshes it and re-issues the cookie —
// which the VU's cookie jar picks up, exactly like a browser.
//
// LOGIN_MODE=app    (default) signs in through the product's own Server Action:
//                   rate limiter → Supabase Auth → user bootstrap → AAL check →
//                   Set-Cookie. This is what a person does and what a login storm
//                   really costs.
// LOGIN_MODE=gotrue password grant straight to Supabase Auth and the cookie is
//                   built here. Bypasses the Next server on login (use only to
//                   isolate app capacity from Auth capacity).
import http from "k6/http";
import encoding from "k6/encoding";
import { check } from "k6";
import { Counter, Trend } from "k6/metrics";
import { ANON_KEY, BASE_URL, LOGIN_MODE, PASSWORD, SUPABASE_URL } from "./config.js";
import { actionResult, callAction } from "./actions.js";
import { rateLimited } from "./http.js";

export const logins = new Counter("logins");
export const loginFailures = new Counter("login_failures");
export const loginDuration = new Trend("login_duration", true);

const CHUNK = 3180;
const cookieKey = `sb-${/^https?:\/\/([^/:.]+)/.exec(SUPABASE_URL)[1]}-auth-token`;

function setSessionCookie(session) {
  const jar = http.cookieJar();
  const value = "base64-" + encoding.b64encode(JSON.stringify(session), "rawurl");
  if (value.length <= CHUNK) {
    jar.set(BASE_URL, cookieKey, value, { path: "/" });
    return;
  }
  for (let i = 0, n = 0; i < value.length; i += CHUNK, n++) {
    jar.set(BASE_URL, `${cookieKey}.${n}`, value.slice(i, i + CHUNK), { path: "/" });
  }
}

export function hasSessionCookie() {
  const c = http.cookieJar().cookiesForURL(BASE_URL);
  for (const k in c) if (k.indexOf(cookieKey) === 0) return true;
  return false;
}

/** Sign in. Returns true on success. `actions.signIn` comes from setup(). */
export function login(email, actions) {
  const t0 = Date.now();
  let ok = false;
  if (LOGIN_MODE === "gotrue" || !actions.signIn) {
    const res = http.post(
      `${SUPABASE_URL}/auth/v1/token?grant_type=password`,
      JSON.stringify({ email, password: PASSWORD }),
      { headers: { apikey: ANON_KEY, "Content-Type": "application/json" }, tags: { name: "auth:password_grant", kind: "auth" } },
    );
    if (res.status === 429) rateLimited.add(1, { name: "auth:password_grant" });
    if (res.status === 200) {
      setSessionCookie(res.json());
      ok = true;
    }
  } else {
    const res = callAction("/login", actions.signIn, [null], { email, password: PASSWORD }, "action:signIn");
    const r = actionResult(res);
    if (r.ok === false && r.error && r.error.indexOf("Too many") !== -1) rateLimited.add(1, { name: "action:signIn" });
    ok = res.status === 200 && r.ok === true && hasSessionCookie();
  }
  loginDuration.add(Date.now() - t0);
  check(ok, { "login ok": (v) => v === true });
  if (ok) logins.add(1);
  else loginFailures.add(1);
  return ok;
}

export function logout(actions) {
  if (actions.signOut) callAction("/dashboard", actions.signOut, [], {}, "action:signOut");
  http.cookieJar().clear(BASE_URL);
}

/**
 * Per-VU session lifecycle. A VU signs in once, works for a random number of
 * tasks (a "shift"), signs out, and signs back in — never more than 4 sign-ins
 * per 10 minutes, the product's own per-identity auth limit being 5.
 */
export function makeSession(identity, minTasks, maxTasks) {
  const s = { in: false, left: 0, stamps: [] };
  return {
    ensure(actions) {
      if (s.in && s.left > 0) {
        s.left--;
        return true;
      }
      const now = Date.now();
      s.stamps = s.stamps.filter((t) => now - t < 600000);
      if (s.in && s.stamps.length >= 4) {
        // budget exhausted — keep the current session rather than trip the limiter
        s.left = 5;
        return true;
      }
      if (s.in) logout(actions);
      s.in = false;
      if (s.stamps.length >= 4) return false;
      s.stamps.push(now);
      s.in = login(identity.email, actions);
      s.left = minTasks + Math.floor(Math.random() * (maxTasks - minTasks + 1));
      return s.in;
    },
    /** The session was lost server-side (bounced to /login) — force a fresh sign-in. */
    invalidate() {
      s.in = false;
      http.cookieJar().clear(BASE_URL);
    },
  };
}
