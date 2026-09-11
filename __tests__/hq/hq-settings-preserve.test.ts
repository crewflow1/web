import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * hq_settings — the blob-preservation invariant (2026-09-11).
 *
 * hq_settings is ONE JSONB singleton shared by two owners: the /admin/settings
 * UI (the eight SECTION_IDS) and migration-seeded infra gate flags read by SQL
 * `security definer` functions — `memory_embedding.worker_enabled`,
 * `memory_lifecycle.worker_enabled`, `event_spine` — which are flipped only by
 * service-role SQL, never by the UI.
 *
 * Before this fix, updateSection rebuilt the blob from SECTION_IDS only, so
 * ANY settings save silently DELETED the infra keys, and every fail-dark gate
 * (`coalesce(..., false)`) then read false: an invisible off-switch for the
 * embedding worker, the lifecycle worker and the event-spine consumer, with no
 * error and no audit trail. This suite proves a save now preserves foreign
 * sections byte-for-byte — the hard prerequisite for embeddings activation.
 */

type Row = Record<string, unknown>;

const h = vi.hoisted(() => {
  const state: { blob: Row; activity: Row[] } = { blob: {}, activity: [] };
  const admin = {
    from(name: string) {
      if (name !== "hq_settings") throw new Error(`unexpected table ${name}`);
      return {
        select() {
          return {
            eq() {
              return {
                maybeSingle: () =>
                  Promise.resolve({ data: { data: state.blob }, error: null }),
              };
            },
          };
        },
        upsert(row: { data: Row }) {
          state.blob = row.data;
          return Promise.resolve({ error: null });
        },
      };
    },
  };
  return { state, admin };
});

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => h.admin }));
vi.mock("@/server/services/hq-audit", () => ({
  recordAdminActivity: (row: Record<string, unknown>) => {
    h.state.activity.push(row);
    return Promise.resolve(undefined);
  },
}));

import { updateSection } from "@/server/services/hq-settings";

const ACTOR = { id: "u-hq", email: "hq@crewflow.uk" };

/** The exact infra shape prod carries today (seeded by migrations). */
const INFRA = {
  event_spine: { consumer_enabled: false, note: "seeded" },
  memory_embedding: { worker_enabled: true },
  memory_lifecycle: { worker_enabled: false },
};

beforeEach(() => {
  h.state.blob = { ...INFRA };
  h.state.activity = [];
});

describe("updateSection preserves sections it does not own", () => {
  it("a save keeps every infra gate flag byte-for-byte (the embedding-activation prerequisite)", async () => {
    const res = await updateSection(
      "general",
      { platform_name: "CrewFlow Ltd" },
      ACTOR,
    );
    expect(res.ok).toBe(true);
    expect(h.state.blob.event_spine).toEqual(INFRA.event_spine);
    expect(h.state.blob.memory_embedding).toEqual(INFRA.memory_embedding);
    expect(h.state.blob.memory_lifecycle).toEqual(INFRA.memory_lifecycle);
    // And the edited section landed.
    expect((h.state.blob.general as Row).platform_name).toBe("CrewFlow Ltd");
  });

  it("two consecutive saves of different sections still lose nothing", async () => {
    await updateSection("general", { platform_name: "CrewFlow Ltd" }, ACTOR);
    await updateSection("notifications", { daily_digest_enabled: true }, ACTOR);
    expect(h.state.blob.memory_embedding).toEqual(INFRA.memory_embedding);
    expect(h.state.blob.event_spine).toEqual(INFRA.event_spine);
    expect((h.state.blob.general as Row).platform_name).toBe("CrewFlow Ltd");
  });

  it("a failed settings read refuses the save rather than writing a rebuilt blob", async () => {
    const failingAdmin = {
      from() {
        return {
          select() {
            return {
              eq() {
                return {
                  maybeSingle: () =>
                    Promise.resolve({ data: null, error: { message: "down" } }),
                };
              },
            };
          },
          upsert() {
            throw new Error("must not write when the read failed");
          },
        };
      },
    };
    const spy = vi
      .spyOn(h.admin, "from")
      .mockImplementation(failingAdmin.from as never);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const res = await updateSection("general", { platform_name: "X" }, ACTOR);
    expect(res.ok).toBe(false);
    spy.mockRestore();
  });
});
