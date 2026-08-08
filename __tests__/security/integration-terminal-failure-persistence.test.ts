import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

/**
 * TERMINAL-FAILURE-PERSISTENCE class guard (C47 bank-sync / C48 calendar / C49
 * telematics + sweep).
 *
 * THE INVARIANT every provider sync/push must satisfy:
 *   - a TERMINAL auth failure (a revoked/expired grant — a token 400/401/403 /
 *     invalid_grant, or a still-401 after the one refresh+retry) PERSISTS
 *     status='error' so the cron STOPS auto-selecting the connection and the panel
 *     shows "reconnect required";
 *   - a TRANSIENT failure (5xx / 429 / network / a rate-limit 403) keeps
 *     status='connected' + last_error so a later tick SELF-HEALS — never stranding a
 *     live feed on one blip;
 *   - a SUCCESS restores status='connected' and clears last_error;
 *   - a terminal status='error' clears ONLY on re-consent (the callback upsert).
 *
 * This suite pins that terminal→status='error' path against SOURCE for every
 * cron-driven OAuth connection sync, and a DISCOVERY GUARD fails the build if a NEW
 * such integration ships without one (so the class cannot silently reopen).
 *
 * ── PER-INTEGRATION SWEEP (the class, closed) ───────────────────────────────
 *   bank        (server/services/bank-sync.ts, cron bank-sync)         — LOOP: yes
 *                 terminal-persist ✓  transient-safe ✓  self-heal ✓   (C47)
 *   calendar    (push-adapter + token-store + calendar-connections)    — PUSH on save
 *                 terminal-persist ✓  transient-safe ✓  self-heal ✓   (C48 + GAP 2 fix)
 *   telematics  (server/services/telematics-sync.ts, cron telematics-sync) — LOOP: yes
 *                 terminal-persist ✓  transient-safe ✓  self-heal ✓   (GAP 3 fix)
 *   accounting  (server/services/accounting-connections.ts)            — NO cron loop
 *                 user-triggered push (syncToProvider, actorId); gated on
 *                 status==='connected' but never LOOPED by a cron, so a terminal
 *                 failure is surfaced via last_error and retried by the user, not
 *                 silently stranded. Not the stranding defect. (see guard below)
 *   hmrc        (server/services/hmrc-connections.ts)                  — NO sync loop
 *                 prepare-only (no submit/POST, no token refresh, no cron); nothing
 *                 to strand. (see guard below)
 *   weather     (weather-fetch / weather-watch-sync crons)             — NOT OAuth
 *                 internal data pipelines, no per-org OAuth grant / status column.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");
/** Strip block + line comments so assertions match real CODE, not doc prose. */
const codeOf = (ts: string) =>
  ts.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

/** A source write of status='error' (accepts `status: "error"` and `status = "error"`). */
const STATUS_ERROR = /status\s*[:=]\s*"error"/;

describe("bank-sync persists a TERMINAL auth failure as status='error'", () => {
  const code = codeOf(read("server/services/bank-sync.ts"));
  it("classifies terminal (unauthorized / dead-grant) vs transient", () => {
    expect(code).toMatch(/terminal/);
    expect(code).toMatch(/"unauthorized"/);
  });
  it("writes status='error' on the terminal branch and self-heals on success", () => {
    expect(code).toMatch(STATUS_ERROR);
    // success path re-asserts connected + clears last_error
    expect(code).toMatch(/status:\s*"connected"/);
    expect(code).toMatch(/lastError:\s*null|last_error/);
  });
});

describe("telematics-sync persists a TERMINAL auth failure as status='error' (GAP 3)", () => {
  const sync = codeOf(read("server/services/telematics-sync.ts"));
  const conn = codeOf(read("server/services/telematics-connections.ts"));
  const oauth = codeOf(read("lib/integrations/telematics/oauth.ts"));
  const samsara = codeOf(read("lib/integrations/telematics/adapters/samsara.ts"));

  it("the sync writes status='error' only on a terminal failure", () => {
    expect(sync).toMatch(STATUS_ERROR);
    expect(sync).toMatch(/terminal/);
  });
  it("markSynced self-heals (restores status='connected', clears last_error)", () => {
    expect(sync).toMatch(/status:\s*"connected"/);
    expect(sync).toMatch(/last_error:\s*null/);
  });
  it("the oauth refresh flags a dead grant (400/401/403) as terminal", () => {
    expect(oauth).toMatch(/terminal/);
    expect(oauth).toMatch(/400|401|403/);
  });
  it("the sync result / adapter surface a token rejection as `unauthorized` → terminal", () => {
    expect(conn).toMatch(/terminal/);
    expect(samsara).toMatch(/"unauthorized"/);
  });
});

describe("calendar push persists a TERMINAL auth failure as status='error' (C48 + GAP 2)", () => {
  const store = codeOf(read("lib/integrations/calendar/token-store.ts"));
  const svc = codeOf(read("server/services/calendar-connections.ts"));
  const adapter = codeOf(read("lib/integrations/calendar/push-adapter.ts"));

  it("markConnectionError writes status='error'; markConnectionSynced self-heals", () => {
    expect(store).toMatch(STATUS_ERROR);
    expect(store).toMatch(/status:\s*"connected"/);
  });
  it("the service flips status only when the push reports terminal", () => {
    expect(svc).toMatch(/\.terminal/);
    expect(svc).toMatch(/markConnectionError/);
  });
  it("GAP 2: a bare event-API 403 is NOT blanket-terminal — the body is classified", () => {
    // The regression was `status === 403` ⇒ terminal on the EVENT response.
    expect(adapter).not.toMatch(/status === 403/);
    expect(adapter).toMatch(/classifyEventApiFailure/);
    // Rate-limit reasons are reclassified TRANSIENT.
    expect(adapter).toMatch(/rateLimitExceeded/);
    expect(adapter).toMatch(/RESOURCE_EXHAUSTED/);
  });
});

describe("DISCOVERY GUARD — a new cron-driven OAuth sync cannot ship without a terminal path", () => {
  // Any service that BOTH refreshes an OAuth token AND selects connections by
  // status='connected' in a loop is a cron-driven connection sync — exactly the
  // shape that strands a revoked grant. It MUST persist status='error' on a
  // terminal failure. This scans server/services so a NEW such file forces the
  // author to add the terminal path (or this test fails).
  const dir = resolve(ROOT, "server/services");
  const files = readdirSync(dir).filter((f) => f.endsWith(".ts"));

  const cronDrivenOAuthSyncs = files.filter((f) => {
    const code = codeOf(read(`server/services/${f}`));
    const refreshesOAuth = /refreshAccessToken\s*\(/.test(code);
    const loopsOnConnected = /\.eq\(\s*"status"\s*,\s*"connected"\s*\)/.test(code);
    return refreshesOAuth && loopsOnConnected;
  });

  it("finds the known cron-driven OAuth connection syncs", () => {
    // bank-sync + telematics-sync are the current members. If this set changes, the
    // per-file assertion below still enforces the invariant on every member.
    expect(cronDrivenOAuthSyncs.sort()).toEqual(["bank-sync.ts", "telematics-sync.ts"]);
  });

  it("EVERY cron-driven OAuth sync writes status='error' on a terminal failure", () => {
    for (const f of cronDrivenOAuthSyncs) {
      const code = codeOf(read(`server/services/${f}`));
      expect(code, `${f} must persist status='error' on a terminal auth failure`).toMatch(
        STATUS_ERROR,
      );
      expect(code, `${f} must classify terminal vs transient`).toMatch(/terminal/);
    }
  });
});

describe("SWEEP evidence — accounting / hmrc are NOT cron-driven loops (exempt with cause)", () => {
  const cronDir = resolve(ROOT, "app/api/cron");
  const cronNames = readdirSync(cronDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  it("no accounting-sync / hmrc-sync cron exists (user-triggered / prepare-only)", () => {
    expect(cronNames).not.toContain("accounting-sync");
    expect(cronNames).not.toContain("hmrc-sync");
  });

  it("accounting sync is user-triggered (takes an actorId), not a status-looping cron", () => {
    const code = codeOf(read("server/services/accounting-connections.ts"));
    // A user action carries the actor; it gates on a single connection's status
    // rather than looping the platform's connected set.
    expect(code).toMatch(/actorId/);
    expect(code).not.toMatch(/\.eq\(\s*"status"\s*,\s*"connected"\s*\)/);
  });

  it("hmrc is prepare-only — no token refresh, no submit loop to strand", () => {
    const code = codeOf(read("server/services/hmrc-connections.ts"));
    expect(code).not.toMatch(/refreshAccessToken\s*\(/);
  });
});
