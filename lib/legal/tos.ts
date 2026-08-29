/**
 * Terms-of-Service versioning.
 *
 * The single constant every ToS-stamping write uses (migration
 * 20261223000000 added the org-level columns). Bump this when the
 * published terms materially change; orgs whose organizations.tos_version
 * differs from this constant accepted an older revision.
 *
 * 'legacy' is RESERVED for the migration backfill — orgs created before
 * acceptance was persisted. Never stamp it from application code.
 *
 * Dependency-free so both server actions and unit tests import it.
 */
// Tracks the PUBLISHED revision: app/terms/page.tsx lastUpdated="2026-05-21".
// A stamped version must name terms a person could actually have read — the
// tos-stamp test pins this constant to the published page's revision month.
export const CURRENT_TOS_VERSION = "2026-05";

/** The reserved backfill marker (see migration 20261223000000). */
export const LEGACY_TOS_VERSION = "legacy";
