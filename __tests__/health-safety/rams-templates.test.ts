import { describe, it, expect } from "vitest";
import {
  RAMS_TEMPLATES,
  buildRamsDraftFromTemplate,
  getRamsTemplate,
  isRamsTemplateKey,
  ramsTemplateOptions,
} from "@/lib/health-safety/rams-templates";
import { validateHazard, riskRating, LIKELIHOOD_MAX, SEVERITY_MAX } from "@/lib/health-safety/rams";

/**
 * RAMS auto-draft generator — deterministic template → draft mapping.
 *
 * The generator must be pure, total, and produce ONLY draft-safe content: every
 * templated hazard has to satisfy the same domain rules the DB and manual UI
 * enforce (validateHazard), so a bad template can't ship a RAMS the pipeline
 * would later reject.
 */

describe("catalogue integrity", () => {
  it("has a non-empty starter set", () => {
    expect(RAMS_TEMPLATES.length).toBeGreaterThanOrEqual(4);
  });

  it("has unique, stable, url-safe keys", () => {
    const keys = RAMS_TEMPLATES.map((t) => t.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const k of keys) expect(k).toMatch(/^[a-z0-9-]+$/);
  });

  it("every template carries a complete header and at least one hazard", () => {
    for (const t of RAMS_TEMPLATES) {
      expect(t.title.trim()).not.toBe("");
      expect(t.activity.trim()).not.toBe("");
      expect(t.methodStatement.trim()).not.toBe("");
      expect(t.ppe.length).toBeGreaterThan(0);
      expect(t.hazards.length).toBeGreaterThan(0);
    }
  });

  it("every templated hazard is valid per the shared domain rules", () => {
    for (const t of RAMS_TEMPLATES) {
      for (const h of t.hazards) {
        const errs = validateHazard({
          hazard: h.hazard,
          whoAtRisk: h.whoAtRisk,
          likelihood: h.likelihood,
          severity: h.severity,
          controlMeasures: h.controlMeasures,
          residualLikelihood: h.residualLikelihood,
          residualSeverity: h.residualSeverity,
        });
        expect(errs, `${t.key} / ${h.hazard}`).toEqual([]);
      }
    }
  });

  it("residual risk is never higher than initial risk (controls reduce risk)", () => {
    for (const t of RAMS_TEMPLATES) {
      for (const h of t.hazards) {
        expect(
          riskRating(h.residualLikelihood, h.residualSeverity),
          `${t.key} / ${h.hazard}`,
        ).toBeLessThanOrEqual(riskRating(h.likelihood, h.severity));
      }
    }
  });

  it("all scores sit inside the 5×5 matrix", () => {
    for (const t of RAMS_TEMPLATES) {
      for (const h of t.hazards) {
        for (const v of [h.likelihood, h.severity, h.residualLikelihood, h.residualSeverity]) {
          expect(v).toBeGreaterThanOrEqual(1);
          expect(v).toBeLessThanOrEqual(Math.max(LIKELIHOOD_MAX, SEVERITY_MAX));
        }
      }
    }
  });
});

describe("lookup helpers", () => {
  it("isRamsTemplateKey / getRamsTemplate agree with the catalogue", () => {
    for (const t of RAMS_TEMPLATES) {
      expect(isRamsTemplateKey(t.key)).toBe(true);
      expect(getRamsTemplate(t.key)?.key).toBe(t.key);
    }
    expect(isRamsTemplateKey("no-such-template")).toBe(false);
    expect(getRamsTemplate("no-such-template")).toBeNull();
  });

  it("ramsTemplateOptions mirrors the catalogue keys/labels", () => {
    const options = ramsTemplateOptions();
    expect(options.map((o) => o.key)).toEqual(RAMS_TEMPLATES.map((t) => t.key));
    for (const o of options) {
      expect(o.label.trim()).not.toBe("");
      expect(o.summary.trim()).not.toBe("");
    }
  });
});

describe("buildRamsDraftFromTemplate — deterministic mapping", () => {
  it("returns null for an unknown key (fail closed)", () => {
    expect(buildRamsDraftFromTemplate("nope")).toBeNull();
    expect(buildRamsDraftFromTemplate("")).toBeNull();
  });

  it("maps a template's header and hazards faithfully", () => {
    const t = getRamsTemplate("working-at-height")!;
    const draft = buildRamsDraftFromTemplate("working-at-height")!;
    expect(draft.templateKey).toBe("working-at-height");
    expect(draft.header.title).toBe(t.title);
    expect(draft.header.activity).toBe(t.activity);
    expect(draft.header.ppe).toEqual(t.ppe);
    expect(draft.header.methodStatement).toBe(t.methodStatement);
    expect(draft.hazards.length).toBe(t.hazards.length);
    draft.hazards.forEach((h, i) => {
      expect(h.hazard).toBe(t.hazards[i]!.hazard);
      expect(h.likelihood).toBe(t.hazards[i]!.likelihood);
      expect(h.severity).toBe(t.hazards[i]!.severity);
      expect(h.controlMeasures).toBe(t.hazards[i]!.controlMeasures);
    });
  });

  it("assigns a stable presentation order (sortOrder = index)", () => {
    const draft = buildRamsDraftFromTemplate("roofing")!;
    expect(draft.hazards.map((h) => h.sortOrder)).toEqual(
      draft.hazards.map((_, i) => i),
    );
  });

  it("is deterministic — identical output across calls, decoupled from the source", () => {
    const a = buildRamsDraftFromTemplate("groundworks")!;
    const b = buildRamsDraftFromTemplate("groundworks")!;
    expect(a).toEqual(b);
    // Mutating the produced draft must not bleed into the catalogue or later calls.
    a.header.ppe.push("TAMPERED");
    a.hazards[0]!.hazard = "TAMPERED";
    const c = buildRamsDraftFromTemplate("groundworks")!;
    expect(c.header.ppe).not.toContain("TAMPERED");
    expect(c.hazards[0]!.hazard).not.toBe("TAMPERED");
    expect(getRamsTemplate("groundworks")!.hazards[0]!.hazard).not.toBe("TAMPERED");
  });

  it("never pre-sets an assessor or any issued state (human keeps approval)", () => {
    for (const t of RAMS_TEMPLATES) {
      const draft = buildRamsDraftFromTemplate(t.key)!;
      // The generated header shape carries only draftable content — no assessor,
      // reference, status or issue stamp fields exist on it to smuggle in.
      expect(Object.keys(draft.header).sort()).toEqual(
        ["activity", "methodStatement", "ppe", "title"],
      );
    }
  });

  it("generated ratings match the DB generated-column formula", () => {
    const draft = buildRamsDraftFromTemplate("electrical")!;
    for (const h of draft.hazards) {
      // risk_rating / residual_rating are generated as likelihood × severity in
      // the DB; the template values must be consistent with that.
      expect(riskRating(h.likelihood, h.severity)).toBe(h.likelihood * h.severity);
      expect(riskRating(h.residualLikelihood, h.residualSeverity)).toBe(
        h.residualLikelihood * h.residualSeverity,
      );
    }
  });
});
