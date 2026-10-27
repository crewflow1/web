/**
 * Migration OS operator surface — activation readiness.
 *
 * A sibling of lib/comms/readiness.ts and lib/monitoring/readiness.ts. The
 * operator-only Migration OS controls are gated by the super-admin allowlist
 * (CREWFLOW_SUPERADMIN_EMAILS); with the allowlist empty, nobody is an operator
 * and the surface is inert. This reports whether operators are provisioned so
 * /api/health shows the true enabled/dark state. Does NOT gate `ok`.
 *
 *   operatorAllowlistConfigured — CREWFLOW_SUPERADMIN_EMAILS names at least one
 *                                 operator (the server-side authorization gate
 *                                 for every app/admin/** surface). Empty ⇒ the
 *                                 operator surface authorises nobody.
 *
 * Reads `process.env` DIRECTLY, imports no `server-only`, so it is edge-safe and
 * CAN NEVER THROW. Emits a BOOLEAN ONLY — never the allowlisted addresses nor
 * the env-var name; /api/health is public.
 */

const present = (v: string | undefined | null): boolean =>
  typeof v === "string" && v.trim().length > 0;

export type MigrationReadiness = {
  operatorAllowlistConfigured: boolean;
};

export function getMigrationReadiness(): MigrationReadiness {
  return {
    operatorAllowlistConfigured: present(process.env.CREWFLOW_SUPERADMIN_EMAILS),
  };
}
