import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { AI_TASK_CLASSES, AI_TIERS, TIER_MODEL, isAnyTierBound } from "@/lib/ai/governor/registry";
import {
  getAiGovernorReadiness,
  isGovernorActivated,
  isInferenceTierActivated,
  isTierActivated,
  KNOWN_VENDOR_CREDENTIALS,
} from "@/lib/ai/governor/readiness";
import { AI_MONTHLY_CEILING_PENCE } from "@/lib/ai/governor/policy";

// ---------------------------------------------------------------------------
// RUNTIME FIXTURES for the partial-binding proof (section 10, at the foot of
// this file). A mutable TIER_MODEL stands in for the registry's so ONE tier can
// be armed at a time; the admin client is a COUNTING mock so "no reservation
// RPC" is a measurement, not a claim; the text door hands back a LIVE provider
// so the caller is driven into exactly the cross-tier shape the fix defends.
//
// Everything else — readiness, the governor seam, the caller — is REAL. The mocks
// default to fully DARK (every tier null), so the source-text sections above,
// which assert TIER_MODEL is null and the governor is unactivated, are unaffected;
// the one runtime describe arms `cheap` inside its own before/afterEach and resets.
// ---------------------------------------------------------------------------

const tierModelRef = vi.hoisted(
  () =>
    ({ cheap: null, mid: null, high: null, embedding: null }) as Record<string, unknown>,
);
vi.mock("@/lib/ai/governor/registry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai/governor/registry")>();
  // Same object identity across the whole module graph; the runtime test mutates
  // its keys. `isAnyTierBound` stays actual (it closes over the real, all-null
  // table), so the darkness pins above keep reading false regardless.
  return { ...actual, TIER_MODEL: tierModelRef };
});

const adminConstructions = vi.hoisted(() => ({ count: 0 }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    adminConstructions.count += 1;
    return {
      from: () => ({ insert: async () => ({ error: null }) }),
      rpc: async () => ({ data: [], error: null }),
    };
  },
}));

const providerGenerate = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ai/text", () => ({
  // The door is stubbed OPEN with a live provider — the partial-binding shape.
  // Whether the caller nonetheless calls it is the thing under test.
  getTextProvider: () => ({
    info: { provider: "anthropic", model: "fake-model" },
    generate: providerGenerate,
  }),
  textCostUsd: () => 0,
}));

import { invokeWithGovernor } from "@/lib/ai/governor";
import { generateInsightNarrative } from "@/lib/ai/insight-narrative";

/**
 * AI Cost Governor — trust-boundary invariants (slot 20261062).
 *
 * This wave installs a cost control BEFORE the thing it controls exists. Two
 * classes of claim therefore have to be proven against SOURCE TEXT rather than
 * against behaviour, because the behaviour is (deliberately) "nothing happens":
 *
 *   A. THE DARKNESS IS REAL. No provider is activated, no credential is
 *      introduced, every tier maps to no model, and the readiness surfaces say
 *      so. This mirrors the comms-readiness precedent (lib/comms/readiness.ts,
 *      __tests__/comms/readiness.test.ts) whose whole existence traces to a
 *      capability reporting ready over a path that could not run.
 *
 *   B. THE LEDGER'S BOUNDARY HOLDS. Usage telemetry is admin-read-only per org
 *      and service-role-write-only, the rollups hold no privilege of their own,
 *      and a row cannot be rewritten. A SECURITY DEFINER aggregate here would
 *      have been a cross-tenant read primitive — the exact defect class the
 *      20261031–37 storage wave was written to eliminate.
 *
 * SQL checks run over `exec` (-- comments stripped); TS checks over `code`
 * (// and block comments stripped) — so the prose that DOCUMENTS a contract can
 * neither satisfy a positive match nor trip a negative one.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

function execOf(sql: string): string {
  return sql
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("--");
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join("\n");
}

function codeOf(ts: string): string {
  return ts.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const MIG_DIR = resolve(ROOT, "supabase/migrations");
const MIGRATION = "supabase/migrations/20261062000000_ai_invocations.sql";
/** The atomic budget reservation — slot 20261070, this lane's only slot. */
const RESERVATION = "supabase/migrations/20261070000000_ai_budget_reservation.sql";
const SEAM = "lib/ai/governor.ts";
const POLICY = "lib/ai/governor/policy.ts";
const REGISTRY = "lib/ai/governor/registry.ts";
const READINESS = "lib/ai/governor/readiness.ts";
const SNAPSHOT = "server/services/ai-cost-snapshot.ts";
const HQ_PAGE = "app/admin/ai-costs/page.tsx";

/** Every file this wave adds. The "no new credential" pins sweep all of them. */
const WAVE_TS = [SEAM, POLICY, REGISTRY, READINESS, SNAPSHOT, HQ_PAGE] as const;

/** The files whose provider calls this wave routed through the governor. */
const GOVERNED = [
  "server/services/expense-drafts.ts",
  "server/services/receptionist-generation.ts",
  "server/services/receptionist.ts",
] as const;

// =====================================================================
// 0. Migration hygiene — the reserved slot, and nothing back-dated under it.
// =====================================================================

describe("20261062 migration hygiene", () => {
  it("exists in its reserved slot", () => {
    expect(existsSync(resolve(ROOT, MIGRATION))).toBe(true);
  });

  it("uses its slot, with NO duplicate version prefix anywhere in the directory", () => {
    // Supabase keys migration identity on the numeric prefix. Two files sharing
    // one prefix replay unpredictably from a fresh database while looking fine
    // on an already-migrated one — the failure that only shows up in a restore.
    const versions = readdirSync(MIG_DIR)
      .filter((f) => f.endsWith(".sql"))
      .map((f) => f.split("_")[0]!)
      .sort();

    expect(versions).toContain("20261062000000");
    expect(new Set(versions).size, "duplicate migration version prefixes").toBe(versions.length);
  });

  it("sorts strictly AFTER the applied production tip (20261058)", () => {
    const versions = readdirSync(MIG_DIR)
      .filter((f) => f.endsWith(".sql"))
      .map((f) => f.split("_")[0]!)
      .sort();
    expect(versions.indexOf("20261062000000")).toBeGreaterThan(
      versions.indexOf("20261058000000"),
    );
  });

  it("claims ONLY its own slot — no 20261059/60/61 file is added here", () => {
    // Those numbers belong to other lanes working in parallel.
    const owned = readdirSync(MIG_DIR).filter((f) =>
      /^2026(1059|1060|1061)/.test(f),
    );
    for (const f of owned) {
      expect(f).not.toMatch(/ai_invocation|governor|ai_cost/i);
    }
  });

  it("is ADDITIVE — it creates its own objects and alters no existing table", () => {
    const exec = execOf(read(MIGRATION));
    expect(exec).not.toMatch(/\balter\s+table\s+public\.(?!ai_invocations)/i);
    expect(exec).not.toMatch(/\bdrop\s+table\b/i);
    const creates = exec.match(/create\s+table\s+if\s+not\s+exists\s+public\.(\w+)/gi) ?? [];
    expect(creates).toHaveLength(1);
    expect(exec).toMatch(/create\s+table\s+if\s+not\s+exists\s+public\.ai_invocations/i);
  });
});

// =====================================================================
// 1. The ledger's shape — the columns the ceiling depends on.
// =====================================================================

describe("ai_invocations — shape", () => {
  const exec = execOf(read(MIGRATION));

  it("is org-scoped and TEARDOWN-SAFE (cascades from organizations)", () => {
    expect(exec).toMatch(
      /org_id\s+uuid\s+not\s+null\s+references\s+public\.organizations\s*\(\s*id\s*\)\s+on\s+delete\s+cascade/i,
    );
  });

  it("user_id is NULLABLE and survives the user — system jobs have no human", () => {
    expect(exec).toMatch(
      /user_id\s+uuid\s+references\s+public\.users\s*\(\s*id\s*\)\s+on\s+delete\s+set\s+null/i,
    );
    expect(exec).not.toMatch(/user_id\s+uuid\s+not\s+null/i);
  });

  it("cost is INTEGER PENCE, not numeric — telemetry, never commercial money", () => {
    expect(exec).toMatch(/estimated_cost_pence\s+integer\s+not\s+null/i);
    expect(exec).not.toMatch(/estimated_cost_pence\s+numeric/i);
    // And it can never be negative.
    expect(exec).toMatch(/check\s*\(\s*estimated_cost_pence\s*>=\s*0\s*\)/i);
  });

  it("records the full accounting shape the governor writes", () => {
    for (const col of [
      /feature\s+text\s+not\s+null/i,
      /provider\s+text\s+not\s+null/i,
      /model\s+text\s+not\s+null/i,
      /input_tokens\s+integer\s+not\s+null/i,
      /output_tokens\s+integer\s+not\s+null/i,
      /latency_ms\s+integer\s+not\s+null/i,
      /success\s+boolean\s+not\s+null/i,
      /error_code\s+text/i,
      /created_at\s+timestamp\s+with\s+time\s+zone\s+not\s+null\s+default\s+now\(\)/i,
    ]) {
      expect(exec, `missing column matching ${col}`).toMatch(col);
    }
  });

  it("a DETERMINISTIC invocation is structurally UNREPRESENTABLE", () => {
    // The TypeScript wrapper refuses it; the database makes the same claim for
    // every role including service_role, which no procedural code can bypass.
    expect(exec).toMatch(
      /task_class\s+text\s+not\s+null\s+check\s*\(\s*task_class\s+in\s*\(\s*'classification'\s*,\s*'drafting'\s*,\s*'complex'\s*\)\s*\)/i,
    );
    expect(exec).not.toMatch(/task_class\s+in\s*\([^)]*'deterministic'/i);
  });

  it("a failure must carry a code, and a success must not", () => {
    expect(exec).toMatch(
      /check\s*\(\s*\(\s*success\s+and\s+error_code\s+is\s+null\s*\)\s+or\s+\(\s*not\s+success\s+and\s+error_code\s+is\s+not\s+null\s*\)\s*\)/i,
    );
  });

  it("content_hash is a FINGERPRINT — hex-shaped, never the prompt", () => {
    expect(exec).toMatch(/content_hash\s+text\s+check[^,]*\^\[0-9a-f\]\{64\}\$/i);
    // No column exists that could hold the request or response body.
    expect(exec).not.toMatch(/\b(prompt|request_body|response_body|content|transcript)\s+text/i);
  });

  it("carries the two required indexes: (org_id, created_at) and (feature)", () => {
    expect(exec).toMatch(
      /create\s+index\s+if\s+not\s+exists\s+ai_invocations_org_created_idx\s+on\s+public\.ai_invocations\s*\(\s*org_id\s*,\s*created_at/i,
    );
    expect(exec).toMatch(
      /create\s+index\s+if\s+not\s+exists\s+ai_invocations_feature_idx\s+on\s+public\.ai_invocations\s*\(\s*feature/i,
    );
  });
});

// =====================================================================
// 2. THE boundary — admin-read-only, service-role write, immutable.
// =====================================================================

describe("ai_invocations — RLS is admin-read-only per org, writes are service-role only", () => {
  const exec = execOf(read(MIGRATION));

  it("RLS is ENABLED", () => {
    expect(exec).toMatch(
      /alter\s+table\s+public\.ai_invocations\s+enable\s+row\s+level\s+security/i,
    );
  });

  it("has EXACTLY ONE policy, and it is a SELECT gated on is_org_admin", () => {
    // Usage data reveals how a firm works. It is owner/admin information, not
    // crew information — so membership is deliberately NOT enough.
    const policies = exec.match(/create\s+policy\s+\w+\s+on\s+public\.ai_invocations/gi) ?? [];
    expect(policies).toHaveLength(1);
    expect(exec).toMatch(
      /create\s+policy\s+ai_invocations_select\s+on\s+public\.ai_invocations\s+for\s+select\s+using\s*\(\s*public\.is_org_admin\s*\(\s*org_id\s*\)\s*\)/i,
    );
    expect(exec).not.toMatch(/using\s*\(\s*org_id\s+in\s*\(\s*select\s+public\.current_org_ids/i);
  });

  it("has NO insert / update / delete policy — a tenant client can never write a row", () => {
    // If a user could insert, a user could fabricate spend to trip their own
    // ceiling, or write zero-cost rows while the real spend went unrecorded.
    expect(exec).not.toMatch(/for\s+insert/i);
    expect(exec).not.toMatch(/create\s+policy[^;]*for\s+update/i);
    expect(exec).not.toMatch(/create\s+policy[^;]*for\s+delete/i);
    expect(exec).not.toMatch(/for\s+all\b/i);
  });

  it("rows are IMMUTABLE — a BEFORE UPDATE trigger refuses every rewrite", () => {
    expect(exec).toMatch(/before\s+update\s+on\s+public\.ai_invocations/i);
    expect(exec).toMatch(/execute\s+function\s+public\.tg_ai_invocations_immutable\(\)/i);
    expect(exec).toMatch(/raise\s+exception[^;]*immutable/i);
  });

  it("DELETE is deliberately NOT guarded, so org teardown still cascades", () => {
    // A BEFORE DELETE guard would abort `delete from organizations` — the exact
    // failure 20261052 was written to fix, and the one that blocks GDPR erasure.
    expect(exec).not.toMatch(/before\s+delete\s+on\s+public\.ai_invocations/i);
    expect(exec).not.toMatch(/for\s+each\s+row[^;]*delete[^;]*ai_invocations_immutable/i);
  });

  it("the ONE permitted update is `user_id → null`, and the hole is cut narrowly", () => {
    // `on delete set null` is implemented as an UPDATE, so a blanket refusal
    // would make this ledger BLOCK USER DELETION — the same class of failure as
    // a delete guard, and one that leaves personal data undeletable.
    expect(exec).toMatch(/old\.user_id\s+is\s+not\s+null\s+and\s+new\.user_id\s+is\s+null/i);
    // The narrowness: the whole row must otherwise be byte-identical…
    expect(exec).toMatch(/new\s+is\s+not\s+distinct\s+from\s+v_anonymised/i);
    // …compared with IS NOT DISTINCT FROM, never `=`. Row equality involving a
    // NULL field yields NULL, which would refuse every legitimate anonymisation
    // of a row with a null error_code or content_hash.
    expect(exec).not.toMatch(/if\s+new\s*=\s*v_anonymised/i);
  });
});

// =====================================================================
// 3. The rollups hold NO privilege of their own.
// =====================================================================

describe("the monthly rollups are invoker-rights and month-correct", () => {
  const exec = execOf(read(MIGRATION));

  it("neither rollup is SECURITY DEFINER — no cross-tenant read primitive is created", () => {
    // THE pin. A definer-rights aggregate over an org-scoped table hands any
    // authenticated caller another tenant's totals — the defect class the
    // 20261031–37 storage wave existed to eliminate.
    expect(exec).not.toMatch(/security\s+definer/i);
  });

  it("both rollups pin an empty search_path", () => {
    const setPaths = exec.match(/set\s+search_path\s*=\s*''/gi) ?? [];
    expect(setPaths.length).toBeGreaterThanOrEqual(2);
  });

  it("ships the org-month rollup and the per-feature rollup", () => {
    expect(exec).toMatch(
      /create\s+or\s+replace\s+function\s+public\.ai_invocations_month_totals\s*\(/i,
    );
    expect(exec).toMatch(
      /create\s+or\s+replace\s+function\s+public\.ai_invocations_month_by_feature\s*\(/i,
    );
  });

  it("the month window is EUROPE/LONDON, matching the TypeScript month key", () => {
    // A UTC month would spend August's budget out of July for the first hour of
    // every BST month — and, at a blocked boundary, refuse the first call of a
    // fresh month.
    const windows = exec.match(/at\s+time\s+zone\s+'Europe\/London'/gi) ?? [];
    expect(windows.length).toBeGreaterThanOrEqual(4); // two bounds × two functions
    expect(exec).toMatch(/date_trunc\s*\(\s*'month'/i);
  });

  it("the window is HALF-OPEN — `>= start` and `< end`, so no row is double-counted", () => {
    expect(exec).toMatch(/created_at\s*>=\s*\(\s*b\.naive_start/i);
    expect(exec).toMatch(/created_at\s*<\s*\(\s*b\.naive_end/i);
    expect(exec).not.toMatch(/created_at\s*<=\s*\(\s*b\.naive_end/i);
  });

  it("EXECUTE is revoked from public before being granted — no accidental inheritance", () => {
    expect(exec).toMatch(
      /revoke\s+all\s+on\s+function\s+public\.ai_invocations_month_totals\(uuid,\s*date\)\s+from\s+public/i,
    );
    expect(exec).toMatch(
      /revoke\s+all\s+on\s+function\s+public\.ai_invocations_month_by_feature\(date,\s*uuid\)\s+from\s+public/i,
    );
  });

  it("contains no dynamic SQL", () => {
    expect(exec).not.toMatch(/\bexecute\s+format\s*\(/i);
    expect(exec).not.toMatch(/\bexecute\s+'/i);
  });
});

// =====================================================================
// 4. NO PROVIDER IS ACTIVATED. The darkness, proven against source.
// =====================================================================

describe("A. no provider is activated and no credential is introduced", () => {
  it("EVERY tier maps to null in the source — the routing table is literally dark", () => {
    const code = codeOf(read(REGISTRY));
    expect(code).toMatch(/cheap:\s*null/);
    expect(code).toMatch(/mid:\s*null/);
    expect(code).toMatch(/high:\s*null/);
    // And at runtime.
    for (const tier of AI_TIERS) expect(TIER_MODEL[tier]).toBeNull();
    expect(isAnyTierBound()).toBe(false);
  });

  it("the registry names NO vendor and NO model — activation is a visible diff, not a config value", () => {
    const code = codeOf(read(REGISTRY));
    expect(code).not.toMatch(/claude-|gpt-4|gpt-5|gemini|mistral|llama|haiku|sonnet|opus/i);
    // The tier→model binding is not readable from the environment either: a
    // model change alters cost and quality for every tenant at once.
    expect(code).not.toMatch(/process\.env/);
  });

  it("NO new credential env var is introduced by ANY file in this wave", () => {
    // The only two AI credentials this build knows are the ones that already
    // existed (lib/ai/text/index.ts, lib/ai/safety.ts). This wave adds none.
    //
    // Two things are swept, because a credential can enter either way:
    //   (a) a direct `process.env.NAME` / `process.env["NAME"]` read;
    //   (b) a credential-SHAPED STRING LITERAL — how readiness.ts names the
    //       variables it probes, and how a new vendor would slip in.
    // Bare identifiers are deliberately NOT swept: a local like `MONTH_KEY` is
    // not a credential, and matching it would make this pin noise.
    const ALLOWED = new Set(["ANTHROPIC_API_KEY", "OPENAI_API_KEY"]);
    const CREDENTIAL_SHAPED = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*_(?:API_KEY|SECRET|TOKEN|PASSWORD)$/;

    for (const file of WAVE_TS) {
      const code = codeOf(read(file));

      const envReads = [
        ...code.matchAll(/process\.env\.([A-Z0-9_]+)/g),
        ...code.matchAll(/process\.env\[\s*["']([A-Z0-9_]+)["']\s*\]/g),
      ].map((m) => m[1]!);
      for (const n of envReads) {
        expect(ALLOWED.has(n), `${file} reads env var ${n}`).toBe(true);
      }

      const literals = [...code.matchAll(/["']([A-Z][A-Z0-9_]*)["']/g)]
        .map((m) => m[1]!)
        .filter((n) => CREDENTIAL_SHAPED.test(n));
      for (const n of literals) {
        expect(ALLOWED.has(n), `${file} names credential ${n}`).toBe(true);
      }
    }
    expect([...KNOWN_VENDOR_CREDENTIALS].sort()).toEqual(["ANTHROPIC_API_KEY", "OPENAI_API_KEY"]);
  });

  it("the governor imports NO vendor SDK and opens NO network connection", () => {
    for (const file of [SEAM, POLICY, REGISTRY, READINESS]) {
      const code = codeOf(read(file));
      expect(code, `${file} must not import a vendor SDK`).not.toMatch(
        /@anthropic-ai\/sdk|from\s+"openai"|new\s+Anthropic|new\s+OpenAI/,
      );
      expect(code, `${file} must not open a network connection`).not.toMatch(/\bfetch\s*\(/);
    }
  });

  it("the DARK READINESS SURFACES report false", () => {
    const r = getAiGovernorReadiness();
    expect(r.activated).toBe(false);
    expect(r.anyTierBound).toBe(false);
    expect(isGovernorActivated()).toBe(false);
    expect(r.tiers.every((t) => !t.providerResolvable)).toBe(true);
    expect(r.blockers.length).toBeGreaterThan(0);
  });

  it("readiness mirrors the comms precedent's decomposition — not one ambiguous boolean", () => {
    const code = codeOf(read(READINESS));
    for (const field of [
      "modelBindingPresent",
      "credentialsPresent",
      "providerResolvable",
      "activated",
      "blockers",
    ]) {
      expect(code, `readiness must report ${field}`).toContain(field);
    }
    // The invariant, in source: resolvable requires the build-time fact FIRST.
    expect(code).toMatch(
      /providerResolvable\s*=\s*modelBindingPresent\s*&&\s*credentialsPresent/,
    );
  });

  it("readiness is edge-safe: no server-only, no DB client, no SDK", () => {
    const code = codeOf(read(READINESS));
    expect(code).not.toMatch(/server-only/);
    expect(code).not.toMatch(/createAdminClient|@\/lib\/supabase/);
  });
});

// =====================================================================
// 5. The ceiling is product policy, in code.
// =====================================================================

describe("the £100 ceiling is a CODE CONSTANT, not configuration", () => {
  it("is 10,000 integer pence", () => {
    expect(AI_MONTHLY_CEILING_PENCE).toBe(10_000);
  });

  it("the pure core reads NO environment variable at all", () => {
    // If the ceiling were an env var it could be raised on a deploy dashboard
    // to silence an alert, with no diff and no reviewer.
    const code = codeOf(read(POLICY));
    expect(code).not.toMatch(/process\.env/);
    expect(code).toMatch(/export\s+const\s+AI_MONTHLY_CEILING_PENCE\s*=\s*10_000/);
  });

  it("the pure core is PURE — no server-only, no DB client, no network", () => {
    for (const file of [POLICY, REGISTRY]) {
      const code = codeOf(read(file));
      expect(code, file).not.toMatch(/server-only/);
      expect(code, file).not.toMatch(/createAdminClient|@\/lib\/supabase/);
      expect(code, file).not.toMatch(/\bfetch\s*\(/);
    }
  });

  it("the SEAM is server-only and writes through the service-role client alone", () => {
    const code = codeOf(read(SEAM));
    expect(code).toMatch(/^import\s+"server-only";/m);
    expect(code).toMatch(/createAdminClient/);
    // Never a tenant client: the ledger has no INSERT policy, so a tenant
    // client could not write anyway — using one would be a silent no-op.
    expect(code).not.toMatch(/@\/lib\/supabase\/server/);
  });
});

// =====================================================================
// 6. The dark seams are wired, and their degraded paths are intact.
// =====================================================================

describe("B. the existing dark provider paths now route through the governor", () => {
  it("all three governed services import the seam", () => {
    for (const file of GOVERNED) {
      expect(codeOf(read(file)), `${file} must import invokeWithGovernor`).toMatch(
        /invokeWithGovernor/,
      );
    }
  });

  it("expense receipt extraction is governed and STILL degrades to an empty draft", () => {
    const code = codeOf(read("server/services/expense-drafts.ts"));
    expect(code).toMatch(/invokeWithGovernor\(\s*\n?\s*"expense\.receipt_extraction"/);
    // The gate is now the SHARED VISION DOOR rather than `isAiConfigured()`. The
    // old bare key check was satisfied by a credential alone, so it let this path
    // reach a provider while no cost tier was bound — real spend that the
    // governor's dark pass-through could only wave through. `getVisionProvider()`
    // requires governor ACTIVATION, and the degraded value is unchanged.
    expect(code).toMatch(/const vision = getVisionProvider\(\)/);
    expect(code).toMatch(/if\s*\(\s*!vision/);
    expect(code).not.toMatch(/if\s*\(\s*!isAiConfigured\(\)/);
    expect(code).toMatch(/return\s+zeroExtraction\(\)/);
    // …and it no longer constructs a vendor SDK of its own.
    expect(code).not.toMatch(/@anthropic-ai\/sdk|new\s+Anthropic/);
  });

  it("receptionist inbound extraction is governed and STILL degrades deterministically", () => {
    const code = codeOf(read("server/services/receptionist.ts"));
    expect(code).toMatch(/invokeWithGovernor\(\s*\n?\s*"receptionist\.inbound_extraction"/);
    // Same substitution, same reason: activation, not a credential.
    expect(code).toMatch(/if\s*\(\s*!isTierActivated\(\"cheap\"\)\s*\|\|\s*!rawText\.trim\(\)\s*\)/);
    expect(code).not.toMatch(/if\s*\(\s*!isAiConfigured\(\)/);
    expect(code).toMatch(/return\s+deterministicExtract\(rawText\)/);
  });

  it("the conversation engine — the WhatsApp draft path too — is governed and STILL degrades", () => {
    const code = codeOf(read("server/services/receptionist-generation.ts"));
    expect(code).toMatch(/invokeWithGovernor\(\s*\n?\s*"receptionist\.reply_draft"/);
    // The pre-existing no-provider gate is untouched: getTextProvider() null ⇒
    // the deterministic acknowledgement, and the governor is never reached.
    expect(code).toMatch(/if\s*\(\s*!provider\s*\)\s*return\s+fallbackResponse\([^)]*no_provider/);
    // Budget refusal and duplicate refusal degrade the SAME way — total generation.
    expect(code).toMatch(/fallbackResponse\([^)]*budget_blocked/);
    expect(code).toMatch(/fallbackResponse\([^)]*duplicate_request/);
  });

  it("the governor RETHROWS rather than swallowing, so each caller's catch is unchanged", () => {
    const code = codeOf(read(SEAM));
    expect(code).toMatch(/throw\s+err;/);
    // It records the failure BEFORE rethrowing.
    const idxRecord = code.indexOf("success: false");
    const idxThrow = code.indexOf("throw err;");
    expect(idxRecord).toBeGreaterThan(-1);
    expect(idxThrow).toBeGreaterThan(idxRecord);
  });

  it("the DARK SHORT-CIRCUIT comes before the RESERVATION — no claim on a dark build", () => {
    // This is what makes wiring the dark seams a genuine no-op, and it still
    // holds with the atomic reservation in place: the reservation sits BEHIND
    // the short-circuit, so `ai_cost_reservations` stays empty in production.
    // PER-TIER since the embeddings governance train: the gate asks whether
    // THIS call's tier can reach a provider — a build with one modality armed
    // must not push the other's calls into the reservation path with a null
    // binding.
    const code = codeOf(read(SEAM));
    const idxDark = code.indexOf("!isTierActivated(tier)");
    const idxReserve = code.indexOf("await reserveBudget(");
    const idxSettle = code.indexOf("await settleReservation(");
    expect(idxDark).toBeGreaterThan(-1);
    expect(idxReserve).toBeGreaterThan(-1);
    expect(idxSettle).toBeGreaterThan(-1);
    expect(idxDark).toBeLessThan(idxReserve);
    expect(idxDark).toBeLessThan(idxSettle);
    // And the seam no longer consults the GLOBAL predicate at all.
    expect(code).not.toMatch(/\bisGovernorActivated\s*\(\)/);
  });

  it("the ceiling is decided by ONE atomic RPC, never by a read-then-act in TypeScript", () => {
    // THE pin for this whole wave. The old governor decided the ceiling with
    // `await checkBudget(...)` and the duplicate question with a `select` over
    // the ledger, both inside `invokeWithGovernor` — two reads with the provider
    // call between them and the write. Neither may return.
    const code = codeOf(read(SEAM));
    const invoke = code.slice(code.indexOf("export async function invokeWithGovernor"));
    expect(invoke, "invokeWithGovernor must not read the budget to decide it").not.toMatch(
      /await\s+checkBudget\s*\(/,
    );
    expect(invoke, "the dedupe probe must not be a TypeScript read").not.toMatch(
      /hasRecentIdentical/,
    );
    // …and the decision it DOES make is a single RPC to the SQL gate.
    expect(code).toMatch(/const\s+RESERVE_FN\s*=\s*"ai_reserve_invocation"/);
    expect(code).toMatch(/\.rpc\(RESERVE_FN,/);
  });

  it("the reservation FAILS CLOSED — an error refuses the call, it never falls through", () => {
    // The one place the governor's fail-open posture is deliberately reversed.
    // A reservation that failed open would mean the ceiling is unenforced
    // whenever the database hiccups, which is not a control at all.
    const code = codeOf(read(SEAM));
    const fn = code.slice(
      code.indexOf("export async function reserveBudget"),
      code.indexOf("export async function settleReservation"),
    );
    expect(fn.length).toBeGreaterThan(0);
    expect(fn).toMatch(/reason:\s*"reservation_unavailable"/);

    // Every error exit is a REFUSAL. Checked by isolating the two error paths —
    // the `if (error)` branch and the `catch` — and asserting neither can hand
    // back a claim. A single grep over the whole function would pass on the
    // happy path's own `reserved` and prove nothing.
    const errBranch = fn.slice(fn.indexOf("if (error)"), fn.indexOf("const row ="));
    const catchBlock = fn.slice(fn.lastIndexOf("} catch (e)"));
    expect(errBranch.length).toBeGreaterThan(0);
    expect(catchBlock.length).toBeGreaterThan(0);
    for (const [name, block] of [
      ["error branch", errBranch],
      ["catch block", catchBlock],
    ] as const) {
      expect(block, `${name} must refuse`).toMatch(/outcome:\s*"blocked"/);
      expect(block, `${name} must not admit a claim`).not.toMatch(/outcome:\s*"reserved"/);
    }
    // An unrecognised SQL outcome is refused too, never assumed benign.
    expect(fn).toMatch(/unrecognised reservation outcome/);
  });

  it("the seam states the event-driven doctrine — AI wakes on change, never on page load", () => {
    // Kept in the module header on purpose: no wrapper can enforce WHERE a call
    // is made, so the rule has to be written where the next author will read it.
    const header = read(SEAM).slice(0, 4000);
    expect(header).toMatch(/wakes\s+on\s+meaningful\s+change,\s+never\s+on\s+page\s+load/i);
  });
});

// =====================================================================
// 7. The HQ view is HQ-gated and reads through the service role only.
// =====================================================================

// =====================================================================
// 8. THE ATOMIC RESERVATION (slot 20261070) — hygiene and trust boundary.
// =====================================================================

describe("20261070 migration hygiene", () => {
  it("exists in its reserved slot, and nothing else claims a duplicate prefix", () => {
    const versions = readdirSync(MIG_DIR)
      .filter((f) => f.endsWith(".sql"))
      .map((f) => f.split("_")[0]!)
      .sort();
    expect(existsSync(resolve(ROOT, RESERVATION))).toBe(true);
    expect(versions).toContain("20261070000000");
    expect(new Set(versions).size, "duplicate migration version prefixes").toBe(versions.length);
  });

  it("sorts strictly AFTER the applied production tip (20261069)", () => {
    const versions = readdirSync(MIG_DIR)
      .filter((f) => f.endsWith(".sql"))
      .map((f) => f.split("_")[0]!)
      .sort();
    expect(versions.indexOf("20261070000000")).toBeGreaterThan(
      versions.indexOf("20261069000000"),
    );
  });

  it("claims ONLY its own slot — 20261071 belongs to another lane", () => {
    const trespass = readdirSync(MIG_DIR).filter((f) => /^2026107[1-9]/.test(f));
    for (const f of trespass) {
      expect(f).not.toMatch(/reservation|ai_budget|ai_invocation|governor/i);
    }
  });

  it("is ADDITIVE — one new table, and it alters no existing one", () => {
    const exec = execOf(read(RESERVATION));
    // `ai_invocations` is INSERTED INTO by the settlement function, never
    // altered: its immutability trigger, its CHECKs and its RLS are the things
    // this wave was careful not to weaken.
    expect(exec).not.toMatch(/\balter\s+table\s+public\.(?!ai_cost_reservations)/i);
    expect(exec).not.toMatch(/\bdrop\s+table\b/i);
    expect(exec).not.toMatch(/drop\s+trigger\s+if\s+exists\s+ai_invocations_immutable/i);
    const creates = exec.match(/create\s+table\s+if\s+not\s+exists\s+public\.(\w+)/gi) ?? [];
    expect(creates).toHaveLength(1);
    expect(exec).toMatch(/create\s+table\s+if\s+not\s+exists\s+public\.ai_cost_reservations/i);
  });

  it("documents its own rollback", () => {
    const prose = read(RESERVATION).slice(0, 8000);
    expect(prose).toMatch(/drop\s+table\s+if\s+exists\s+public\.ai_cost_reservations/i);
    expect(prose).toMatch(/drop\s+function\s+if\s+exists\s+public\.ai_reserve_invocation/i);
  });
});

describe("the reservation gate is ATOMIC, and the lock is the load-bearing part", () => {
  const exec = execOf(read(RESERVATION));

  it("takes a per-ORG advisory transaction lock before it reads", () => {
    // THE pin. A conditional `insert ... select ... where sum(...) <= ceiling`
    // is NOT sufficient at READ COMMITTED: two transactions both evaluate the
    // predicate against a snapshot taken before either inserted, both find room,
    // and both commit. Removing this line reproduces the overshoot — measured,
    // with a transcript, in docs/ai-cost-governor.md.
    expect(exec).toMatch(
      /perform\s+pg_advisory_xact_lock\s*\(\s*hashtext\s*\(\s*'ai_budget_reservation'\s*\)\s*,\s*hashtext\s*\(\s*p_org_id::text\s*\)\s*\)/i,
    );
    // Transaction-scoped, never session-scoped: a session lock survives a
    // crashed backend and would wedge an org's AI until the connection died.
    expect(exec).not.toMatch(/pg_advisory_lock\s*\(/i);
  });

  it("the lock is taken BEFORE the aggregates it protects", () => {
    const fn = exec.slice(
      exec.indexOf("create or replace function public.ai_reserve_invocation"),
      exec.indexOf("revoke all on function public.ai_reserve_invocation"),
    );
    expect(fn.length).toBeGreaterThan(0);
    const idxLock = fn.indexOf("pg_advisory_xact_lock");
    const idxCommitted = fn.indexOf("from public.ai_invocations i");
    const idxInsert = fn.indexOf("insert into public.ai_cost_reservations");
    expect(idxLock).toBeGreaterThan(-1);
    expect(idxLock).toBeLessThan(idxCommitted);
    expect(idxLock).toBeLessThan(idxInsert);
  });

  it("BOTH gates are in the insert's own WHERE — the check and the write are one statement", () => {
    // (a) the band gate: at or over the ceiling, nothing starts, whatever it costs.
    expect(exec).toMatch(/where\s+v_committed\s*\+\s*v_reserved\s*<\s*p_ceiling_pence/i);
    // (b) the reserve gate: this call must fit.
    expect(exec).toMatch(
      /and\s+v_committed\s*\+\s*v_reserved\s*\+\s*v_claim\s*<=\s*p_ceiling_pence/i,
    );
  });

  it("the budget is COMMITTED plus LIVE CLAIMS — an expired claim consumes nothing", () => {
    expect(exec).toMatch(/coalesce\s*\(\s*sum\s*\(\s*i\.estimated_cost_pence\s*\)/i);
    expect(exec).toMatch(/coalesce\s*\(\s*sum\s*\(\s*r\.estimate_pence\s*\)/i);
    // The lazy TTL reclaim: the arithmetic filters on expiry, so the ceiling is
    // right whether or not the cosmetic 'expired' stamp ever runs.
    expect(exec).toMatch(/r\.state\s*=\s*'reserved'\s*and\s*r\.expires_at\s*>\s*now\(\)/i);
  });

  it("the month boundary is EUROPE/LONDON, matching the ledger's own rollups", () => {
    const windows = exec.match(/at\s+time\s+zone\s+'Europe\/London'/gi) ?? [];
    expect(windows.length).toBeGreaterThanOrEqual(4);
    expect(exec).toMatch(/date_trunc\s*\(\s*'month'/i);
  });

  it("DEDUPE is decided inside the same critical section, not by a prior read", () => {
    const fn = exec.slice(
      exec.indexOf("create or replace function public.ai_reserve_invocation"),
      exec.indexOf("revoke all on function public.ai_reserve_invocation"),
    );
    const idxLock = fn.indexOf("pg_advisory_xact_lock");
    const idxDedupe = fn.indexOf("r.content_hash = p_content_hash");
    expect(idxDedupe).toBeGreaterThan(-1);
    expect(idxDedupe).toBeGreaterThan(idxLock);
    // Only a LIVE claim or a recent SUCCESS suppresses — a failed or released
    // attempt must never block the retry it is the reason for.
    expect(fn).toMatch(/r\.state\s*=\s*'settled'\s+and\s+r\.success/i);
    // The window is still SLIDING, not a tumbling bucket, so no pair of
    // identical submits either side of a bucket edge both pay.
    expect(fn).toMatch(/r\.created_at\s*>=\s*now\(\)\s*-\s*make_interval/i);
  });

  it("settlement writes the ledger row AND frees the claim in ONE function", () => {
    const fn = exec.slice(
      exec.indexOf("create or replace function public.ai_settle_reservation"),
      exec.indexOf("revoke all on function public.ai_settle_reservation"),
    );
    expect(fn).toMatch(/insert\s+into\s+public\.ai_invocations/i);
    expect(fn).toMatch(/update\s+public\.ai_cost_reservations/i);
    // Row-locked, so two settlements of one claim serialise rather than race.
    expect(fn).toMatch(/for\s+update/i);
    // Idempotent: only a live claim settles.
    expect(fn).toMatch(/already_settled/i);
  });

  it("contains no dynamic SQL and no SECURITY DEFINER anywhere", () => {
    // A definer-rights reservation function would be a FORGE primitive: any
    // caller could claim (or exhaust) another tenant's budget. A definer-rights
    // rollup would be the cross-tenant read primitive the 20261031-37 storage
    // wave existed to eliminate.
    expect(exec).not.toMatch(/security\s+definer/i);
    expect(exec).not.toMatch(/\bexecute\s+format\s*\(/i);
    expect(exec).not.toMatch(/\bexecute\s+'/i);
  });

  it("both write RPCs are granted to service_role ONLY", () => {
    for (const fn of ["ai_reserve_invocation", "ai_settle_reservation", "ai_release_reservation"]) {
      expect(exec, `${fn} must revoke from public`).toMatch(
        new RegExp(`revoke\\s+all\\s+on\\s+function\\s+public\\.${fn}\\(`, "i"),
      );
      const grant = exec.match(
        new RegExp(`grant\\s+execute\\s+on\\s+function\\s+public\\.${fn}\\([^)]*\\)\\s*\\n?\\s*to\\s+([^;]+);`, "i"),
      );
      expect(grant, `${fn} must have a grant`).not.toBeNull();
      expect(grant![1]!.trim()).toBe("service_role");
    }
  });
});

describe("ai_cost_reservations — the trust boundary matches the ledger's", () => {
  const exec = execOf(read(RESERVATION));

  it("RLS is enabled with EXACTLY ONE policy: admin SELECT", () => {
    expect(exec).toMatch(
      /alter\s+table\s+public\.ai_cost_reservations\s+enable\s+row\s+level\s+security/i,
    );
    const policies =
      exec.match(/create\s+policy\s+\w+\s+on\s+public\.ai_cost_reservations/gi) ?? [];
    expect(policies).toHaveLength(1);
    expect(exec).toMatch(
      /create\s+policy\s+ai_cost_reservations_select\s+on\s+public\.ai_cost_reservations\s+for\s+select\s+using\s*\(\s*public\.is_org_admin\s*\(\s*org_id\s*\)\s*\)/i,
    );
  });

  it("has NO insert / update / delete policy — a tenant cannot FORGE or free a claim", () => {
    // A forged claim is a denial-of-service primitive: claim the whole ceiling
    // and every AI call is refused until the TTL lapses. A tenant-freeable claim
    // is the inverse — a way to spend past the ceiling.
    expect(exec).not.toMatch(/for\s+insert/i);
    expect(exec).not.toMatch(/create\s+policy[^;]*for\s+update/i);
    expect(exec).not.toMatch(/create\s+policy[^;]*for\s+delete/i);
    expect(exec).not.toMatch(/for\s+all\b/i);
  });

  it("a DETERMINISTIC claim is structurally unrepresentable, as on the ledger", () => {
    expect(exec).toMatch(
      /task_class\s+text\s+not\s+null\s+check\s*\(\s*task_class\s+in\s*\(\s*'classification'\s*,\s*'drafting'\s*,\s*'complex'\s*\)\s*\)/i,
    );
    expect(exec).not.toMatch(/task_class\s+in\s*\([^)]*'deterministic'/i);
  });

  it("a claim can never be FREE — the floor is structural, not just in TypeScript", () => {
    // A zero claim consumes no budget, so N concurrent unpriced calls would all
    // pass however many there were.
    expect(exec).toMatch(/estimate_pence\s+integer\s+not\s+null\s+check\s*\(\s*estimate_pence\s*>=\s*1\s*\)/i);
  });

  it("the claim's IDENTITY is frozen and a terminal state is TERMINAL", () => {
    // Walking a settled claim back to 'reserved' would double-count committed
    // spend; editing its amount after the fact would make the gate meaningless.
    expect(exec).toMatch(/before\s+update\s+on\s+public\.ai_cost_reservations/i);
    expect(exec).toMatch(/execute\s+function\s+public\.tg_ai_cost_reservations_lifecycle\(\)/i);
    expect(exec).toMatch(/new\.estimate_pence\s+is\s+distinct\s+from\s+old\.estimate_pence/i);
    expect(exec).toMatch(/new\.org_id\s+is\s+distinct\s+from\s+old\.org_id/i);
    expect(exec).toMatch(/new\.expires_at\s+is\s+distinct\s+from\s+old\.expires_at/i);
    expect(exec).toMatch(/old\.state\s*<>\s*'reserved'/i);
    expect(exec).toMatch(/is\s+already\s+%/i);
  });

  it("the FK anonymisation hole is cut narrowly, with IS NOT DISTINCT FROM", () => {
    // `on delete set null` is implemented as an UPDATE, so a blanket refusal
    // would make this table block user deletion — the same class of failure a
    // DELETE guard would be.
    expect(exec).toMatch(/new\s+is\s+not\s+distinct\s+from\s+v_expected/i);
    expect(exec).not.toMatch(/if\s+new\s*=\s*v_expected/i);
  });

  it("DELETE is deliberately NOT guarded, so org teardown still cascades", () => {
    // A BEFORE DELETE guard would abort tenant teardown and GDPR erasure — the
    // exact failure 20261052 was written to fix.
    expect(exec).not.toMatch(/before\s+delete\s+on\s+public\.ai_cost_reservations/i);
    expect(exec).toMatch(
      /org_id\s+uuid\s+not\s+null\s+references\s+public\.organizations\s*\(\s*id\s*\)\s+on\s+delete\s+cascade/i,
    );
  });

  it("stores NO prompt and NO model output — only the SHA-256 fingerprint", () => {
    expect(exec).toMatch(/content_hash\s+text\s+check[^,]*\^\[0-9a-f\]\{64\}\$/i);
    expect(exec).not.toMatch(/\b(prompt|request_body|response_body|transcript|completion)\s+text/i);
  });

  it("introduces NO cron, NO provider and NO credential", () => {
    // Reclaim is LAZY by design: nothing external stands between a crashed
    // process and the budget it was holding.
    expect(exec).not.toMatch(/cron\.|pg_cron|schedule\s*\(/i);
    expect(exec).not.toMatch(/anthropic|openai|claude|gpt-|api_key|secret/i);
    expect(exec).not.toMatch(/\bhttp\b|\bnet\.\w+|extension/i);
  });
});

describe("the HQ cost view is gated and privilege-honest", () => {
  it("the page requires HQ", () => {
    const code = codeOf(read(HQ_PAGE));
    expect(code).toMatch(/requireHqPage\(\)/);
    expect(code).toMatch(/export\s+const\s+dynamic\s*=\s*"force-dynamic"/);
  });

  it("it lives under app/admin/** and is reachable from the HQ nav", () => {
    expect(existsSync(resolve(ROOT, HQ_PAGE))).toBe(true);
    expect(read("app/admin/layout.tsx")).toContain('href: "/admin/ai-costs"');
  });

  it("the snapshot is service-role only and never takes a tenant client", () => {
    const code = codeOf(read(SNAPSHOT));
    expect(code).toMatch(/^import\s+"server-only";/m);
    expect(code).toMatch(/createAdminClient/);
    expect(code).not.toMatch(/@\/lib\/supabase\/server/);
  });

  it("the page renders no secret — only presence, never a credential VALUE", () => {
    const code = codeOf(read(HQ_PAGE));
    expect(code).not.toMatch(/process\.env/);
  });
});

// =====================================================================
// 8b. The HQ TREND view — same gate, London-pinned, read-only presentation.
// =====================================================================

describe("the AI-cost trend is gated, London-pinned and writes nothing", () => {
  it("the trend read lives in the SERVICE-ROLE snapshot module, behind the HQ gate", () => {
    // It ships inside ai-cost-snapshot.ts, which section 8 already pins as
    // server-only + service-role and free of any tenant client. The page that
    // renders it is HQ-gated (requireHqPage), so the trend inherits exactly the
    // same boundary as every other figure on the surface.
    const snap = codeOf(read(SNAPSHOT));
    expect(snap).toMatch(/export\s+async\s+function\s+buildAiCostTrend/);
    expect(snap).toMatch(/export\s+function\s+composeAiCostTrend/);

    const page = codeOf(read(HQ_PAGE));
    expect(page).toMatch(/requireHqPage\(\)/);
    expect(page).toMatch(/buildAiCostTrend/);
  });

  it("the trend buckets by the EUROPE/LONDON month helper, never by toISOString month maths", () => {
    // A £100 MONTHLY ceiling is a UK calendar-month promise; the trend that
    // reports against it must bucket on the same boundary the SQL rollups and
    // `ukMonthKeyOf` use. `.slice(0, 7)` on an ISO string is the UTC-month
    // shortcut this forbids — `probeDateFor` legitimately takes `.slice(0, 10)`
    // (a DATE), which this pattern does not match.
    const snap = codeOf(read(SNAPSHOT));
    expect(snap).toMatch(/ukMonthKeyOf/);
    expect(snap).toMatch(/trailingMonths/);
    expect(snap).not.toMatch(/toISOString\(\)\.slice\(\s*0\s*,\s*7\s*\)/);
    expect(snap).not.toMatch(/getUTCMonth\(\)/);
  });

  it("the trend is READ-ONLY — it reads the rollups and writes no ledger row", () => {
    // Pure presentation over telemetry that already exists. It must never touch
    // the write path (the ledger insert or the reservation RPCs), and it reads
    // through the SAME two invoker-rights rollups the rest of the module uses.
    const snap = codeOf(read(SNAPSHOT));
    expect(snap).toMatch(/ai_invocations_month_totals/);
    expect(snap).toMatch(/ai_invocations_month_by_feature/);
    expect(snap).not.toMatch(/insert\s+into|\.insert\s*\(/i);
    expect(snap).not.toMatch(/ai_reserve_invocation|ai_settle_reservation|ai_release_reservation/);
    // No provider door and no vendor SDK reaches this presentation module.
    expect(snap).not.toMatch(/@anthropic-ai\/sdk|new\s+Anthropic|new\s+OpenAI|invokeWithGovernor/);
  });
});

// =====================================================================
// 9. EMBEDDINGS GOVERNANCE (slot 20261080) — the widened task_class CHECKs.
// =====================================================================

describe("20261080 migration hygiene — embeddings admitted to the governed vocabulary", () => {
  const EMBEDDINGS_MIG =
    "supabase/migrations/20261080000000_embeddings_governance.sql";

  it("exists in its slot, with no duplicate version prefix anywhere", () => {
    const versions = readdirSync(MIG_DIR)
      .filter((f) => f.endsWith(".sql"))
      .map((f) => f.split("_")[0]!)
      .sort();
    expect(existsSync(resolve(ROOT, EMBEDDINGS_MIG))).toBe(true);
    expect(versions).toContain("20261080000000");
    expect(new Set(versions).size, "duplicate migration version prefixes").toBe(versions.length);
  });

  it("sorts strictly AFTER the previous tip in this directory (20261079)", () => {
    const versions = readdirSync(MIG_DIR)
      .filter((f) => f.endsWith(".sql"))
      .map((f) => f.split("_")[0]!)
      .sort();
    expect(versions.indexOf("20261080000000")).toBeGreaterThan(
      versions.indexOf("20261079000000"),
    );
  });

  it("is a PURE WIDENING — two constraint swaps on the two governor tables, nothing else", () => {
    const exec = execOf(read(EMBEDDINGS_MIG));
    // Only the two governor tables are touched, and only their task_class CHECK.
    expect(exec).not.toMatch(
      /\balter\s+table\s+public\.(?!ai_invocations\b|ai_cost_reservations\b)/i,
    );
    expect(exec).not.toMatch(/\bcreate\s+table\b/i);
    expect(exec).not.toMatch(/\bdrop\s+table\b/i);
    expect(exec).not.toMatch(/\bcreate\s+(or\s+replace\s+)?function\b/i);
    expect(exec).not.toMatch(/\bcreate\s+policy\b/i);
    const drops = exec.match(/drop\s+constraint\s+\w+_task_class_check/gi) ?? [];
    const adds = exec.match(/add\s+constraint\s+\w+_task_class_check/gi) ?? [];
    expect(drops).toHaveLength(2);
    expect(adds).toHaveLength(2);
  });

  it("widens BOTH CHECKs to admit 'embedding' — ledger and reservations agree", () => {
    const exec = execOf(read(EMBEDDINGS_MIG));
    const widened =
      /check\s*\(\s*task_class\s+in\s*\(\s*'classification'\s*,\s*'drafting'\s*,\s*'complex'\s*,\s*'embedding'\s*\)\s*\)/gi;
    expect(exec.match(widened) ?? []).toHaveLength(2);
    for (const table of ["ai_invocations", "ai_cost_reservations"]) {
      expect(exec, `${table} must get the widened CHECK`).toMatch(
        new RegExp(
          `alter\\s+table\\s+public\\.${table}\\s+add\\s+constraint\\s+${table}_task_class_check`,
          "i",
        ),
      );
    }
  });

  it("'deterministic' remains structurally unrepresentable in BOTH new CHECKs", () => {
    // The database keeps refusing a ledger row or a budget claim for work that
    // must never reach a model — for every role, including service_role.
    const exec = execOf(read(EMBEDDINGS_MIG));
    expect(exec).not.toMatch(/'deterministic'/i);
  });

  it("the widened vocabulary matches the registry's billable classes EXACTLY", () => {
    // The TS side and the SQL side of one closed set: every non-deterministic
    // task class is admitted, and nothing else is. Drift in either direction
    // fails here rather than at INSERT time in production.
    const exec = execOf(read(EMBEDDINGS_MIG));
    const inList = exec.match(/task_class\s+in\s*\(([^)]*)\)/i)?.[1] ?? "";
    const sqlClasses = [...inList.matchAll(/'(\w+)'/g)].map((m) => m[1]).sort();
    const billable = AI_TASK_CLASSES.filter((c) => c !== "deterministic").sort();
    expect(sqlClasses).toEqual(billable);
  });
});

// =====================================================================
// 10. THE CROSS-TIER PARTIAL-BINDING PROOF (C35-C) — a RUNTIME measurement.
//
// The defect: the doors open on ANY generative tier, but a `drafting`/`complex`
// call's OWN tier can be dark while `cheap` is bound. With only `cheap` armed +
// a vendor key, a `mid` door caller resolved a LIVE provider that the governor's
// per-tier dark short-circuit then RAN — a real, billable call with no
// reservation and no ledger row, the £100 ceiling never consulted.
//
// Everything here is real except the three fixtures at the top of the file: the
// tier table (so `cheap` alone can be armed), the admin client (so "no
// reservation RPC" is `adminConstructions.count === 0`), and the text door (stubbed
// OPEN with a live provider, to force the exact cross-tier shape).
// =====================================================================

const CHEAP_BINDING = {
  provider: "anthropic",
  model: "claude-haiku-4-5",
  usdPerMTokIn: 1,
  usdPerMTokOut: 5,
  reserveInputTokens: 4_000,
  reserveOutputTokens: 1_000,
};
const PARTIAL_ORG = "00000000-0000-0000-0000-0000000000c3";

describe("only 'cheap' bound: a 'drafting' path spends NOTHING and reserves NOTHING", () => {
  beforeEach(() => {
    for (const t of ["cheap", "mid", "high", "embedding"]) tierModelRef[t] = null;
    tierModelRef.cheap = CHEAP_BINDING; // ONLY the cheap generative tier is armed…
    adminConstructions.count = 0;
    providerGenerate.mockReset();
    providerGenerate.mockResolvedValue({
      text: "should never be produced",
      model: "fake-model",
      inputTokens: 100,
      outputTokens: 20,
    });
    // …with EVERY vendor credential present — the worst case an operator can make.
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-not-real");
    vi.stubEnv("OPENAI_API_KEY", "sk-not-real");
    vi.stubEnv("MEMORY_TEXT_PROVIDER", "auto");
  });
  afterEach(() => {
    for (const t of ["cheap", "mid", "high", "embedding"]) tierModelRef[t] = null;
    vi.unstubAllEnvs();
  });

  it("the fixture really is a PARTIAL binding — cheap live, the mid tier dark", () => {
    // Otherwise both assertions below would be vacuous.
    expect(isInferenceTierActivated()).toBe(true); // the door WOULD open…
    expect(isTierActivated("cheap")).toBe(true);
    expect(isTierActivated("mid")).toBe(false); // …but this call's own tier is dark
  });

  it("PRIMARY — the door caller refuses on its own dark tier: no generate, no reservation", async () => {
    const out = await generateInsightNarrative(
      "activity",
      { org_id: "ORG-SECRET", key_metrics: { total_events: 7 } },
      { orgId: PARTIAL_ORG, userId: null },
    );

    // Degrades to deterministic-only — and, crucially, spends nothing:
    expect(out).toBeNull();
    expect(providerGenerate, "the live provider must NEVER be called").not.toHaveBeenCalled();
    expect(adminConstructions.count, "no reserveBudget RPC may be issued").toBe(0);
  });

  it("DEFENCE IN DEPTH — even if a caller skipped its gate, the governor BLOCKS a dark-tier live call", async () => {
    // Drive the governor DIRECTLY with a live fn, as a caller that forgot its
    // own-tier gate would. The dark `mid` tier + a resolvable modality provider
    // must be REFUSED, never run.
    const fn = vi.fn(async () => ({ value: "draft", usage: null }));

    const outcome = await invokeWithGovernor("insights.narrative", "drafting", fn, {
      orgId: PARTIAL_ORG,
    });

    expect(outcome.status).toBe("blocked");
    if (outcome.status !== "blocked") throw new Error("unreachable");
    expect(outcome.reason).toBe("tier_dark_provider_live");
    expect(fn, "the governor must not run a dark-tier live call").not.toHaveBeenCalled();
    expect(adminConstructions.count, "a blocked dark-tier call takes no reservation").toBe(0);
  });
});
