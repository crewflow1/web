"use server";

import { revalidatePath } from "next/cache";
import {
  listPinsForVersion, listLinkableSnags, listAssignableMembers,
  createNotePin, createSnagPin, linkSnagPin, createTaskPin, updateTaskPin,
  movePin, deletePin,
  type PinResult,
} from "@/server/services/blueprint-pins";
import {
  listPinComments, createPinComment, deletePinComment, type CommentResult,
} from "@/server/services/blueprint-pin-comments";
import {
  listPinPhotos, uploadPinPhoto, deletePinPhoto, type PinPhoto,
} from "@/server/services/blueprint-pin-photos";
import type { PinComment } from "@/lib/blueprints/pin-comments";
import type {
  BlueprintPin, CreateNotePinInput, CreateSnagPinInput, LinkSnagPinInput, MovePinInput,
  CreateTaskPinInput, UpdateTaskPinInput,
} from "@/lib/blueprints/pins";

/**
 * Server actions for the Blueprint Pins layer. The viewer is a client component
 * (dynamic ssr:false), so it calls these to read/mutate pins in place. Each
 * mutation revalidates the register route so a server re-render reflects it.
 */

export async function getPinsAction(versionId: string): Promise<BlueprintPin[]> {
  return listPinsForVersion(versionId);
}

export async function getLinkableSnagsAction(jobId: string): Promise<{ id: string; title: string; status: string }[]> {
  return listLinkableSnags(jobId);
}

export async function placeNotePinAction(jobId: string, input: CreateNotePinInput): Promise<PinResult> {
  const res = await createNotePin(input);
  if (res.ok) revalidatePath(`/jobs/${jobId}/blueprints`);
  return res;
}

export async function placeSnagPinAction(jobId: string, input: CreateSnagPinInput): Promise<PinResult> {
  const res = await createSnagPin(input);
  if (res.ok) revalidatePath(`/jobs/${jobId}/blueprints`);
  return res;
}

export async function linkSnagPinAction(jobId: string, input: LinkSnagPinInput): Promise<PinResult> {
  const res = await linkSnagPin(input);
  if (res.ok) revalidatePath(`/jobs/${jobId}/blueprints`);
  return res;
}

export async function movePinAction(jobId: string, input: MovePinInput): Promise<PinResult> {
  const res = await movePin(input);
  if (res.ok) revalidatePath(`/jobs/${jobId}/blueprints`);
  return res;
}

export async function deletePinAction(jobId: string, pinId: string): Promise<PinResult> {
  const res = await deletePin(pinId);
  if (res.ok) revalidatePath(`/jobs/${jobId}/blueprints`);
  return res;
}

// ── task pins ────────────────────────────────────────────────────────────────

export async function getAssignableMembersAction(): Promise<{ id: string; name: string }[]> {
  return listAssignableMembers();
}

export async function placeTaskPinAction(jobId: string, input: CreateTaskPinInput): Promise<PinResult> {
  const res = await createTaskPin(input);
  if (res.ok) revalidatePath(`/jobs/${jobId}/blueprints`);
  return res;
}

export async function updateTaskPinAction(jobId: string, input: UpdateTaskPinInput): Promise<PinResult> {
  const res = await updateTaskPin(input);
  if (res.ok) revalidatePath(`/jobs/${jobId}/blueprints`);
  return res;
}

// ── threaded comments ────────────────────────────────────────────────────────

export async function getPinCommentsAction(pinId: string): Promise<PinComment[]> {
  return listPinComments(pinId);
}

export async function addPinCommentAction(
  jobId: string,
  input: { pin_id: string; body: string; parent_comment_id?: string },
): Promise<CommentResult> {
  const res = await createPinComment(input);
  if (res.ok) revalidatePath(`/jobs/${jobId}/blueprints`);
  return res;
}

export async function deletePinCommentAction(jobId: string, commentId: string): Promise<CommentResult> {
  const res = await deletePinComment(commentId);
  if (res.ok) revalidatePath(`/jobs/${jobId}/blueprints`);
  return res;
}

// ── direct pin photos ────────────────────────────────────────────────────────

export async function getPinPhotosAction(pinId: string): Promise<PinPhoto[]> {
  return listPinPhotos(pinId);
}

export async function uploadPinPhotoAction(
  formData: FormData,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const pinId = String(formData.get("pin_id") ?? "");
  const file = formData.get("file");
  if (!pinId) return { ok: false, error: "pin_not_found" };
  if (!(file instanceof File) || file.size === 0) return { ok: false, error: "no_file" };
  const bytes = new Uint8Array(await file.arrayBuffer());
  const res = await uploadPinPhoto({ pinId, filename: file.name, mimeType: file.type, bytes });
  if (!res.ok) return { ok: false, error: res.error };
  return { ok: true };
}

export async function deletePinPhotoAction(attachmentId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const res = await deletePinPhoto(attachmentId);
  if (!res.ok) return { ok: false, error: res.error };
  return { ok: true };
}
