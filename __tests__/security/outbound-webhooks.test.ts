import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHmac } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";

/**
 * Outbound webhooks (Train A) — trust-boundary + policy pins.
 *
 * Hermetic: filesystem scans + pure functions + a mocked DNS layer. The live-DB
 * RLS proofs are in __tests__/integration/rls/outbound-webhooks.test.ts.
 *
 * What is pinned, and why each pin is load-bearing:
 *   1. MIGRATION — RLS admin-only on endpoints, read-only deliveries, the
 *      COLUMN-LEVEL `secret` exclusion (the whole no-readback mechanism), org
 *      pinning, the verify-before-activate + immutability trigger, and the
 *      registered spine consumer + fan-out apply branch.
 *   2. SSRF — the table-driven fuzz: every private/link-local/ULA/v4-mapped/
 *      IP-literal/no-dot/.internal/platform case is refused; the vetted fetch
 *      re-resolves and refuses a rebind to a private address before connecting.
 *   3. SIGNATURE — the t/v1 HMAC vector + tamper/replay rejection.
 *   4. BACKOFF + BREAKER — the exact schedule and the attempt/failure ceilings.
 *   5. ALLOWLIST — every exposable verb is a real spine Verb (drift guard).
 *   6. REDACTION — the per-verb key allowlist strips everything else.
 *   7. DARK ⇒ ZERO EGRESS — the cron 204-no-ops before any DB work; the ONLY
 *      network egress in the feature is the SSRF-vetted path.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");
const MIGRATION = "supabase/migrations/20261087000000_outbound_webhooks.sql";
const MIG_DIR = resolve(ROOT, "supabase/migrations");

const sqlOnly = (src: string) =>
  src
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("--");
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join("\n");

const codeOf = (ts: string) =>
  ts.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

// DNS is mocked file-wide so no test can make a real lookup. Default: reject.
let mockLookup: (host: string, opts: unknown) => Promise<unknown> = () =>
  Promise.reject(new Error("dns disabled in tests"));
vi.mock("node:dns/promises", () => ({
  lookup: (host: string, opts: unknown) => mockLookup(host, opts),
}));

// ===========================================================================
// 1. Migration
// ===========================================================================

describe("migration — slot + single definer", () => {
  it("occupies exactly the assigned slot 20261087000000, once", () => {
    const files = readdirSync(MIG_DIR).filter((f) => f.startsWith("20261087"));
    expect(files).toEqual(["20261087000000_outbound_webhooks.sql"]);
  });

  it("never touches the parallel train's slot 20261088", () => {
    const files = readdirSync(MIG_DIR).filter((f) => f.startsWith("20261088"));
    // If it exists it's not ours; our migration must not reference it.
    expect(read(MIGRATION)).not.toContain("20261088");
    void files;
  });

  it("is the ONLY migration defining webhook_endpoints/webhook_deliveries policies or grants", () => {
    const definers = readdirSync(MIG_DIR)
      .filter((f) => f.endsWith(".sql"))
      .filter((f) => {
        const src = sqlOnly(readFileSync(resolve(MIG_DIR, f), "utf8"));
        return /(create policy|revoke|grant)[\s\S]{0,300}?public\.webhook_(endpoints|deliveries)\b/i.test(src);
      })
      .sort();
    expect(definers).toEqual(["20261087000000_outbound_webhooks.sql"]);
  });
});

describe("migration — RLS: admin-manage endpoints, read-only deliveries", () => {
  const sql = sqlOnly(read(MIGRATION));

  it("enables RLS on both tables", () => {
    expect(sql).toMatch(/alter table public\.webhook_endpoints enable row level security/i);
    expect(sql).toMatch(/alter table public\.webhook_deliveries enable row level security/i);
  });

  it("gates endpoint select/insert/update/delete on is_org_admin — never current_org_ids", () => {
    expect(sql).toMatch(/for select to authenticated\s+using \(public\.is_org_admin\(org_id\)\)/i);
    expect(sql).toMatch(/for insert to authenticated\s+with check \(public\.is_org_admin\(org_id\)\)/i);
    expect(sql).toMatch(/for update to authenticated\s+using \(public\.is_org_admin\(org_id\)\)/i);
    expect(sql).toMatch(/for delete to authenticated\s+using \(public\.is_org_admin\(org_id\)\)/i);
    // endpoints must not be visible to a plain member
    const epBlock = sql.slice(sql.indexOf("webhook_endpoints enable row level security"));
    expect(epBlock.slice(0, epBlock.indexOf("webhook_deliveries enable"))).not.toMatch(/current_org_ids/);
  });

  it("deliveries have a SELECT policy only — NO insert/update/delete policy", () => {
    const delPolicies = sql.match(/create policy\s+"[^"]*"\s+on public\.webhook_deliveries/gi) ?? [];
    expect(delPolicies).toHaveLength(1);
    expect(sql).toMatch(/on public\.webhook_deliveries\s+for select/i);
    // and the write grants are revoked as a second lock
    expect(sql).toMatch(/revoke insert, update, delete, truncate, references, trigger\s+on table public\.webhook_deliveries from authenticated/i);
  });
});

describe("migration — the column-level secret exclusion (THE mechanism)", () => {
  const sql = sqlOnly(read(MIGRATION));

  it("revokes table-wide SELECT from authenticated, then grants an EXPLICIT list WITHOUT secret", () => {
    expect(sql).toMatch(/revoke select, update, delete, truncate, references, trigger\s+on table public\.webhook_endpoints from authenticated/i);
    const grant = /grant select \(([^)]+)\)\s+on public\.webhook_endpoints to authenticated/i.exec(sql);
    expect(grant, "explicit safe-column SELECT grant missing").not.toBeNull();
    const columns = grant![1]!.split(",").map((c) => c.trim());
    // The single most important assertion in this file.
    expect(columns).not.toContain("secret");
    expect(columns).toContain("url");
    expect(columns).toContain("status");
  });

  it("tenant UPDATE is column-limited to config only (never secret/counters/verified_at)", () => {
    const grant = /grant update \(([^)]+)\)\s+on public\.webhook_endpoints to authenticated/i.exec(sql);
    expect(grant).not.toBeNull();
    const cols = grant![1]!.split(",").map((c) => c.trim()).sort();
    expect(cols).toEqual(["description", "event_verbs", "status"]);
    expect(cols).not.toContain("secret");
    expect(cols).not.toContain("verified_at");
    expect(cols).not.toContain("consecutive_failures");
  });

  it("revokes anon on both tables", () => {
    expect(sql).toMatch(/revoke all on table public\.webhook_endpoints from anon/i);
    expect(sql).toMatch(/revoke all on table public\.webhook_deliveries from anon/i);
  });
});

describe("migration — org pinning + integrity", () => {
  const sql = sqlOnly(read(MIGRATION));

  it("url is https-only at the DB", () => {
    expect(sql).toMatch(/url\s+text not null check \(url ~ '\^https:\/\/'\)/i);
  });

  it("endpoint org FK cascades and (id, org_id) candidate key exists", () => {
    expect(sql).toMatch(/org_id\s+uuid not null references public\.organizations\(id\) on delete cascade/i);
    expect(sql).toMatch(/constraint webhook_endpoints_id_org_key unique \(id, org_id\)/i);
  });

  it("deliveries bind (endpoint_id, org_id) via composite FK, cascade, and dedupe (endpoint_id, event_id)", () => {
    expect(sql).toMatch(/foreign key \(endpoint_id, org_id\)\s+references public\.webhook_endpoints \(id, org_id\) on delete cascade/i);
    expect(sql).toMatch(/constraint webhook_deliveries_endpoint_event_key unique \(endpoint_id, event_id\)/i);
  });

  it("event_verbs pins shape (no NULL/blank) — app validates membership", () => {
    expect(sql).toMatch(/array_position\(event_verbs, null\) is null\s+and array_position\(event_verbs, ''\) is null/i);
  });

  it("the guard trigger freezes secret + org, sets verified_at once, and blocks unverified activation — for every role", () => {
    expect(sql).toMatch(/create or replace function public\.tg_webhook_endpoints_guard\(\)/i);
    expect(sql).toMatch(/set search_path = public/i);
    expect(sql).toMatch(/new\.secret is distinct from old\.secret/i);
    expect(sql).toMatch(/new\.org_id is distinct from old\.org_id/i);
    expect(sql).toMatch(/old\.verified_at is not null and new\.verified_at is distinct from old\.verified_at/i);
    expect(sql).toMatch(/new\.status = 'active' and new\.verified_at is null/i);
    expect(sql).toMatch(/create trigger webhook_endpoints_guard\s+before update on public\.webhook_endpoints/i);
  });
});

describe("migration — spine consumer wiring", () => {
  const sql = sqlOnly(read(MIGRATION));

  it("registers the outbound_webhooks consumer at the current head (no history replay)", () => {
    expect(sql).toMatch(/hq_consumer_register\('outbound_webhooks',\s*coalesce\(\(select max\(id\) from public\.hq_events\), 0\)\)/i);
  });

  it("adds the fan-out WHEN branch to the generic drainer's static dispatch", () => {
    expect(sql).toMatch(/when 'outbound_webhooks' then\s+perform public\.webhook_fan_out_event\(p_event\)/i);
    // the selftest branch is preserved (reproduced verbatim)
    expect(sql).toMatch(/when '__spine_selftest__' then/i);
  });

  it("all new functions are SECURITY DEFINER with a pinned search_path, service_role-only", () => {
    for (const fn of [
      "webhook_resolve_org",
      "webhook_fan_out_event",
      "webhook_dispatch_drain",
      "webhook_claim_deliveries",
      "webhook_mark_delivered",
      "webhook_mark_failed",
      "webhook_enqueue_ping",
    ]) {
      const re = new RegExp(`grant execute on function public\\.${fn}\\([^)]*\\)\\s+to service_role`, "i");
      expect(sql, `${fn} must be granted only to service_role`).toMatch(re);
      const revoke = new RegExp(`revoke all on function public\\.${fn}\\([^)]*\\)\\s+from public, anon, authenticated`, "i");
      expect(sql, `${fn} must be revoked from public/anon/authenticated`).toMatch(revoke);
    }
    // every definer function pins an empty search_path
    expect((sql.match(/security definer\s+set search_path = ''/gi) ?? []).length).toBeGreaterThanOrEqual(7);
  });
});

// ===========================================================================
// 2. SSRF — table-driven fuzz + vetted fetch
// ===========================================================================

describe("SSRF — private/loopback/link-local classification", async () => {
  const { isPrivateHost, isPrivateIpv4, isPrivateIpv6 } = await import("@/lib/webhooks/ssrf");

  const PRIVATE_HOSTS: [string, boolean][] = [
    // IPv4 RFC-1918 / loopback / link-local / reserved
    ["10.0.0.1", true],
    ["10.255.255.255", true],
    ["172.16.0.1", true],
    ["172.31.255.255", true],
    ["192.168.1.1", true],
    ["127.0.0.1", true],
    ["0.0.0.0", true],
    ["169.254.169.254", true], // cloud metadata
    ["100.64.0.1", true], // CGNAT
    ["224.0.0.1", true], // multicast
    // public v4 — allowed
    ["8.8.8.8", false],
    ["1.1.1.1", false],
    ["93.184.216.34", false],
    // hostnames
    ["localhost", true],
    ["foo.localhost", true],
    ["service.internal", true],
    ["printer.local", true],
    ["example.com", false],
    ["hooks.zapier.com", false],
    // IPv6
    ["::1", true],
    ["::", true],
    ["fe80::1", true], // link-local
    ["fc00::1", true], // ULA
    ["fd12:3456::1", true], // ULA
    ["fec0::1", true], // site-local
    ["ff02::1", true], // multicast
    ["::ffff:127.0.0.1", true], // v4-mapped loopback
    ["::ffff:169.254.169.254", true], // v4-mapped metadata
    ["::ffff:7f00:1", true], // v4-mapped loopback, hex form
    ["2606:4700:4700::1111", false], // public v6 (cloudflare)
  ];

  it.each(PRIVATE_HOSTS)("isPrivateHost(%s) === %s", (host, expected) => {
    expect(isPrivateHost(host)).toBe(expected);
  });

  it("v4 helper: malformed octets are treated as private", () => {
    expect(isPrivateIpv4("999.1.1.1")).toBe(true);
    expect(isPrivateIpv4("10.0.0.1")).toBe(true);
    expect(isPrivateIpv4("8.8.8.8")).toBe(false);
  });

  it("v6 helper: a malformed v4-mapped form is treated as private (conservative)", () => {
    expect(isPrivateIpv6("::ffff:1:2:3")).toBe(true); // too many groups after ::ffff:
    expect(isPrivateIpv6("::ffff:0:0")).toBe(true); // maps to 0.0.0.0
  });
});

describe("SSRF — assertPublicWebhookUrl rejects everything unsafe", async () => {
  const { assertPublicWebhookUrl, WebhookUrlError, validateWebhookUrl } = await import("@/lib/webhooks/ssrf");

  const REJECTS: [string, string][] = [
    ["http://example.com/hook", "not-https"], // plaintext
    ["ftp://example.com/hook", "not-https"],
    ["https://127.0.0.1/hook", "ip-literal"],
    ["https://10.0.0.5/hook", "ip-literal"],
    ["https://[::1]/hook", "ip-literal"],
    ["https://[fe80::1]/hook", "ip-literal"],
    ["https://192.168.0.1/hook", "ip-literal"],
    ["https://localhost/hook", "ip-literal"], // localhost has no dot → but is not an IP; falls to no-dot
    ["https://intranet/hook", "no-dot-host"],
    ["https://box.local/hook", "internal-tld"],
    ["https://svc.internal/hook", "internal-tld"],
    ["https://crewflow.uk/hook", "platform-host"],
    ["https://app.crewflow.uk/hook", "platform-host"],
    ["https://anything.vercel.app/hook", "platform-host"],
    ["not a url", "invalid-url"],
  ];

  it.each(REJECTS)("rejects %s", (url, reason) => {
    let thrown: unknown;
    try {
      assertPublicWebhookUrl(url);
    } catch (e) {
      thrown = e;
    }
    expect(thrown, `${url} should have been rejected`).toBeInstanceOf(WebhookUrlError);
    // localhost is special: it is not an IP literal but has no dot.
    if (url.includes("localhost")) {
      expect((thrown as { reason: string }).reason).toBe("no-dot-host");
    } else {
      expect((thrown as { reason: string }).reason).toBe(reason);
    }
  });

  it("accepts a normal public https URL", () => {
    expect(() => assertPublicWebhookUrl("https://hooks.example.com/crewflow")).not.toThrow();
    expect(validateWebhookUrl("https://hooks.example.com/crewflow")).toEqual({
      ok: true,
      url: "https://hooks.example.com/crewflow",
    });
  });
});

describe("SSRF — safeWebhookFetch vets before it connects (rebind defence)", async () => {
  const { safeWebhookFetch } = await import("@/lib/webhooks/ssrf");

  beforeEach(() => {
    mockLookup = () => Promise.reject(new Error("dns disabled in tests"));
  });

  it("refuses a bad URL WITHOUT any DNS/network work", async () => {
    let dnsCalled = false;
    mockLookup = () => {
      dnsCalled = true;
      return Promise.resolve([{ address: "8.8.8.8", family: 4 }]);
    };
    const r = await safeWebhookFetch("http://example.com/x", { body: "{}", headers: {} });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("blocked:not-https");
    expect(dnsCalled).toBe(false);
  });

  it("refuses when DNS resolves to a PRIVATE address (rebind) — no connection made", async () => {
    mockLookup = () => Promise.resolve([{ address: "169.254.169.254", family: 4 }]);
    const r = await safeWebhookFetch("https://evil.example.com/x", { body: "{}", headers: {} });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("blocked:dns-private");
  });

  it("refuses if ANY resolved address is private (mixed A records)", async () => {
    mockLookup = () =>
      Promise.resolve([
        { address: "93.184.216.34", family: 4 },
        { address: "10.0.0.9", family: 4 },
      ]);
    const r = await safeWebhookFetch("https://mixed.example.com/x", { body: "{}", headers: {} });
    expect(r.error).toBe("blocked:dns-private");
  });

  it("reports dns-failed on resolution error", async () => {
    mockLookup = () => Promise.reject(new Error("NXDOMAIN"));
    const r = await safeWebhookFetch("https://ghost.example.com/x", { body: "{}", headers: {} });
    expect(r.error).toBe("blocked:dns-failed");
  });
});

// ===========================================================================
// 3. Signature
// ===========================================================================

describe("HMAC signature — vector + tamper/replay", async () => {
  const { computeSignature, signWebhookPayload, verifyWebhookSignature, parseSignatureHeader } =
    await import("@/lib/webhooks/signature");

  const SECRET = "whsec_test_secret_value";
  const BODY = '{"id":42,"verb":"job.completed"}';
  const TS = 1_700_000_000;

  it("computes HMAC-SHA256 over `${t}.${body}` (independent reimplementation)", () => {
    const expected = createHmac("sha256", SECRET).update(`${TS}.${BODY}`, "utf8").digest("hex");
    expect(computeSignature(SECRET, BODY, TS)).toBe(expected);
    expect(expected).toMatch(/^[0-9a-f]{64}$/);
  });

  it("builds and parses the t=,v1= header", () => {
    const header = signWebhookPayload(SECRET, BODY, TS);
    expect(header).toBe(`t=${TS},v1=${computeSignature(SECRET, BODY, TS)}`);
    expect(parseSignatureHeader(header)).toEqual({ t: TS, v1: computeSignature(SECRET, BODY, TS) });
  });

  it("verifies a good signature and rejects tamper / wrong secret", () => {
    const header = signWebhookPayload(SECRET, BODY, TS);
    expect(verifyWebhookSignature(SECRET, BODY, header)).toBe(true);
    expect(verifyWebhookSignature(SECRET, BODY + " ", header)).toBe(false); // body tamper
    expect(verifyWebhookSignature("whsec_wrong", BODY, header)).toBe(false); // wrong secret
    expect(verifyWebhookSignature(SECRET, BODY, "garbage")).toBe(false);
    expect(verifyWebhookSignature(SECRET, BODY, null)).toBe(false);
  });

  it("enforces a freshness window when asked (replay defence)", () => {
    const header = signWebhookPayload(SECRET, BODY, TS);
    expect(verifyWebhookSignature(SECRET, BODY, header, { toleranceSeconds: 300, nowSeconds: TS + 100 })).toBe(true);
    expect(verifyWebhookSignature(SECRET, BODY, header, { toleranceSeconds: 300, nowSeconds: TS + 1000 })).toBe(false);
  });
});

// ===========================================================================
// 4. Backoff + circuit breaker
// ===========================================================================

describe("backoff schedule + ceilings", async () => {
  const { backoffMinutes, MAX_ATTEMPTS, FAILURE_THRESHOLD } = await import("@/server/services/webhook-dispatch");

  it("doubles 1m → 128m across the 8 attempts", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8].map(backoffMinutes)).toEqual([1, 2, 4, 8, 16, 32, 64, 128]);
  });

  it("caps at ~6h (360m) for large attempt numbers", () => {
    expect(backoffMinutes(20)).toBe(360);
  });

  it("MAX_ATTEMPTS is 8 and FAILURE_THRESHOLD is 5", () => {
    expect(MAX_ATTEMPTS).toBe(8);
    expect(FAILURE_THRESHOLD).toBe(5);
  });
});

// ===========================================================================
// 5. Allowlist ↔ Verb-registry drift guard
// ===========================================================================

describe("exposable-event allowlist — drift guard against the spine registry", async () => {
  const { EXPOSABLE_WEBHOOK_EVENTS, WEBHOOK_EVENT_LABELS, WEBHOOK_REDACTION_MAP } = await import("@/lib/webhooks/events");
  const { VERBS } = await import("@/lib/events/registry");

  it("every exposable verb is a REAL registered spine Verb", () => {
    const registered = new Set<string>(VERBS as readonly string[]);
    for (const verb of EXPOSABLE_WEBHOOK_EVENTS) {
      expect(registered.has(verb), `${verb} is not a registered Verb`).toBe(true);
    }
  });

  it("the allowlist is minimal and non-empty (a data-boundary decision)", () => {
    expect(EXPOSABLE_WEBHOOK_EVENTS.length).toBeGreaterThan(0);
    expect(EXPOSABLE_WEBHOOK_EVENTS.length).toBeLessThanOrEqual(12);
    expect(new Set(EXPOSABLE_WEBHOOK_EVENTS).size).toBe(EXPOSABLE_WEBHOOK_EVENTS.length); // no dupes
  });

  it("every exposable verb has a label AND a redaction entry (no silent gaps)", () => {
    for (const verb of EXPOSABLE_WEBHOOK_EVENTS) {
      expect(WEBHOOK_EVENT_LABELS[verb]).toBeTruthy();
      expect(WEBHOOK_REDACTION_MAP[verb]).toBeDefined();
    }
    expect(Object.keys(WEBHOOK_REDACTION_MAP).sort()).toEqual([...EXPOSABLE_WEBHOOK_EVENTS].sort());
  });
});

// ===========================================================================
// 6. Redaction
// ===========================================================================

describe("payload redaction — per-verb key allowlist", async () => {
  const { redactEnvelope } = await import("@/lib/webhooks/events");

  it("strips any key not on the verb's allowlist", () => {
    const out = redactEnvelope({
      id: 1,
      verb: "quote.sent",
      ts: "2026-08-01T00:00:00Z",
      org_id: "org-1",
      data: { number: "Q-1", total: 500, customer_email: "leak@example.com", notes: "secret" },
    });
    expect(out.data).toEqual({ number: "Q-1", total: 500 });
    expect(out.data).not.toHaveProperty("customer_email");
  });

  it("customer.updated keeps only fields; customer.created keeps nothing", () => {
    expect(
      redactEnvelope({ id: 2, verb: "customer.updated", ts: "t", org_id: "o", data: { fields: ["email"], name: "Jo" } }).data,
    ).toEqual({ fields: ["email"] });
    expect(
      redactEnvelope({ id: 3, verb: "customer.created", ts: "t", org_id: "o", data: { name: "Jo", email: "x@y.z" } }).data,
    ).toEqual({});
  });

  it("preserves envelope metadata (id/ts/object/org_id) untouched", () => {
    const out = redactEnvelope({
      id: 9,
      verb: "job.completed",
      ts: "2026-08-01",
      org_id: "org-9",
      object: { type: "job", id: "j-1" },
      data: { from: "in-progress", to: "completed", internal: "x" },
    });
    expect(out.id).toBe(9);
    expect(out.object).toEqual({ type: "job", id: "j-1" });
    expect(out.data).toEqual({ from: "in-progress", to: "completed" });
  });

  it("a non-exposable verb (ping) is passed through — it carries no tenant data", () => {
    const ping = { id: null, verb: "webhook.ping", ts: "t", org_id: "o", data: { message: "hi" } };
    expect(redactEnvelope(ping).data).toEqual({ message: "hi" });
  });
});

// ===========================================================================
// 7. Dark ⇒ zero egress; the single egress path; cron gates
// ===========================================================================

describe("dark ⇒ zero egress + single vetted egress path", () => {
  it("the cron checks the flag and 204-no-ops BEFORE any DB/egress work", () => {
    const route = codeOf(read("app/api/cron/webhook-dispatch/route.ts"));
    expect(route).toMatch(/export const runtime = "nodejs"/);
    const authIdx = route.indexOf("if (!isCronAuthorised");
    const flagIdx = route.indexOf("if (!outboundWebhooksEnabled()");
    const fanIdx = route.indexOf("await fanOutPendingEvents");
    expect(authIdx).toBeGreaterThan(-1);
    expect(flagIdx).toBeGreaterThan(authIdx); // flag checked after auth
    expect(route).toMatch(/if \(!outboundWebhooksEnabled\(\)\) \{\s*return new NextResponse\(null, \{ status: 204 \}\)/);
    expect(fanIdx).toBeGreaterThan(flagIdx); // real work only after the gate
  });

  it("the dispatch service egresses ONLY through safeWebhookFetch — no raw fetch/https", () => {
    const svc = codeOf(read("server/services/webhook-dispatch.ts"));
    expect(svc).toMatch(/safeWebhookFetch/);
    expect(svc).not.toMatch(/\bfetch\(/);
    expect(svc).not.toMatch(/https?\.request\(/);
    expect(svc).not.toMatch(/node:https|node:http\b/);
  });

  it("safeWebhookFetch is the ONLY network egress anywhere in lib/webhooks", () => {
    const dir = resolve(ROOT, "lib/webhooks");
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".ts")) continue;
      const src = codeOf(readFileSync(join(dir, name), "utf8"));
      if (name === "ssrf.ts") {
        expect(src, "ssrf.ts holds the single egress").toMatch(/https\.request\(/);
      } else {
        expect(src, `${name} must not perform network egress`).not.toMatch(/https?\.request\(|\bfetch\(/);
      }
    }
  });

  it("the cron is registered in vercel.json", () => {
    const vercel = JSON.parse(read("vercel.json")) as { crons: { path: string }[] };
    expect(vercel.crons.some((c) => c.path === "/api/cron/webhook-dispatch")).toBe(true);
  });

  it("the feature flag defaults to false in the env schema", () => {
    const env = read("lib/env.ts");
    expect(env).toMatch(/NEXT_PUBLIC_FEATURE_OUTBOUND_WEBHOOKS: z\.enum\(\["true", "false"\]\)\.default\("false"\)/);
  });

  it("no secret-touching file logs the secret", () => {
    for (const f of [
      "app/(app)/settings/webhooks/actions.ts",
      "app/(app)/settings/webhooks/page.tsx",
      "lib/webhooks/secret.ts",
    ]) {
      const calls = codeOf(read(f)).match(/console\.\w+\([^;]*\)/g) ?? [];
      for (const call of calls) {
        expect(call, `${f}: a console call references the secret`).not.toMatch(/secret/i);
      }
    }
    // the settings page never names the secret column, and never star-selects
    const page = codeOf(read("app/(app)/settings/webhooks/page.tsx"));
    expect(page).not.toMatch(/["'`]secret["'`]/);
    expect(page).not.toMatch(/select\(\s*["'`]\s*\*\s*["'`]\s*\)/);
  });
});
