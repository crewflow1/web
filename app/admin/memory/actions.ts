"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireUser } from "@/server/auth/session";
import { isSuperAdminEmail } from "@/server/auth/superadmin";
import { recordAdminActivity } from "@/server/services/hq-audit";
import {
  createMemory,
  setMemoryPinned,
  setMemoryStatus,
  updateMemory,
  type MemoryWriteInput,
  type RelationshipInput,
} from "@/server/services/hq-memory";
import {
  DEPARTMENTS,
  ENTITY_TYPES,
  IMPORTANCES,
  MEMORY_STATUSES,
  MEMORY_VISIBILITIES,
  normalizeTags,
  type EntityType,
} from "@/lib/memory/model";

/**
 * CrewFlow HQ — Shared Memory Engine, server actions (CEO Directive 002).
 *
 * HQ operator only. Every action re-checks isSuperAdminEmail (the
 * /admin/* layout already 404s non-allowlisted users; this is
 * defence-in-depth against a request that reaches the action URL
 * directly). Each write is audited to admin_activity_log AND produces a
 * per-memory event inside the service.
 *
 * READ-FIRST for AI: there is no action here that an AI employee can
 * invoke. These are operator-facing curation actions only.
 */

async function requireAdmin(): Promise<{ id: string; email: string }> {
  const user = await requireUser();
  if (!isSuperAdminEmail(user.email)) redirect("/dashboard");
  return { id: user.id, email: user.email ?? "" };
}

const SLUG_RE = /^[a-z0-9_]{1,60}$/;

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .or(z.literal("").transform(() => null));

const writeSchema = z.object({
  title: z.string().trim().min(1).max(300),
  summary: z.string().trim().max(2000).optional().or(z.literal("")),
  body: z.string().trim().max(200_000).optional().or(z.literal("")),
  memory_type: z.string().regex(SLUG_RE),
  department: z.enum(DEPARTMENTS).optional().or(z.literal("")),
  importance: z.enum(IMPORTANCES),
  visibility: z.enum(MEMORY_VISIBILITIES),
  source: z.string().regex(SLUG_RE),
  status: z.enum(MEMORY_STATUSES),
  confidence: z.coerce.number().int().min(0).max(100).optional(),
  organisation_name: optionalText(200),
});

/** Parse the relationships textarea: one `type | label | id` per line. */
function parseRelationships(raw: string | null): RelationshipInput[] {
  if (!raw) return [];
  const out: RelationshipInput[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split("|").map((s) => s.trim());
    const entityType = (parts[0] ?? "").toLowerCase();
    if (!ENTITY_TYPES.includes(entityType as EntityType)) continue;
    const entityLabel = (parts[1] ?? "").slice(0, 300);
    if (!entityLabel) continue;
    const entityId = parts[2] ? parts[2].slice(0, 200) : null;
    out.push({ entityType, entityLabel, entityId, relation: "related_to" });
    if (out.length >= 30) break;
  }
  return out;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function buildWriteInput(formData: FormData):
  | { ok: true; value: MemoryWriteInput }
  | { ok: false } {
  const parsed = writeSchema.safeParse({
    title: formData.get("title"),
    summary: formData.get("summary") ?? "",
    body: formData.get("body") ?? "",
    memory_type: formData.get("memory_type"),
    department: formData.get("department") ?? "",
    importance: formData.get("importance"),
    visibility: formData.get("visibility"),
    source: formData.get("source"),
    status: formData.get("status"),
    confidence: formData.get("confidence") ?? undefined,
    organisation_name: formData.get("organisation_name") ?? "",
  });
  if (!parsed.success) return { ok: false };
  const d = parsed.data;

  const employeeIds = formData
    .getAll("employee_ids")
    .map((v) => String(v))
    .filter((v) => UUID_RE.test(v))
    .slice(0, 50);

  const grantDepartments = formData
    .getAll("grant_departments")
    .map((v) => String(v))
    .filter((v) => (DEPARTMENTS as readonly string[]).includes(v))
    .slice(0, 20);

  const pinnedRaw = String(formData.get("pinned") ?? "");
  const pinned = pinnedRaw === "on" || pinnedRaw === "true" || pinnedRaw === "1";

  return {
    ok: true,
    value: {
      title: d.title,
      summary: d.summary || "",
      body: d.body || "",
      memoryType: d.memory_type,
      department: d.department ? d.department : null,
      importance: d.importance,
      visibility: d.visibility,
      source: d.source,
      status: d.status,
      confidence: d.confidence ?? 80,
      pinned,
      tags: normalizeTags(String(formData.get("tags") ?? "")),
      organisationName: d.organisation_name ?? null,
      relationships: parseRelationships(
        formData.get("relationships") ? String(formData.get("relationships")) : null,
      ),
      employeeIds,
      grantDepartments,
    },
  };
}

// --------------------------------------------------------------------
// Create
// --------------------------------------------------------------------

export async function createMemoryAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const built = buildWriteInput(formData);
  if (!built.ok) {
    redirect(
      `/admin/memory/new?error=${encodeURIComponent("Invalid memory input")}`,
    );
  }

  const result = await createMemory(built.value, {
    id: admin.id,
    email: admin.email,
  });
  if (!result.ok) {
    redirect(
      `/admin/memory/new?error=${encodeURIComponent("Couldn't save memory — check fields and try again.")}`,
    );
  }

  await recordAdminActivity({
    actorId: admin.id,
    actorEmail: admin.email,
    action: "hq_memory.created",
    targetTable: "hq_memories",
    targetId: result.id,
    metadata: {
      title: built.value.title,
      memory_type: built.value.memoryType,
      visibility: built.value.visibility,
      importance: built.value.importance,
    },
  });

  revalidatePath("/admin/memory");
  revalidatePath("/admin/memory/search");
  revalidatePath(`/admin/memory/${result.id}`);
  redirect(`/admin/memory/${result.id}?saved=created`);
}

// --------------------------------------------------------------------
// Update (snapshots a new version)
// --------------------------------------------------------------------

export async function updateMemoryAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const idRaw = String(formData.get("id") ?? "");
  if (!UUID_RE.test(idRaw)) {
    redirect(`/admin/memory?error=${encodeURIComponent("Invalid memory id")}`);
  }

  const built = buildWriteInput(formData);
  if (!built.ok) {
    redirect(
      `/admin/memory/${idRaw}/edit?error=${encodeURIComponent("Invalid memory input")}`,
    );
  }

  const result = await updateMemory(idRaw, built.value, {
    id: admin.id,
    email: admin.email,
  });
  if (!result.ok) {
    redirect(
      `/admin/memory/${idRaw}/edit?error=${encodeURIComponent("Couldn't update memory.")}`,
    );
  }

  await recordAdminActivity({
    actorId: admin.id,
    actorEmail: admin.email,
    action: "hq_memory.updated",
    targetTable: "hq_memories",
    targetId: idRaw,
    metadata: { title: built.value.title, memory_type: built.value.memoryType },
  });

  revalidatePath("/admin/memory");
  revalidatePath("/admin/memory/search");
  revalidatePath(`/admin/memory/${idRaw}`);
  redirect(`/admin/memory/${idRaw}?saved=updated`);
}

// --------------------------------------------------------------------
// Pin / unpin
// --------------------------------------------------------------------

const pinSchema = z.object({
  id: z.string().uuid(),
  next: z.enum(["true", "false"]),
});

export async function togglePinAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const parsed = pinSchema.safeParse({
    id: formData.get("id"),
    next: formData.get("next"),
  });
  if (!parsed.success) {
    redirect(`/admin/memory?error=${encodeURIComponent("Invalid pin request")}`);
  }
  const pinned = parsed.data.next === "true";

  const result = await setMemoryPinned(parsed.data.id, pinned, {
    id: admin.id,
    email: admin.email,
  });
  if (!result.ok) {
    redirect(
      `/admin/memory/${parsed.data.id}?error=${encodeURIComponent("Couldn't update pin.")}`,
    );
  }

  await recordAdminActivity({
    actorId: admin.id,
    actorEmail: admin.email,
    action: pinned ? "hq_memory.pinned" : "hq_memory.unpinned",
    targetTable: "hq_memories",
    targetId: parsed.data.id,
  });

  revalidatePath("/admin/memory");
  revalidatePath(`/admin/memory/${parsed.data.id}`);
  redirect(`/admin/memory/${parsed.data.id}?saved=${pinned ? "pinned" : "unpinned"}`);
}

// --------------------------------------------------------------------
// Status change (active / archived / superseded / draft)
// --------------------------------------------------------------------

const statusSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(MEMORY_STATUSES),
});

export async function setStatusAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const parsed = statusSchema.safeParse({
    id: formData.get("id"),
    status: formData.get("status"),
  });
  if (!parsed.success) {
    redirect(
      `/admin/memory?error=${encodeURIComponent("Invalid status request")}`,
    );
  }

  const result = await setMemoryStatus(parsed.data.id, parsed.data.status, {
    id: admin.id,
    email: admin.email,
  });
  if (!result.ok) {
    redirect(
      `/admin/memory/${parsed.data.id}?error=${encodeURIComponent("Couldn't change status.")}`,
    );
  }

  await recordAdminActivity({
    actorId: admin.id,
    actorEmail: admin.email,
    action: "hq_memory.status_changed",
    targetTable: "hq_memories",
    targetId: parsed.data.id,
    metadata: { status: parsed.data.status },
  });

  revalidatePath("/admin/memory");
  revalidatePath(`/admin/memory/${parsed.data.id}`);
  redirect(`/admin/memory/${parsed.data.id}?saved=status`);
}
