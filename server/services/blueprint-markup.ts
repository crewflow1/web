import "server-only";
import { createClient } from "@/lib/supabase/server";
import { readFailure, type SupabaseReadError } from "@/lib/supabase/read-failure";
import { requireOrgContext } from "@/server/auth/session";
import { recordAdminActivity } from "@/server/services/hq-audit";
import {
  createMarkupSchema, deleteMarkupSchema, quantizePoints,
  type BlueprintMarkup, type CreateMarkupInput, type MarkupKind,
} from "@/lib/blueprints/markup";

/**
 * Blueprint Markup service (Programme C) — structural sibling of
 * blueprint-pins.ts. All writes go through the TENANT client so RLS scopes them
 * and the before-write trigger derives org_id/job_id + the bbox (client tenancy
 * and bbox are ignored). Points are quantised before insert so client-preview
 * and the DB-derived bbox agree. Audit on create/remove/delete only — never on
 * reshape (there is no post-hoc geometry edit in this milestone). A member
 * "removes" via a soft UPDATE (status='removed'); hard delete is admin-only.
 */

export type MarkupResult<T = { id: string }> = { ok: true; data: T } | { ok: false; error: string };

type MarkupChain = PromiseLike<{ data: Record<string, unknown>[] | null; error: SupabaseReadError | null }> & {
  eq: (k: string, v: unknown) => MarkupChain;
  order: (k: string, o: { ascending: boolean }) => Promise<{ data: Record<string, unknown>[] | null; error: SupabaseReadError | null }>;
};
type MarkupClient = {
  from: (t: string) => {
    select: (c: string) => MarkupChain;
    insert: (r: unknown) => { select: (c: string) => { single: () => Promise<{ data: { id: string } | null; error: { message: string } | null }> } };
    update: (r: unknown) => { eq: (k: string, v: unknown) => Promise<{ error: { message: string } | null; count: number | null }> };
    delete: (o: { count: string }) => { eq: (k: string, v: unknown) => Promise<{ error: { message: string } | null; count: number | null }> };
  };
};
const mc = (c: Awaited<ReturnType<typeof createClient>>) => c as unknown as MarkupClient;

type RawMarkup = {
  id: string; blueprint_version_id: string; page_number: number; shape: MarkupKind;
  geom: { points: { u: number; v: number }[] }; color: string | null; text_content: string | null;
  stroke_width: number | null; created_at: string; created_by: string | null;
};

/** Active markup on a drawing revision. RLS scopes the read to the caller's orgs. */
export async function listMarkupForVersion(versionId: string): Promise<BlueprintMarkup[]> {
  const supabase = mc(await createClient());
  const { data, error } = await supabase
    .from("blueprint_markup")
    .select("id, blueprint_version_id, page_number, shape, geom, color, text_content, stroke_width, created_at, created_by")
    .eq("blueprint_version_id", versionId)
    .eq("status", "active")
    .order("created_at", { ascending: true });
  if (error) throw readFailure("blueprint-markup: markup for version", error);
  return ((data ?? []) as unknown as RawMarkup[]).map((m) => ({
    id: m.id, blueprint_version_id: m.blueprint_version_id, page_number: m.page_number,
    kind: m.shape, points: Array.isArray(m.geom?.points) ? m.geom.points : [],
    color: m.color, text: m.text_content, stroke_width: m.stroke_width,
    created_at: m.created_at, created_by: m.created_by,
  }));
}

/** Commit a drawn shape. org_id/job_id/bbox are derived by the DB trigger. */
export async function createMarkup(raw: CreateMarkupInput): Promise<MarkupResult> {
  const parsed = createMarkupSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "That shape isn't valid." };
  const { ctx, user } = await requireOrgContext();
  const supabase = mc(await createClient());
  const { data, error } = await supabase
    .from("blueprint_markup")
    .insert({
      blueprint_version_id: parsed.data.blueprint_version_id,
      page_number: parsed.data.page_number,
      shape: parsed.data.geom.kind,
      geom: { points: quantizePoints(parsed.data.geom.points) },
      color: parsed.data.color ?? undefined,
      stroke_width: parsed.data.stroke_width ?? undefined,
      text_content: parsed.data.geom.kind === "text" ? parsed.data.text : null,
      created_by: user.id,
    })
    .select("id")
    .single();
  if (error || !data) return { ok: false, error: friendly(error?.message) };
  await recordAdminActivity({
    actorId: user.id, actorEmail: user.email ?? null, action: "blueprint_markup.created",
    targetTable: "blueprint_markup", targetId: data.id,
    metadata: { shape: parsed.data.geom.kind, org_id: ctx.org.id, blueprint_version_id: parsed.data.blueprint_version_id },
  });
  return { ok: true, data };
}

/** Member soft-remove: hide the redline (status='removed'), audited. */
export async function removeMarkup(rawId: string): Promise<MarkupResult> {
  const parsed = deleteMarkupSchema.safeParse({ id: rawId });
  if (!parsed.success) return { ok: false, error: "Invalid markup id." };
  const { ctx, user } = await requireOrgContext();
  const supabase = mc(await createClient());
  const { error, count } = await supabase
    .from("blueprint_markup")
    .update({ status: "removed", deleted_at: new Date().toISOString(), updated_by: user.id })
    .eq("id", parsed.data.id);
  if (error) return { ok: false, error: friendly(error.message) };
  if (count === 0) return { ok: false, error: "Markup not found." };
  await recordAdminActivity({
    actorId: user.id, actorEmail: user.email ?? null, action: "blueprint_markup.removed",
    targetTable: "blueprint_markup", targetId: parsed.data.id, metadata: { org_id: ctx.org.id },
  });
  return { ok: true, data: { id: parsed.data.id } };
}

/** Admin hard-delete: permanently purge (count-gated — a denied delete purges nothing). */
export async function deleteMarkup(rawId: string): Promise<MarkupResult> {
  const parsed = deleteMarkupSchema.safeParse({ id: rawId });
  if (!parsed.success) return { ok: false, error: "Invalid markup id." };
  const { ctx, user } = await requireOrgContext();
  const supabase = mc(await createClient());
  const { error, count } = await supabase.from("blueprint_markup").delete({ count: "exact" }).eq("id", parsed.data.id);
  if (error) return { ok: false, error: friendly(error.message) };
  if (!count) return { ok: false, error: "Only owners/admins can permanently delete markup." };
  await recordAdminActivity({
    actorId: user.id, actorEmail: user.email ?? null, action: "blueprint_markup.deleted",
    targetTable: "blueprint_markup", targetId: parsed.data.id, metadata: { org_id: ctx.org.id },
  });
  return { ok: true, data: { id: parsed.data.id } };
}

function friendly(dbMessage?: string): string {
  if (!dbMessage) return "Couldn't save the markup.";
  if (dbMessage.includes("is immutable")) return "Markup can't be moved to another sheet.";
  if (dbMessage.includes("outside [0,1]") || dbMessage.includes("requires") || dbMessage.includes("points")) return "That shape isn't valid.";
  if (dbMessage.includes("does not exist") || dbMessage.includes("foreign key")) return "That drawing revision no longer exists.";
  return "Couldn't save the markup.";
}
