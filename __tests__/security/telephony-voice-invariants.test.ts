import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Voice Telephony (Wave 8) — trust-boundary proofs.
 *
 * Section 1: the migration. phone_numbers is member-read / admin-write, org-
 * pinned with unique(provider,e164) and unique(id,org_id), a no-fake active
 * CHECK, and provider_auth_secret stripped from the authenticated read surface
 * (column privilege) with anon revoked. call_events is append-only (member-read
 * only, NO authenticated write policy) with a composite (call_id, org_id) FK and
 * an idempotency unique. `calls` gains the composite unique + the provider_call
 * partial unique the substrate needs.
 *
 * Section 2: lib/telephony is dark. The factory returns null unconfigured; no
 * vendor SDK is imported at module scope; parse/verify fail closed; the AI turn
 * seam gates on an EXISTING tier's activation (never a bare credential) and
 * routes through the governor.
 *
 * Section 3: the webhook routes 503 before ANY work while dark, verify the
 * signature BEFORE parsing, attribute the org from the DIALED number (never the
 * body), and pin org_id explicitly on the service path.
 *
 * All source assertions run over COMMENT-STRIPPED text so prose can neither
 * satisfy nor trip a pin, and are written to be mutation-sensitive.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

/** Strip SQL line comments so NEGATIVE assertions test EXECUTABLE statements. */
const sqlOnly = (s: string) =>
  s
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("--");
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join("\n");

/** Strip TS/JS comments, for source contracts about real code. */
const codeOf = (ts: string) =>
  ts.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

const MIG = "supabase/migrations/20261098000000_voice_telephony_phone_numbers.sql";
const sql = sqlOnly(read(MIG));

const CONFIG = "lib/telephony/config.ts";
const INDEX = "lib/telephony/index.ts";
const ROUTER = "lib/telephony/router.ts";
const AI_TURN = "lib/telephony/ai-turn.ts";
const TW_PROVIDER = "lib/telephony/providers/twilio.ts";
const VAPI_PROVIDER = "lib/telephony/providers/vapi.ts";
const SERVICE = "server/services/telephony.ts";
const R_VOICE = "app/api/webhooks/twilio/voice/route.ts";
const R_STATUS = "app/api/webhooks/twilio/voice/status/route.ts";
const R_VAPI = "app/api/webhooks/vapi/route.ts";

// ---------------------------------------------------------------------------
// 1. THE MIGRATION
// ---------------------------------------------------------------------------

describe("calls: the substrate keys", () => {
  it("adds the composite (id, org_id) unique the child FK needs", () => {
    expect(sql).toMatch(/alter table public\.calls add constraint calls_id_org_key unique \(id, org_id\)/i);
  });
  it("adds the provider_call_id PARTIAL unique for idempotent redelivery", () => {
    expect(sql).toMatch(
      /create unique index[^;]*calls_provider_call_uniq[\s\S]*on public\.calls \(provider, provider_call_id\)[\s\S]*where provider_call_id is not null/i,
    );
  });
});

describe("phone_numbers — RLS, tenancy, no fake provisioned", () => {
  it("enables RLS", () => {
    expect(sql).toMatch(/alter table public\.phone_numbers enable row level security/i);
  });
  it("is member-read: select gated on current_org_ids()", () => {
    expect(sql).toMatch(
      /create policy[^;]*members can select[^;]*for select[\s\S]*current_org_ids\(\)/i,
    );
  });
  it("is admin-write: insert / update / delete gated on is_org_admin()", () => {
    expect(sql).toMatch(/create policy[^;]*admins can insert[^;]*for insert[\s\S]*is_org_admin\(/i);
    expect(sql).toMatch(/create policy[^;]*admins can update[^;]*for update[\s\S]*is_org_admin\(/i);
    expect(sql).toMatch(/create policy[^;]*admins can delete[^;]*for delete[\s\S]*is_org_admin\(/i);
  });
  it("is org-pinned with cascade + composite candidate key", () => {
    expect(sql).toMatch(
      /org_id\s+uuid not null references public\.organizations\(id\) on delete cascade/i,
    );
    expect(sql).toMatch(/unique\s*\(id,\s*org_id\)/i);
  });
  it("has one number per (provider, e164)", () => {
    expect(sql).toMatch(/unique\s*\(provider,\s*e164\)/i);
  });
  it("constrains provider to the documented vocabulary", () => {
    expect(sql).toMatch(/provider\s+text not null check \(provider in \('twilio', 'vapi'\)\)/i);
  });
  it("FORBIDS a fake active state: active requires a provider SID", () => {
    expect(sql).toMatch(/check\s*\(\s*active is false or provider_number_sid is not null\s*\)/i);
  });
  it("STRIPS provider_auth_secret from the authenticated read surface", () => {
    expect(sql).toMatch(/revoke\s+all\s+on\s+table\s+public\.phone_numbers\s+from\s+anon/i);
    expect(sql).toMatch(
      /revoke\s+select\s+on\s+table\s+public\.phone_numbers\s+from\s+authenticated/i,
    );
    const grant = sql.match(
      /grant\s+select\s*\(([\s\S]*?)\)\s*on\s+public\.phone_numbers\s+to\s+authenticated/i,
    );
    expect(grant, "expected an explicit safe-column SELECT grant").not.toBeNull();
    const cols = grant![1];
    expect(cols).not.toMatch(/provider_auth_secret/i);
    expect(cols).toMatch(/\be164\b/i);
    expect(cols).toMatch(/\bactive\b/i);
  });
  it("writes no row (dark) and defaults active FALSE", () => {
    expect(sql).not.toMatch(/insert\s+into\s+public\.phone_numbers/i);
    expect(sql).toMatch(/active\s+boolean not null default false/i);
  });
});

describe("call_events — append-only audit, composite FK, idempotent", () => {
  it("enables RLS and is member-read only", () => {
    expect(sql).toMatch(/alter table public\.call_events enable row level security/i);
    expect(sql).toMatch(/create policy[^;]*members can select[^;]*for select[\s\S]*current_org_ids\(\)/i);
  });
  it("has NO authenticated write policy (append-only, service-role writer)", () => {
    // No insert/update/delete policy anywhere for call_events.
    expect(sql).not.toMatch(/create policy[^;]*on public\.call_events[\s\S]*for insert/i);
    expect(sql).not.toMatch(/create policy[^;]*on public\.call_events[\s\S]*for update/i);
    expect(sql).not.toMatch(/create policy[^;]*on public\.call_events[\s\S]*for delete/i);
    expect(sql).toMatch(/revoke\s+all\s+on\s+table\s+public\.call_events\s+from\s+anon/i);
  });
  it("binds a composite (call_id, org_id) FK to calls(id, org_id)", () => {
    expect(sql).toMatch(
      /foreign key \(call_id, org_id\) references public\.calls \(id, org_id\) on delete cascade/i,
    );
  });
  it("is idempotent on (call_id, provider_event_id)", () => {
    expect(sql).toMatch(/unique\s*\(call_id,\s*provider_event_id\)/i);
  });
  it("constrains event_type to the lifecycle vocabulary", () => {
    expect(sql).toMatch(/event_type\s+text not null check \(event_type in \(/i);
    for (const e of ["initiated", "ringing", "answered", "completed", "failed", "canceled"]) {
      expect(sql).toMatch(new RegExp(`'${e}'`));
    }
  });
});

// ---------------------------------------------------------------------------
// 2. lib/telephony IS DARK
// ---------------------------------------------------------------------------

describe("lib/telephony is dark + fail-closed", () => {
  it("the factory returns null before any provider when the flag is off", () => {
    const code = codeOf(read(INDEX));
    const idxFlag = code.indexOf("voiceInboundFeatureEnabled()");
    const idxCase = code.indexOf('case "twilio"');
    expect(idxFlag).toBeGreaterThan(-1);
    expect(idxCase).toBeGreaterThan(-1);
    // The flag refusal precedes any provider construction.
    expect(idxFlag).toBeLessThan(idxCase);
    expect(code).toMatch(/if \(!voiceInboundFeatureEnabled\(\)\) return null/);
    expect(code).toMatch(/if \(!isVoiceConfigured\(\)\) return null/);
  });

  it("isVoiceConfigured is BOTH the flag AND a resolvable provider (two-switch)", () => {
    const code = codeOf(read(CONFIG));
    expect(code).toMatch(/voiceInboundFeatureEnabled\(\)\s*&&\s*isVoiceProviderResolvable\(\)/);
  });

  it("no vendor SDK is imported at MODULE SCOPE in any telephony module", () => {
    for (const f of [CONFIG, INDEX, ROUTER, TW_PROVIDER, VAPI_PROVIDER]) {
      const code = codeOf(read(f));
      // No top-level `import ... from "twilio"/"@vapi..."`. The Twilio SDK is
      // reached only via the reused verifier's lazy dynamic import.
      expect(code, `${f} must not import the twilio SDK at module scope`).not.toMatch(
        /^\s*import\s+[^;]*from\s+["']twilio["']/m,
      );
    }
  });

  it("the Vapi verifier fails closed without a secret or signature", () => {
    const code = codeOf(read(VAPI_PROVIDER));
    expect(code).toMatch(/if \(!secret \|\| !input\.signature\) return false/);
    expect(code).toMatch(/timingSafeEqual/);
    // Reads the secret at call time, not a frozen import.
    expect(code).toMatch(/process\.env\.VAPI_WEBHOOK_SECRET/);
  });

  it("the ai-turn seam gates on its OWN class's tier activation, never any tier or a bare credential", () => {
    const code = codeOf(read(AI_TURN));
    // PER-TIER. This is a `drafting` caller ⇒ the `mid` tier. The coarse
    // any-generative-tier gate (isInferenceTierActivated) was the partial-binding
    // hole: with only cheap bound + a key it answered true and this MID call ran
    // ungoverned. It must gate on its own tier and NOT on the coarse gate.
    expect(code).toMatch(/if \(!isTierActivated\("mid"\)\) return null/);
    expect(code).not.toMatch(/isInferenceTierActivated/);
    // Governed, and NOT gated on the bare credential probe.
    expect(code).toMatch(/invokeWithGovernor/);
    expect(code).not.toMatch(/isAiConfigured/);
    expect(code).not.toMatch(/process\.env\.ANTHROPIC_API_KEY/);
    // Reaches a model only through the shared door (no own SDK construction).
    expect(code).not.toMatch(/new\s+Anthropic\b|@anthropic-ai\/sdk/);
    expect(code).toMatch(/getTextProvider\(\)/);
  });
});

// ---------------------------------------------------------------------------
// 3. THE WEBHOOK ROUTES — dark-gated, verify-before-parse, org-from-dialed
// ---------------------------------------------------------------------------

describe("voice webhook routes are dark-gated + verify-before-parse", () => {
  for (const f of [R_VOICE, R_STATUS, R_VAPI]) {
    it(`${f}: 503s before any work when not configured`, () => {
      const code = codeOf(read(f));
      expect(code).toMatch(/if \(!isVoiceConfigured\(\)\)/);
      const idxGate = code.indexOf("if (!isVoiceConfigured())");
      const idxText = code.indexOf("await request.text()");
      expect(idxGate, `${f} must gate before reading the body`).toBeGreaterThan(-1);
      expect(idxText).toBeGreaterThan(-1);
      expect(idxGate).toBeLessThan(idxText);
      // The dark refusal is a retry-safe 503, not a 200.
      expect(code).toMatch(/status:\s*503/);
    });

    it(`${f}: verifies the signature BEFORE parsing`, () => {
      const code = codeOf(read(f));
      const idxVerify = code.indexOf(".verify(");
      const idxParse = code.indexOf(".parse(");
      expect(idxVerify, `${f} must verify`).toBeGreaterThan(-1);
      expect(idxParse, `${f} must parse`).toBeGreaterThan(-1);
      expect(idxVerify).toBeLessThan(idxParse);
      // An invalid signature is a hard 401.
      expect(code).toMatch(/invalid_signature[\s\S]*status:\s*401|status:\s*401[\s\S]*invalid_signature/);
    });

    it(`${f}: resolves the org from the DIALED number, not the body identity`, () => {
      const code = codeOf(read(f));
      expect(code).toMatch(/resolveOrgForDialedNumber\(call\.to\)/);
      // Unrouted → no tenant write.
      expect(code).toMatch(/if \(!orgId\)/);
    });
  }

  it("the origination route ack-drops an unrouted call with no tenant write", () => {
    const code = codeOf(read(R_VOICE));
    const idxUnrouted = code.indexOf("if (!orgId)");
    const idxRecord = code.indexOf("recordInboundCall(");
    expect(idxUnrouted).toBeGreaterThan(-1);
    expect(idxRecord).toBeGreaterThan(-1);
    // The unrouted return precedes any write.
    expect(idxUnrouted).toBeLessThan(idxRecord);
    expect(code).toMatch(/buildAckDropTwiml\(\)/);
  });
});

describe("completion enrichment: BOTH terminal provider paths write it (no divergence)", () => {
  // The defect class this pins: a provider completion-path DIVERGENCE — Vapi's
  // end-of-call-report enriched the calls row (duration_sec / ended_at / recording)
  // while Twilio, the DEFAULT live provider, silently discarded it. Every provider
  // webhook that owns a call's terminal transition MUST reach the single enrichment
  // writer, so a future provider that skips it is caught here. Source pins over
  // comment-stripped code so prose can neither satisfy nor trip the assertion.
  it("the Vapi webhook enriches on its terminal report", () => {
    const code = codeOf(read(R_VAPI));
    expect(code).toMatch(/end-of-call-report/);
    expect(code).toMatch(/updateCallCompletion\(/);
  });

  it("the Twilio status route enriches on the TERMINAL status, gated + best-effort", () => {
    const code = codeOf(read(R_STATUS));
    // It reaches the single enrichment writer…
    expect(code).toMatch(/updateCallCompletion\(/);
    // …only on a terminal transition (the shared TERMINAL_CALL_EVENTS set, not an
    // ad-hoc inline list that could drift from the vocabulary)…
    expect(code).toMatch(/TERMINAL_CALL_EVENTS/);
    // …carrying the parsed duration + the terminal timestamp…
    expect(code).toMatch(/durationSec:\s*call\.durationSec/);
    expect(code).toMatch(/endedAt:\s*call\.occurredAt/);
    // …and best-effort: the enrichment is wrapped so a write failure never 500s the
    // webhook ack (which would make Twilio retry-storm).
    expect(code).toMatch(/updateCallCompletion[\s\S]*catch\s*\(/);
  });

  it("the Twilio parser carries CallDuration into the neutral shape", () => {
    const code = codeOf(read(TW_PROVIDER));
    expect(code).toMatch(/CallDuration/);
    expect(code).toMatch(/durationSec/);
  });
});

describe("router + service pin org_id explicitly", () => {
  it("the router resolves an ACTIVE route by dialed number on the admin client", () => {
    const code = codeOf(read(ROUTER));
    expect(code).toMatch(/createAdminClient\(\)/);
    expect(code).toMatch(/\.eq\("e164"[\s\S]*\.eq\("active", true\)[\s\S]*\.maybeSingle\(\)/);
  });

  it("the service pins org_id on every read and write, and fails loud", () => {
    const code = codeOf(read(SERVICE));
    const pins = code.match(/\.eq\("org_id",\s*orgId\)/g) ?? [];
    expect(pins.length).toBeGreaterThanOrEqual(3);
    expect(code).toMatch(/Sentry\.captureException/);
    expect(code).toMatch(/throw new Error/);
    // The append path advances status through the PURE reducer, never inline.
    expect(code).toMatch(/nextCallState\(/);
  });
});
