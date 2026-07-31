"use server";

import { revalidatePath } from "next/cache";
import { requireOrgContext } from "@/server/auth/session";
import {
  dispatchOfflineWrite,
  type OfflineWriteOutcome,
  type QueuedWriteEnvelope,
} from "@/server/services/offline-writes";
import { isOfflineWriteKind, offlineWriteEntity } from "@/lib/offline/registry";

/**
 * The ONE server entry point for the offline write queue.
 *
 * It is deliberately thin. Everything that decides whether a queued write is
 * allowed lives in `dispatchOfflineWrite` (registry gate, active-org pin, schema,
 * tenant client, RLS) — this file only establishes WHO is asking, using exactly the
 * same call every online page and action uses:
 *
 *     const { ctx, user } = await requireOrgContext();
 *
 * Consequences worth stating plainly, because they are the security model:
 *   - `requireOrgContext()` REDIRECTS when there is no session (or the org has no
 *     active access). Inside a server action that redirect surfaces to the client as
 *     a thrown error, which the outbox treats as TRANSIENT — so a queued write is
 *     never destroyed by an expired cookie. It simply waits for a real session.
 *   - The org is read from the caller's own session and active-org cookie. A queued
 *     item cannot name the org it wants to be written to; it can only be REFUSED
 *     for naming a different one.
 *   - There is no batch/admin/service-role variant of this action, and no argument
 *     that changes who the write is attributed to. `created_by` is the session user.
 *
 * One item per call, on purpose: a batch would have to decide what "partially
 * succeeded" means, and the client already drains in `seq` order and stops on the
 * first transient failure so ordering is preserved without that ambiguity.
 */
export async function syncQueuedWrite(
  item: QueuedWriteEnvelope,
): Promise<OfflineWriteOutcome> {
  const { ctx, user } = await requireOrgContext();

  const outcome = await dispatchOfflineWrite({ ctx, user, item });

  // Only a real write invalidates a cached page. A duplicate replay changed
  // nothing, and a rejection wrote nothing.
  if (outcome.status === "accepted" && isOfflineWriteKind(item.kind)) {
    revalidatePath(offlineWriteEntity(item.kind).viewHref);
  }
  return outcome;
}
