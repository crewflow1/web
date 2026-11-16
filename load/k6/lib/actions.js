// load/k6/lib/actions.js — Next.js Server Action discovery + invocation.
//
// HOW A SERVER ACTION TRAVELS (Next 15 App Router, verified against this build):
//
//   POST <the page's own URL>
//     Next-Action: <40–42 hex action id>        ← build-specific
//     Accept: text/x-component
//     Origin: <same origin>                     ← Next's CSRF check compares it to Host
//     Content-Type: multipart/form-data
//   body = React's `encodeReply` of the argument list:
//     _1_<field>   one part per form field (the FormData argument is "part 1")
//     0            JSON array of the arguments, the FormData written as "$K1":
//                    action(formData)            → ["$K1"]
//                    action(prevState, formData) → [null,"$K1"]      (useActionState)
//                    action.bind(null,id)(fd)    → ["<id>","$K1"]    (bound argument)
//     The root part "0" MUST come last: the server decodes the stream as it
//     arrives and resolves "$K1" from the parts it has already seen.
//
//   Response:
//     redirect()-style action → 303 + `x-action-redirect: /path?x=y;push`
//     FormState-style action  → 200 text/x-component, a row `1:{"ok":true,…,"redirectTo":…}`
//
// ACTION IDS ARE BUILD-SPECIFIC. They are never hard-coded here. They come from
//   (1) load/k6/.manifest/actions.json, written by scripts/load/discover-actions.mjs
//       from the build's own server-reference manifest; and/or
//   (2) HTTP discovery in setup() against the live target (named references in
//       client chunks; `$ACTION_ID_` hidden inputs in server-rendered forms),
// and setup() then VERIFIES the map against the live target (build id + the id
// actually being present on the page that uses it). A stale or unresolvable id
// disables that flow and is reported — it is never guessed.
import http from "k6/http";
import { BASE_URL } from "./config.js";
import { actionMap } from "./data.js";

/** Logical action → source reference (file#export) in the server-reference manifest. */
export const ACTION_KEYS = {
  signIn: "app/(auth)/actions.ts#signInWithPassword",
  signOut: "app/(auth)/actions.ts#signOut",
  clockIn: "app/(app)/me/actions.ts#clockIn",
  clockOut: "app/(app)/me/actions.ts#clockOut",
  createQuote: "app/(app)/quotes/actions.ts#createQuote",
  acceptQuote: "app/(app)/quotes/actions.ts#acceptQuoteAsOwner",
  createRota: "app/(app)/staff/actions.ts#createRotaEntry",
  createJob: "app/(app)/jobs/actions.ts#createJob",
  ackSafety: "app/(app)/health-safety/signoff-actions.ts#acknowledgeSafetyDocument",
};

const HEX = "[0-9a-f]{40,42}";

/** Build id the target is serving (present in every HTML document's flight data). */
export function buildIdOf(html) {
  if (typeof html !== "string") return null;
  const m = /\\?"b\\?":\\?"([A-Za-z0-9_-]{8,})\\?"/.exec(html);
  return m ? m[1] : null;
}

/** Named server references compiled into a page's client chunks. */
export function discoverFromChunks(html, headers) {
  const out = {};
  if (typeof html !== "string") return out;
  const seen = {};
  const re = /\/_next\/static\/chunks\/[^"'\\ ]+?\.js/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    if (seen[m[0]]) continue;
    seen[m[0]] = true;
    const res = http.get(BASE_URL + m[0], { headers, tags: { name: "setup:chunk", kind: "setup" } });
    if (res.status !== 200 || typeof res.body !== "string") continue;
    const ref = new RegExp(`createServerReference\\)?\\("(${HEX})",[^)]*?"([A-Za-z0-9_$]+)"\\)`, "g");
    let r;
    while ((r = ref.exec(res.body)) !== null) out[r[2]] = r[1];
  }
  return out;
}

/** `$ACTION_ID_<id>` hidden inputs React emits for server-rendered <form action={fn}>. */
export function discoverFormIds(html) {
  if (typeof html !== "string") return [];
  const out = [];
  const re = new RegExp(`\\$ACTION_ID_(${HEX})`, "g");
  let m;
  while ((m = re.exec(html)) !== null) if (out.indexOf(m[1]) === -1) out.push(m[1]);
  return out;
}

/** Start from the build manifest map (may be empty / stale — setup verifies). */
export function initialActions() {
  const out = {};
  for (const k in ACTION_KEYS) out[k] = (actionMap.actions && actionMap.actions[ACTION_KEYS[k]]) || null;
  return out;
}

function multipart(fields, rootJson) {
  const b = "----k6lt" + Math.random().toString(16).slice(2) + Date.now().toString(16);
  let body = "";
  for (const k in fields) {
    body += `--${b}\r\nContent-Disposition: form-data; name="_1_${k}"\r\n\r\n${fields[k]}\r\n`;
  }
  body += `--${b}\r\nContent-Disposition: form-data; name="0"\r\n\r\n${rootJson}\r\n--${b}--\r\n`;
  return { body, contentType: `multipart/form-data; boundary=${b}` };
}

/**
 * Invoke a server action exactly as the hydrated client does.
 * @param pagePath   the URL of the page hosting the action (actions POST to their page)
 * @param actionId   build-specific id (from setup data)
 * @param prefixArgs arguments BEFORE the FormData ([] | [null] | ["<bound id>"])
 * @param fields     form fields
 */
export function callAction(pagePath, actionId, prefixArgs, fields, name) {
  const { body, contentType } = multipart(fields || {}, JSON.stringify([...(prefixArgs || []), "$K1"]));
  return http.post(BASE_URL + pagePath, body, {
    headers: {
      "Next-Action": actionId,
      Accept: "text/x-component",
      "Content-Type": contentType,
      Origin: BASE_URL,
      "Accept-Encoding": "gzip",
      "User-Agent": "crewflow-load-harness/1 (k6)",
    },
    redirects: 0,
    tags: { name, kind: "action" },
  });
}

/** Normalise the two response shapes into one result. */
export function actionResult(res) {
  const raw = res.headers["X-Action-Redirect"] || null;
  const out = { status: res.status, redirect: raw ? raw.split(";")[0] : null, ok: null, redirectTo: null, error: null };
  if (typeof res.body === "string" && res.body.length > 0) {
    const row = /^[0-9a-f]+:\{"ok":(true|false)[^\n]*/m.exec(res.body);
    if (row) {
      out.ok = row[1] === "true";
      const r = /"redirectTo":"([^"]+)"/.exec(row[0]);
      if (r) out.redirectTo = r[1];
      const e = /"error":"([^"]*)"/.exec(row[0]);
      if (e) out.error = e[1];
    }
  }
  return out;
}
