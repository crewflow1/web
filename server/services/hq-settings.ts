import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  DEFAULT_SETTINGS,
  SECTION_SCHEMAS,
  diffSection,
  mergeSettings,
  type HqSettings,
  type SectionId,
} from "@/lib/hq/settings";
import { recordAdminActivity } from "@/server/services/hq-audit";

/**
 * Phase 4 — HQ settings service.
 *
 *   getSettings()  → fully-populated HqSettings (defaults merged in)
 *   updateSection(...) → validate + UPSERT a single section, audit
 *
 * Service-role only. Callers must already have confirmed
 * isSuperAdminEmail (the page layout + the action wrapper both
 * enforce this — defence in depth).
 */

// Loose adapter — generated Supabase types don't yet include
// hq_settings, so cast past the typed client.
type SelectResult = {
  data: unknown | null;
  error: { message: string } | null;
};

function adminTable(name: string) {
  const admin = createAdminClient();
  return admin.from(name as never) as unknown as {
    select: (cols: string) => {
      eq: (k: string, v: unknown) => {
        maybeSingle: () => Promise<SelectResult>;
      };
    };
    upsert: (
      payload: unknown,
      opts?: { onConflict?: string },
    ) => Promise<{ error: { message: string } | null }>;
  };
}

// ---------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------

export async function getSettings(): Promise<HqSettings> {
  const res = await adminTable("hq_settings")
    .select("data")
    .eq("id", "singleton")
    .maybeSingle();
  if (res.error) {
    console.error("[hq-settings] read failed", res.error.message);
    return DEFAULT_SETTINGS;
  }
  const raw = (res.data as { data?: unknown } | null)?.data ?? null;
  return mergeSettings(raw);
}

// ---------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------

export type UpdateActor = {
  id: string;
  email: string;
};

export type UpdateResult =
  | { ok: true; changedKeys: string[] }
  | { ok: false; error: string };

/**
 * Validate `patch` against the section schema, merge into the
 * existing blob, UPSERT, and write an audit-log row with the diff.
 *
 * Returns the list of keys that actually changed — useful for the
 * page to render a "Saved (3 fields)" toast.
 */
export async function updateSection<S extends SectionId>(
  section: S,
  patch: Record<string, unknown>,
  actor: UpdateActor,
): Promise<UpdateResult> {
  const schema = SECTION_SCHEMAS[section];

  // 1. Read current so we can compute the diff + merge. The RAW blob is read
  //    alongside the normalised view: hq_settings is one JSONB singleton that
  //    ALSO carries sections this module does not own — the infra flags read
  //    by SQL gate functions (memory_embedding.worker_enabled,
  //    memory_lifecycle.worker_enabled, event_spine), which are seeded by
  //    migrations and flipped by service-role SQL, never by this UI. Before
  //    2026-09-11 the upsert below rebuilt the blob from SECTION_IDS only, so
  //    ANY settings save silently deleted those keys and every fail-dark gate
  //    read `false` — an invisible off-switch for the embedding/lifecycle
  //    workers and the event-spine consumer. The raw blob is now the upsert
  //    base, so keys outside SECTION_IDS survive every save byte-for-byte.
  const rawRes = await adminTable("hq_settings")
    .select("data")
    .eq("id", "singleton")
    .maybeSingle();
  if (rawRes.error) {
    console.error("[hq-settings] read failed", rawRes.error.message);
    return { ok: false, error: "Could not load current settings — try again." };
  }
  const rawBlob = ((rawRes.data as { data?: unknown } | null)?.data ?? {}) as Record<
    string,
    unknown
  >;
  const before = mergeSettings(rawBlob);
  const beforeSection = before[section] as Record<string, unknown>;

  // 2. Validate the incoming patch on top of current.
  const candidate = { ...beforeSection, ...patch };
  const parsed = schema.safeParse(candidate);
  if (!parsed.success) {
    return {
      ok: false,
      error:
        parsed.error.issues[0]?.message ??
        "Invalid settings — check the fields and try again.",
    };
  }
  const afterSection = parsed.data as Record<string, unknown>;

  const { keys, before: beforeDiff, after: afterDiff } = diffSection(
    beforeSection,
    afterSection,
  );
  if (keys.length === 0) {
    return { ok: true, changedKeys: [] };
  }

  // 3. UPSERT the merged blob — RAW FIRST, so sections this module does not
  //    own (infra gate flags) are preserved; the known sections then overlay
  //    their normalised values, and the edited section its new value.
  const nextData = { ...rawBlob, ...before, [section]: afterSection };
  const up = await adminTable("hq_settings").upsert(
    {
      id: "singleton",
      data: nextData,
      updated_by: actor.id,
      // updated_at is bumped by trigger.
    },
    { onConflict: "id" },
  );
  if (up.error) {
    console.error(
      "[hq-settings] upsert failed",
      section,
      up.error.message,
    );
    return { ok: false, error: "Database error — settings not saved." };
  }

  // 4. Audit-log the diff (best-effort).
  await recordAdminActivity({
    actorId: actor.id,
    actorEmail: actor.email,
    action: `hq_settings.${section}.updated`,
    targetTable: "hq_settings",
    targetId: "singleton",
    metadata: {
      section,
      keys,
      before: beforeDiff,
      after: afterDiff,
    },
  });

  return { ok: true, changedKeys: keys };
}
