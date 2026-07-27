import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  deriveIdempotencyKey,
  applyOnce,
  createInMemoryApplicationStore,
  type ExecutionIdentity,
} from "@/server/sdk/application";
import { type ExecutionOutcome } from "@/server/sdk/executor";

/**
 * CrewFlow HQ — apply-on-approval marker trust-boundary invariants
 * (CEO Directive #014 / D-04, Phase C, increment C3; ADR 0009 Decisions 4, 5, 6, 9, 10; the Executor
 * Idempotency Rule + the Executor Boundary Rule).
 *
 * The marker (server/sdk/application.ts) records that a cleared action was applied — beside the
 * Approval Engine, never inside it — and guarantees it is applied at most once. By canon it must NOT
 * reopen the Approval Engine state machine (no sixth state, no approval transition), must NOT touch the
 * Task Engine or any client/facet, and must derive its idempotency key DETERMINISTICALLY (no clock, no
 * randomness — the "never rely on 'probably once'" rule). C3 proves this as a matter of SOURCE, not
 * discipline, exactly as the doorman's purity, the registry's, and the executor's are proven by source.
 *
 * Each fact below, and what breaks if it silently flips:
 *   • The module imports ONLY its sibling pure contract `./executor` (and only its `ExecutionOutcome`
 *     TYPE) — no Approval Engine (`hq-approvals`, `lib/approvals/state`), no Task Engine (`./tasks`,
 *     `hq-tasks`), no admin/service client, no facet, and no `server-only`. A single such import would
 *     let the marker reach AROUND its injected store/boundary for a side effect (and break
 *     UI-importability).
 *   • The executable source reopens NO approval state machine — it names no `ApprovalState` /
 *     `APPROVAL_STATES` and makes no approval transition (`approveApproval` / `requestApproval`): the
 *     "applied" marker is a SEPARATE record, not a sixth approval state (Decision 5).
 *   • The executable source names no execution construct (`.rpc(`/`.from(`/`fetch(`/a client factory)
 *     and no task-lifecycle call (`failTask`/`checkpointTask`/`hq_ai_task_*`): persistence is the
 *     injected store, the boundary is the injected `apply`, and lifecycle stays with the runner.
 *   • The key derivation is DETERMINISTIC: the source contains no `Math.random`, no `crypto` /
 *     `randomUUID`, and no clock (`Date.now` / `new Date`). A single one would make the key
 *     "probably once", violating the Executor Idempotency Rule.
 *   • The in-memory store exposes only get/put — no approve/transition member.
 *   • Behaviourally: the key is a pure function of identity (deterministic), and `applyOnce` crosses
 *     the injected boundary at most once per key (an already-applied key is a no-op success).
 *
 * Comment text is stripped first, so the prose that DOCUMENTS the contract (which names "approval",
 * "Task Engine", "hq_approvals", etc. to explain what the module does NOT do) can neither satisfy a
 * positive match nor trip a negative one.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

/** Strip block + line comments so only executable source is matched. */
function codeOf(ts: string): string {
  return ts
    .replace(/\/\*[\s\S]*?\*\//g, "") // block comments
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1"); // line comments (keep `://` in URLs)
}

/** Every module specifier the source imports — `from "x"` and bare `import "x"`. */
function importSpecifiers(code: string): string[] {
  const specs: string[] = [];
  const fromRe = /\bfrom\s*["']([^"']+)["']/g;
  const bareRe = /\bimport\s+["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = fromRe.exec(code))) {
    if (m[1]) specs.push(m[1]);
  }
  while ((m = bareRe.exec(code))) {
    if (m[1]) specs.push(m[1]);
  }
  return specs;
}

const APPLICATION = "server/sdk/application.ts";
const ALLOWED_IMPORTS = ["./executor"];

// =====================================================================
// 0. The C3 contract file exists.
// =====================================================================

describe("application marker — the contract exists", () => {
  it("ships server/sdk/application.ts", () => {
    expect(existsSync(resolve(ROOT, APPLICATION)), APPLICATION).toBe(true);
  });
});

// =====================================================================
// 1. It imports only the sibling pure contract — no engine/client/facet.
// =====================================================================

describe("application marker — imports consume the contract, they do not reach", () => {
  const code = codeOf(read(APPLICATION));

  it("imports nothing but ./executor", () => {
    const specs = importSpecifiers(code);
    expect(specs.length).toBeGreaterThan(0);
    for (const spec of specs) {
      expect(ALLOWED_IMPORTS, `unexpected import: ${spec}`).toContain(spec);
    }
  });

  it("does not import server-only — the UI may import the contract (the output.ts discipline)", () => {
    expect(code).not.toContain("server-only");
  });

  it("reaches for no Approval Engine, Task Engine, client, or facet module", () => {
    for (const forbidden of [
      "lib/approvals", // the Approval Engine state machine — NOT reopened (Decision 5)
      "hq-approvals",
      "./tasks", // the runner / Task Engine — no runner wiring in C3
      "hq-tasks",
      "supabase",
      "/facets",
      "admin",
    ]) {
      expect(code, `must not import ${forbidden}`).not.toContain(forbidden);
    }
  });
});

// =====================================================================
// 2. It reopens no approval state machine — the marker is a SEPARATE record.
// =====================================================================

describe("application marker — a separate record, not a sixth approval state (Decision 5)", () => {
  const code = codeOf(read(APPLICATION));

  it("names no approval state vocabulary and makes no approval transition", () => {
    for (const forbidden of [
      "ApprovalState", // the five-state type — not referenced
      "APPROVAL_STATES",
      "approveApproval", // the grant transition — the marker does not decide approvals
      "requestApproval", // the request transition — the marker does not queue them
      "escalateApproval",
    ]) {
      expect(code, `must not contain ${forbidden}`).not.toContain(forbidden);
    }
  });
});

// =====================================================================
// 3. The source names no execution or task-lifecycle construct of its own.
// =====================================================================

describe("application marker — persists through the injected store, applies through the injected boundary", () => {
  const code = codeOf(read(APPLICATION));

  it("contains no execution construct of its own (persistence is the injected store)", () => {
    for (const forbidden of [
      ".rpc(", // a SECURITY DEFINER call
      ".from(", // a table read/write — the real store lives behind the seam
      "fetch(", // an external call (Phase D's gateway, not here)
      "createClient",
      "createServiceClient",
      "supabaseAdmin",
    ]) {
      expect(code, `must not contain ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("makes no task-lifecycle call — lifecycle stays with the runner (runner rule 3)", () => {
    for (const forbidden of ["failTask", "completeTask", "checkpointTask", "hq_ai_task_complete", "hq_ai_task_fail"]) {
      expect(code, `must not contain ${forbidden}`).not.toContain(forbidden);
    }
  });
});

// =====================================================================
// 4. The idempotency key is DETERMINISTIC — the Executor Idempotency Rule.
// =====================================================================

describe("application marker — the key is deterministic, never 'probably once'", () => {
  const code = codeOf(read(APPLICATION));

  it("derives the key from no clock and no randomness", () => {
    for (const forbidden of [
      "Math.random",
      "randomUUID",
      "crypto", // any randomness/hash source
      "Date.now",
      "new Date",
      "Date(",
    ]) {
      expect(code, `must not contain ${forbidden}`).not.toContain(forbidden);
    }
  });
});

// =====================================================================
// 5. The in-memory store exposes only get/put.
// =====================================================================

describe("application marker — the store reads and writes, it does not decide", () => {
  it("exposes only get/put members", () => {
    const store = createInMemoryApplicationStore();
    const keys = Object.keys(store).sort();
    expect(keys).toEqual(["get", "put"]);
    for (const forbidden of ["approve", "transition", "decide", "request", "escalate"]) {
      expect(keys).not.toContain(forbidden);
    }
  });
});

// =====================================================================
// 6. Behaviour — deterministic key; the boundary is crossed at most once.
// =====================================================================

const ID: ExecutionIdentity = {
  source: "autonomous",
  correlationId: "corr_1",
  taskId: "task_1",
  toolLabel: "memory.write",
  actionId: "act_1",
};

function countingApply(): { apply: () => Promise<ExecutionOutcome>; count: () => number } {
  let n = 0;
  const apply = async (): Promise<ExecutionOutcome> => {
    n += 1;
    return { status: "applied", label: "memory.write", result: { ok: true } };
  };
  return { apply, count: () => n };
}

describe("application marker — deterministic key, apply at most once", () => {
  it("the key is a pure function of identity — same in, same out", () => {
    expect(deriveIdempotencyKey(ID)).toBe(deriveIdempotencyKey(ID));
  });

  it("applyOnce crosses the injected boundary at most once per key", async () => {
    const store = createInMemoryApplicationStore();
    const boundary = countingApply();
    const first = await applyOnce({ store, identity: ID, apply: boundary.apply });
    expect(first.status).toBe("applied");
    const second = await applyOnce({ store, identity: ID, apply: boundary.apply });
    expect(second.status).toBe("already_applied");
    expect(boundary.count()).toBe(1); // the boundary was crossed exactly once
  });

  it("records are frozen — a recorded application is immutable", async () => {
    const store = createInMemoryApplicationStore();
    const r = await applyOnce({ store, identity: ID, apply: countingApply().apply });
    expect(Object.isFrozen(r.record)).toBe(true);
  });
});
