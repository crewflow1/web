import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Regression guard for the /admin/launch-checklist false-RED bug.
 *
 * server/services/launch-readiness.ts probes a set of artifacts with
 * `existsSync(resolve(process.cwd(), rel))`. The page is `force-dynamic`,
 * so those checks run at REQUEST time inside the Vercel lambda. The lambda
 * filesystem only contains what @vercel/nft traced — and nft cannot follow
 * the dynamic path strings the probe builds. So unless next.config.ts
 * force-includes each artifact via `outputFileTracingIncludes`, the probe
 * returns false in production and the checklist shows RED even though every
 * feature is deployed and working.
 *
 * This test fails if a `fileExists("X")` check exists in the readiness
 * service that is NOT covered by a trace-include glob in next.config.ts —
 * catching the drift in CI instead of in production.
 */

const ROOT = resolve(__dirname, "..", "..");

/** Minimal glob → RegExp supporting only `*`, `**`, and `\`-escaped literals. */
function globToRegExp(glob: string): RegExp {
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob.charAt(i);
    if (c === "\\") {
      re += escape(glob.charAt(++i));
    } else if (c === "*") {
      if (glob.charAt(i + 1) === "*") {
        i++; // consume the second '*'
        if (glob.charAt(i + 1) === "/") i++; // consume the slash after '**'
        re += "(?:.*/)?"; // '**' spans zero or more path segments
      } else {
        re += "[^/]*"; // '*' stays within one segment
      }
    } else {
      re += escape(c);
    }
  }
  return new RegExp("^" + re + "$");
}

function readinessFileChecks(): string[] {
  const src = readFileSync(
    resolve(ROOT, "server/services/launch-readiness.ts"),
    "utf8",
  );
  const paths = new Set<string>();
  for (const m of src.matchAll(/fileExists\(\s*"([^"]+)"\s*\)/g)) {
    if (m[1]) paths.add(m[1]);
  }
  return [...paths];
}

function launchChecklistTraceGlobs(): string[] {
  const cfg = readFileSync(resolve(ROOT, "next.config.ts"), "utf8");
  const block = cfg.match(/"\/admin\/launch-checklist"\s*:\s*\[([\s\S]*?)\]/);
  if (!block || !block[1]) return [];
  const globs: string[] = [];
  for (const m of block[1].matchAll(/"([^"]+)"/g)) {
    if (m[1]) globs.push(m[1]);
  }
  return globs;
}

describe("launch-checklist trace coverage", () => {
  it("the readiness service performs at least one fileExists() check", () => {
    expect(readinessFileChecks().length).toBeGreaterThan(0);
  });

  it("next.config.ts force-includes the launch-checklist artifacts", () => {
    expect(launchChecklistTraceGlobs().length).toBeGreaterThan(0);
  });

  it("every fileExists() artifact is covered by a trace-include glob", () => {
    const checks = readinessFileChecks();
    const matchers = launchChecklistTraceGlobs().map(globToRegExp);
    const uncovered = checks.filter((p) => !matchers.some((re) => re.test(p)));
    expect(
      uncovered,
      `These launch-checklist artifacts are checked at runtime but not ` +
        `force-traced into the lambda via outputFileTracingIncludes in ` +
        `next.config.ts, so the checklist will show RED in production:\n` +
        uncovered.map((p) => `  - ${p}`).join("\n"),
    ).toEqual([]);
  });
});
