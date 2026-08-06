import "server-only";
import { createClient } from "@/lib/supabase/server";
import { readFailure, type SupabaseReadError } from "@/lib/supabase/read-failure";
import { requireOrgContext } from "@/server/auth/session";
import { recordAdminActivity } from "@/server/services/hq-audit";
import {
  createNotePinSchema, createSnagPinSchema, linkSnagPinSchema, movePinSchema,
  type BlueprintPin, type CreateNotePinInput, type CreateSnagPinInput,
  type LinkSnagPinInput, type MovePinInput,
} from "@/lib/blueprints/pins";
import type { SnagStatus } from "@/lib/snags/schema";

/**
 * Blueprint Pins service (Programme B).
 *
 * All writes go through the TENANT client so RLS scopes them and the
 * before-write DB trigger derives org_id/job_id from the parent version
 * (client-sent tenancy is ignored). The "create a snag + its pin" path is a
 * single SECURITY INVOKER RPC so both inserts share one transaction (no
 * orphaned snag if the pin insert fails). Status is NEVER stored on the pin —
 * a snag pin reads its status from the joined snag row (the authority). Audit
 * uses `recordAdminActivity` (the working path) on create/link/delete only —
 * never per-move (position drift is high-volume, low-signal).
 */

export type PinResult<T = { id: string }> = { ok: true; data: T } | { ok: false; error: string };

// Minimal structural view of the tenant client for the stale generated types
// (blueprint_pins is not yet in lib/supabase/types). Mirrors blueprints.ts.
type PinRows = { data: Record<string, unknown>[] | null; error: SupabaseReadError | null };
type PinChain = PromiseLike<PinRows> & {
  eq: (k: string, v: unknown) => PinChain;
  in: (k: string, v: unknown[]) => PinChain;
  order: (k: string, o: { ascending: boolean }) => Promise<PinRows>;
};
/** Chainable `.eq()` so an update/delete can carry BOTH the id and the org pin. */
type PinMutation = PromiseLike<{ error: { message: string } | null; count: number | null }> & {
  eq: (k: string, v: unknown) => PinMutation;
};
type PinClient = {
  from: (t: string) => {
    select: (c: string) => PinChain;
    insert: (r: unknown) => { select: (c: string) => { single: () => Promise<{ data: { id: string } | null; error: { message: string } | null }> } };
    update: (r: unknown, o?: { count: string }) => PinMutation;
    delete: (o: { count: string }) => PinMutation;
  };
  rpc: (fn: string, args: Record<string, unknown>) => { single: () => Promise<{ data: { id: string } | null; error: { message: string } | null }> };
};
const pc = (c: Awaited<ReturnType<typeof createClient>>) => c as unknown as PinClient;

type RawPin = {
  id: string; blueprint_version_id: string; page_number: number; u: number; v: number;
  kind: "snag" | "note"; title: string | null; note: string | null; snag_id: string | null; created_at: string;
};

/**
 * Every pin on a drawing revision, with each snag pin's live status/title joined
 * in ONE batched query (no N+1).
 *
 * Pinned to the ACTIVE org, not merely RLS-scoped: `current_org_ids()` returns
 * EVERY org the viewer belongs to, so an RLS-only read would surface the other
 * company's pins (and, through the snag join, their defect titles) on this org's
 * drawing. Same class as #456/#463.
 */
export async function listPinsForVersion(versionId: string): Promise<BlueprintPin[]> {
  const { ctx } = await requireOrgContext();
  const supabase = pc(await createClient());
  const { data: rows, error } = await supabase
    .from("blueprint_pins")
    .select("id, blueprint_version_id, page_number, u, v, kind, title, note, snag_id, created_at")
    .eq("blueprint_version_id", versionId)
    .eq("org_id", ctx.org.id)
    .order("created_at", { ascending: true });
  if (error) throw readFailure("blueprint-pins: pins for version", error);
  const pins = (rows ?? []) as unknown as RawPin[];
  if (pins.length === 0) return [];

  const snagIds = [...new Set(pins.filter((p) => p.snag_id).map((p) => p.snag_id as string))];
  const snagById = new Map<string, { status: SnagStatus; title: string }>();
  if (snagIds.length > 0) {
    const { data: snagRows } = await supabase
      .from("snags")
      .select("id, status, title")
      .eq("org_id", ctx.org.id)
      .in("id", snagIds);
    for (const s of (snagRows ?? []) as unknown as { id: string; status: SnagStatus; title: string }[]) {
      snagById.set(s.id, { status: s.status, title: s.title });
    }
  }

  return pins.map((p) => {
    const snag = p.snag_id ? snagById.get(p.snag_id) : undefined;
    return {
      id: p.id, blueprint_version_id: p.blueprint_version_id, page_number: p.page_number,
      u: p.u, v: p.v, kind: p.kind, title: p.title, note: p.note, snag_id: p.snag_id,
      created_at: p.created_at,
      snag_status: snag?.status ?? null,
      snag_title: snag?.title ?? null,
    };
  });
}

/** Open snags on a job that a pin could link to (for the "link existing" flow). */
export async function listLinkableSnags(jobId: string): Promise<{ id: string; title: string; status: SnagStatus }[]> {
  const { ctx } = await requireOrgContext();
  const supabase = pc(await createClient());
  const { data, error } = await supabase
    .from("snags")
    .select("id, title, status")
    .eq("job_id", jobId)
    .eq("org_id", ctx.org.id)
    .order("created_at", { ascending: false });
  if (error) throw readFailure("blueprint-pins: linkable snags", error);
  return ((data ?? []) as unknown as { id: string; title: string; status: SnagStatus }[]).filter(
    (s) => s.status !== "verified" && s.status !== "wont_fix",
  );
}

/** Place a self-contained note pin. */
export async function createNotePin(raw: CreateNotePinInput): Promise<PinResult> {
  const parsed = createNotePinSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid note pin." };
  const { ctx, user } = await requireOrgContext();
  const supabase = pc(await createClient());
  const { data, error } = await supabase
    .from("blueprint_pins")
    .insert({
      blueprint_version_id: parsed.data.blueprint_version_id,
      page_number: parsed.data.page_number,
      u: parsed.data.u, v: parsed.data.v,
      kind: "note", title: parsed.data.title ?? null, note: parsed.data.note,
      created_by: user.id,
    })
    .select("id")
    .single();
  if (error || !data) return { ok: false, error: friendly(error?.message) };
  await recordAdminActivity({
    actorId: user.id, actorEmail: user.email ?? null, action: "blueprint_pin.created",
    targetTable: "blueprint_pins", targetId: data.id,
    metadata: { kind: "note", org_id: ctx.org.id, blueprint_version_id: parsed.data.blueprint_version_id },
  });
  return { ok: true, data };
}

/** Place a pin that CREATES a snag at that location (atomic via RPC). */
export async function createSnagPin(raw: CreateSnagPinInput): Promise<PinResult> {
  const parsed = createSnagPinSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid snag pin." };
  const { ctx, user } = await requireOrgContext();
  const supabase = pc(await createClient());
  const { data, error } = await supabase
    .rpc("create_blueprint_pin_with_snag", {
      p_blueprint_version_id: parsed.data.blueprint_version_id,
      p_page_number: parsed.data.page_number,
      p_u: parsed.data.u, p_v: parsed.data.v,
      p_pin_title: parsed.data.pin_title ?? null,
      p_snag_title: parsed.data.snag_title,
      p_snag_description: parsed.data.snag_description ?? null,
      p_snag_priority: parsed.data.snag_priority,
      p_snag_location: parsed.data.snag_location ?? null,
    })
    .single();
  if (error || !data) return { ok: false, error: friendly(error?.message) };
  await recordAdminActivity({
    actorId: user.id, actorEmail: user.email ?? null, action: "blueprint_pin.created",
    targetTable: "blueprint_pins", targetId: data.id,
    metadata: { kind: "snag", org_id: ctx.org.id, blueprint_version_id: parsed.data.blueprint_version_id },
  });
  return { ok: true, data };
}

/** Place a pin that LINKS an existing snag. */
export async function linkSnagPin(raw: LinkSnagPinInput): Promise<PinResult> {
  const parsed = linkSnagPinSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid link." };
  const { ctx, user } = await requireOrgContext();
  const supabase = pc(await createClient());
  const { data, error } = await supabase
    .from("blueprint_pins")
    .insert({
      blueprint_version_id: parsed.data.blueprint_version_id,
      page_number: parsed.data.page_number,
      u: parsed.data.u, v: parsed.data.v,
      kind: "snag", title: parsed.data.title ?? null, snag_id: parsed.data.snag_id,
      created_by: user.id,
    })
    .select("id")
    .single();
  if (error || !data) return { ok: false, error: friendly(error?.message) };
  await recordAdminActivity({
    actorId: user.id, actorEmail: user.email ?? null, action: "blueprint_pin.linked",
    targetTable: "blueprint_pins", targetId: data.id,
    metadata: { kind: "snag", snag_id: parsed.data.snag_id, org_id: ctx.org.id },
  });
  return { ok: true, data };
}

/** Reposition a pin (member-allowed; not audited — position refinement). */
export async function movePin(raw: MovePinInput): Promise<PinResult> {
  const parsed = movePinSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Invalid position." };
  const { ctx } = await requireOrgContext();
  const supabase = pc(await createClient());
  // ACTIVE-org pin + an EXACT count. Without the pin, a dual-org member could
  // reposition the other org's pin (RLS's `current_org_ids()` admits it), and
  // without `{ count: "exact" }` PostgREST returns a null count so the
  // "Pin not found." branch below could never fire.
  const { error, count } = await supabase
    .from("blueprint_pins")
    .update({ u: parsed.data.u, v: parsed.data.v }, { count: "exact" })
    .eq("id", parsed.data.id)
    .eq("org_id", ctx.org.id);
  if (error) return { ok: false, error: friendly(error.message) };
  if (!count) return { ok: false, error: "Pin not found." };
  return { ok: true, data: { id: parsed.data.id } };
}

/** Delete a pin. Admin-only (count-gated: a denied delete removes nothing). */
export async function deletePin(pinId: string): Promise<PinResult> {
  const { ctx, user } = await requireOrgContext();
  const supabase = pc(await createClient());
  // ACTIVE-org pin (mirrors movePin): blueprint_pins' delete RLS is
  // is_org_admin(org_id), which a dual-org owner/admin satisfies for BOTH orgs,
  // so without the pin they could delete the other org's pin. The exact count
  // still gates the "not found" branch.
  const { error, count } = await supabase.from("blueprint_pins").delete({ count: "exact" }).eq("id", pinId).eq("org_id", ctx.org.id);
  if (error) return { ok: false, error: friendly(error.message) };
  if (!count) return { ok: false, error: "Only owners/admins can delete a pin." };
  await recordAdminActivity({
    actorId: user.id, actorEmail: user.email ?? null, action: "blueprint_pin.deleted",
    targetTable: "blueprint_pins", targetId: pinId, metadata: { org_id: ctx.org.id },
  });
  return { ok: true, data: { id: pinId } };
}

function friendly(dbMessage?: string): string {
  if (!dbMessage) return "Couldn't save the pin.";
  if (dbMessage.includes("different job")) return "That snag belongs to a different job.";
  if (dbMessage.includes("does not exist") || dbMessage.includes("foreign key")) return "That drawing revision no longer exists.";
  if (dbMessage.includes("blueprint_pins_kind_payload")) return "That pin is missing required details.";
  return "Couldn't save the pin.";
}
