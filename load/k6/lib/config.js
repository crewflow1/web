// load/k6/lib/config.js — environment, target safety, persona mix, stage profiles.
import { classifyTarget } from "./guard.js";
import { stageProfile as stageProfileFor } from "./model.js";
//
// Everything a run needs comes from environment variables so the same scripts
// drive the local harness-validation pass and (once the founder approves and
// supplies a staging project) the staged runs. NOTHING here targets production:
// the guard below refuses the production host and project ref unconditionally.

export const BASE_URL = (__ENV.BASE_URL || "http://localhost:3000").replace(/\/+$/, "");
export const SUPABASE_URL = (__ENV.SUPABASE_URL || "http://127.0.0.1:54321").replace(/\/+$/, "");
export const ANON_KEY = __ENV.SUPABASE_ANON_KEY || "";
export const STAGE = __ENV.STAGE || "smoke";
export const TAG = __ENV.LOAD_TAG || "lt1";
export const MANIFEST_PATH = __ENV.MANIFEST || `../.manifest/${TAG}.json`;
export const ACTIONS_PATH = __ENV.ACTIONS || "../.manifest/actions.json";
/** Multiplies every think time. 1 = realistic pacing; <1 compresses a short local pass. */
export const THINK_SCALE = Number(__ENV.THINK_SCALE || "1");
/** Fraction of responses whose body is scanned for a foreign-tenant marker. */
export const SCAN_RATE = Number(__ENV.SCAN_RATE || "1");
/** Next <Link> prefetch requests issued after each page navigation. */
export const PREFETCH_PER_NAV = Number(__ENV.PREFETCH_PER_NAV || "4");
/** Site-photo upload size. Real phone photos are 2–4 MB; keep small locally. */
export const PHOTO_KB = Number(__ENV.PHOTO_KB || "150");
/** "app" = sign in through the product's own server action (real path);
 *  "gotrue" = password grant straight to Supabase Auth, cookie built client-side. */
export const LOGIN_MODE = __ENV.LOGIN_MODE || "app";
export const ALLOW_SHARED_USERS = __ENV.ALLOW_SHARED_USERS === "1";

/**
 * Target safety (rules + tests: ./guard.js, __tests__/load/guard.test.ts).
 * Runs in the init context of every VU, so a mis-pointed run dies before a
 * single request is sent. Production is refused with no override; a non-local
 * target needs LOAD_STAGING_HOST + LOAD_STAGING_REF naming it on purpose; and
 * setup() then proves with a canary session that the app is not
 * wired to another database (guard.sessionProofVerdict). The last
 * interlock is structural: every authenticated persona signs in as a
 * `…@loadtest.crewflow.invalid` user that exists only in a seeded local /
 * staging database (the seeder refuses production), so setup() aborts anywhere
 * that was not seeded for this.
 */
export function assertSafeTarget() {
  return classifyTarget(BASE_URL, SUPABASE_URL, __ENV);
}

export const TARGET_KIND = assertSafeTarget();

/** Shared synthetic password. Local default mirrors scripts/load/seed.mjs. */
export const PASSWORD = __ENV.LOAD_USER_PASSWORD || (TARGET_KIND === "local" ? "Loadtest-Local-Only-1!" : "");
if (!PASSWORD) throw new Error("LOAD_USER_PASSWORD is required for a non-local target.");

// Persona mix, stage profiles, phases, thresholds and the sessions / RPS /
// in-flight model live in ./model.js (pure, unit-tested).
export { PERSONA_SLOTS, SLOTS_TOTAL, assignVu, personaCounts, STAGES, phasesOf, phaseAt, thresholdsFor as thresholds } from "./model.js";

export function stageProfile() {
  return stageProfileFor(STAGE, TARGET_KIND, __ENV.ALLOW_BIG_LOCAL === "1");
}
