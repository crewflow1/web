import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve, dirname } from "node:path";
import {
  detectScheduleConflicts,
  type RotaShiftRow,
  type ScheduledJobRow,
} from "@/lib/schedule/conflicts";
import { buildScheduleWindow } from "@/lib/schedule/window";
import { recommendForConflicts } from "@/lib/schedule/recommendations";

/**
 * Schedule Recommendations — the two boundaries this feature must not cross.
 *
 * ── 1. IT INTRODUCES NO AI CALL SITE ─────────────────────────────────────────
 *
 * The platform is mid-way through governing its AI surface: spend runs through
 * `lib/ai/governor`, and an ungoverned call site is a hole in a £-ceiling that
 * a key alone can walk through. Scheduling is a CONSTRAINT-SOLVING problem over
 * rows the product already stores — interval overlap and integer arithmetic —
 * so the correct number of model calls here is zero, and a future edit that
 * quietly adds one (directly, or by importing a module that does) must fail
 * here rather than surface as a bill.
 *
 * The check is TRANSITIVE, not a grep of the new files: it walks the real
 * import graph out of the schedule modules and asserts nothing in the closure
 * is an AI module. Importing an innocent-looking helper that itself reaches a
 * model is exactly the way an ungoverned call site gets added by accident.
 *
 * ── 2. IT PROPOSES; IT NEVER APPLIES ─────────────────────────────────────────
 *
 * A recommender that can move a shift is a scheduler that moves people's lives
 * around without asking. The boundary is enforced structurally, and proven here
 * three ways: the pure engine cannot write (no client, no write verb, not even
 * a server module); the surface renders LINKS and has no form or action; and
 * the write it eventually leads to is the pre-existing `createRotaEntry`, with
 * its own admin gate and active-org pin still intact and asserted below.
 *
 * Comments are stripped before matching, so prose that DOCUMENTS a boundary by
 * naming what it does not do cannot satisfy the very check it describes.
 */

const ROOT = resolve(__dirname, "..", "..");

/** The modules this lane owns or changed. */
const PURE_ENGINE = "lib/schedule/recommendations.ts";
const READ_SERVICE = "server/services/schedule-integrity.ts";
const CONFLICTS_PAGE = "app/(app)/staff/rota/conflicts/page.tsx";
const ROTA_PAGE = "app/(app)/staff/rota/page.tsx";
const ROTA_FORM = "app/(app)/staff/rota/_create-form.tsx";
const ROTA_ACTIONS = "app/(app)/staff/actions.ts";

function read(rel: string): string {
  return readFileSync(resolve(ROOT, rel), "utf8");
}

/** Source with comments removed — see the header. */
function code(rel: string): string {
  return read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

// ── The import-graph walk ────────────────────────────────────────────────────

const IMPORT_RE = /(?:from|import)\s*\(?\s*["']([^"']+)["']/g;

/** Resolve a repo-internal specifier to a real file, or null if it leaves the repo. */
function resolveSpecifier(spec: string, fromFile: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = resolve(ROOT, spec.slice(2));
  else if (spec.startsWith(".")) base = resolve(dirname(resolve(ROOT, fromFile)), spec);
  else return null; // a package — not ours to walk
  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}/index.ts`,
    `${base}/index.tsx`,
  ]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return candidate.slice(ROOT.length + 1);
    }
  }
  return null;
}

/** Every repo file reachable from `entries`, plus every bare package imported. */
function moduleClosure(entries: readonly string[]): {
  files: Set<string>;
  packages: Set<string>;
} {
  const files = new Set<string>();
  const packages = new Set<string>();
  const queue = [...entries];
  while (queue.length > 0) {
    const current = queue.pop()!;
    if (files.has(current)) continue;
    files.add(current);
    const source = code(current);
    for (const match of source.matchAll(IMPORT_RE)) {
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

/** Packages that mean "a model is being called". */
const AI_PACKAGES = [/^@anthropic-ai\//, /^openai$/, /^openai\//, /^@ai-sdk\//, /^ai$/];

describe("schedule recommendations introduce NO AI call site", () => {
  const scheduleClosure = moduleClosure([PURE_ENGINE, "lib/schedule/conflicts.ts", "lib/schedule/window.ts"]);

  it("the pure engine's whole import closure contains no AI module", () => {
    const ai = [...scheduleClosure.files].filter((f) => f.startsWith("lib/ai/"));
    expect(ai, `AI modules reachable from ${PURE_ENGINE}`).toEqual([]);
    // …and the closure is not trivially small, so "clean" means something.
    expect(scheduleClosure.files.size).toBeGreaterThan(3);
  });

  it("the pure engine's closure pulls in no model SDK", () => {
    const sdks = [...scheduleClosure.packages].filter((p) =>
      AI_PACKAGES.some((re) => re.test(p)),
    );
    expect(sdks, "model SDKs reachable from the schedule engine").toEqual([]);
  });

  it("no file this lane touches imports lib/ai or a model SDK directly", () => {
    for (const file of [PURE_ENGINE, READ_SERVICE, CONFLICTS_PAGE, ROTA_PAGE, ROTA_FORM]) {
      const source = code(file);
      expect(source, file).not.toMatch(/from\s+["']@\/lib\/ai/);
      expect(source, file).not.toMatch(/from\s+["']@anthropic-ai\//);
      expect(source, file).not.toMatch(/from\s+["']openai["']/);
    }
  });

  it("no file this lane touches reaches the governor or the invocation ledger", () => {
    // A governed call is still a call: if one ever appears here it must appear
    // as a deliberate change to this list, not slip in as a helper import.
    const forbidden = [
      "invokeWithGovernor",
      "reserveBudget",
      "settleReservation",
      "recordInvocation",
      "ai_invocations",
      "messages.create",
      "chat.completions",
    ];
    for (const file of [PURE_ENGINE, READ_SERVICE, CONFLICTS_PAGE, ROTA_PAGE, ROTA_FORM]) {
      const source = code(file);
      for (const needle of forbidden) {
        expect(source.includes(needle), `${file} contains "${needle}"`).toBe(false);
      }
    }
  });

  it("the engine is deterministic by construction — no clock and no randomness", () => {
    const source = code(PURE_ENGINE);
    // `new Date(ms)` is fine; a clock of its own is not — the window carries the
    // pinned instant, which is what makes two renders agree.
    expect(source).not.toMatch(/new Date\(\s*\)/);
    expect(source).not.toContain("Date.now(");
    expect(source).not.toContain("Math.random(");
  });
});

// ── The propose / apply boundary ─────────────────────────────────────────────

describe("recommendations propose — they never apply", () => {
  it("the pure engine holds no database client and no write verb", () => {
    const source = code(PURE_ENGINE);
    expect(source).not.toContain("server-only");
    expect(source).not.toContain('"use server"');
    expect(source).not.toMatch(/from\s+["']@\/lib\/supabase/);
    for (const verb of [".insert(", ".update(", ".delete(", ".upsert(", ".rpc(", ".from("]) {
      expect(source.includes(verb), `pure engine contains ${verb}`).toBe(false);
    }
  });

  it("the read service still cannot write, with recommendations attached", () => {
    const source = code(READ_SERVICE);
    for (const verb of [".insert(", ".update(", ".delete(", ".upsert(", ".rpc("]) {
      expect(source.includes(verb), `read service contains ${verb}`).toBe(false);
    }
    // Every read stays pinned to the ACTIVE org — including the widened
    // membership read the roster is built from.
    expect(source).toContain('.eq("org_id", orgId)');
    expect(source).toContain('"memberships"');
  });

  it("the conflicts surface has no form, no server action and no mutation", () => {
    const source = code(CONFLICTS_PAGE);
    expect(source).not.toContain("<form");
    expect(source).not.toContain("action={");
    expect(source).not.toContain('"use server"');
    expect(source).not.toContain("createRotaEntry");
    expect(source).not.toContain("deleteRotaEntry");
    expect(source).not.toMatch(/from\s+["']\.\.\/\.\.\/actions["']/);
    // What it DOES render is a link to the existing rota surface.
    expect(source).toContain("applyHref");
  });

  it("applying still runs the pre-existing action, gate and org pin untouched", () => {
    const source = code(ROTA_ACTIONS);
    const action = source.slice(source.indexOf("export async function createRotaEntry"));
    expect(action).toContain("requireAdmin(ctx)");
    expect(action).toContain("listUserShiftsOnDay");
    expect(action).toContain("org_id: ctx.org.id");
    // The rota page still wires the form to that same action — the pre-fill
    // changed the form's DEFAULTS, never where it posts.
    expect(code(ROTA_PAGE)).toContain("action={createRotaEntry}");
  });

  it("the pre-filled form cannot submit itself", () => {
    const source = code(ROTA_FORM);
    expect(source).toContain("prefill");
    // No programmatic submission, and the pre-fill is inert until a human acts.
    expect(source).not.toContain("requestSubmit");
    expect(source).not.toContain("formAction()");
    expect(source).not.toContain(".submit()");
    // It only seeds a PRISTINE form, so a real submission always wins.
    expect(source).toContain("isPristine(state)");
  });

  it("every apply link is a relative rota link — never an off-site redirect", () => {
    const NOW = new Date("2026-08-10T09:00:00Z");
    const window = buildScheduleWindow(NOW);
    const rota: RotaShiftRow[] = [
      { id: "s-1", user_id: "u-1", job_id: null, starts_at: "2026-08-12T08:00:00Z", ends_at: "2026-08-12T17:00:00Z" },
      { id: "s-2", user_id: "u-1", job_id: null, starts_at: "2026-08-12T09:00:00Z", ends_at: "2026-08-12T12:00:00Z" },
    ];
    const jobs: ScheduledJobRow[] = [
      { id: "j-1", assigned_to: null, scheduled_date: "2026-08-14", status: "new", customer_name: "Acme" },
    ];
    const input = {
      window,
      rota,
      jobs,
      leave: [],
      custody: [],
      roster: [
        { userId: "u-1", name: "One", role: "staff" },
        { userId: "u-2", name: "Two", role: "staff" },
      ],
    };
    const recs = recommendForConflicts(detectScheduleConflicts(input), input);
    const hrefs = [...recs.values()].flatMap((r) => r.candidates.map((c) => c.applyHref));
    expect(hrefs.length).toBeGreaterThan(0);
    for (const href of hrefs) {
      expect(href.startsWith("/staff/rota?"), href).toBe(true);
      expect(href).not.toMatch(/^https?:/);
      expect(href).not.toContain("//");
    }
  });

  it("never proposes a person outside the roster it was handed", () => {
    // The roster is the ACTIVE org's membership list, so this is the pure half
    // of the tenant boundary: a dual-org colleague read into `rota` but absent
    // from `roster` can never become a suggestion.
    const window = buildScheduleWindow(new Date("2026-08-10T09:00:00Z"));
    const input = {
      window,
      rota: [
        { id: "s-1", user_id: "u-1", job_id: null, starts_at: "2026-08-12T08:00:00Z", ends_at: "2026-08-12T17:00:00Z" },
        { id: "s-2", user_id: "u-1", job_id: null, starts_at: "2026-08-12T09:00:00Z", ends_at: "2026-08-12T12:00:00Z" },
        { id: "s-x", user_id: "u-other-org", job_id: null, starts_at: "2026-08-13T08:00:00Z", ends_at: "2026-08-13T09:00:00Z" },
      ],
      jobs: [],
      leave: [],
      custody: [],
      roster: [{ userId: "u-1", name: "One", role: "staff" }],
    };
    const recs = recommendForConflicts(detectScheduleConflicts(input), input);
    const touched = [...recs.values()].flatMap((r) => [
      ...r.candidates.map((c) => c.userId),
      ...r.ruledOut.map((x) => x.userId),
    ]);
    expect(touched).not.toContain("u-other-org");
  });
});
