import { describe, it, expect, vi, afterEach } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";

/**
 * Public API-key foundation (Train 9) — trust-boundary pins.
 *
 * What is pinned, and why each pin is load-bearing:
 *
 *  1. MIGRATION — RLS enabled, admin-only per-command policies, NO tenant
 *     delete (revoke, never erase), and the COLUMN-LEVEL key_hash exclusion:
 *     `revoke select … from authenticated` + an explicit safe-column grant
 *     that does not name key_hash. That grant list is the entire mechanism —
 *     someone "fixing" a failing select('*') by re-granting table-wide SELECT
 *     would silently hand every org admin offline-crack material.
 *
 *  2. SOURCE — the plaintext key is returned once and never persisted or
 *     logged; the resolver re-checks revoked_at/expires_at on EVERY call with
 *     no cache; the probe route is rate-limited and returns only the three
 *     safe fields.
 *
 *  3. THE DELIBERATE DEVIATION, FLAGGED NOT SILENT — the api_v1 rate limit
 *     inherits this module's fail-OPEN design. That was a reviewed v1 choice
 *     (a broken limiter must not black out a read-only substrate); the pin
 *     makes removing the flag, or silently flipping the trade, a red test.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

const MIGRATION = "supabase/migrations/20261086000000_api_keys.sql";
const MIG_DIR = resolve(ROOT, "supabase/migrations");

/** Strip SQL line comments so assertions test EXECUTABLE statements. */
const sqlOnly = (src: string) =>
  src
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("--");
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join("\n");

/** Strip TS/JS comments, for source contracts about real code. */
const codeOf = (ts: string) =>
  ts.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else yield p;
  }
}

// ---------------------------------------------------------------------------
// 1. Migration — the credential store's shape
// ---------------------------------------------------------------------------

describe("api_keys migration — slot + single definer", () => {
  it("occupies exactly the assigned slot 20261086000000, once", () => {
    const files = readdirSync(MIG_DIR).filter((f) => f.startsWith("20261086"));
    expect(files).toEqual(["20261086000000_api_keys.sql"]);
  });

  it("is the ONLY migration that defines api_keys policies or grants (replayed state)", () => {
    const definers = readdirSync(MIG_DIR)
      .filter((f) => f.endsWith(".sql"))
      .filter((f) => {
        const src = sqlOnly(readFileSync(resolve(MIG_DIR, f), "utf8"));
        return /(create policy|revoke|grant)[\s\S]{0,300}?public\.api_keys\b/i.test(src);
      })
      .sort();
    expect(definers).toEqual(["20261086000000_api_keys.sql"]);
  });
});

describe("api_keys migration — RLS is admin-only, and DELETE does not exist", () => {
  const sql = sqlOnly(read(MIGRATION));

  it("enables row level security", () => {
    expect(sql).toMatch(/alter table public\.api_keys enable row level security/i);
  });

  it("gates select, insert and update on public.is_org_admin", () => {
    expect(sql).toMatch(
      /for select to authenticated\s+using \(public\.is_org_admin\(org_id\)\)/i,
    );
    expect(sql).toMatch(
      /for insert to authenticated\s+with check \(public\.is_org_admin\(org_id\)\)/i,
    );
    expect(sql).toMatch(
      /for update to authenticated\s+using \(public\.is_org_admin\(org_id\)\)\s+with check \(public\.is_org_admin\(org_id\)\)/i,
    );
  });

  it("NEVER grants access via org membership — current_org_ids would show keys to every member", () => {
    expect(sql).not.toMatch(/current_org_ids/);
  });

  it("declares exactly THREE policies — and none of them is FOR DELETE or FOR ALL", () => {
    const policies = sql.match(/create policy[\s\S]*?on public\.api_keys/gi) ?? [];
    expect(policies).toHaveLength(3);
    expect(sql).not.toMatch(/for delete/i);
    expect(sql).not.toMatch(/for all/i);
  });

  it("revokes the DELETE grant too — no policy AND no privilege (two independent locks)", () => {
    expect(sql).toMatch(
      /revoke select, update, delete, truncate, references, trigger\s+on table public\.api_keys from authenticated/i,
    );
    expect(sql).toMatch(/revoke all on table public\.api_keys from anon/i);
  });
});

describe("api_keys migration — the column-level key_hash exclusion (THE mechanism)", () => {
  const sql = sqlOnly(read(MIGRATION));

  it("revokes table-wide SELECT from authenticated, then grants an EXPLICIT column list", () => {
    const grant = /grant select \(([^)]+)\)\s+on public\.api_keys to authenticated/i.exec(sql);
    expect(grant, "explicit safe-column SELECT grant missing").not.toBeNull();
    const columns = grant![1]!.split(",").map((c) => c.trim());
    expect(columns).toEqual([
      "id",
      "org_id",
      "name",
      "key_prefix",
      "scopes",
      "created_by",
      "created_at",
      "last_used_at",
      "expires_at",
      "revoked_at",
    ]);
    // The single most important assertion in this file.
    expect(columns).not.toContain("key_hash");
  });

  it("tenant UPDATE is column-limited to rename + revoke", () => {
    const grant = /grant update \(([^)]+)\)\s+on public\.api_keys to authenticated/i.exec(sql);
    expect(grant).not.toBeNull();
    expect(grant![1]!.split(",").map((c) => c.trim()).sort()).toEqual(["name", "revoked_at"]);
  });

  it("key_hash is unique (it IS the resolver's lookup key) and shape-constrained", () => {
    expect(sql).toMatch(/constraint api_keys_key_hash_key unique \(key_hash\)/i);
    expect(sql).toMatch(/key_hash\s+text not null check \(key_hash ~ '\^\[0-9a-f\]\{64\}\$'\)/i);
  });
});

describe("api_keys migration — org pinning + integrity", () => {
  const sql = sqlOnly(read(MIGRATION));

  it("org FK cascades and the (id, org_id) candidate key exists (house org-pinning shape)", () => {
    expect(sql).toMatch(
      /org_id\s+uuid not null references public\.organizations\(id\) on delete cascade/i,
    );
    expect(sql).toMatch(/constraint api_keys_id_org_key unique \(id, org_id\)/i);
  });

  it("credential immutability + revocation finality are trigger-enforced for EVERY role", () => {
    expect(sql).toMatch(/create or replace function public\.tg_api_keys_immutable\(\)/i);
    expect(sql).toMatch(/set search_path = public/i); // no schema-hijack surface
    expect(sql).toMatch(/new\.key_hash is distinct from old\.key_hash/i);
    expect(sql).toMatch(/old\.revoked_at is not null and new\.revoked_at is distinct from old\.revoked_at/i);
    expect(sql).toMatch(/create trigger api_keys_immutable\s+before update on public\.api_keys/i);
  });

  it("expiry must post-date creation; scope entries cannot be NULL or blank", () => {
    expect(sql).toMatch(/check \(expires_at is null or expires_at > created_at\)/i);
    expect(sql).toMatch(/array_position\(scopes, null\) is null and array_position\(scopes, ''\) is null/i);
  });
});

// ---------------------------------------------------------------------------
// 2. Source — the plaintext never persists, never logs
// ---------------------------------------------------------------------------

const SECRET_TOUCHING_FILES = [
  "lib/api-auth/keygen.ts",
  "lib/api-auth/resolve.ts",
  "lib/api-auth/scopes.ts",
  "app/(app)/settings/api-keys/actions.ts",
  "app/(app)/settings/api-keys/page.tsx",
  "app/(app)/settings/api-keys/_forms.tsx",
  "app/api/v1/me/route.ts",
];

describe("plaintext key — forbidden sinks", () => {
  it("no secret-touching file calls console.log at all", () => {
    for (const f of SECRET_TOUCHING_FILES) {
      expect(codeOf(read(f)), `${f} must not console.log`).not.toMatch(/console\.log\(/);
    }
  });

  it("no console call in any secret-touching file mentions the plaintext", () => {
    for (const f of SECRET_TOUCHING_FILES) {
      const calls = codeOf(read(f)).match(/console\.\w+\([^;]*\)/g) ?? [];
      for (const call of calls) {
        expect(call, `${f}: a console call references plaintext`).not.toMatch(/plaintext/i);
        expect(call, `${f}: a console call references the key object`).not.toMatch(/key\.plaintext/);
      }
    }
  });

  it("the create action inserts the HASH, never a plaintext column, and never selects back", () => {
    const action = codeOf(read("app/(app)/settings/api-keys/actions.ts"));
    const insert = /\.insert\(\{([\s\S]*?)\}\)/.exec(action);
    expect(insert, "insert payload not found").not.toBeNull();
    expect(insert![1]).toMatch(/key_hash: key\.keyHash/);
    expect(insert![1]).toMatch(/key_prefix: key\.keyPrefix/);
    expect(insert![1]).not.toMatch(/plaintext/);
    // No `.insert(...).select(...)` readback — key_hash must never round-trip.
    expect(action).not.toMatch(/\.insert\(\{[\s\S]*?\}\)\s*\.select/);
  });

  it("generation is CSPRNG — randomBytes, never Math.random", () => {
    const keygen = codeOf(read("lib/api-auth/keygen.ts"));
    expect(keygen).toMatch(/randomBytes\(/);
    for (const f of SECRET_TOUCHING_FILES) {
      expect(codeOf(read(f)), `${f} uses Math.random`).not.toMatch(/Math\.random/);
    }
  });

  it("no tenant-side surface ever names key_hash in a SELECT (only the service-role resolver + the insert write it)", () => {
    const page = codeOf(read("app/(app)/settings/api-keys/page.tsx"));
    const forms = codeOf(read("app/(app)/settings/api-keys/_forms.tsx"));
    expect(page).not.toMatch(/key_hash/);
    expect(forms).not.toMatch(/key_hash/);
    // And the page must not use a star select — the column grant makes it
    // fail, so a star here is a latent 500, not a convenience.
    expect(page).not.toMatch(/select\(\s*["'`]\s*\*\s*["'`]\s*\)/);
  });
});

// ---------------------------------------------------------------------------
// 3. Resolver — revoked/expired on EVERY call, no cache
// ---------------------------------------------------------------------------

describe("resolveApiKey — per-call authority", () => {
  const resolver = codeOf(read("lib/api-auth/resolve.ts"));

  it("checks revoked_at and expires_at inline on the fetched row", () => {
    expect(resolver).toMatch(/data\.revoked_at !== null.*return null/s);
    expect(resolver).toMatch(/data\.expires_at !== null && Date\.parse\(data\.expires_at\) <= Date\.now\(\)/);
  });

  it("holds NO cache: no module-level Map/store, a fresh lookup every call", () => {
    // The portal precedent stores nothing either; a Map here would turn
    // revocation into 'eventually'.
    expect(resolver).not.toMatch(/new Map\(/);
    expect(resolver).not.toMatch(/globalThis/);
    expect(resolver).not.toMatch(/lru|memoi[sz]e|cache/i);
  });

  it("looks up by sha256 of the presented key — no plaintext comparison anywhere", () => {
    expect(resolver).toMatch(/\.eq\("key_hash", hashApiKey\(plaintext\)\)/);
    expect(resolver).not.toMatch(/===\s*plaintext/);
  });

  it("refuses malformed keys BEFORE any DB traffic (format gate ahead of the client)", () => {
    const idx = resolver.indexOf("parseApiKeyFromAuthorization(authorizationHeader)");
    const client = resolver.indexOf("createAdminClient()", idx);
    expect(idx).toBeGreaterThan(-1);
    expect(client).toBeGreaterThan(idx);
    expect(resolver.slice(idx, client)).toMatch(/if \(!plaintext\) return null/);
  });
});

// ---------------------------------------------------------------------------
// 4. The probe route — 401 → rate limit → three safe fields
// ---------------------------------------------------------------------------

describe("GET /api/v1/me — the substrate's living proof", () => {
  const route = codeOf(read("app/api/v1/me/route.ts"));

  it("authenticates through resolveApiKey and 401s on null", () => {
    expect(route).toMatch(/resolveApiKey\(request\.headers\.get\("authorization"\)\)/);
    expect(route).toMatch(/if \(!key\) return UNAUTHORIZED\(\)/);
    expect(route).toMatch(/status: 401/);
  });

  it("rate-limits with DEFAULT_LIMITS.api_v1 keyed by the KEY ID", () => {
    expect(route).toMatch(
      /enforceIdentified\(\s*"api_v1",\s*key\.keyId,\s*DEFAULT_LIMITS\.api_v1,?\s*\)/,
    );
    expect(route).toMatch(/if \(limited\) return limited/);
  });

  it("returns ONLY {org_id, key_prefix, scopes} — nothing else, ever", () => {
    expect(route).toMatch(
      /NextResponse\.json\(\{\s*org_id: key\.orgId,\s*key_prefix: key\.keyPrefix,\s*scopes: key\.scopes,\s*\}\)/,
    );
    expect(route).not.toMatch(/key_hash/);
    expect(route).not.toMatch(/keyId(?!,\s*\n?\s*DEFAULT_LIMITS)/); // key id only feeds the limiter
  });

  it("is one of exactly NINE /api/v1 route files: the probe + the read/write surface (all dark behind one flag)", () => {
    // The probe (/me) needs no flag; the jobs read/write pair, the customers
    // read/write pair, the invoices + quotes reads (quotes also writes), the
    // leads write, and the openapi.json spec all ship DARK behind the ONE
    // FEATURE_PUBLIC_API_JOBS flag — every one 404s until the CEO enables it
    // (see lib/public-api/flag.ts). Exposing them is that decision; this pin
    // makes any FURTHER /api/v1 surface a conscious diff.
    const routes = [...walk(resolve(ROOT, "app/api/v1"))].filter((f) =>
      /route\.tsx?$/.test(f),
    );
    expect(routes.map((f) => f.replace(`${ROOT}/`, "")).sort()).toEqual([
      "app/api/v1/customers/[id]/route.ts",
      "app/api/v1/customers/route.ts",
      "app/api/v1/invoices/route.ts",
      "app/api/v1/jobs/[id]/route.ts",
      "app/api/v1/jobs/route.ts",
      "app/api/v1/leads/route.ts",
      "app/api/v1/me/route.ts",
      "app/api/v1/openapi.json/route.ts",
      "app/api/v1/quotes/route.ts",
    ]);
  });
});

// ---------------------------------------------------------------------------
// 5. Rate limiting — the DELIBERATE fail-open inheritance, flagged not silent
// ---------------------------------------------------------------------------

describe("api_v1 rate limit — configuration + the reviewed fail-open trade", () => {
  const rawSource = read("lib/security/rate-limit.ts"); // comments INCLUDED: the flag is the point

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("DEFAULT_LIMITS.api_v1 is 120 requests per 60s", async () => {
    const { DEFAULT_LIMITS } = await import("@/lib/security/rate-limit");
    expect(DEFAULT_LIMITS.api_v1).toEqual({ limit: 120, windowSeconds: 60 });
  });

  it("the fail-open inheritance is DOCUMENTED at the config site (removing the flag is a red test)", () => {
    expect(rawSource).toMatch(/DELIBERATE, REVIEWED v1 CHOICE — THE LIMITER FAILS OPEN/);
    expect(rawSource).toMatch(/must revisit it EXPLICITLY/);
  });

  it("and it is TRUE: with the api_v1 config, an internal limiter fault allows the request", async () => {
    const { check, DEFAULT_LIMITS, _resetForTests } = await import("@/lib/security/rate-limit");
    _resetForTests();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    // A TRANSIENT clock fault: the first Date.now() inside check() throws,
    // the recovery path's own Date.now() then works — the shape of a real
    // corrupted-entry/clock-skew blip the module's header describes.
    const realNow = Date.now.bind(Date);
    const now = vi.spyOn(Date, "now").mockImplementationOnce(() => {
      throw new Error("clock fault");
    });
    now.mockImplementation(realNow);
    try {
      const result = check("api_v1", "key-under-test", DEFAULT_LIMITS.api_v1);
      expect(result.allowed).toBe(true); // fail OPEN — the inherited, flagged design
    } finally {
      now.mockRestore();
      err.mockRestore();
    }
  });

  it("blocks the 121st request within a window (the limit actually limits)", async () => {
    const { check, DEFAULT_LIMITS, _resetForTests } = await import("@/lib/security/rate-limit");
    _resetForTests();
    for (let i = 0; i < 120; i++) {
      expect(check("api_v1", "busy-key", DEFAULT_LIMITS.api_v1).allowed).toBe(true);
    }
    expect(check("api_v1", "busy-key", DEFAULT_LIMITS.api_v1).allowed).toBe(false);
    // Another key is unaffected — the budget is per key id.
    expect(check("api_v1", "other-key", DEFAULT_LIMITS.api_v1).allowed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 6. Readiness — build facts that cannot drift
// ---------------------------------------------------------------------------

describe("integrations readiness — apiKeys block", () => {
  it("implemented:true is backed by the resolver actually existing in this build", async () => {
    const { getApiKeysReadiness } = await import("@/lib/integrations/readiness");
    const r = getApiKeysReadiness();
    expect(r.implemented).toBe(true);
    expect(existsSync(resolve(ROOT, "lib/api-auth/resolve.ts"))).toBe(true);
    expect(existsSync(resolve(ROOT, "lib/api-auth/keygen.ts"))).toBe(true);
  });

  it("endpoints equals the REAL number of /api/v1 routes (drift guard)", async () => {
    const { getApiKeysReadiness } = await import("@/lib/integrations/readiness");
    const routes = [...walk(resolve(ROOT, "app/api/v1"))].filter((f) =>
      /route\.tsx?$/.test(f),
    );
    expect(getApiKeysReadiness().endpoints).toBe(routes.length);
  });

  it("/api/health surfaces the block (booleans + count, no env names)", () => {
    const health = codeOf(read("app/api/health/route.ts"));
    expect(health).toMatch(/getIntegrationsReadiness/);
    expect(health).toMatch(/implemented: integrations\.apiKeys\.implemented/);
    expect(health).toMatch(/endpoints: integrations\.apiKeys\.endpoints/);
  });

  it("the readiness module is edge-safe: no server-only, no env reads, no SDK imports", () => {
    const readiness = codeOf(read("lib/integrations/readiness.ts"));
    expect(readiness).not.toMatch(/server-only/);
    expect(readiness).not.toMatch(/process\.env/);
    expect(readiness).not.toMatch(/from "@\/lib\/supabase/);
  });
});
