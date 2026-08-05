import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Write one row to public.admin_activity_log — the HQ-side audit
 * trail. Service-role client only; the table has no RLS policies,
 * so callers must already have confirmed isSuperAdminEmail before
 * invoking this helper.
 *
 * Failures are logged + swallowed: audit writes must never break the
 * primary user action. If the actor mutated state successfully, we'd
 * rather have a silent audit gap than a 500.
 *
 * The `admin_activity_log` table landed in migration
 * 20260605000000 and isn't in the generated Supabase types yet —
 * `untypedAdminTable()` casts past the typed client until the next
 * `pnpm db:generate` run.
 */
function untypedAdminTable<T extends string>(name: T) {
  const admin = createAdminClient();
  return admin.from(name as never) as unknown as {
    insert: (payload: unknown) => Promise<{ error: { message: string } | null }>;
    select: (cols: string) => {
      eq: (k: string, v: unknown) => {
        eq: (k: string, v: unknown) => {
          order: (
            k: string,
            opts: { ascending: boolean },
          ) => {
            limit: (
              n: number,
            ) => Promise<{
              data: unknown[] | null;
              error: { message: string } | null;
            }>;
          };
        };
      };
    };
  };
}

export async function recordAdminActivity(input: {
  actorId: string | null;
  actorEmail: string | null;
  action: string;
  targetTable: string;
  targetId: string;
  metadata?: Record<string, unknown> | null;
}): Promise<void> {
  try {
    const res = await untypedAdminTable("admin_activity_log").insert({
      actor_id: input.actorId,
      actor_email: input.actorEmail,
      action: input.action,
      target_table: input.targetTable,
      target_id: input.targetId,
      metadata: input.metadata ?? null,
    });
    if (res.error) {
      console.error("[hq-audit] recordAdminActivity insert error", res.error);
    }
  } catch (e) {
    console.error("[hq-audit] recordAdminActivity failed", {
      action: input.action,
      target: `${input.targetTable}/${input.targetId}`,
      err: e instanceof Error ? e.message : String(e),
    });
  }
}

/**
 * Read recent HQ activity entries for a specific target — used to
 * render the per-demo timeline in the side panel. Empty array on
 * failure (UI shows "no activity yet" rather than an error toast).
 */
export type AdminActivityRow = {
  id: string;
  actor_email: string | null;
  action: string;
  metadata: Record<string, unknown> | null;
  created_at: string;
};

export async function listAdminActivity(
  targetTable: string,
  targetId: string,
  limit = 25,
): Promise<AdminActivityRow[]> {
  try {
    const { data, error } = await untypedAdminTable("admin_activity_log")
      .select("id, actor_email, action, metadata, created_at")
      .eq("target_table", targetTable)
      .eq("target_id", targetId)
      .order("created_at", { ascending: false })
      .limit(Math.min(limit, 1000)); // F-1: provable cap; PostgREST clamps to 1000
    if (error) {
      console.error("[hq-audit] listAdminActivity failed", error);
      return [];
    }
    return (data ?? []) as unknown as AdminActivityRow[];
  } catch (e) {
    console.error("[hq-audit] listAdminActivity threw", e);
    return [];
  }
}
