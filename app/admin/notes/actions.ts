"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireHq } from "@/server/auth/hq";
import { recordAdminActivity } from "@/server/services/hq-audit";
import { emitNotifications } from "@/server/services/notifications-service";
import { notifyOnUrgentHqAlert } from "@/lib/notifications/events";
import {
  createInternalNote,
  updateInternalNote,
  archiveInternalNote,
  unarchiveInternalNote,
  pinInternalNote,
  loadInternalNoteById,
} from "@/server/services/hq-internal-notes";
import {
  INTERNAL_NOTE_CATEGORIES,
  INTERNAL_NOTE_PRIORITIES,
} from "@/lib/hq/internal-notes";

/**
 * HQ-side internal-notes server actions (HQ-9).
 *
 * Every action:
 *   1. Re-checks isSuperAdminEmail.
 *   2. Routes via the service-role client (RLS bypass by design —
 *      tenants can never see these rows).
 *   3. Writes admin_activity_log so /admin/customers/[id] timelines
 *      surface the note action.
 *   4. URGENT notes additionally fire an HQ-only notification via
 *      notifyOnUrgentHqAlert.
 */

// --------------------------------------------------------------------
// Schemas
// --------------------------------------------------------------------

const noteIdSchema = z.string().uuid();

const createSchema = z.object({
  org_id: z.string().uuid(),
  title: z
    .string()
    .trim()
    .max(200)
    .optional()
    .or(z.literal("").transform(() => null)),
  body: z.string().trim().min(1).max(20_000),
  category: z.enum(INTERNAL_NOTE_CATEGORIES).default("general"),
  priority: z.enum(INTERNAL_NOTE_PRIORITIES).default("normal"),
  pinned: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  /** Used by the customer-detail panel to redirect back rather than
   * to /admin/notes. */
  redirect_to: z.string().optional(),
});

const updateSchema = z.object({
  id: noteIdSchema,
  title: z
    .string()
    .trim()
    .max(200)
    .optional()
    .or(z.literal("").transform(() => null)),
  body: z.string().trim().min(1).max(20_000).optional(),
  category: z.enum(INTERNAL_NOTE_CATEGORIES).optional(),
  priority: z.enum(INTERNAL_NOTE_PRIORITIES).optional(),
  pinned: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === "true")),
  redirect_to: z.string().optional(),
});

const idOnlySchema = z.object({
  id: noteIdSchema,
  redirect_to: z.string().optional(),
});

// --------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------

function safeRedirect(input: string | undefined, fallback: string): string {
  if (!input) return fallback;
  // Only allow same-origin paths starting with "/" (not "//").
  if (input.startsWith("/") && !input.startsWith("//")) return input;
  return fallback;
}

// --------------------------------------------------------------------
// CREATE
// --------------------------------------------------------------------

export async function createNoteAction(formData: FormData): Promise<void> {
  const admin = await requireHq();
  const parsed = createSchema.safeParse({
    org_id: formData.get("org_id"),
    title: formData.get("title") ?? "",
    body: formData.get("body"),
    category: formData.get("category") ?? "general",
    priority: formData.get("priority") ?? "normal",
    pinned: formData.get("pinned") ?? "false",
    redirect_to: formData.get("redirect_to") ?? undefined,
  });
  if (!parsed.success) {
    const fallback = safeRedirect(
      formData.get("redirect_to") as string | null | undefined ?? undefined,
      "/admin/notes",
    );
    redirect(`${fallback}?error=invalid_input`);
  }

  const note = await createInternalNote({
    org_id: parsed.data.org_id,
    author_user_id: admin.id,
    author_email: admin.email,
    title: parsed.data.title,
    body: parsed.data.body,
    category: parsed.data.category,
    priority: parsed.data.priority,
    pinned: parsed.data.pinned,
  });

  if (!note) {
    const fallback = safeRedirect(parsed.data.redirect_to, "/admin/notes");
    redirect(`${fallback}?error=create_failed`);
  }

  await recordAdminActivity({
    actorId: admin.id,
    actorEmail: admin.email,
    action: "internal_note.created",
    targetTable: "organizations",
    targetId: parsed.data.org_id,
    metadata: {
      note_id: note!.id,
      category: parsed.data.category,
      priority: parsed.data.priority,
      pinned: parsed.data.pinned,
    },
  });

  // Urgent priority → HQ notification so the team sees it on
  // /admin/notifications. Customer-side NEVER notified (audience is
  // forced to 'hq' by notifyOnUrgentHqAlert).
  if (parsed.data.priority === "urgent") {
    await emitNotifications(
      notifyOnUrgentHqAlert({
        org_id: parsed.data.org_id,
        alert_label: `Urgent note · ${parsed.data.category}`,
        detail: parsed.data.title ?? parsed.data.body.slice(0, 200),
        alert_url: `/admin/customers/${parsed.data.org_id}`,
      }),
    );
  }

  revalidatePath("/admin/notes");
  revalidatePath(`/admin/customers/${parsed.data.org_id}`);
  const target = safeRedirect(parsed.data.redirect_to, "/admin/notes");
  redirect(`${target}?saved=note_created`);
}

// --------------------------------------------------------------------
// UPDATE
// --------------------------------------------------------------------

export async function updateNoteAction(formData: FormData): Promise<void> {
  const admin = await requireHq();
  const parsed = updateSchema.safeParse({
    id: formData.get("id"),
    title: formData.get("title") ?? undefined,
    body: formData.get("body") ?? undefined,
    category: formData.get("category") ?? undefined,
    priority: formData.get("priority") ?? undefined,
    pinned: formData.get("pinned") ?? undefined,
    redirect_to: formData.get("redirect_to") ?? undefined,
  });
  if (!parsed.success) {
    redirect("/admin/notes?error=invalid_input");
  }

  // Look up org_id BEFORE update so we can revalidate the right
  // customer page even if the update fails.
  const existing = await loadInternalNoteById(parsed.data.id);
  if (!existing) {
    redirect("/admin/notes?error=not_found");
  }

  const updated = await updateInternalNote({
    id: parsed.data.id,
    title: parsed.data.title,
    body: parsed.data.body,
    category: parsed.data.category,
    priority: parsed.data.priority,
    pinned: parsed.data.pinned,
  });

  if (!updated) {
    const fallback = safeRedirect(parsed.data.redirect_to, "/admin/notes");
    redirect(`${fallback}?error=update_failed`);
  }

  await recordAdminActivity({
    actorId: admin.id,
    actorEmail: admin.email,
    action: "internal_note.updated",
    targetTable: "organizations",
    targetId: existing!.org_id,
    metadata: {
      note_id: parsed.data.id,
      changed: Object.keys(parsed.data).filter(
        (k) => parsed.data[k as keyof typeof parsed.data] !== undefined &&
        k !== "id" && k !== "redirect_to",
      ),
    },
  });

  revalidatePath("/admin/notes");
  revalidatePath(`/admin/customers/${existing!.org_id}`);
  const target = safeRedirect(parsed.data.redirect_to, "/admin/notes");
  redirect(`${target}?saved=note_updated`);
}

// --------------------------------------------------------------------
// ARCHIVE / UNARCHIVE / PIN
// --------------------------------------------------------------------

export async function archiveNoteAction(formData: FormData): Promise<void> {
  const admin = await requireHq();
  const parsed = idOnlySchema.safeParse({
    id: formData.get("id"),
    redirect_to: formData.get("redirect_to") ?? undefined,
  });
  if (!parsed.success) redirect("/admin/notes?error=invalid_input");

  const existing = await loadInternalNoteById(parsed.data.id);
  if (!existing) redirect("/admin/notes?error=not_found");

  await archiveInternalNote(parsed.data.id);
  await recordAdminActivity({
    actorId: admin.id,
    actorEmail: admin.email,
    action: "internal_note.archived",
    targetTable: "organizations",
    targetId: existing!.org_id,
    metadata: { note_id: parsed.data.id },
  });
  revalidatePath("/admin/notes");
  revalidatePath(`/admin/customers/${existing!.org_id}`);
  const target = safeRedirect(parsed.data.redirect_to, "/admin/notes");
  redirect(`${target}?saved=note_archived`);
}

export async function unarchiveNoteAction(formData: FormData): Promise<void> {
  const admin = await requireHq();
  const parsed = idOnlySchema.safeParse({
    id: formData.get("id"),
    redirect_to: formData.get("redirect_to") ?? undefined,
  });
  if (!parsed.success) redirect("/admin/notes?error=invalid_input");

  const existing = await loadInternalNoteById(parsed.data.id);
  if (!existing) redirect("/admin/notes?error=not_found");

  await unarchiveInternalNote(parsed.data.id);
  await recordAdminActivity({
    actorId: admin.id,
    actorEmail: admin.email,
    action: "internal_note.unarchived",
    targetTable: "organizations",
    targetId: existing!.org_id,
    metadata: { note_id: parsed.data.id },
  });
  revalidatePath("/admin/notes");
  revalidatePath(`/admin/customers/${existing!.org_id}`);
  const target = safeRedirect(parsed.data.redirect_to, "/admin/notes");
  redirect(`${target}?saved=note_unarchived`);
}

export async function togglePinNoteAction(formData: FormData): Promise<void> {
  const admin = await requireHq();
  const parsed = idOnlySchema.safeParse({
    id: formData.get("id"),
    redirect_to: formData.get("redirect_to") ?? undefined,
  });
  if (!parsed.success) redirect("/admin/notes?error=invalid_input");

  const existing = await loadInternalNoteById(parsed.data.id);
  if (!existing) redirect("/admin/notes?error=not_found");

  await pinInternalNote(parsed.data.id, !existing.pinned);
  await recordAdminActivity({
    actorId: admin.id,
    actorEmail: admin.email,
    action: existing.pinned
      ? "internal_note.unpinned"
      : "internal_note.pinned",
    targetTable: "organizations",
    targetId: existing.org_id,
    metadata: { note_id: parsed.data.id },
  });
  revalidatePath("/admin/notes");
  revalidatePath(`/admin/customers/${existing.org_id}`);
  const target = safeRedirect(parsed.data.redirect_to, "/admin/notes");
  redirect(`${target}?saved=${existing.pinned ? "unpinned" : "pinned"}`);
}
