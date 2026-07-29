import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { AI_TIERS, TIER_MODEL, isAnyTierBound } from "@/lib/ai/governor/registry";
import {
  getAiGovernorReadiness,
  isGovernorActivated,
  KNOWN_VENDOR_CREDENTIALS,
} from "@/lib/ai/governor/readiness";
import { AI_MONTHLY_CEILING_PENCE } from "@/lib/ai/governor/policy";

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
    // The pre-existing gate is untouched: no key ⇒ the governor is never reached.
    expect(code).toMatch(/if\s*\(\s*!isAiConfigured\(\)/);
    expect(code).toMatch(/return\s+zeroExtraction\(\)/);
  });

  it("receptionist inbound extraction is governed and STILL degrades deterministically", () => {
    const code = codeOf(read("server/services/receptionist.ts"));
    expect(code).toMatch(/invokeWithGovernor\(\s*\n?\s*"receptionist\.inbound_extraction"/);
    expect(code).toMatch(/if\s*\(\s*!isAiConfigured\(\)\s*\|\|\s*!rawText\.trim\(\)\s*\)/);
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

  it("the DARK SHORT-CIRCUIT comes before any budget or dedupe read", () => {
    // This is what makes wiring three dark seams a genuine no-op.
    const code = codeOf(read(SEAM));
    const idxDark = code.indexOf("isGovernorActivated()");
    const idxBudget = code.indexOf("await checkBudget(");
    const idxDedupe = code.indexOf("hasRecentIdentical(");
    expect(idxDark).toBeGreaterThan(-1);
    expect(idxDark).toBeLessThan(idxBudget);
    expect(idxDark).toBeLessThan(idxDedupe);
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
