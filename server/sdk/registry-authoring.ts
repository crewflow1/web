import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * CrewFlow HQ — The Capability Registry, LR1: the registry-native AUTHORING seam
 * (the write half of the IO bridge).
 *
 * CEO Directive #015 / D-05, Legacy Removal increment 1. ADR:
 * docs/bible/decisions/0010-capability-registry.md. Migration:
 * supabase/migrations/20260808000000_capability_registry_native_authoring.sql.
 *
 * R1–R4 made the registry the AUTHORITATIVE runtime source while authority was
 * still AUTHORED into the legacy `ai_employees` columns and only mirrored INTO the
 * registry by the R2 backfill. LR1 reverses the write direction: authority is now
 * authored AT the registry, and the legacy model receives a parity-faithful mirror
 * (the dual write is RETAINED, per the LR1 scope — nothing is removed).
 *
 * This module is the SERVER-ONLY write counterpart to the read bridge in
 * server/sdk/registry-parity.ts. It authors EXCLUSIVELY through the atomic
 * SECURITY DEFINER RPC {@link https hq_author_employee_capabilities} — never a
 * direct table write — because supabase-js has no client-side multi-statement
 * transaction (CEO decision D1): only the RPC can make the registry write and the
 * legacy mirror succeed or fail together, leaving no divergence window.
 *
 * The RPC (`hq_author_employee_capabilities`):
 *   • defines any new token in the catalogue;
 *   • upserts the employee-scoped grant — TOKENS ONLY (posture + memory_scope
 *     preserved, so the execution lock never moves);
 *   • mirrors the parity-faithful split (scopes → permissions.scopes, everything
 *     else → tools_allowed) back to the retained legacy columns.
 *
 * STRICTLY non-throwing: every outcome — success, an expected validation envelope,
 * or an unexpected error — comes back as a discriminated result so the caller (the
 * superadmin-gated server action) can record the audit trail and surface the right
 * message. The atomic dual write is the RPC's job; this function only supplies the
 * IO (the service-role admin client) and the result mapping.
 */

/** What to author: the subject, the token SET, and the acting superadmin. */
export interface AuthorCapabilitiesInput {
  /** EmployeeIdentity.slug — the canonical key the registry resolves against. */
  slug: string;
  /** The token SET to hold at the employee scope (the act is a full SET replace). */
  tokens: readonly string[];
  /** The acting superadmin, stamped onto a newly-created grant's immutable audit. */
  actorId?: string | null;
  actorEmail?: string | null;
}

/** The discriminated outcome of an authoring attempt. */
export type AuthorCapabilitiesResult =
  | {
      ok: true;
      /** `created` when the employee had no grant (backfill gap); else `updated`. */
      action: "created" | "updated";
      slug: string;
      grantId: string;
      /** The normalised (sorted-distinct) token set now held by the grant. */
      tokens: string[];
      /** The legacy mirror's tool half (kind ≠ scope). */
      toolsAllowed: string[];
      /** The legacy mirror's scope half (kind = scope). */
      scopes: string[];
    }
  | { ok: false; reason: "invalid_token"; token: string }
  | { ok: false; reason: "unknown_employee"; slug: string }
  | { ok: false; reason: "error"; error: string };

// hq_author_employee_capabilities isn't in the generated Supabase types (a
// service-role-only HQ internal). Cast past the typed client, the .rpc() idiom the
// HQ services use (event-spine.ts emitEvent).
type AuthorRpc = (
  fn: "hq_author_employee_capabilities",
  args: Record<string, unknown>,
) => Promise<{ data: unknown; error: { message: string } | null }>;

/** A non-empty string from an untrusted jsonb envelope field, or `undefined`. */
function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** A `string[]` from a jsonb array field, defaulting to `[]` for anything else. */
function strArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/**
 * Author an employee's capabilities at the registry (and mirror to the retained
 * legacy model) through the atomic authoring RPC. Never throws.
 */
export async function authorEmployeeCapabilities(
  input: AuthorCapabilitiesInput,
): Promise<AuthorCapabilitiesResult> {
  try {
    const admin = createAdminClient();
    const rpc = admin.rpc.bind(admin) as unknown as AuthorRpc;
    const { data, error } = await rpc("hq_author_employee_capabilities", {
      p_slug: input.slug,
      p_tokens: [...input.tokens],
      p_actor_id: input.actorId ?? null,
      p_actor_email: input.actorEmail ?? null,
    });

    if (error || data == null || typeof data !== "object") {
      const message = error?.message ?? "authoring failed";
      console.warn(`[registry-authoring] author failed for ${input.slug}:`, message);
      return { ok: false, reason: "error", error: message };
    }

    const env = data as Record<string, unknown>;
    if (env.ok !== true) {
      const reason = str(env.reason);
      if (reason === "invalid_token") {
        return { ok: false, reason: "invalid_token", token: str(env.token) ?? "" };
      }
      if (reason === "unknown_employee") {
        return { ok: false, reason: "unknown_employee", slug: str(env.slug) ?? input.slug };
      }
      console.warn(`[registry-authoring] author rejected for ${input.slug}:`, reason ?? "unknown");
      return { ok: false, reason: "error", error: reason ?? "authoring rejected" };
    }

    return {
      ok: true,
      action: env.action === "created" ? "created" : "updated",
      slug: str(env.slug) ?? input.slug,
      grantId: str(env.grant_id) ?? "",
      tokens: strArray(env.tokens),
      toolsAllowed: strArray(env.tools_allowed),
      scopes: strArray(env.scopes),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[registry-authoring] author threw for ${input.slug}:`, message);
    return { ok: false, reason: "error", error: message };
  }
}
