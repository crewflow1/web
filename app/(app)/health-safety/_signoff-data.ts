import { createClient } from "@/lib/supabase/server";
import { readFailure, type SupabaseReadError } from "@/lib/supabase/read-failure";
import type { AcknowledgementRow } from "@/lib/health-safety/acknowledgements-schema";
import type { AckSubjectType, RevisableSubject } from "@/lib/health-safety/acknowledgements";
import { RAMS_REVISABLE } from "@/lib/health-safety/acknowledgements";

/**
 * Operative sign-off read layer (shared by the RAMS + permit detail pages).
 * Tenant (user-JWT) client only → RLS-scoped; never the service-role client.
 * safety_acknowledgements post-dates the generated types → precise-shape cast.
 */

type AckWithName = AcknowledgementRow & { signer_name: string };

export async function listAcknowledgements(
  subjectType: AckSubjectType,
  subjectId: string,
): Promise<AckWithName[]> {
  const supabase = await createClient();
  const { data, error } = await (supabase as unknown as {
    from: (t: string) => { select: (c: string) => { eq: (k: string, v: string) => { eq: (k: string, v: string) => { order: (k: string, o: { ascending: boolean }) => Promise<{ data: Array<AcknowledgementRow & { users: { full_name: string | null; email: string | null } | null }> | null; error: SupabaseReadError | null }> } } } };
  })
    .from("safety_acknowledgements")
    .select("id, org_id, subject_type, subject_id, subject_version, user_id, acknowledged_at, statement, statement_version, signed_name, users(full_name, email)")
    .eq("subject_type", subjectType)
    .eq("subject_id", subjectId)
    .order("acknowledged_at", { ascending: false });
  if (error) throw readFailure("health-safety: acknowledgements", error);
  return (data ?? []).map((a) => ({ ...a, signer_name: a.users?.full_name || a.users?.email || a.signed_name }));
}

/** Count of org members (the acknowledgement "expected" denominator). */
export async function countOrgMembers(): Promise<number> {
  const supabase = await createClient();
  const { count, error } = await (supabase as unknown as {
    from: (t: string) => { select: (c: string, o: { count: string; head: boolean }) => Promise<{ count: number | null; error: SupabaseReadError | null }> };
  })
    .from("memberships")
    .select("user_id", { count: "exact", head: true });
  if (error) throw readFailure("health-safety: member count", error);
  return count ?? 0;
}

/**
 * Did the current user acknowledge an EARLIER revision of this series? Used to prompt
 * re-acknowledgement on a new revision (M6c / toolbox M3): "you signed Rev N — please
 * re-acknowledge Rev N+1". Two bounded, RLS-scoped reads. Returns the highest earlier
 * revision the user signed, or null.
 *
 * Generic over any RevisableSubject (RAMS, toolbox talk) — the table, series-root
 * column and ack subject_type come from the config, so there are no hardcoded RAMS
 * literals here. `subjectRef` defaults to RAMS to keep the existing RAMS callers
 * working unchanged.
 */
export type PriorSignoff = { reference: string | null; revisionNumber: number; acknowledgedAt: string };
export async function priorRevisionSignoff(
  rootId: string,
  currentRevision: number,
  userId: string,
  subject: RevisableSubject = RAMS_REVISABLE,
): Promise<PriorSignoff | null> {
  if (currentRevision <= 1) return null;
  const supabase = await createClient();
  const { data: earlier } = await (supabase as unknown as {
    from: (t: string) => { select: (c: string) => { eq: (k: string, v: string) => { lt: (k: string, v: number) => Promise<{ data: Array<{ id: string; reference: string | null; revision_number: number }> | null }> } } };
  })
    .from(subject.table).select("id, reference, revision_number")
    .eq(subject.rootColumn, rootId).lt("revision_number", currentRevision);
  const revs = earlier ?? [];
  if (revs.length === 0) return null;
  const byId = new Map(revs.map((r) => [r.id, r]));
  const { data: acks } = await (supabase as unknown as {
    from: (t: string) => { select: (c: string) => { eq: (k: string, v: string) => { eq: (k: string, v: string) => { in: (k: string, v: string[]) => Promise<{ data: Array<{ subject_id: string; acknowledged_at: string }> | null }> } } } };
  })
    .from("safety_acknowledgements").select("subject_id, acknowledged_at")
    .eq("subject_type", subject.subjectType).eq("user_id", userId).in("subject_id", revs.map((r) => r.id));
  let best: PriorSignoff | null = null;
  for (const a of acks ?? []) {
    const rev = byId.get(a.subject_id);
    if (rev && (!best || rev.revision_number > best.revisionNumber)) {
      best = { reference: rev.reference, revisionNumber: rev.revision_number, acknowledgedAt: a.acknowledged_at };
    }
  }
  return best;
}

export type Operative = { id: string; name: string };

/**
 * The operatives REQUIRED to acknowledge a job's safety documents — the distinct
 * users rota'd to the job. `rota_entries` is the platform's canonical "who is on
 * this job" source (declared canonical in 20260523), so H&S reuses it rather than
 * keeping a second workforce list. Empty when the document has no job link: we
 * never invent a requirement. RLS-scoped (rota is org-member-readable).
 */
export async function requiredOperatives(jobId: string | null): Promise<Operative[]> {
  if (!jobId) return [];
  const supabase = await createClient();
  const { data: rows, error } = await (supabase as unknown as {
    from: (t: string) => { select: (c: string) => { eq: (k: string, v: string) => Promise<{ data: Array<{ user_id: string }> | null; error: SupabaseReadError | null }> } };
  })
    .from("rota_entries").select("user_id").eq("job_id", jobId);
  if (error) throw readFailure("health-safety: rota required operatives", error);
  const ids = [...new Set((rows ?? []).map((r) => r.user_id))];
  if (ids.length === 0) return [];
  // Names via the same memberships→users embed listAssessors uses (unambiguous FK).
  const { data: members } = await (supabase as unknown as {
    from: (t: string) => { select: (c: string) => { in: (k: string, v: string[]) => Promise<{ data: Array<{ user_id: string; users: { full_name: string | null; email: string | null } | null }> | null }> } };
  })
    .from("memberships").select("user_id, users(full_name, email)").in("user_id", ids);
  const nameById = new Map((members ?? []).map((m) => [m.user_id, m.users?.full_name || m.users?.email || "Operative"]));
  return ids.map((id) => ({ id, name: nameById.get(id) ?? "Operative" }));
}
