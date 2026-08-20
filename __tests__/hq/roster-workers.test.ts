import { describe, it, expect } from "vitest";
import {
  summariseSecurityPosture,
  summariseDeployHealth,
  summariseDataIntegrity,
  summariseApiContract,
  summariseDocDrift,
  summariseOnboarding,
  summariseWorkforce,
  summariseCompliance,
  summariseDesignConsistency,
  summariseOrchestration,
  summariseWorkflow,
  summariseMemoryCuration,
} from "@/lib/hq/roster-workers";

/**
 * CrewFlow HQ — Roster-worker derivations (HQ roster completion), unit contract.
 *
 * These pure derivations are the whole of each deterministic worker's business logic. The
 * two first principles are pinned here: HONEST "insufficient" over thin data, and a
 * fully-determined, sourced, explainable result over real data with a human-approval floor.
 * `now` is injected so every assertion is deterministic.
 */

const NOW = new Date("2026-08-20T12:00:00.000Z");
const iso = (msFromNow: number) => new Date(NOW.getTime() + msFromNow).toISOString();
const DAYS = 24 * 60 * 60 * 1000;

describe("summariseSecurityPosture", () => {
  it("is insufficient with no grants", () => {
    const r = summariseSecurityPosture([], [], NOW);
    expect(r.insufficient).toBe(true);
    expect(r.confidence).toBe(0);
    expect(r.approvalRequired).toBe(true);
  });
  it("reports the deny floor holding as ok over real grants", () => {
    const r = summariseSecurityPosture(
      [{ scope_level: "employee", scope_key: "hr-ai", can_execute: false, requires_approval: true }],
      [],
      NOW,
    );
    expect(r.severity).toBe("ok");
    expect(r.confidence).toBe(1);
    expect(r.signals.executeEnabled).toBe(0);
  });
  it("flags an execute-enabled grant as critical", () => {
    const r = summariseSecurityPosture(
      [{ scope_level: "employee", scope_key: "x", can_execute: true, requires_approval: true }],
      [],
      NOW,
    );
    expect(r.severity).toBe("critical");
    expect(r.signals.executeEnabled).toBe(1);
  });
  it("flags approval-waived / apply activity as a warning", () => {
    const r = summariseSecurityPosture(
      [{ scope_level: "employee", scope_key: "x", can_execute: false, requires_approval: false }],
      [{ stage: "applied" }],
      NOW,
    );
    expect(r.severity).toBe("warning");
    expect(r.signals.approvalWaived).toBe(1);
    expect(r.signals.applyActivity).toBe(1);
  });
});

describe("summariseDeployHealth", () => {
  it("is insufficient with no runs", () => {
    expect(summariseDeployHealth([], [], NOW).insufficient).toBe(true);
  });
  it("reports healthy over passing runs", () => {
    const r = summariseDeployHealth([{ route: "spine-drain", ok: true }], [{ outcome: "fired" }], NOW);
    expect(r.severity).toBe("ok");
  });
  it("warns on a failed cron and dedupes the route", () => {
    const r = summariseDeployHealth(
      [{ route: "weather-fetch", ok: false }, { route: "weather-fetch", ok: false }],
      [],
      NOW,
    );
    expect(r.severity).toBe("warning");
    expect(r.signals.failedCronRuns).toBe(2);
    expect(r.signals.failedRoutes).toEqual(["weather-fetch"]);
  });
  it("escalates a failed schedule run to critical", () => {
    const r = summariseDeployHealth([{ route: "x", ok: true }], [{ outcome: "failed" }], NOW);
    expect(r.severity).toBe("critical");
    expect(r.signals.failedScheduleRuns).toBe(1);
  });
});

describe("summariseDataIntegrity", () => {
  it("is insufficient with nothing to observe", () => {
    expect(summariseDataIntegrity([], [], NOW).insufficient).toBe(true);
  });
  it("reports clear over consumers with no backlog", () => {
    const r = summariseDataIntegrity([], [{ consumer: "spine" }], NOW);
    expect(r.severity).toBe("ok");
  });
  it("warns on a retry backlog and escalates high-attempt to critical", () => {
    const warn = summariseDataIntegrity([{ consumer: "a", attempts: 2 }], [{ consumer: "a" }], NOW);
    expect(warn.severity).toBe("warning");
    const crit = summariseDataIntegrity([{ consumer: "a", attempts: 5 }], [{ consumer: "a" }], NOW);
    expect(crit.severity).toBe("critical");
    expect(crit.signals.highAttemptEvents).toBe(1);
    expect(crit.signals.affectedConsumers).toEqual(["a"]);
  });
});

describe("summariseApiContract", () => {
  it("is insufficient with no tokens or catalogue", () => {
    expect(summariseApiContract([], [], NOW).insufficient).toBe(true);
  });
  it("is ok when every granted token resolves", () => {
    const r = summariseApiContract(["read", "draft"], ["read", "draft", "memory"], NOW);
    expect(r.severity).toBe("ok");
    expect(r.signals.grantedTokens).toBe(2);
  });
  it("flags a granted token absent from the catalogue as critical", () => {
    const r = summariseApiContract(["read", "ghost"], ["read"], NOW);
    expect(r.severity).toBe("critical");
    expect(r.signals.unknownTokens).toEqual(["ghost"]);
  });
});

describe("summariseDocDrift", () => {
  it("is insufficient with nothing to check", () => {
    expect(summariseDocDrift([], [], NOW).insufficient).toBe(true);
  });
  it("is ok when everything is documented", () => {
    const r = summariseDocDrift(
      [{ slug: "a", role: "R", description: "D" }],
      [{ token: "read", description: "reads" }],
      NOW,
    );
    expect(r.severity).toBe("ok");
  });
  it("flags blank descriptions on employees and tokens", () => {
    const r = summariseDocDrift(
      [{ slug: "a", role: "R", description: "  " }],
      [{ token: "read", description: null }],
      NOW,
    );
    expect(r.severity).toBe("warning");
    expect(r.signals.undocumentedEmployees).toEqual(["a"]);
    expect(r.signals.undocumentedTokens).toEqual(["read"]);
  });
});

describe("summariseOnboarding", () => {
  it("is insufficient with no active orgs", () => {
    const r = summariseOnboarding([{ status: "cancelled", onboarding_state: null, onboarding_percent: 0 }], NOW);
    expect(r.insufficient).toBe(true);
  });
  it("is ok when all active orgs are fully onboarded", () => {
    const r = summariseOnboarding(
      [{ status: "active", onboarding_state: "complete", onboarding_percent: 100 }],
      NOW,
    );
    expect(r.severity).toBe("ok");
    expect(r.signals.fullyOnboarded).toBe(1);
  });
  it("warns on stalled activation and excludes inactive orgs", () => {
    const r = summariseOnboarding(
      [
        { status: "active", onboarding_state: "in_progress", onboarding_percent: 40 },
        { status: "active", onboarding_state: "not_started", onboarding_percent: 0 },
        { status: "suspended", onboarding_state: "not_started", onboarding_percent: 0 },
      ],
      NOW,
    );
    expect(r.severity).toBe("warning");
    expect(r.signals.activeOrgs).toBe(2);
    expect(r.signals.inProgress).toBe(1);
    expect(r.signals.notStarted).toBe(1);
  });
});

describe("summariseWorkforce", () => {
  it("is insufficient with no employees", () => {
    expect(summariseWorkforce([], [], NOW).insufficient).toBe(true);
  });
  it("is ok when every employee carries a grant", () => {
    const r = summariseWorkforce(
      [{ slug: "a", department: "engineering", status: "idle" }],
      ["a"],
      NOW,
    );
    expect(r.severity).toBe("ok");
    expect(r.signals.byDepartment).toEqual([{ department: "engineering", count: 1 }]);
  });
  it("flags an ungranted employee as a critical backfill gap", () => {
    const r = summariseWorkforce(
      [{ slug: "a", department: "engineering", status: "idle" }],
      [],
      NOW,
    );
    expect(r.severity).toBe("critical");
    expect(r.signals.ungranted).toEqual(["a"]);
  });
});

describe("summariseCompliance", () => {
  it("is insufficient with nothing to review", () => {
    expect(summariseCompliance([], [], NOW).insufficient).toBe(true);
  });
  it("warns on pending obligations", () => {
    const r = summariseCompliance(
      [{ state: "pending", expires_at: iso(1 * DAYS) }],
      [{ status: "open", delay_until: null }],
      NOW,
    );
    expect(r.severity).toBe("warning");
    expect(r.signals.pendingApprovals).toBe(1);
    expect(r.signals.openDecisions).toBe(1);
  });
  it("escalates an expired approval or overdue decision to critical", () => {
    const r = summariseCompliance(
      [{ state: "pending", expires_at: iso(-1 * DAYS) }],
      [{ status: "delayed", delay_until: iso(-1 * DAYS) }],
      NOW,
    );
    expect(r.severity).toBe("critical");
    expect(r.signals.expiredApprovals).toBe(1);
    expect(r.signals.overdueDecisions).toBe(1);
  });
});

describe("summariseDesignConsistency", () => {
  it("is insufficient with no employees", () => {
    expect(summariseDesignConsistency([], NOW).insufficient).toBe(true);
  });
  it("is ok when every employee has a brand token", () => {
    const r = summariseDesignConsistency(
      [{ slug: "a", icon: "shield", accent: "red" }],
      NOW,
    );
    expect(r.severity).toBe("ok");
    expect(r.signals.distinctAccents).toBe(1);
  });
  it("warns on a missing icon or accent", () => {
    const r = summariseDesignConsistency([{ slug: "a", icon: null, accent: "" }], NOW);
    expect(r.severity).toBe("warning");
    expect(r.signals.missingIcon).toEqual(["a"]);
    expect(r.signals.missingAccent).toEqual(["a"]);
  });
});

describe("summariseOrchestration", () => {
  it("is insufficient with no tasks", () => {
    expect(summariseOrchestration([], NOW).insufficient).toBe(true);
  });
  it("is ok when open tasks are all assigned", () => {
    const r = summariseOrchestration(
      [{ status: "running", task_type: "x", assigned_employee_id: "e1" }],
      NOW,
    );
    expect(r.severity).toBe("ok");
    expect(r.signals.open).toBe(1);
    expect(r.signals.byType).toEqual([{ type: "x", count: 1 }]);
  });
  it("warns on unassigned open work and ignores terminal tasks", () => {
    const r = summariseOrchestration(
      [
        { status: "pending", task_type: "x", assigned_employee_id: null },
        { status: "completed", task_type: "y", assigned_employee_id: null },
      ],
      NOW,
    );
    expect(r.severity).toBe("warning");
    expect(r.signals.open).toBe(1);
    expect(r.signals.unassignedOpen).toBe(1);
  });
});

describe("summariseWorkflow", () => {
  it("is insufficient with no sagas", () => {
    expect(summariseWorkflow([], [], NOW).insufficient).toBe(true);
  });
  it("is ok when active sagas sequence cleanly", () => {
    const r = summariseWorkflow(
      [{ id: "s1", status: "active" }],
      [{ saga_id: "s1", status: "completed" }],
      NOW,
    );
    expect(r.severity).toBe("ok");
    expect(r.signals.activeSagas).toBe(1);
  });
  it("warns on pending steps and escalates a failed step to critical", () => {
    const warn = summariseWorkflow(
      [{ id: "s1", status: "running" }],
      [{ saga_id: "s1", status: "pending" }],
      NOW,
    );
    expect(warn.severity).toBe("warning");
    const crit = summariseWorkflow(
      [{ id: "s1", status: "running" }],
      [{ saga_id: "s1", status: "failed" }],
      NOW,
    );
    expect(crit.severity).toBe("critical");
    expect(crit.signals.failedSteps).toBe(1);
  });
  it("ignores steps of inactive sagas", () => {
    const r = summariseWorkflow(
      [{ id: "s1", status: "completed" }],
      [{ saga_id: "s1", status: "failed" }],
      NOW,
    );
    expect(r.signals.stepsInActive).toBe(0);
    expect(r.severity).toBe("ok");
  });
});

describe("summariseMemoryCuration", () => {
  it("is insufficient with no memories", () => {
    expect(summariseMemoryCuration([], [], NOW).insufficient).toBe(true);
  });
  it("is ok when nothing needs curation", () => {
    const r = summariseMemoryCuration(
      [{ status: "active", expires_at: null, last_accessed_at: iso(-1 * DAYS), consolidated_into: null, pinned: false }],
      [],
      NOW,
    );
    expect(r.severity).toBe("ok");
  });
  it("flags expired, superseded and stale memories, excluding pinned", () => {
    const r = summariseMemoryCuration(
      [
        { status: "active", expires_at: iso(-1 * DAYS), last_accessed_at: null, consolidated_into: null, pinned: false },
        { status: "active", expires_at: null, last_accessed_at: null, consolidated_into: "m2", pinned: false },
        { status: "active", expires_at: null, last_accessed_at: iso(-100 * DAYS), consolidated_into: null, pinned: false },
        { status: "active", expires_at: iso(-1 * DAYS), last_accessed_at: iso(-100 * DAYS), consolidated_into: "m2", pinned: true },
      ],
      [{ memory_id: "m1" }],
      NOW,
    );
    expect(r.severity).toBe("warning");
    expect(r.signals.expired).toBe(1);
    expect(r.signals.superseded).toBe(1);
    expect(r.signals.stale).toBe(1);
    expect(r.signals.versions).toBe(1);
  });
});
