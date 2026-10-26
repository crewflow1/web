/**
 * Integration-tier readiness gate (F-I1 — PostgREST upstream 50x on a cold stack).
 *
 * THE DEFECT THIS CLOSES. The CI integration job boots the Supabase local stack
 * (`supabase start`), applies every migration on a fresh volume, and then runs
 * `npm run test:integration` with NOTHING in between that confirms the Data API
 * is actually serving. `supabase start` returns once the CONTAINERS report
 * healthy, but PostgREST builds (and, right after the migrations land, RELOADS)
 * its schema cache asynchronously after that. During that short window Kong has
 * no healthy upstream to forward to and answers requests with a 502/503 whose
 * body is "An invalid response was received from the upstream server". Whichever
 * integration file happens to issue the first query in that window fails on an
 * infrastructure error that has nothing to do with the assertion it was making —
 * the receptionist conversation-substrate suite was simply the one that drew the
 * short straw (captured in CI-FLAKE-EVIDENCE.md as F-I1). Run ×20 against a WARM
 * stack the same suite is 20/20 green, which pins the cause to startup readiness,
 * not test logic.
 *
 * THE FIX IS A DETERMINISTIC GATE, NOT A PER-CALL RETRY. This runs ONCE in the
 * vitest main process before any test file is collected (vitest `globalSetup`),
 * and blocks until the Data API has genuinely settled: PostgREST answers its
 * schema endpoint with a non-5xx status. That is precisely the eventually-
 * consistent external contract the flake policy allows a bounded wait to express
 * (PostgREST schema-cache settle) — and it is applied at the ONE place that
 * removes the race for the whole tier, so not a single assertion anywhere is
 * wrapped in a retry and not a single timeout is inflated. If the API never
 * settles inside the bound the gate throws, so a genuinely broken stack still
 * fails the run loudly and immediately rather than being masked.
 *
 * NO-OP WHEN THERE IS NO DATABASE. Resolution is byte-identical to _harness.ts
 * readConn(): with nothing configured this returns immediately and leaves the
 * tier's own gating (describeIntegration: skip locally / fail loudly in CI) to
 * decide what "no database" means — exactly as before.
 */

function readUrlAndKey(): { url?: string; key?: string } {
  return {
    url: process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL,
    // The service-role key is what the suite's fixtures use; either name is
    // accepted for the anon key, matching the harness.
    key:
      process.env.SUPABASE_SERVICE_ROLE_KEY ??
      process.env.SUPABASE_ANON_KEY ??
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  };
}

/** One readiness probe. Ready === PostgREST answered with a non-5xx status. */
async function probe(url: string, key: string): Promise<{ ready: boolean; detail: string }> {
  const base = url.replace(/\/$/, "");
  try {
    // The REST root serves the OpenAPI description, which PostgREST can only
    // produce once its schema cache is built — so a 200 here means the cache is
    // loaded, while a reload / cold start surfaces as a 5xx from Kong. apikey is
    // required or Kong rejects the call before it ever reaches PostgREST.
    const res = await fetch(`${base}/rest/v1/`, {
      headers: { apikey: key, authorization: `Bearer ${key}` },
    });
    // Any non-5xx proves PostgREST is up and serving from a loaded schema cache.
    // A 5xx is the exact "invalid response from upstream" window we are gating.
    return { ready: res.status < 500, detail: `HTTP ${res.status}` };
  } catch (e) {
    // Connection refused / reset while the container is still coming up.
    return { ready: false, detail: (e as Error).message };
  }
}

export default async function setup(): Promise<void> {
  const { url, key } = readUrlAndKey();
  // No database configured → nothing to gate. The tier's describeIntegration
  // decides skip-locally / fail-loudly-in-CI, unchanged.
  if (!url || !key) return;

  const DEADLINE_MS = 90_000; // generous; a warm stack clears on the first probe.
  const INTERVAL_MS = 1_000;
  const startedAt = Date.now();
  let last = "no probe yet";

  for (;;) {
    const { ready, detail } = await probe(url, key);
    if (ready) {
      // Only announce when we actually had to wait, so a warm run stays silent.
      if (Date.now() - startedAt > INTERVAL_MS) {
        console.log(
          `[integration] PostgREST ready after ${Math.round((Date.now() - startedAt) / 1000)}s (${detail}).`,
        );
      }
      return;
    }
    last = detail;
    if (Date.now() - startedAt >= DEADLINE_MS) {
      throw new Error(
        `[integration] PostgREST at ${url} did not become ready within ${DEADLINE_MS / 1000}s ` +
          `(last probe: ${last}). The Data API never finished loading its schema cache — ` +
          `this is a real broken-stack signal, not a flake to retry past.`,
      );
    }
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }
}
