"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { acknowledgeSchema } from "@/lib/health-safety/acknowledgements-schema";
import { ackStatement, ACK_STATEMENT_VERSION, type AckSubjectType } from "@/lib/health-safety/acknowledgements";

/**
 * Operative sign-off action (shared by RAMS + permits). Tenant (user-JWT) client
 * only → RLS scopes it AND enforces `user_id = auth.uid()` (a worker signs only as
 * themselves). The DB validates the rest — subject issued, version anchor,
 * membership, append-only. Re-signing the same issued version is idempotent.
 */

type FromChain = { from: (t: string) => any }; // eslint-disable-line @typescript-eslint/no-explicit-any

function subjectPath(subjectType: AckSubjectType, subjectId: string): string {
  if (subjectType === "permit_to_work") return `/health-safety/permits/${subjectId}`;
  if (subjectType === "toolbox_talk") return `/toolbox/${subjectId}`;
  return `/health-safety/${subjectId}`;
}

export async function acknowledgeSafetyDocument(formData: FormData): Promise<void> {
  const { user, ctx } = await requireOrgContext();
  const parsed = acknowledgeSchema.safeParse({
    subjectType: formData.get("subjectType"),
    subjectId: formData.get("subjectId"),
    subjectVersion: formData.get("subjectVersion"),
    signedName: formData.get("signedName"),
  });
  const rawId = String(formData.get("subjectId") ?? "");
  const rawType = String(formData.get("subjectType") ?? "risk_assessment") as AckSubjectType;
  const back = subjectPath(rawType, rawId);
  if (!parsed.success) redirect(`${back}?error=${encodeURIComponent(parsed.error.issues[0]?.message ?? "Invalid input")}`);
  const v = parsed.data;

  const supabase = await createClient();
  const { error } = await (supabase as unknown as FromChain).from("safety_acknowledgements").insert({
    // org_id is authoritatively re-derived from the subject by the DB trigger.
    org_id: ctx.org.id,
    subject_type: v.subjectType,
    subject_id: v.subjectId,
    subject_version: v.subjectVersion,
    user_id: user.id,
    statement: ackStatement(v.subjectType, v.subjectVersion),
    statement_version: ACK_STATEMENT_VERSION,
    signed_name: v.signedName,
  });
  // 23505 = already acknowledged this exact version → idempotent success.
  if (error && (error as { code?: string }).code !== "23505") {
    redirect(`${subjectPath(v.subjectType, v.subjectId)}?error=${encodeURIComponent(error.message)}`);
  }
  const dest = subjectPath(v.subjectType, v.subjectId);
  revalidatePath(dest);
  redirect(`${dest}?saved=acknowledged`);
}
