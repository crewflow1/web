import { describe, it, expect, vi, beforeEach } from "vitest";
import type { OnboardingSnapshot } from "@/lib/onboarding/checklist";

/**
 * Perf de-dupe: buildRetentionSnapshot() must REUSE a pre-built onboarding
 * snapshot when the caller hands one in, instead of building a fresh one.
 *
 * Why this matters: the owner dashboard already builds the onboarding
 * snapshot for its SetupChecklist card. Retention also needs it. Before this
 * change both code paths built it independently, so every dashboard load ran
 * the onboarding org-row fetch + its 5 count round-trips TWICE. Passing the
 * in-flight promise through collapses that to one execution.
 *
 * The guarantees pinned here:
 *   - given { onboarding } (value OR promise), the internal builder is NOT
 *     called, and the provided snapshot is embedded verbatim in the result;
 *   - given nothing, it falls back to building its own (one call), preserving
 *     the AI-question path's existing behaviour.
 */

const { onboardingSpy, fixtureSnapshot } = vi.hoisted(() => {
  const fixture = {
    org: {
      name: "Acme Builders",
      phone: null,
      email: null,
      vat_number: null,
      logo_url: null,
      bank_details: null,
      default_terms: null,
      address: null,
    },
    counts: {
      staffMembers: 0,
      customers: 0,
      invoices: 0,
      quotes: 0,
      importsCommitted: 0,
    },
    dismissed: new Set(),
    timestamps: { started_at: null, completed_at: null },
  } as OnboardingSnapshot;
  return { onboardingSpy: vi.fn(async () => fixture), fixtureSnapshot: fixture };
});

vi.mock("@/server/services/onboarding-snapshot", () => ({
  buildOnboardingSnapshot: onboardingSpy,
}));

// Minimal chainable Supabase stub. Every query builder method returns the
// same builder; awaiting the builder yields an empty/zero result set, and the
// single-row terminals resolve to null. Retention's reducers tolerate empties
// (everything collapses to 0 / [] / null), so the builder never throws.
function chainable() {
  const awaited = { data: [] as unknown[], count: 0, error: null };
  const builder: Record<string, unknown> = {};
  for (const m of [
    "select",
    "eq",
    "neq",
    "gte",
    "lte",
    "in",
    "not",
    "is",
    "order",
    "limit",
    "range",
  ]) {
    builder[m] = () => builder;
  }
  builder.maybeSingle = async () => ({ data: null, error: null });
  builder.single = async () => ({ data: null, error: null });
  // Make the builder awaitable for the count/data query shapes.
  builder.then = (resolve: (v: typeof awaited) => unknown) => resolve(awaited);
  return builder;
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ from: () => chainable() }),
}));

import { buildRetentionSnapshot } from "@/server/services/retention-snapshot";

beforeEach(() => {
  onboardingSpy.mockClear();
});

describe("buildRetentionSnapshot — onboarding snapshot reuse", () => {
  it("reuses a passed-in snapshot VALUE and never rebuilds it", async () => {
    const res = await buildRetentionSnapshot("org-1", {
      onboarding: fixtureSnapshot,
    });
    expect(onboardingSpy).not.toHaveBeenCalled();
    expect(res.onboarding).toBe(fixtureSnapshot);
    // Sanity: still produces a well-formed signal payload.
    expect(res.windows.last_7d.customers_added).toBe(0);
    expect(typeof res.now).toBe("string");
  });

  it("awaits a passed-in snapshot PROMISE (the dashboard's shared-promise case)", async () => {
    const res = await buildRetentionSnapshot("org-1", {
      onboarding: Promise.resolve(fixtureSnapshot),
    });
    expect(onboardingSpy).not.toHaveBeenCalled();
    expect(res.onboarding).toBe(fixtureSnapshot);
  });

  it("falls back to building its own snapshot exactly once when none is given", async () => {
    const res = await buildRetentionSnapshot("org-1");
    expect(onboardingSpy).toHaveBeenCalledTimes(1);
    expect(onboardingSpy).toHaveBeenCalledWith("org-1");
    expect(res.onboarding).toBe(fixtureSnapshot);
  });
});
