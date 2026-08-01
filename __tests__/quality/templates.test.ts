import { describe, expect, it } from "vitest";
import {
  TEMPLATE_STATUSES,
  TEMPLATE_STATUS_META,
  canInstantiate,
  canPublish,
  canTemplateTransition,
  isTemplateEditable,
} from "@/lib/quality/templates";
import {
  WITNESS_STATUSES,
  WITNESS_STATUS_META,
  canInviteWitness,
  canWitnessTransition,
} from "@/lib/quality/itp";
import {
  createTemplateSchema,
  templateItemSchema,
  instantiateTemplateSchema,
  inviteWitnessSchema,
  witnessOutcomeSchema,
  startRevisionSchema,
} from "@/lib/quality/schema";

/**
 * Works Quality M2 — template + witness-invitation pure domain tests.
 * No DB, no I/O, no AI (the lib/quality convention).
 */

const ID = "11111111-1111-1111-1111-111111111111";
const JOB = "22222222-2222-2222-2222-222222222222";

describe("template lifecycle", () => {
  it("mirrors the DB transition matrix exactly", () => {
    expect(canTemplateTransition("draft", "published")).toBe(true);
    expect(canTemplateTransition("draft", "archived")).toBe(true);
    expect(canTemplateTransition("published", "archived")).toBe(true);
    expect(canTemplateTransition("published", "draft")).toBe(false);
    expect(canTemplateTransition("archived", "published")).toBe(false);
    expect(canTemplateTransition("archived", "draft")).toBe(false);
  });

  it("only a draft is editable; only a published version instantiates", () => {
    expect(isTemplateEditable("draft")).toBe(true);
    expect(isTemplateEditable("published")).toBe(false);
    expect(isTemplateEditable("archived")).toBe(false);
    expect(canInstantiate("published")).toBe(true);
    expect(canInstantiate("draft")).toBe(false);
    expect(canInstantiate("archived")).toBe(false);
  });

  it("publish readiness mirrors the DB item gate", () => {
    expect(canPublish({ status: "draft", itemCount: 3 })).toEqual({ ok: true, reasons: [] });
    expect(canPublish({ status: "draft", itemCount: 0 }).ok).toBe(false);
    expect(canPublish({ status: "published", itemCount: 3 }).ok).toBe(false);
  });

  it("every status has display metadata", () => {
    for (const s of TEMPLATE_STATUSES) expect(TEMPLATE_STATUS_META[s].label).toBeTruthy();
  });

  it("a template item mirrors the plan item's structural rules", () => {
    const base = {
      templateId: ID,
      itemNumber: 1,
      title: "Bedding",
      acceptanceCriteria: "100mm pea gravel",
      controlPoint: "witness",
    };
    expect(templateItemSchema.safeParse(base).success).toBe(true);
    expect(templateItemSchema.safeParse({ ...base, acceptanceCriteria: "" }).success).toBe(false);
    expect(templateItemSchema.safeParse({ ...base, controlPoint: "hold" }).success).toBe(false);
    expect(templateItemSchema.safeParse({ ...base, itemNumber: 0 }).success).toBe(false);
  });

  it("creating and instantiating validate their shapes", () => {
    expect(createTemplateSchema.safeParse({ name: "Drainage ITP" }).success).toBe(true);
    expect(createTemplateSchema.safeParse({ name: " " }).success).toBe(false);
    expect(
      instantiateTemplateSchema.safeParse({ templateId: ID, jobId: JOB, workPackage: "Drainage" })
        .success,
    ).toBe(true);
    expect(
      instantiateTemplateSchema.safeParse({ templateId: ID, jobId: "", workPackage: "Drainage" })
        .success,
    ).toBe(false);
    expect(
      instantiateTemplateSchema.safeParse({ templateId: ID, jobId: JOB, workPackage: " " }).success,
    ).toBe(false);
  });
});

describe("witness invitations", () => {
  it("every outcome is terminal — a correction is a fresh invitation", () => {
    expect(canWitnessTransition("invited", "attended")).toBe(true);
    expect(canWitnessTransition("invited", "not_attended")).toBe(true);
    expect(canWitnessTransition("invited", "cancelled")).toBe(true);
    for (const from of ["attended", "not_attended", "cancelled"] as const) {
      for (const to of WITNESS_STATUSES) {
        expect(canWitnessTransition(from, to)).toBe(false);
      }
    }
  });

  it("only witness/approve control points have a second party to invite", () => {
    expect(canInviteWitness("witness")).toBe(true);
    expect(canInviteWitness("approve")).toBe(true);
    expect(canInviteWitness("inspect")).toBe(false);
  });

  it("every status has display metadata", () => {
    for (const s of WITNESS_STATUSES) expect(WITNESS_STATUS_META[s].label).toBeTruthy();
  });

  it("an invitation names the witness AND their organisation; email is optional", () => {
    const base = { itemId: ID, planId: JOB, witnessName: "J Carter", witnessOrganisation: "Building Control" };
    expect(inviteWitnessSchema.safeParse(base).success).toBe(true);
    expect(inviteWitnessSchema.safeParse({ ...base, witnessOrganisation: " " }).success).toBe(false);
    expect(inviteWitnessSchema.safeParse({ ...base, witnessEmail: "not-an-email" }).success).toBe(false);
    expect(inviteWitnessSchema.safeParse({ ...base, witnessEmail: "j@example.com" }).success).toBe(true);
  });

  it("outcome recording only accepts the three legal outcomes", () => {
    const base = { id: ID, planId: JOB };
    for (const outcome of ["attended", "not_attended", "cancelled"]) {
      expect(witnessOutcomeSchema.safeParse({ ...base, outcome }).success).toBe(true);
    }
    expect(witnessOutcomeSchema.safeParse({ ...base, outcome: "invited" }).success).toBe(false);
  });
});

describe("revision lineage", () => {
  it("starting a revision needs only the source plan id", () => {
    expect(startRevisionSchema.safeParse({ id: ID }).success).toBe(true);
    expect(startRevisionSchema.safeParse({ id: "nope" }).success).toBe(false);
  });
});
