import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * AI-assisted saga decomposition — the WIRING proofs (P15 activation, 2026-09-10).
 *
 * Before this wiring, maybeDecomposeWithAi was a zero-caller dark seam: fully
 * governed, never reachable. This suite proves the seam is now consulted through
 * the canonical createSaga path — and ONLY behind the explicit sentinel — with
 * every safety property intact:
 *
 *   • the sentinel (AI_ASSISTED_TEMPLATE_KEY) routes createSaga through the seam,
 *     persisting the proposed plan with the sentinel as provenance and the audit
 *     row stamped decomposition:"ai_assisted";
 *   • a refusing seam (dark tier / ceiling / invalid proposal → null) FAILS the
 *     create with the honest "ai_decomposition_unavailable" error — nothing is
 *     persisted, no template is silently substituted;
 *   • the deterministic template path is byte-for-byte unchanged and NEVER
 *     consults the seam;
 *   • the super-admin gate runs BEFORE the seam — a forbidden actor can never
 *     cause AI spend;
 *   • the picker offers the sentinel and the action layer maps the new error.
 */

type Row = Record<string, unknown>;

const h = vi.hoisted(() => {
  const state: { sagas: Row[]; steps: Row[]; activity: Row[] } = {
    sagas: [],
    steps: [],
    activity: [],
  };
  let seq = 0;

  function makeQuery(rows: Row[]) {
    const q = {
      _inserted: [] as Row[],
      _eq: [] as Array<[string, unknown]>,
      insert(payload: Row | Row[]) {
        const items = Array.isArray(payload) ? payload : [payload];
        for (const item of items) {
          seq += 1;
          const row = { id: `row-${seq}`, ...item };
          rows.push(row);
          q._inserted.push(row);
        }
        return q;
      },
      select() {
        return q;
      },
      eq(col: string, val: unknown) {
        q._eq.push([col, val]);
        return q;
      },
      order() {
        return q;
      },
      _run(): Row[] {
        if (q._inserted.length > 0) return q._inserted.map((r) => ({ ...r }));
        return rows
          .filter((r) => q._eq.every(([c, v]) => r[c] === v))
          .map((r) => ({ ...r }));
      },
      maybeSingle() {
        return Promise.resolve({ data: q._run()[0] ?? null, error: null });
      },
      then<T>(onF: (v: { data: Row[]; error: null }) => T) {
        return Promise.resolve({ data: q._run(), error: null as null }).then(onF);
      },
    };
    return q;
  }

  const admin = {
    from(name: string) {
      if (name === "hq_workflow_sagas") return makeQuery(state.sagas);
      if (name === "hq_saga_steps") return makeQuery(state.steps);
      throw new Error(`unexpected table ${name}`);
    },
  };

  const maybeDecomposeWithAi = vi.fn();

  return { state, admin, maybeDecomposeWithAi };
});

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => h.admin }));
vi.mock("@/server/services/hq-audit", () => ({
  recordAdminActivity: (row: Record<string, unknown>) => {
    h.state.activity.push(row);
    return Promise.resolve(undefined);
  },
}));
vi.mock("@/server/auth/superadmin", () => ({
  isSuperAdminEmail: (email: string | null) => email === "hq@crewflow.uk",
}));
vi.mock("@/lib/hq/workflow/ai-decompose", () => ({
  maybeDecomposeWithAi: (input: { directive: string }) => h.maybeDecomposeWithAi(input),
}));

import { createSaga, SAGA_TEMPLATES } from "@/server/services/hq-workflow";
import { AI_ASSISTED_TEMPLATE_KEY } from "@/lib/hq/workflow/decompose";

const HQ = { id: "u-hq", email: "hq@crewflow.uk" };
const OUTSIDER = { id: "u-out", email: "someone@example.com" };

/** A minimal valid SagaPlan as the seam contract returns it (templateKey ""). */
function aiPlan() {
  return {
    title: "Ship the winter reliability push",
    templateKey: "",
    status: "planned" as const,
    steps: [
      {
        ordinal: 1,
        title: "Scope the failure classes",
        department: "Research",
        role: "researcher",
        dependsOnOrdinal: null,
        status: "pending" as const,
      },
      {
        ordinal: 2,
        title: "Harden the top three",
        department: "Engineering",
        role: "engineer",
        dependsOnOrdinal: 1,
        status: "pending" as const,
      },
    ],
  };
}

beforeEach(() => {
  h.state.sagas = [];
  h.state.steps = [];
  h.state.activity = [];
  h.maybeDecomposeWithAi.mockReset();
});

describe("createSaga — the AI-assisted sentinel path", () => {
  it("routes the sentinel through the seam and persists the proposal with AI provenance", async () => {
    h.maybeDecomposeWithAi.mockResolvedValue({ plan: aiPlan(), reason: null });

    const res = await createSaga({
      creator: HQ,
      title: "Ship the winter reliability push",
      templateKey: AI_ASSISTED_TEMPLATE_KEY,
    });

    expect(h.maybeDecomposeWithAi).toHaveBeenCalledWith({
      directive: "Ship the winter reliability push",
    });
    expect(res.ok).toBe(true);
    // Provenance: the persisted saga carries the sentinel, not "" and not a template.
    expect(h.state.sagas).toHaveLength(1);
    expect(h.state.sagas[0]!.template_key).toBe(AI_ASSISTED_TEMPLATE_KEY);
    expect(h.state.steps).toHaveLength(2);
    expect(h.state.steps.map((s) => s.ordinal)).toEqual([1, 2]);
    // Audit row is stamped as AI-assisted.
    expect(h.state.activity).toHaveLength(1);
    const meta = h.state.activity[0]!.metadata as Record<string, unknown>;
    expect(meta.decomposition).toBe("ai_assisted");
    expect(meta.template_key).toBe(AI_ASSISTED_TEMPLATE_KEY);
  });

  it("a refusing seam FAILS the create honestly WITH the stage reason — nothing persisted, no silent template", async () => {
    h.maybeDecomposeWithAi.mockResolvedValue({ plan: null, reason: "budget_refused" });

    const res = await createSaga({
      creator: HQ,
      title: "Anything novel",
      templateKey: AI_ASSISTED_TEMPLATE_KEY,
    });

    expect(res).toEqual({ ok: false, error: "ai_decomposition_unavailable:budget_refused" });
    expect(h.state.sagas).toHaveLength(0);
    expect(h.state.steps).toHaveLength(0);
    expect(h.state.activity).toHaveLength(0);
  });

  it("the super-admin gate runs BEFORE the seam — a forbidden actor causes no AI consult", async () => {
    const res = await createSaga({
      creator: OUTSIDER,
      title: "Anything",
      templateKey: AI_ASSISTED_TEMPLATE_KEY,
    });

    expect(res).toEqual({ ok: false, error: "forbidden" });
    expect(h.maybeDecomposeWithAi).not.toHaveBeenCalled();
  });
});

describe("createSaga — the deterministic path is unchanged", () => {
  it("a real template decomposes deterministically and NEVER consults the seam", async () => {
    const template = SAGA_TEMPLATES[0]!;
    const res = await createSaga({
      creator: HQ,
      title: "Launch the invoicing revamp",
      templateKey: template.key,
    });

    expect(h.maybeDecomposeWithAi).not.toHaveBeenCalled();
    expect(res.ok).toBe(true);
    expect(h.state.sagas[0]!.template_key).toBe(template.key);
    expect(h.state.steps).toHaveLength(template.steps.length);
    const meta = h.state.activity[0]!.metadata as Record<string, unknown>;
    expect(meta.decomposition).toBe("template");
  });

  it("an unknown template still fails with the deterministic error (no AI fallback)", async () => {
    const res = await createSaga({
      creator: HQ,
      title: "Anything",
      templateKey: "no-such-template",
    });
    expect(res).toEqual({ ok: false, error: "unknown_template" });
    expect(h.maybeDecomposeWithAi).not.toHaveBeenCalled();
  });
});

describe("the surface offers — and honestly describes — the AI path", () => {
  const ROOT = resolve(__dirname, "..", "..");
  const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

  it("the sentinel is NOT a member of SAGA_TEMPLATES (it is a routing key, not a template)", () => {
    expect(SAGA_TEMPLATES.some((t) => t.key === AI_ASSISTED_TEMPLATE_KEY)).toBe(false);
  });

  it("the picker offers the sentinel option", () => {
    const page = read("app/admin/workflow-sagas/page.tsx");
    expect(page).toMatch(/AI_ASSISTED_TEMPLATE_KEY/);
    expect(page).toMatch(/AI-assisted/);
  });

  it("the action layer maps EVERY failure stage to its own operator message (no blending)", () => {
    const actions = read("app/admin/workflow-sagas/actions.ts");
    expect(actions).toMatch(/ai_decomposition_unavailable/);
    for (const reason of [
      "model_dark",
      "attribution_missing",
      "budget_refused",
      "duplicate_suppressed",
      "provider_failure",
      "provider_invalid_response",
      "parse_failure",
      "plan_validation_failure",
    ]) {
      expect(actions, `describeAiDecompositionFailure must map ${reason}`).toMatch(
        new RegExp(`case "${reason}":`),
      );
    }
    expect(actions).toMatch(/No saga was created/);
  });
});
