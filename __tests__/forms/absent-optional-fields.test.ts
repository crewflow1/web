import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { revokeOverrideSchema } from "@/lib/assets/inspection-override";
import { recordCalibrationSchema } from "@/lib/assets/calibration";

/**
 * An optional form field that is ABSENT from the form must parse as "not given".
 *
 * `FormData.get()` returns `null` for a field the form does not render. The house helper for
 * optional fields only turned an EMPTY STRING into `undefined`, so `null` reached
 * `z.string().optional()` and was rejected ("Expected string, received null") — the action
 * failed for every user whenever a form legitimately omitted the field. Confirmed broken that
 * way: "Report fault", "Start inspection" (no template), "Revoke inspection override",
 * "Create service schedule", and "Record calibration" for an asset with no schedule.
 */
describe("absent optional fields parse as not given", () => {
  it("revoke inspection override: the form has no reason input", () => {
    const r = revokeOverrideSchema.safeParse({ override_id: "6b1f6a0e-3b1c-4d43-9d0c-1b6f0d2c9a11", revoke_reason: null });
    expect(r.success, JSON.stringify(r.error?.issues)).toBe(true);
  });
  it("record calibration: an asset with no calibration schedule renders no schedule select", () => {
    const r = recordCalibrationSchema.safeParse({
      asset_id: "6b1f6a0e-3b1c-4d43-9d0c-1b6f0d2c9a11", schedule_id: null, certificate_number: "CERT-1",
      calibrated_by: "Lab", calibration_date: "2026-11-01", next_due_date: null, result: "pass", notes: null,
    });
    const scheduleIssue = r.success ? undefined : r.error.issues.find((i) => i.path[0] === "schedule_id" || i.path[0] === "next_due_date");
    expect(scheduleIssue, JSON.stringify(scheduleIssue)).toBeUndefined();
  });
});

describe("guard: no blank-to-undefined helper ignores null", () => {
  const root = resolve(__dirname, "../..");
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name.startsWith(".")) continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(name)) files.push(p);
    }
  };
  ["app", "lib", "server"].forEach((d) => walk(join(root, d)));

  it("every `blank string → undefined` preprocess also maps null", () => {
    const offenders: string[] = [];
    for (const f of files) {
      readFileSync(f, "utf8").split("\n").forEach((line, i) => {
        if (/typeof v === "string" && v\.trim\(\) === ""\)? \? undefined : v/.test(line) && !line.includes("v === null")) {
          offenders.push(`${f.slice(root.length + 1)}:${i + 1}`);
        }
      });
    }
    // lib/assets/inspection.ts is corrected by the post-D-17 stabilisation change (PR #1098).
    expect(offenders.filter((o) => !o.startsWith("lib/assets/inspection.ts:"))).toEqual([]);
  });
});
