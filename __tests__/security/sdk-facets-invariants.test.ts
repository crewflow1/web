import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * CrewFlow HQ — Directive #014 Phase A SDK-facet trust-boundary invariants
 * (CEO Directive #014 / D-04, Phase A; ADR 0008; Bible Volume XIII §10/§12/§13).
 *
 * Phase A graduates the SDK envelope and adds two facets — events + comms. These pin
 * the load-bearing properties as a matter of SOURCE, not discipline. Each fact below,
 * and what breaks if it silently flips:
 *
 *   • events stamps actor_type:"ai_employee" + actor_id = identity.slug on EVERY emit,
 *     and EmitInput carries NO actorType/actorId — there is no parameter to emit as a
 *     different actor (XIII §8, the no-spoofing rule). A leaked actor field would let a
 *     handler forge the spine's narrative.
 *   • events is BEST-EFFORT — it binds emitEvent and never throws from its own source;
 *     a throw would let a spine hiccup break the handler's primary work.
 *   • comms re-implements nothing — it binds deliverDraft + the read surfaces, never
 *     reaching for the table builder (no `.from(`); a raw write would bypass the
 *     Approval Engine + the DB trigger that gate every outbound communication.
 *   • comms surfaces a refusal as a THROW (the throw-based ABI) so the Task Engine
 *     records a refused send as a failure rather than swallowing it.
 *   • the envelope module is PURE — output.ts carries no `server-only` and performs no
 *     I/O, so the timeline / Boardroom UI may import the result types (XIII §10).
 *   • the runner wires both facets onto the RunContext and runs the evidence-drain
 *     BEFORE completion — provenance is folded in, not left to handler discipline.
 *
 * Comment text is stripped first, so the prose that DOCUMENTS the contract can neither
 * satisfy a positive match nor trip a negative one.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

/** Strip block + line comments so only executable source is matched. */
function codeOf(ts: string): string {
  return ts
    .replace(/\/\*[\s\S]*?\*\//g, "") // block comments
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1"); // line comments (keep `://` in URLs)
}

const OUTPUT = "server/sdk/output.ts";
const EVENTS = "server/sdk/events.ts";
const COMMS = "server/sdk/comms.ts";
const SDK = "server/sdk/tasks.ts";

// =====================================================================
// 0. The Phase A files exist.
// =====================================================================

describe("Phase A facets — the layer exists", () => {
  it("ships the output envelope, the events facet, and the comms facet", () => {
    expect(existsSync(resolve(ROOT, OUTPUT)), OUTPUT).toBe(true);
    expect(existsSync(resolve(ROOT, EVENTS)), EVENTS).toBe(true);
    expect(existsSync(resolve(ROOT, COMMS)), COMMS).toBe(true);
  });
});

// =====================================================================
// 1. events — stamps the bound actor; no actor parameter to spoof; best-effort.
// =====================================================================

describe("events facet — stamps the bound actor, exposes no actor parameter (no spoofing)", () => {
  const code = codeOf(read(EVENTS));

  it("hardcodes actor_type 'ai_employee' and sources actor_id from identity.slug", () => {
    expect(code).toMatch(/actorType:\s*["'`]ai_employee["'`]/);
    expect(code).toMatch(/actorId\s*=\s*identity\.slug/);
  });

  it("the EmitInput type carries NO actorType / actorId field (nothing to spoof)", () => {
    const m = code.match(/export type EmitInput\s*=\s*\{([\s\S]*?)\n\};/);
    expect(m, "EmitInput type not found").toBeTruthy();
    const body = m![1]!;
    expect(body).not.toMatch(/actorType/);
    expect(body).not.toMatch(/actorId/);
  });

  it("BEST-EFFORT — binds emitEvent and never throws from its own source", () => {
    expect(code).toMatch(/emitEvent\(/);
    expect(code).not.toMatch(/\bthrow\b/);
  });
});

// =====================================================================
// 2. comms — binds the Communication Layer, never the table; throw-based ABI.
// =====================================================================

describe("comms facet — binds the Communication Layer, never the table; throw-based ABI", () => {
  const code = codeOf(read(COMMS));

  it("delivers via deliverDraft and never reaches for the table builder", () => {
    expect(code).toMatch(/deliverDraft\(/);
    expect(code).not.toMatch(/\.from\(/);
  });

  it("surfaces a refused/failed delivery as a THROW (the throw-based ABI)", () => {
    expect(code).toMatch(/throw new Error\(/);
  });

  it("delegates the read surfaces to the service (no re-implementation)", () => {
    expect(code).toMatch(/getCommunication\(/);
    expect(code).toMatch(/listCommunicationsForDraft\(/);
    expect(code).toMatch(/listCommunicationsForSubject\(/);
  });
});

// =====================================================================
// 3. output envelope — pure + I/O-free so the UI can import the result types.
// =====================================================================

describe("output envelope — pure + I/O-free so the UI can import the result types", () => {
  const code = codeOf(read(OUTPUT));

  it("carries NO `server-only` import (it is a pure types + helper module)", () => {
    expect(code).not.toMatch(/server-only/);
  });

  it("reaches for no server module and performs no I/O (no admin client, rpc, or fetch)", () => {
    expect(code).not.toMatch(/createAdminClient/);
    expect(code).not.toMatch(/\brpc\(/);
    expect(code).not.toMatch(/\bfetch\(/);
    expect(code).not.toMatch(/@\/server\//);
  });

  it("exports the evidence-drain the runner folds provenance through", () => {
    expect(code).toMatch(/export function drainEvidenceInto\(/);
  });
});

// =====================================================================
// 4. runner — wires both facets onto the RunContext; drains before completion.
// =====================================================================

describe("runner — wires the facets onto RunContext and drains evidence before completion", () => {
  const code = codeOf(read(SDK));

  it("the RunContext carries the events + comms facets", () => {
    const m = code.match(/export interface RunContext \{([\s\S]*?)\n\}/);
    expect(m, "RunContext interface not found").toBeTruthy();
    const body = m![1]!;
    expect(body).toMatch(/events:\s*BoundEvents/);
    expect(body).toMatch(/comms:\s*BoundComms/);
  });

  it("binds both facets to the employee's slug + the run's correlation", () => {
    expect(code).toMatch(
      /createEvents\(\s*\{\s*slug:\s*identity\.slug\s*\}\s*,\s*task\.correlation_id\s*\)/,
    );
    expect(code).toMatch(
      /createComms\(\s*\{\s*slug:\s*identity\.slug\s*\}\s*,\s*task\.correlation_id\s*\)/,
    );
  });

  it("runs the evidence-drain BEFORE handing the result to completeTask", () => {
    const drain = code.indexOf("drainEvidenceInto(result");
    const complete = code.indexOf("completeTask(task.id, leaseOwner, result");
    expect(drain).toBeGreaterThan(-1);
    expect(complete).toBeGreaterThan(-1);
    expect(drain).toBeLessThan(complete);
  });
});
