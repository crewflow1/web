import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * HQ Support AI — trust-boundary invariants (hermetic source scan).
 *
 * Pins:
 *   1. The page AND the aggregator gate on requireHqPage — HQ-only, never
 *      tenant auth. A non-allowlisted caller must 404 before seeing any figure.
 *   2. The triage-narrative path is GOVERNED but DARK BY DEFAULT: the aggregator
 *      delegates to the shared HQ narrative helper (server/services/hq-narrative.ts)
 *      under the registered `hq.support_ai_narrative` key. It constructs NO raw
 *      model SDK and opens no model door itself — the door + governor live in the
 *      helper — so with no tier bound it returns null and cannot spend money. A
 *      raw SDK on this surface still fails this test loudly. (A per-ticket AI
 *      REPLY draft remains a separate, still-unbuilt capability.)
 *   3. Registered in the HQ nav.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

const PAGE = read("app/admin/support-ai/page.tsx");
const SERVICE = read("server/services/hq-support-ai.ts");
const PURE = read("lib/hq/support-ai.ts");
const LAYOUT = read("app/admin/layout.tsx");

describe("Support AI — super-admin gated (HQ-only)", () => {
  it("the page imports and awaits requireHqPage", () => {
    expect(PAGE).toMatch(/import\s*\{[^}]*requireHqPage[^}]*\}\s*from\s*"@\/server\/auth\/hq"/);
    expect(PAGE).toMatch(/await\s+requireHqPage\(\)/);
  });

  it("the aggregator re-gates on requireHqPage before reading any ticket", () => {
    expect(SERVICE).toMatch(/import\s*\{[^}]*requireHqPage[^}]*\}\s*from\s*"@\/server\/auth\/hq"/);
    expect(SERVICE).toMatch(/await\s+requireHqPage\(\)/);
  });

  it("the parent /admin layout also gates on requireHqPage (defence in depth)", () => {
    expect(LAYOUT).toMatch(/await\s+requireHqPage\(\)/);
  });
});

describe("Support AI — triage narrative is GOVERNED (fail-closed), constructs no raw SDK", () => {
  it("the narrative loader delegates to the shared governed helper", () => {
    expect(SERVICE).toMatch(/loadSupportNarrative/);
    // The governed call the earlier dark stub anticipated: it goes through the
    // shared HQ narrative helper under its registered key, never a raw client.
    expect(SERVICE).toMatch(/generateHqBoardNarrative\(\s*"hq\.support_ai_narrative"/);
    expect(SERVICE).toMatch(/@\/server\/services\/hq-narrative/);
  });

  it("the service constructs no raw model SDK", () => {
    expect(SERVICE).not.toMatch(/@anthropic-ai\/sdk|from\s*"openai"|new\s+Anthropic\(|new\s+OpenAI\(/);
  });
});

// P13 — the per-ticket reply draft is BUILT now, so the old "opens no model
// door" pin is superseded by the STRONGER contract every door caller carries
// (mirroring ai-governance-closure): own-tier gate BEFORE the door, governed
// invocation under a registered key, HQ-budget attribution fail-closed, and —
// the Support-specific boundary — NEVER a transport, NEVER a customer-visible
// write. The draft is an artifact a human copies; it is structurally unsendable
// from this module.
describe("Support AI — reply draft: governed, dark, NEVER auto-sent", () => {
  it("gates on its OWN class's tier BEFORE opening the provider door", () => {
    const gate = 'isTierActivated("mid")';
    const idxGate = SERVICE.indexOf(gate);
    const idxDoor = SERVICE.search(/\bgetTextProvider\s*\(/);
    expect(idxGate, "own-tier gate must exist").toBeGreaterThan(-1);
    expect(idxDoor, "door open must exist").toBeGreaterThan(-1);
    expect(idxGate, "gate must precede the door").toBeLessThan(idxDoor);
    // Never the coarse/global predicates (the partial-binding hole).
    expect(SERVICE).not.toMatch(/\bisInferenceTierActivated\s*\(/);
    expect(SERVICE).not.toMatch(/\bisGovernorActivated\s*\(/);
  });

  it("the generative leg runs ONLY under the registered hq.draft key, billed to the HQ budget org", () => {
    expect(SERVICE).toMatch(/invokeWithGovernor\(\s*\n?\s*"hq\.draft"/);
    expect(SERVICE).toMatch(/hqBudgetOrgId\(\)/);
    // Fail-closed on missing attribution — no budget org, no model call.
    expect(SERVICE).toMatch(/if \(!budgetOrgId\) return null;/);
  });

  it("NEVER sends: no transport import, no support_messages write, no reply action", () => {
    // No mailer / comms transport of any kind.
    expect(SERVICE).not.toMatch(/resend|nodemailer|smtp|sendEmail|deliverDraft|\/comms/i);
    // Never writes the customer-visible thread.
    expect(SERVICE).not.toMatch(/from\(\s*["'`]support_messages/);
    expect(SERVICE).not.toMatch(/\breplyAsHq\b/);
    // The artifact carries the structural pin.
    expect(SERVICE).toMatch(/neverSent: true/);
  });

  it("touches the task queue only through the sanctioned surfaces (enqueue + runner SDK; reads only)", () => {
    expect(SERVICE).toMatch(/import\s*\{[^}]*\benqueueTask\b[^}]*\}\s*from\s*"@\/server\/services\/hq-tasks"/);
    const oneLine = SERVICE.replace(/\s+/g, " ");
    expect(oneLine).not.toMatch(
      /\.from\(\s*["'`]hq_ai_tasks["'`](\s+as\s+never)?\s*\)\s*\.(insert|update|delete|upsert)\b/,
    );
  });

  it("the admin action never auto-sends the draft either", () => {
    const ACTIONS = read("app/admin/support/actions.ts");
    const fn = ACTIONS.slice(ACTIONS.indexOf("export async function generateSupportReplyDraft"));
    expect(fn.length).toBeGreaterThan(0);
    // The generate action enqueues + drains + audits — it must not write a
    // message row or call the reply path.
    expect(fn).not.toMatch(/replyAsHq\s*\(/);
    expect(fn).not.toMatch(/support_messages/);
    expect(fn).not.toMatch(/emitNotifications\s*\(/);
  });
});

describe("Support AI — the pure layer is clock- and Supabase-free", () => {
  it("takes an injected `now` and never touches Date.now or the DB", () => {
    expect(PURE).toMatch(/computeSupportBoard\([^)]*now:\s*Date/);
    expect(PURE).not.toMatch(/Date\.now\(/);
    expect(PURE).not.toMatch(/from\s*"@\/lib\/supabase|createAdminClient/);
  });
});

describe("Support AI — wired into the HQ nav", () => {
  it("the admin nav links to /admin/support-ai", () => {
    expect(read("app/admin/_nav/hq-nav-model.ts")).toMatch(/href:\s*"\/admin\/support-ai"/);
  });
});
