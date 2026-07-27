import { describe, it, expect } from "vitest";
import {
  decideMemoryWrite,
  SHARED_WRITE_SCOPE,
  type MemoryClass,
} from "@/lib/memory/model";

/**
 * Shared Memory — §6 AI write-rule contract tests
 * (CrewFlow Bible Volume X §6; CEO Directive 009 Module 1, PR2).
 *
 * Proves the pure write-decision predicate the SQL `hq_memory_write`
 * mirrors as its atomic gate: autonomous for an employee's own lived
 * experience, an approval checkpoint for shared company-brain knowledge
 * (waived only by the `memory.write.shared` capability), and a hard deny
 * for system memory and another employee's private memory.
 */

const alice = { id: "emp-alice" };
const aliceWithScope = { id: "emp-alice", scopes: [SHARED_WRITE_SCOPE] };

describe("decideMemoryWrite — owned lived experience is autonomous", () => {
  it("an employee's own episodic memory is autonomous", () => {
    const d = decideMemoryWrite(
      { memory_class: "episodic", visibility: "private", owner_employee_id: "emp-alice" },
      alice,
    );
    expect(d.outcome).toBe("autonomous");
    expect(d.reason).toBe("owned_experience");
  });

  it("an employee's own working memory is autonomous", () => {
    const d = decideMemoryWrite(
      { memory_class: "working", visibility: "private", owner_employee_id: "emp-alice" },
      alice,
    );
    expect(d.outcome).toBe("autonomous");
  });

  it("an employee's own PRIVATE semantic note is autonomous (private, not the shared brain)", () => {
    const d = decideMemoryWrite(
      { memory_class: "semantic", visibility: "private", owner_employee_id: "emp-alice" },
      alice,
    );
    expect(d.outcome).toBe("autonomous");
    expect(d.reason).toBe("owned_experience");
  });

  it("a department-visible OWNED episode is still autonomous (experience, not durable knowledge)", () => {
    const d = decideMemoryWrite(
      { memory_class: "episodic", visibility: "department", owner_employee_id: "emp-alice" },
      alice,
    );
    expect(d.outcome).toBe("autonomous");
  });
});

describe("decideMemoryWrite — shared company knowledge crosses an approval checkpoint", () => {
  const sharedDurable: ReadonlyArray<[MemoryClass, string]> = [
    ["semantic", "public_hq"],
    ["long_term", "public_hq"],
    ["procedural", "public_hq"],
    ["semantic", "department"],
    ["long_term", "department"],
    ["procedural", "department"],
  ];

  it("every durable+shared combination requires approval without the capability", () => {
    for (const [memory_class, visibility] of sharedDurable) {
      const d = decideMemoryWrite({ memory_class, visibility, owner_employee_id: null }, alice);
      expect(d.outcome).toBe("approval_required");
      expect(d.reason).toBe("shared_knowledge_proposal");
    }
  });

  it("requires approval even when the employee OWNS the proposed public memory", () => {
    const d = decideMemoryWrite(
      { memory_class: "semantic", visibility: "public_hq", owner_employee_id: "emp-alice" },
      alice,
    );
    expect(d.outcome).toBe("approval_required");
  });

  it("the memory.write.shared capability waives the checkpoint", () => {
    for (const [memory_class, visibility] of sharedDurable) {
      const d = decideMemoryWrite(
        { memory_class, visibility, owner_employee_id: null },
        aliceWithScope,
      );
      expect(d.outcome).toBe("autonomous");
      expect(d.reason).toBe("shared_write_capability");
    }
  });

  it("an unrelated scope does NOT waive the checkpoint", () => {
    const d = decideMemoryWrite(
      { memory_class: "semantic", visibility: "public_hq", owner_employee_id: null },
      { id: "emp-alice", scopes: ["read", "memory.read", "quotes.write"] },
    );
    expect(d.outcome).toBe("approval_required");
  });
});

describe("decideMemoryWrite — hard denials (§6)", () => {
  it("system memory is never writable via the AI path", () => {
    const d = decideMemoryWrite(
      { memory_class: "semantic", visibility: "system", owner_employee_id: "emp-alice" },
      aliceWithScope, // not even with the capability
    );
    expect(d.outcome).toBe("denied");
    expect(d.reason).toBe("system_visibility");
  });

  it("an employee may never edit ANOTHER employee's private memory", () => {
    const d = decideMemoryWrite(
      { memory_class: "episodic", visibility: "private", owner_employee_id: "emp-bob" },
      alice,
    );
    expect(d.outcome).toBe("denied");
    expect(d.reason).toBe("foreign_private");
  });

  it("an employee may never edit another employee's RESTRICTED memory", () => {
    const d = decideMemoryWrite(
      { memory_class: "semantic", visibility: "restricted", owner_employee_id: "emp-bob" },
      aliceWithScope,
    );
    expect(d.outcome).toBe("denied");
    expect(d.reason).toBe("foreign_private");
  });

  it("fails closed on an owner-less ephemeral memory (no experience owner)", () => {
    const d = decideMemoryWrite(
      { memory_class: "episodic", visibility: "public_hq", owner_employee_id: null },
      alice,
    );
    expect(d.outcome).toBe("denied");
    expect(d.reason).toBe("not_permitted");
  });

  it("fails closed on a self-owned RESTRICTED memory (not private, not shared-durable)", () => {
    const d = decideMemoryWrite(
      { memory_class: "semantic", visibility: "restricted", owner_employee_id: "emp-alice" },
      alice,
    );
    expect(d.outcome).toBe("denied");
    expect(d.reason).toBe("not_permitted");
  });
});
