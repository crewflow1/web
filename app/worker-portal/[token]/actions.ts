"use server";

import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { randomUUID } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadWorkerSession } from "../_loader";
import { workerAcknowledgeSchema } from "@/lib/health-safety/worker-signoff-schema";
import { ackStatement, ACK_STATEMENT_VERSION } from "@/lib/health-safety/acknowledgements";
import { storeSignatureImage, deleteSignatureImage } from "@/server/services/signature-capture";
import { hashIp, getIpFromHeaders } from "@/lib/security/ip-hash";
import { consume, DEFAULT_LIMITS } from "@/lib/security/rate-limit";

/**
 * External worker sign-off action.
 *
 * The caller is anonymous — identified ONLY by the opaque URL token. Every
 * decision funnels through loadWorkerSession (the single authority): a bad /
 * expired / revoked token resolves to null and the write never happens. The
 * insert goes through the service-role admin client (the worker has no session
 * and worker_acknowledgements has no authenticated INSERT policy), and the DB
 * validate trigger re-derives org_id + job_id from the token and refuses any
 * subject that is not in the token's own org AND job — so this layer is input
 * validation + provenance capture + dispatch, never the isolation boundary.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FromChain = { from: (t: string) => any };

export async function acknowledgeAsWorker(token: string, formData: FormData): Promise<void> {
  const back = `/worker-portal/${encodeURIComponent(token)}`;

  // 1. Resolve the link — the ONLY gate. Fails closed on bad/expired/revoked.
  const session = await loadWorkerSession(token);
  if (!session) redirect(back);

  // 2. Rate-limit token+IP: blocks token-guessing + sign-off spam while letting
  //    a worker sign each of several documents in a sitting.
  const h = await headers();
  const ip = getIpFromHeaders(h) ?? "anonymous";
  const rl = await consume("quote_action", `${session!.token.id}:${ip}`, DEFAULT_LIMITS.quote_action);
  if (!rl.allowed) {
    redirect(`${back}?error=${encodeURIComponent("Too many attempts. Please wait a few minutes and try again.")}`);
  }

  // 3. Validate shape.
  const parsed = workerAcknowledgeSchema.safeParse({
    subjectType: formData.get("subjectType"),
    subjectId: formData.get("subjectId"),
    subjectVersion: formData.get("subjectVersion"),
    signedName: formData.get("signedName"),
    signatureDataUrl: formData.get("signatureDataUrl") ?? undefined,
  });
  if (!parsed.success) {
    redirect(`${back}?error=${encodeURIComponent(parsed.error.issues[0]?.message ?? "Invalid input")}`);
  }
  const v = parsed.data;

  // 4. Provenance — captured server-side so the client can't spoof/backdate it.
  const ipHash = hashIp(getIpFromHeaders(h));
  const userAgent = h.get("user-agent");

  // 5. Optional drawn signature: store the PNG first under an org-first key so we
  //    can reference its path on the (append-only) evidence row. Best-effort — a
  //    storage failure never blocks the sign-off; the typed name still records.
  const ackId = randomUUID();
  const drawn = v.signatureDataUrl
    ? await storeSignatureImage({
        orgId: session!.token.org_id,
        scope: "worker_signoff",
        subjectId: ackId,
        dataUrl: v.signatureDataUrl,
      })
    : null;

  const admin = createAdminClient();
  const { error } = await (admin as unknown as FromChain).from("worker_acknowledgements").insert({
    id: ackId,
    // org_id + job_id are authoritatively re-derived from the token by the DB
    // trigger — these are supplied for completeness and overwritten there.
    org_id: session!.token.org_id,
    token_id: session!.token.id,
    job_id: session!.token.job_id,
    subject_type: v.subjectType,
    subject_id: v.subjectId,
    subject_version: v.subjectVersion,
    signed_name: v.signedName,
    statement: ackStatement(v.subjectType, v.subjectVersion),
    statement_version: ACK_STATEMENT_VERSION,
    ip_hash: ipHash,
    user_agent: userAgent,
    signature_image_bucket: drawn?.bucket ?? null,
    signature_image_path: drawn?.path ?? null,
  });

  // 23505 = already signed this exact version through this link → idempotent
  // success; the just-uploaded image is an orphan (the original stands).
  if (error && (error as { code?: string }).code === "23505") {
    await deleteSignatureImage(drawn);
  } else if (error) {
    await deleteSignatureImage(drawn);
    // Log the real DB error server-side; NEVER reflect raw DB text to an
    // unauthenticated external worker (info disclosure). Surface a generic,
    // user-safe message instead.
    console.error("[worker-portal] acknowledgement insert failed", error);
    redirect(`${back}?error=${encodeURIComponent("Could not record your sign-off — please try again.")}`);
  }

  redirect(`${back}?saved=signed`);
}
