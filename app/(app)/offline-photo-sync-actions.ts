"use server";

import { revalidatePath } from "next/cache";
import { requireOrgContext } from "@/server/auth/session";
import {
  dispatchOfflinePhoto,
  type OfflinePhotoOutcome,
  type QueuedPhotoEnvelope,
} from "@/server/services/offline-photo-writes";

/**
 * The ONE server entry point for the offline PHOTO queue.
 *
 * Thin by design, exactly like syncQueuedWrite: everything that decides whether a
 * capture may be stored lives in `dispatchOfflinePhoto` (envelope shape, MIME/size,
 * active-org pin, target-org verification, RLS row insert, idempotency). This file
 * only establishes WHO is asking, with the same call every online page uses:
 *
 *     const { ctx, user } = await requireOrgContext();
 *
 * Consequences (the security model): `requireOrgContext()` REDIRECTS with no
 * session, surfacing to the client as a thrown error the outbox treats as
 * TRANSIENT — a queued capture is never destroyed by an expired cookie. The org is
 * the caller's own active org; a capture can only be REFUSED for naming another,
 * never re-homed. There is no batch/admin/impersonating variant, and `uploaded_by`
 * is the session user.
 */
export async function syncQueuedPhoto(
  item: QueuedPhotoEnvelope,
): Promise<OfflinePhotoOutcome> {
  const { ctx, user } = await requireOrgContext();

  const outcome = await dispatchOfflinePhoto({ ctx, user, item });

  // Only a real upload invalidates a cached page; a duplicate/rejection wrote no
  // new attachment. The photo appears under its target entity's detail page.
  if (outcome.status === "accepted") {
    revalidatePath(`/${item.targetTable}`);
  }
  return outcome;
}
