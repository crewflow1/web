import { describe, it, expect } from "vitest";
import {
  DRAFT_PROMPT_REVISION,
  assembleDraftPrompt,
  draftPromptChecksum,
  draftPromptVersion,
  deterministicDraft,
} from "@/lib/drafts/prompt";
import type { DraftContext } from "@/lib/drafts/model";

/**
 * CrewFlow HQ — Draft Generation: the pure core, unit-pinned (Directive 010, Phase 3).
 *
 * Phase 3 builds the FIRST REUSABLE INTELLIGENCE LAYER for the whole AI workforce.
 * Its determinism is honestly scoped (ADR 0002): the LLM edge is bounded, but prompt
 * CONSTRUCTION and the FALLBACK draft are PURE and PROVABLE — so they are proven here,
 * exhaustively. These are the CEO success criteria as executable spec:
 *   • "Prompt construction deterministic" — same context in → byte-identical prompt.
 *   • "Shared Memory reused / Research incorporated / Qualification incorporated" —
 *     every present source appears in the assembled prompt, in a fixed order.
 *   • "Prompt versions traceable" — a stable version key + a checksum that moves with
 *     the prompt (drift detection).
 *   • "Fallback behaviour deterministic" — a real, honest draft from the same context,
 *     with no model, identical every time, fabricating nothing.
 */

// A context with ALL three optional sources present (the richest case).
function fullContext(): DraftContext {
  return {
    subject: { name: "Brackenhill Builders", label: "outreach_email" },
    memory: { text: "Prior note: they asked about invoicing back in March.", count: 3 },
    research: {
      summary: "A mid-sized groundworks contractor operating across West Yorkshire.",
      sector: "groundworks",
      painPoints: ["double-keying quotes into spreadsheets", "chasing late invoices by phone"],
      buyingSignals: ["advertised three site-manager roles last month"],
      score: 82,
      recommendedModules: ["quoting", "invoicing"],
    },
    qualification: {
      tier: "hot",
      score: 91,
      decision: "qualified",
      rationale: ["strong fit on company size", "active hiring indicates growth"],
    },
  };
}

// =====================================================================
// 1. Prompt construction is DETERMINISTIC.
// =====================================================================

describe("assembleDraftPrompt — deterministic construction", () => {
  it("same context in → byte-identical prompt out (stable, so the checksum is meaningful)", () => {
    const a = assembleDraftPrompt("cold_email", fullContext());
    const b = assembleDraftPrompt("cold_email", fullContext());
    expect(a).toEqual(b);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("the system prompt states the never-send doctrine and demands strict JSON", () => {
    const { system } = assembleDraftPrompt("cold_email", fullContext());
    expect(system).toMatch(/never send/i);
    expect(system).toMatch(/nothing you write is transmitted/i);
    expect(system).toMatch(/British English/i);
    expect(system).toMatch(/STRICT JSON/i);
  });

  it("incorporates EVERY present source — memory, research, qualification — in fixed order", () => {
    const { user } = assembleDraftPrompt("cold_email", fullContext());
    // Subject.
    expect(user).toContain("Brackenhill Builders");
    // Shared Memory (reused verbatim from recall's prompt-ready text).
    expect(user).toContain("they asked about invoicing back in March");
    // Research.
    expect(user).toContain("groundworks contractor operating across West Yorkshire");
    expect(user).toContain("double-keying quotes into spreadsheets");
    expect(user).toContain("advertised three site-manager roles last month");
    expect(user).toContain("quoting");
    // Qualification.
    expect(user).toContain("qualified");
    expect(user).toContain("strong fit on company size");

    // Fixed order: memory → research → qualification.
    const iMemory = user.indexOf("shared memory");
    const iResearch = user.indexOf("RESEARCH:");
    const iQual = user.indexOf("QUALIFICATION");
    expect(iMemory).toBeGreaterThan(-1);
    expect(iResearch).toBeGreaterThan(iMemory);
    expect(iQual).toBeGreaterThan(iResearch);
  });

  it("NEVER quotes a score — the qualification/research score VALUES stay out of the prompt", () => {
    const { user } = assembleDraftPrompt("cold_email", fullContext());
    // The fixture's only "82"/"91" are the research + qualification scores. The word
    // "score" does appear (the instruction "never quote a score") — the VALUES must not.
    expect(user).not.toContain("82");
    expect(user).not.toContain("91");
  });

  it("omits absent sources entirely — a sparse context yields a smaller, stable prompt", () => {
    const sparse: DraftContext = {
      subject: { name: null, label: "outreach_email" },
      memory: null,
      research: null,
      qualification: null,
    };
    const { user } = assembleDraftPrompt("cold_email", sparse);
    expect(user).not.toContain("RESEARCH:");
    expect(user).not.toContain("QUALIFICATION");
    expect(user).not.toMatch(/shared memory/i);
    // With no name, it addresses generally rather than inventing one.
    expect(user).toMatch(/name unknown/i);
  });
});

// =====================================================================
// 2. Versioning + checksum — traceability and drift detection.
// =====================================================================

describe("draft prompt versioning — traceable, drift-detectable", () => {
  it("the version key is the stable `${kind}:v${rev}` contract", () => {
    expect(draftPromptVersion("cold_email")).toBe(`cold_email:v${DRAFT_PROMPT_REVISION}`);
    expect(draftPromptVersion("cold_email")).toBe("cold_email:v1");
  });

  it("the checksum is a stable SHA-256 hex of the exact prompt", () => {
    const prompt = assembleDraftPrompt("cold_email", fullContext());
    const once = draftPromptChecksum(prompt);
    const twice = draftPromptChecksum(prompt);
    expect(once).toBe(twice);
    expect(once).toMatch(/^[0-9a-f]{64}$/);
  });

  it("a changed context changes the checksum (drift is detectable)", () => {
    const base = draftPromptChecksum(assembleDraftPrompt("cold_email", fullContext()));
    const moved = fullContext();
    moved.subject.name = "Different Company Ltd";
    const after = draftPromptChecksum(assembleDraftPrompt("cold_email", moved));
    expect(after).not.toBe(base);
  });
});

// =====================================================================
// 3. The deterministic fallback — a real, honest, model-free draft.
// =====================================================================

describe("deterministicDraft — the graceful, reproducible fallback", () => {
  it("is deterministic — same context in → identical draft out", () => {
    const a = deterministicDraft("cold_email", fullContext());
    const b = deterministicDraft("cold_email", fullContext());
    expect(a).toEqual(b);
  });

  it("produces a non-empty email and uses ONLY facts present in the context", () => {
    const draft = deterministicDraft("cold_email", fullContext());
    expect(draft.channel).toBe("email");
    expect(draft.subject.length).toBeGreaterThan(0);
    expect(draft.body.length).toBeGreaterThan(0);
    // It addresses the named recipient and draws on the real sector + pain point.
    expect(draft.subject).toContain("Brackenhill Builders");
    expect(draft.body).toContain("Brackenhill Builders");
    expect(draft.body).toContain("groundworks");
    expect(draft.body).toContain("double-keying quotes into spreadsheets");
    // And on the recommended modules, joined stably.
    expect(draft.body).toContain("quoting and invoicing");
  });

  it("never sends, never links, never automates — it is a DRAFT a human reviews", () => {
    const draft = deterministicDraft("cold_email", fullContext());
    const blob = `${draft.subject}\n${draft.body}`.toLowerCase();
    expect(blob).not.toContain("http");
    expect(blob).not.toContain("click here");
    expect(blob).not.toContain("unsubscribe");
    expect(blob).not.toMatch(/i'?ll (call|phone|ring|email|send)/);
  });

  it("a sparse context still yields an honest draft — it writes around the missing facts", () => {
    const sparse: DraftContext = {
      subject: { name: null, label: "outreach_email" },
      memory: null,
      research: null,
      qualification: null,
    };
    const draft = deterministicDraft("cold_email", sparse);
    expect(draft.channel).toBe("email");
    expect(draft.subject.length).toBeGreaterThan(0);
    expect(draft.body.length).toBeGreaterThan(0);
    // No name → a general greeting, never an invented one.
    expect(draft.body).toMatch(/Hi there/);
    // No sector → the generic "construction", not a fabricated speciality.
    expect(draft.body).toContain("construction");
  });
});
