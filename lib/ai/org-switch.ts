import "server-only";

/**
 * Per-company AI off switch — READ side (migration 20261366000000).
 *
 * ENFORCEMENT is NOT here. `ai_reserve_invocation` refuses every governed call
 * for a switched-off company (block_reason "ai_disabled") under the per-org
 * lock; this module only answers "what should the UI say". A read failure
 * returns `null` (unknown) — callers must not render it as "on".
 */

type Reader = {
  from(t: string): {
    select(c: string): {
      eq(k: string, v: string): {
        maybeSingle(): PromiseLike<{ data: unknown; error: unknown }>;
      };
    };
  };
};

/** true = on (default, no row), false = switched off, null = could not be read. */
export async function readOrgAiEnabled(
  client: unknown,
  orgId: string,
): Promise<boolean | null> {
  const { data, error } = await (client as Reader)
    .from("ai_org_switches")
    .select("ai_enabled")
    .eq("org_id", orgId)
    .maybeSingle();
  if (error) {
    console.error("[ai/org-switch] read failed", error);
    return null;
  }
  const row = data as { ai_enabled?: unknown } | null;
  return row ? row.ai_enabled !== false : true;
}
