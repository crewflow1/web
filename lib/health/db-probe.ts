/**
 * Live database reachability probe for `/api/health`.
 *
 * The problem it closes: `/api/health` reported `ok: true` unconditionally, so a deploy whose
 * database was unreachable (bad URL, network partition, Supabase outage) still went green — the
 * worst kind of monitoring signal, a healthy light over a dead dependency. This probe makes the
 * endpoint's `ok`/`status` honestly reflect whether Postgres actually answered.
 *
 * Deliberately reads `process.env` DIRECTLY, imports no provider SDK and no `@/lib/supabase`
 * module, and carries no `import "server-only"` — so it is edge-safe (the health route runs on the
 * edge runtime), dependency-free, and CAN NEVER THROW. A reachability probe must always answer:
 * every failure mode collapses to `{ ok: false, reason }`, never a rejection.
 *
 * It adds NO new credential: `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` are
 * already public. It leaks NO tenant data: the request is a HEAD count against `organizations`
 * with `Range: 0-0`, and RLS returns zero rows to the anon role — only the HTTP status is read,
 * never a row body. A non-5xx status (200/400/404/406) proves the gateway + Postgres answered;
 * 401/403 mean the public anon key itself is rejected (auth-degraded — every client query breaks);
 * `>= 500`, a timeout, or a network error mean the DB could not be reached.
 */

export type DbProbe = { ok: boolean; reason?: string };

/** Fail closed if the DB has not answered within this budget. Health checks must stay snappy. */
const PROBE_TIMEOUT_MS = 2000;

/**
 * Prove a real Postgres roundtrip WITHOUT returning any row body. Returns `{ ok: true }` when the
 * gateway + DB answered, `{ ok: false, reason }` otherwise. Never throws, never rejects.
 */
export async function probeDatabase(): Promise<DbProbe> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  // Missing config is a distinct, diagnosable state — not "unreachable".
  if (!url || !anon) return { ok: false, reason: "unconfigured" };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);

  try {
    // HEAD count read: proves the DB answered, returns no rows (Range 0-0 + RLS ⇒ empty to anon).
    const res = await fetch(`${url}/rest/v1/organizations?select=id&limit=1`, {
      method: "HEAD",
      headers: {
        apikey: anon,
        Authorization: `Bearer ${anon}`,
        Prefer: "count=exact",
        Range: "0-0",
        "Range-Unit": "items",
      },
      signal: controller.signal,
    });

    // 401/403 mean the public anon key was REJECTED — with a valid key, RLS returns an empty
    // 200 to anon, never a 401. A rejected key breaks every client-side query for real users, so
    // that is a genuine degradation (auth), not a healthy answer — do not count it green.
    if (res.status === 401 || res.status === 403) return { ok: false, reason: "auth" };
    // Any other non-5xx status proves the gateway + Postgres answered (200/400/404/406 included).
    // A 5xx means the gateway could not reach or serve the database.
    return res.status < 500 ? { ok: true } : { ok: false, reason: "unreachable" };
  } catch {
    // Abort (timeout) or any network/DNS/TLS error: the DB could not be reached.
    return { ok: false, reason: "unreachable" };
  } finally {
    clearTimeout(timer);
  }
}
