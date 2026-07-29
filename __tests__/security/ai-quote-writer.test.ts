import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { AI_TIERS, TIER_MODEL, featureDefinition, isAnyTierBound } from "@/lib/ai/governor/registry";
import {
  QUOTE_WRITER_FEATURE,
  QUOTE_WRITER_TASK_CLASS,
  getQuoteWriterReadiness,
  quoteWriterStatusLine,
} from "@/lib/ai/quote-writer-readiness";
import { getAiGovernorReadiness, KNOWN_VENDOR_CREDENTIALS } from "@/lib/ai/governor/readiness";
import {
  QUOTE_CONTEXT_EXCLUDED_FIELDS,
  QUOTE_CONTEXT_FIELD_KEYS,
} from "@/lib/ai/quote-context";

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * AI QUOTE WRITER — trust-boundary invariants (slot 20261068).
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * This wave builds a generative capability BEFORE any provider is authorised.
 * Three classes of claim therefore have to be proven against SOURCE TEXT rather
 * than against behaviour, because the behaviour is deliberately "nothing
 * happens":
 *
 *   A. THE DARKNESS IS REAL. No tier is bound, no credential is introduced, and
 *      every readiness surface says so. The #433 precedent, applied again.
 *
 *   B. THERE IS NO PATH FROM A MODEL TO A CUSTOMER. This is the hardest
 *      requirement on the feature and the one that most needs a source pin: the
 *      AI module must not be able to create a quote, allocate a number, mint a
 *      public token, or reach `sendQuote` — not "must not today", but must not
 *      without a diff a reviewer would see.
 *
 *   C. THE DISCLOSURE CONTRACT IS ENFORCED AND DOCUMENTED, and the two agree.
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
const MIGRATION = "supabase/migrations/20261068000000_ai_quote_drafts.sql";
const DOC = "docs/ai-quote-writer.md";

const CONTEXT = "lib/ai/quote-context.ts";
const SCHEMA = "lib/ai/quote-draft-schema.ts";
const PROMPT = "lib/ai/quote-prompt.ts";
const PIPELINE = "lib/ai/quote-draft-pipeline.ts";
const READINESS = "lib/ai/quote-writer-readiness.ts";
const SERVICE = "server/services/ai-quote-writer.ts";
const ACTIONS = "app/(app)/quotes/_quote-writer-actions.ts";
const PANEL = "app/(app)/quotes/_quote-writer-panel.tsx";

/** Every file this wave adds. The credential and SDK sweeps cover all of them. */
const WAVE_FILES = [
  CONTEXT,
  SCHEMA,
  PROMPT,
  PIPELINE,
  READINESS,
  SERVICE,
  ACTIONS,
  PANEL,
] as const;

/** The files that constitute "the AI module" for the no-send-path pins. */
const AI_MODULE = [CONTEXT, SCHEMA, PROMPT, PIPELINE, READINESS, SERVICE, ACTIONS] as const;

// =====================================================================
// 0. Migration hygiene — one slot, and only that slot.
// =====================================================================

describe("20261068 migration hygiene", () => {
  const versions = readdirSync(MIG_DIR)
    .filter((f) => f.endsWith(".sql"))
    .map((f) => f.split("_")[0]!)
    .sort();

  it("exists in its reserved slot", () => {
    expect(existsSync(resolve(ROOT, MIGRATION))).toBe(true);
    expect(versions).toContain("20261068000000");
  });

  it("has NO duplicate version prefix anywhere in the directory", () => {
    // Supabase keys migration identity on the numeric prefix. Two files sharing
    // one prefix replay unpredictably from a fresh database while looking fine
    // on an already-migrated one — the failure that only shows up in a restore.
    expect(new Set(versions).size, "duplicate migration version prefixes").toBe(versions.length);
  });

  it("sorts strictly AFTER the AI governor ledger it depends on", () => {
    expect(versions.indexOf("20261068000000")).toBeGreaterThan(versions.indexOf("20261062000000"));
  });

  it("claims ONLY its own slot — 20261063 to 20261067 belong to other lanes", () => {
    const trespass = readdirSync(MIG_DIR).filter((f) => /^2026106[34567]/.test(f));
    for (const f of trespass) {
      expect(f, `this wave must not occupy slot ${f.split("_")[0]}`).not.toMatch(
        /quote_draft|quote_writer|ai_quote/i,
      );
    }
  });

  it("is ADDITIVE — it creates exactly one table and alters no existing one", () => {
    const exec = execOf(read(MIGRATION));
    expect(exec).not.toMatch(/\balter\s+table\s+public\.(?!ai_quote_drafts)/i);
    expect(exec).not.toMatch(/\bdrop\s+table\b/i);
    const creates = exec.match(/create\s+table\s+if\s+not\s+exists\s+public\.(\w+)/gi) ?? [];
    expect(creates).toHaveLength(1);
    expect(exec).toMatch(/create\s+table\s+if\s+not\s+exists\s+public\.ai_quote_drafts/i);
  });

  it("contains no dynamic SQL", () => {
    const exec = execOf(read(MIGRATION));
    expect(exec).not.toMatch(/\bexecute\s+format\s*\(/i);
    expect(exec).not.toMatch(/\bexecute\s+'/i);
  });
});

// =====================================================================
// 1. The table's boundary.
// =====================================================================

describe("ai_quote_drafts — org scope, lifecycle, and immutable evidence", () => {
  const exec = execOf(read(MIGRATION));

  it("is org-scoped and TEARDOWN-SAFE", () => {
    expect(exec).toMatch(
      /org_id\s+uuid\s+not\s+null\s+references\s+public\.organizations\s*\(\s*id\s*\)\s+on\s+delete\s+cascade/i,
    );
  });

  it("every user reference survives the user's deletion", () => {
    for (const col of ["created_by", "applied_by", "discarded_by"]) {
      expect(exec, col).toMatch(
        new RegExp(
          `${col}\\s+uuid\\s+references\\s+public\\.users\\s*\\(\\s*id\\s*\\)\\s+on\\s+delete\\s+set\\s+null`,
          "i",
        ),
      );
    }
  });

  it("a draft must be anchored to something reachable", () => {
    expect(exec).toMatch(/check\s*\(\s*quote_id\s+is\s+not\s+null\s+or\s+lead_id\s+is\s+not\s+null\s*\)/i);
  });

  it("the lifecycle is draft / applied / discarded, and DISCARD IS NOT A DELETE", () => {
    expect(exec).toMatch(/status\s+text\s+not\s+null\s+default\s+'draft'/i);
    expect(exec).toMatch(/check\s*\(\s*status\s+in\s*\(\s*'draft'\s*,\s*'applied'\s*,\s*'discarded'\s*\)\s*\)/i);
  });

  it("provenance CANNOT be 'deterministic' — there is no computable fallback", () => {
    // The asymmetry with every other governed capability, stated structurally.
    // A row in this table can only exist because a model produced it.
    expect(exec).toMatch(/provenance\s+text\s+not\s+null\s+check\s*\(\s*provenance\s+in\s*\(\s*'anthropic'\s*,\s*'openai'\s*\)\s*\)/i);
    expect(exec).not.toMatch(/provenance\s+in\s*\([^)]*'deterministic'/i);
  });

  it("keeps the model's output and the human's edit SEPARATE", () => {
    // One column could not answer "how much did the operator have to change?".
    expect(exec).toMatch(/content\s+jsonb\s+not\s+null/i);
    expect(exec).toMatch(/applied_content\s+jsonb/i);
  });

  it("records the disclosure as KEYS, never values", () => {
    expect(exec).toMatch(/context_fields\s+text\[\]\s+not\s+null/i);
    // No column exists that could hold the customer's words or the prompt.
    expect(exec).not.toMatch(/\b(prompt|prompt_text|request_body|customer_notes|transcript)\s+text\b/i);
  });

  it("the prompt checksum and invocation fingerprint are hex-shaped", () => {
    expect(exec).toMatch(/prompt_checksum\s+text\s+not\s+null\s+check\s*\([^)]*\^\[0-9a-f\]\{64\}\$/i);
    expect(exec).toMatch(/invocation_hash\s+text\s+check[^,]*\^\[0-9a-f\]\{64\}\$/i);
  });

  it("terminal states carry their stamps, as a CHECK as well as in the trigger", () => {
    expect(exec).toMatch(/constraint\s+ai_quote_drafts_terminal_stamp_check\s+check/i);
  });

  it("a BEFORE UPDATE trigger freezes the model's output and its provenance", () => {
    expect(exec).toMatch(/before\s+update\s+on\s+public\.ai_quote_drafts/i);
    expect(exec).toMatch(/execute\s+function\s+public\.tg_ai_quote_draft_lifecycle\(\)/i);
    for (const frozen of ["content", "provenance", "prompt_checksum", "context_fields", "invocation_hash"]) {
      expect(exec, frozen).toMatch(
        new RegExp(`new\\.${frozen}\\s+is\\s+distinct\\s+from\\s+old\\.${frozen}`, "i"),
      );
    }
    expect(exec).toMatch(/raise\s+exception[^;]*immutable/i);
  });

  it("terminal is TERMINAL — an applied draft cannot be re-applied", () => {
    expect(exec).toMatch(/if\s+old\.status\s*<>\s*'draft'\s+then/i);
    expect(exec).toMatch(/raise\s+exception[^;]*terminal\s+draft\s+cannot\s+change/i);
  });

  it("cuts the FK-anonymisation hole NARROWLY, using IS NOT DISTINCT FROM", () => {
    // `on delete set null` is implemented as an UPDATE, so a blanket refusal
    // would make this table BLOCK USER DELETION and leave personal data
    // undeletable — the failure ai_invocations (20261062) documents.
    expect(exec).toMatch(/old\.created_by\s+is\s+not\s+null\s+and\s+new\.created_by\s+is\s+null/i);
    expect(exec).toMatch(/new\s+is\s+not\s+distinct\s+from\s+v_anonymised/i);
    expect(exec).not.toMatch(/if\s+new\s*=\s*v_anonymised/i);
  });

  it("refuses a draft anchored to ANOTHER org's quote or lead", () => {
    // RLS checks only the row's own org_id. Without this a member of org A could
    // POST a draft (via PostgREST, bypassing the app) anchored to org B's quote.
    expect(exec).toMatch(/create\s+or\s+replace\s+function\s+public\.tg_ai_quote_draft_org_integrity/i);
    expect(exec).toMatch(/security\s+definer\s+set\s+search_path\s*=\s*public/i);
    expect(exec).toMatch(/quote\s+%\s+is\s+not\s+in\s+this\s+org/i);
    expect(exec).toMatch(/lead\s+%\s+is\s+not\s+in\s+this\s+org/i);
    expect(exec).toMatch(/before\s+insert\s+or\s+update\s+on\s+public\.ai_quote_drafts/i);
  });

  it("RLS is enabled, member-scoped, and has NO DELETE POLICY", () => {
    expect(exec).toMatch(/alter\s+table\s+public\.ai_quote_drafts\s+enable\s+row\s+level\s+security/i);
    for (const verb of ["select", "insert", "update"]) {
      expect(exec, verb).toMatch(
        new RegExp(`create\\s+policy\\s+ai_quote_drafts_${verb}\\s+on\\s+public\\.ai_quote_drafts`, "i"),
      );
    }
    // Discard is a status transition; the record of a rejected suggestion survives.
    expect(exec).not.toMatch(/create\s+policy[^;]*for\s+delete/i);
    expect(exec).not.toMatch(/for\s+all\b/i);
    // Every policy is org-scoped.
    const policies = exec.match(/create\s+policy\s+ai_quote_drafts_\w+[\s\S]*?;/gi) ?? [];
    expect(policies).toHaveLength(3);
    for (const p of policies) {
      expect(p).toMatch(/org_id\s+in\s*\(\s*select\s+public\.current_org_ids\(\)\s*\)/i);
    }
  });
});

// =====================================================================
// 2. A. THE DARKNESS IS REAL.
// =====================================================================

describe("A. no provider is activated by this wave", () => {
  it("EVERY tier still maps to null — the quote writer changed no binding", () => {
    for (const tier of AI_TIERS) expect(TIER_MODEL[tier], tier).toBeNull();
    expect(isAnyTierBound()).toBe(false);
  });

  it("the quote writer reports UNAVAILABLE, with a checklist", () => {
    const r = getQuoteWriterReadiness();
    expect(r.available).toBe(false);
    expect(r.modelBindingPresent).toBe(false);
    // …and it is honest about what IS built, which is what makes the dark
    // message useful rather than merely negative.
    expect(r.pipelineImplemented).toBe(true);
    expect(r.featureRegistered).toBe(true);
    expect(r.tier).toBe("mid");
    expect(r.blockers.join(" ")).toMatch(/no model bound to the 'mid' tier/);
  });

  it("`available` can NEVER be true without a binding — the #433 invariant", () => {
    // Everything an operator controls is satisfied and the capability still
    // does not exist.
    const governor = getAiGovernorReadiness();
    const fullyCredentialed = {
      ...governor,
      credentialsPresent: [...KNOWN_VENDOR_CREDENTIALS],
      tiers: governor.tiers.map((t) => ({ ...t, credentialsPresent: true })),
    };
    expect(getQuoteWriterReadiness(fullyCredentialed).available).toBe(false);
  });

  it("a fully activated GOVERNOR still cannot activate a missing PIPELINE", () => {
    // The other direction of the same invariant, proven directly.
    const governor = getAiGovernorReadiness();
    const activated = {
      ...governor,
      activated: true,
      anyTierBound: true,
      tiers: governor.tiers.map((t) => ({
        ...t,
        modelBindingPresent: true,
        credentialsPresent: true,
        providerResolvable: true,
      })),
    };
    expect(getQuoteWriterReadiness(activated, true).available).toBe(true);
    expect(getQuoteWriterReadiness(activated, false).available).toBe(false);
  });

  it("the dark status line tells an operator the TRUE thing", () => {
    const line = quoteWriterStatusLine(getQuoteWriterReadiness());
    expect(line).toMatch(/switched OFF/i);
    expect(line).toMatch(/nothing is sent to any third party/i);
    expect(line).toMatch(/exactly as it always has/i);
  });

  it("introduces NO new credential env var in ANY file of this wave", () => {
    const ALLOWED = new Set(["ANTHROPIC_API_KEY", "OPENAI_API_KEY"]);
    const CREDENTIAL_SHAPED = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*_(?:API_KEY|SECRET|TOKEN|PASSWORD)$/;
    for (const file of WAVE_FILES) {
      const code = codeOf(read(file));
      const envReads = [
        ...code.matchAll(/process\.env\.([A-Z0-9_]+)/g),
        ...code.matchAll(/process\.env\[\s*["']([A-Z0-9_]+)["']\s*\]/g),
      ].map((m) => m[1]!);
      for (const n of envReads) expect(ALLOWED.has(n), `${file} reads env var ${n}`).toBe(true);

      const literals = [...code.matchAll(/["']([A-Z][A-Z0-9_]*)["']/g)]
        .map((m) => m[1]!)
        .filter((n) => CREDENTIAL_SHAPED.test(n));
      for (const n of literals) expect(ALLOWED.has(n), `${file} names credential ${n}`).toBe(true);
    }
  });

  it("imports NO vendor SDK anywhere in the feature", () => {
    // The model arrives through getTextProvider(), the existing abstraction.
    // Not one file in this feature knows a vendor's name in code.
    for (const file of WAVE_FILES) {
      const code = codeOf(read(file));
      expect(code, `${file} must not import a vendor SDK`).not.toMatch(
        /@anthropic-ai\/sdk|from\s+"openai"|new\s+Anthropic\b|new\s+OpenAI\b/,
      );
    }
  });

  it("opens no network connection of its own", () => {
    for (const file of WAVE_FILES) {
      expect(codeOf(read(file)), `${file}`).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|axios/);
    }
  });

  it("the pure modules stay pure — importable without a server or a DB", () => {
    for (const file of [CONTEXT, SCHEMA, PROMPT, PIPELINE, READINESS]) {
      const code = codeOf(read(file));
      expect(code, file).not.toMatch(/server-only/);
      expect(code, file).not.toMatch(/createAdminClient|@\/lib\/supabase/);
    }
  });

  it("the service is server-only", () => {
    expect(codeOf(read(SERVICE))).toMatch(/^import\s+"server-only";/m);
  });

  it("ships NO mock or eval fixture into the application bundle", () => {
    // The mock provider and the corpus live in __tests__ so no production code
    // path can reach them, by construction rather than by discipline.
    for (const file of WAVE_FILES) {
      expect(codeOf(read(file)), file).not.toMatch(/__tests__|quote-writer-corpus|mockQuoteModel/);
    }
    expect(existsSync(resolve(ROOT, "__tests__/ai/quote-writer-corpus.ts"))).toBe(true);
  });
});

// =====================================================================
// 3. B. THERE IS NO PATH FROM A MODEL TO A CUSTOMER.
// =====================================================================

describe("B. model output cannot reach a customer", () => {
  it("the AI module never references any send path", () => {
    // The single hardest requirement on this feature. `sendQuote` is the
    // function that flips a quote to `sent`; the module must not be able to
    // name it, import the actions file that exports it, or reach a send route.
    for (const file of AI_MODULE) {
      const code = codeOf(read(file));
      expect(code, `${file} must not reference sendQuote`).not.toMatch(/\bsendQuote\b/);
      expect(code, `${file} must not import the quote actions module`).not.toMatch(
        /from\s+["'](?:\.\/actions|\.\.\/actions|@\/app\/\(app\)\/quotes\/actions)["']/,
      );
      expect(code, `${file} must not reach a mailer`).not.toMatch(
        /sendInvoiceEmail|sendQuoteEmail|@\/lib\/email|@\/lib\/comms|resend|twilio/i,
      );
    }
  });

  it("the AI module never WRITES to quotes, invoices, jobs or leads", () => {
    // It READS quotes and leads to build context — that is the point — but a
    // write would mean model output landing on a commercial record.
    for (const file of AI_MODULE) {
      const code = codeOf(read(file));
      for (const table of ["quotes", "quote_line_items", "invoices", "jobs", "leads", "customers"]) {
        const writes = new RegExp(
          `from\\(\\s*["']${table}["']\\s*\\)[\\s\\S]{0,120}?\\.(insert|update|delete|upsert)\\s*\\(`,
        );
        expect(code, `${file} must not write to ${table}`).not.toMatch(writes);
      }
    }
  });

  it("never allocates a quote number or mints a public token", () => {
    for (const file of AI_MODULE) {
      const code = codeOf(read(file));
      expect(code, file).not.toMatch(/next_quote_number|next_invoice_number|next_variation_number/);
      expect(code, file).not.toMatch(/public_token|randomUUID\(\)\s*;?\s*\/\/\s*token/);
    }
  });

  it("the only status a draft can be given is a DRAFT status", () => {
    const code = codeOf(read(SERVICE));
    expect(code).toMatch(/status:\s*"applied"/);
    expect(code).toMatch(/status:\s*"discarded"/);
    // Never a quote lifecycle status.
    for (const forbidden of ["approved", "pending_approval", "sent", "accepted"]) {
      expect(code, `must not set status ${forbidden}`).not.toMatch(
        new RegExp(`status:\\s*"${forbidden}"`),
      );
    }
  });

  it("apply RETURNS line items rather than writing a quote", () => {
    const code = codeOf(read(SERVICE));
    expect(code).toMatch(/lineItems:\s*toQuoteLineItems\(/);
    // And it re-validates the operator's edit — a browser is not a trusted
    // source either.
    expect(code).toMatch(/parseQuoteDraft\(edited\)/);
  });

  it("the server actions expose exactly three verbs, none of them transmissive", () => {
    const code = codeOf(read(ACTIONS));
    const exported = [...code.matchAll(/export\s+async\s+function\s+(\w+)/g)].map((m) => m[1]!);
    expect(exported.sort()).toEqual([
      "applyQuoteDraftAction",
      "discardQuoteDraftAction",
      "draftQuoteAction",
    ]);
  });
});

// =====================================================================
// 4. Governance: one invocation path, one registered class.
// =====================================================================

describe("every model call goes through the governor, as a registered drafting call", () => {
  it("`quote_writer` is registered, as `drafting`", () => {
    const def = featureDefinition(QUOTE_WRITER_FEATURE);
    expect(def).not.toBeNull();
    expect(def!.taskClass).toBe("drafting");
    expect(QUOTE_WRITER_TASK_CLASS).toBe("drafting");
    // The registry is honest that this one has NO deterministic fallback.
    expect(def!.degradesTo).toMatch(/NOTHING/);
  });

  it("the service's ONLY provider call is wrapped in invokeWithGovernor", () => {
    const code = codeOf(read(SERVICE));
    expect(code).toMatch(/invokeWithGovernor\(\s*\n?\s*QUOTE_WRITER_FEATURE,\s*\n?\s*QUOTE_WRITER_TASK_CLASS/);
    // Exactly one call site. A second would be a second, ungoverned door.
    expect((code.match(/invokeWithGovernor\(/g) ?? [])).toHaveLength(1);
    // The provider itself is reached exactly once, inside that wrapper's leg.
    expect((code.match(/getTextProvider\(\)/g) ?? [])).toHaveLength(1);
  });

  it("the dark gate comes BEFORE any database read", () => {
    // With no model bound, drafting must cost nothing at all — not a context
    // build, not a price-book scan.
    const code = codeOf(read(SERVICE));
    const gate = code.indexOf("if (!model)");
    const orgCtx = code.indexOf("await requireOrgContext()", gate);
    const build = code.indexOf("await buildQuoteContext(", gate);
    expect(gate).toBeGreaterThan(-1);
    expect(orgCtx).toBeGreaterThan(gate);
    expect(build).toBeGreaterThan(gate);
  });

  it("every context read is pinned to the ACTIVE org, not left to RLS", () => {
    // RLS's current_org_ids() spans every org a user belongs to. A price book
    // assembled from another tenant's quotes would be a cross-tenant
    // disclosure with a model on the far end of it.
    const code = codeOf(read(SERVICE));
    const selects = [...code.matchAll(/\.from\("(\w+)"\)[\s\S]{0,400}?maybeSingle\(\)/g)];
    expect(selects.length).toBeGreaterThanOrEqual(3);
    for (const [chunk, tableName] of selects) {
      expect(chunk, `${tableName} read must be org-pinned`).toMatch(
        /\.eq\("org_id",\s*ctx\.org\.id\)/,
      );
    }
    // The price book and the draft reads too.
    expect(code).toMatch(/table\(supabase, "quote_line_items"\)[\s\S]{0,200}?\.eq\("org_id", ctx\.org\.id\)/);
  });

  it("NEVER selects the columns the disclosure contract withholds", () => {
    const code = codeOf(read(SERVICE));
    // The property read takes notes and pointedly not the address.
    expect(code).toMatch(/\.from\("properties"\)\s*\n?\s*\.select\("id, notes"\)/);
    // No select anywhere names an identifying column.
    const selects = [...code.matchAll(/\.select\("([^"]*)"\)/g)].map((m) => m[1]!);
    for (const sel of selects) {
      for (const forbidden of ["address", "email", "phone", "name", "bank"]) {
        expect(sel.toLowerCase(), `select("${sel}") leaks ${forbidden}`).not.toContain(forbidden);
      }
    }
  });
});

// =====================================================================
// 5. C. THE DISCLOSURE CONTRACT — code and documentation agree.
// =====================================================================

describe("C. the disclosure contract is documented and the doc cannot drift", () => {
  const doc = read(DOC);

  it("the doc exists and states the dark status up front", () => {
    expect(existsSync(resolve(ROOT, DOC))).toBe(true);
    expect(doc.slice(0, 600)).toMatch(/BUILT AND SWITCHED OFF/);
  });

  it("documents EVERY field the code will send", () => {
    for (const key of QUOTE_CONTEXT_FIELD_KEYS) {
      expect(doc, `docs/ai-quote-writer.md must document ${key}`).toContain(`\`${key}\``);
    }
  });

  it("documents every field the code deliberately WITHHOLDS", () => {
    const withheldSection = doc.slice(doc.indexOf("### What is deliberately withheld"));
    for (const { field } of QUOTE_CONTEXT_EXCLUDED_FIELDS) {
      // The doc names them in prose ("Customer name"), so match on the words.
      const words = field.split("_").filter((w) => w !== "prior" && w !== "quote");
      const found = words.every((w) => new RegExp(w, "i").test(withheldSection));
      expect(found, `the doc must explain why ${field} is withheld`).toBe(true);
    }
  });

  it("documents NO field the code does not actually send", () => {
    // The dangerous direction: a doc promising a field is sent when it is not is
    // merely wrong; a doc omitting one that IS sent is a disclosure failure. This
    // pins the table itself, row by row.
    const table = doc.slice(doc.indexOf("| Field |"), doc.indexOf("### What is deliberately withheld"));
    const documented = [...table.matchAll(/^\|\s*`([a-z_]+)`\s*\|/gm)].map((m) => m[1]!);
    expect(documented.sort()).toEqual([...QUOTE_CONTEXT_FIELD_KEYS].sort());
  });

  it("names the pre-activation work rather than implying readiness", () => {
    const section = doc.slice(doc.indexOf("## 8. Before this can be activated"));
    expect(section).toMatch(/Bind a model/);
    // The concurrency finding is recorded where an activator will read it.
    expect(section).toMatch(/read-then-act|start gate/i);
    expect(section).toMatch(/Re-run the eval corpus against the real provider/);
    // And the open product questions are asked, not silently answered.
    expect(section).toMatch(/Who may spend the org's AI budget/);
  });

  it("states the price rule and the totals rule explicitly", () => {
    expect(doc).toMatch(/may not invent a price/i);
    expect(doc).toMatch(/computeTotals/);
    // Whitespace-tolerant: the doc is hard-wrapped, and a pin that breaks when
    // a paragraph reflows is a pin people delete.
    expect(doc).toMatch(/no\s+code\s+path\s+from\s+a\s+draft\s+to\s+`sendQuote`/i);
  });
});
