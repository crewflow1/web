import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve, dirname } from "node:path";

/**
 * The deterministic rota generator — the two boundaries it must not cross.
 * Mirrors __tests__/security/schedule-recommendations-no-ai.test.ts, extended to
 * the new solver lane.
 *
 * 1. IT INTRODUCES NO AI CALL SITE. Scheduling is constraint solving over rows
 *    the product already stores — interval overlap and integer arithmetic — so
 *    the correct number of model calls is zero. The check is TRANSITIVE: it
 *    walks the real import graph out of the solver and asserts nothing in the
 *    closure is an AI module or model SDK. Importing an innocent helper that
 *    itself reaches a model is exactly how an ungoverned call site gets added.
 *
 * 2. THE ENGINE PROPOSES; THE WRITE IS GATED. The pure engine holds no client
 *    and no write verb. The generate surface offers two paths to a rota entry,
 *    both gated and both ADD-ONLY: a per-line LINK to the pre-existing
 *    `createRotaEntry` form, and a bulk `persistGeneratedRota` approve action
 *    that RE-DERIVES the plan server-side (nothing client-supplied) under an
 *    owner/admin capability gate and never deletes or edits. Comments are
 *    stripped before matching, so prose documenting a boundary cannot satisfy
 *    the check that enforces it.
 */

const ROOT = resolve(__dirname, "..", "..");

const PURE_ENGINE = "lib/schedule/solver.ts";
const READ_SERVICE = "server/services/schedule-integrity.ts";
const GENERATE_PAGE = "app/(app)/staff/rota/generate/page.tsx";

function read(rel: string): string {
  return readFileSync(resolve(ROOT, rel), "utf8");
}
function code(rel: string): string {
  return read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const IMPORT_RE = /(?:from|import)\s*\(?\s*["']([^"']+)["']/g;

function resolveSpecifier(spec: string, fromFile: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = resolve(ROOT, spec.slice(2));
  else if (spec.startsWith(".")) base = resolve(dirname(resolve(ROOT, fromFile)), spec);
  else return null;
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return candidate.slice(ROOT.length + 1);
    }
  }
  return null;
}

function moduleClosure(entries: readonly string[]): { files: Set<string>; packages: Set<string> } {
  const files = new Set<string>();
  const packages = new Set<string>();
  const queue = [...entries];
  while (queue.length > 0) {
    const current = queue.pop()!;
    if (files.has(current)) continue;
    files.add(current);
    for (const match of code(current).matchAll(IMPORT_RE)) {
      const spec = match[1]!;
      const target = resolveSpecifier(spec, current);
      if (target == null) {
        if (!spec.startsWith("@/") && !spec.startsWith(".")) packages.add(spec);
        continue;
      }
      if (!files.has(target)) queue.push(target);
    }
  }
  return { files, packages };
}

const AI_PACKAGES = [/^@anthropic-ai\//, /^openai$/, /^openai\//, /^@ai-sdk\//, /^ai$/];

describe("the rota solver introduces NO AI call site", () => {
  const closure = moduleClosure([PURE_ENGINE]);

  it("the solver's whole import closure contains no AI module", () => {
    const ai = [...closure.files].filter((f) => f.startsWith("lib/ai/"));
    expect(ai, `AI modules reachable from ${PURE_ENGINE}`).toEqual([]);
    expect(closure.files.size).toBeGreaterThan(3);
  });

  it("the solver's closure pulls in no model SDK", () => {
    const sdks = [...closure.packages].filter((p) => AI_PACKAGES.some((re) => re.test(p)));
    expect(sdks, "model SDKs reachable from the solver").toEqual([]);
  });

  it("no file this lane touches imports lib/ai or a model SDK directly", () => {
    for (const file of [PURE_ENGINE, READ_SERVICE, GENERATE_PAGE]) {
      const source = code(file);
      expect(source, file).not.toMatch(/from\s+["']@\/lib\/ai/);
      expect(source, file).not.toMatch(/from\s+["']@anthropic-ai\//);
      expect(source, file).not.toMatch(/from\s+["']openai["']/);
    }
  });

  it("no file this lane touches reaches the governor or the invocation ledger", () => {
    const forbidden = [
      "invokeWithGovernor",
      "reserveBudget",
      "settleReservation",
      "recordInvocation",
      "ai_invocations",
      "messages.create",
      "chat.completions",
    ];
    for (const file of [PURE_ENGINE, READ_SERVICE, GENERATE_PAGE]) {
      const source = code(file);
      for (const needle of forbidden) {
        expect(source.includes(needle), `${file} contains "${needle}"`).toBe(false);
      }
    }
  });

  it("the engine is deterministic by construction — no clock and no randomness", () => {
    const source = code(PURE_ENGINE);
    expect(source).not.toMatch(/new Date\(\s*\)/);
    expect(source).not.toContain("Date.now(");
    expect(source).not.toContain("Math.random(");
  });
});

describe("the rota solver proposes — it never applies", () => {
  it("the pure engine holds no database client and no write verb", () => {
    const source = code(PURE_ENGINE);
    expect(source).not.toContain("server-only");
    expect(source).not.toContain('"use server"');
    expect(source).not.toMatch(/from\s+["']@\/lib\/supabase/);
    for (const verb of [".insert(", ".update(", ".delete(", ".upsert(", ".rpc(", ".from("]) {
      expect(source.includes(verb), `pure engine contains ${verb}`).toBe(false);
    }
  });

  it("the read service still cannot write, with the generator attached", () => {
    const source = code(READ_SERVICE);
    for (const verb of [".insert(", ".update(", ".delete(", ".upsert(", ".rpc("]) {
      expect(source.includes(verb), `read service contains ${verb}`).toBe(false);
    }
    // Every read stays pinned to the ACTIVE org.
    expect(source).toContain('.eq("org_id", orgId)');
  });

  it("the generate surface's only write is the gated, add-only approve action", () => {
    const source = code(GENERATE_PAGE);
    // It persists ONLY through the dedicated bulk-approve action, which
    // re-derives the plan server-side and runs its own owner/admin capability
    // gate — never the single-shift create/delete actions, and never inline.
    expect(source).toContain("persistGeneratedRota");
    expect(source).not.toContain('"use server"');
    expect(source).not.toContain("createRotaEntry");
    expect(source).not.toContain("deleteRotaEntry");
    // Approval only ever ADDS — the surface issues no delete/edit/upsert itself.
    for (const verb of [".delete(", ".update(", ".upsert(", ".rpc("]) {
      expect(source.includes(verb), `generate surface contains ${verb}`).toBe(false);
    }
    // The write is gated in the UI by a capability check (the server re-checks).
    expect(source).toContain("hasCapability");
    // It still renders the per-line manual path — a link carrying the pre-fill.
    expect(source).toContain("applyHref");
  });

  it("every apply link is a relative rota link — never an off-site redirect", async () => {
    const { generateRota } = await import("@/lib/schedule/solver");
    const { buildScheduleWindow } = await import("@/lib/schedule/window");
    const window = buildScheduleWindow(new Date("2026-08-10T09:00:00Z"));
    const plan = generateRota({
      window,
      rota: [],
      jobs: [
        { id: "j-1", assigned_to: null, scheduled_date: "2026-08-12", status: "new", customer_name: "Acme" },
      ],
      leave: [],
      custody: [],
      roster: [{ userId: "u-1", name: "One", role: "staff" }],
    });
    const hrefs = plan.assignments.map((a) => a.applyHref);
    expect(hrefs.length).toBeGreaterThan(0);
    for (const href of hrefs) {
      expect(href.startsWith("/staff/rota?"), href).toBe(true);
      expect(href).not.toMatch(/^https?:/);
      expect(href).not.toContain("//");
    }
  });
});
