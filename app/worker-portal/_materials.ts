import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { readFailure } from "@/lib/supabase/read-failure";
import { fetchAllRows } from "@/lib/supabase/paginate";
import type { AckSubjectType } from "@/lib/health-safety/acknowledgements";

/**
 * Read the H&S materials a worker link may see, and the evidence it has already
 * produced. EVERY query here is scoped by BOTH org_id AND job_id taken from the
 * validated session (never from the URL or client) — the token can only ever
 * reach its own org's job. The service-role client bypasses RLS, so this
 * code-level org+job scoping is the read-side half of the isolation the DB
 * validate trigger enforces on writes.
 *
 * Only LIVE, SIGNABLE documents are surfaced:
 *   * risk assessments — status 'issued'
 *   * toolbox talks     — status 'issued'
 *   * permits           — status 'issued' or 'active' (validity window shown)
 * Draft / superseded / withdrawn documents are never leaked to an external
 * worker.
 */

export type WorkerMaterial = {
  subjectType: AckSubjectType;
  subjectId: string;
  /** The issued reference (RA-/TBT-/PTW-NNNN) — also the version anchor. */
  reference: string;
  title: string;
  meta: string | null;
  acknowledged: boolean;
  acknowledgedAt: string | null;
};

type AckRow = {
  subject_type: AckSubjectType;
  subject_id: string;
  subject_version: string;
  acknowledged_at: string;
};

// These H&S tables post-date the generated Supabase types, so reads cast through
// a loose from-chain (the safety_acknowledgements / snags idiom).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FromChain = { from: (t: string) => any };

export async function loadWorkerMaterials(
  orgId: string,
  jobId: string,
  tokenId: string,
): Promise<WorkerMaterial[]> {
  const admin = createAdminClient() as unknown as FromChain;

  // What this link has ALREADY signed (scoped to THIS token's evidence only).
  // PAGED (F-1): a worker may sign many documents on one job; a bare select
  // would clamp at PostgREST max_rows and mis-render a signed doc as unsigned.
  const { data: acksRaw, error: acksErr } = await fetchAllRows<AckRow>((from, to) =>
    admin
      .from("worker_acknowledgements")
      .select("subject_type, subject_id, subject_version, acknowledged_at")
      .eq("org_id", orgId)
      .eq("token_id", tokenId)
      .order("acknowledged_at", { ascending: true })
      .range(from, to) as PromiseLike<{ data: AckRow[] | null; error: unknown }>,
  );
  if (acksErr) throw readFailure("worker-portal: acknowledgements", acksErr);
  const acks = acksRaw ?? [];
  const isSigned = (t: AckSubjectType, id: string, version: string) =>
    acks.find((a) => a.subject_type === t && a.subject_id === id && a.subject_version === version) ?? null;

  const [ras, permits, talks] = await Promise.all([
    admin
      .from("risk_assessments")
      .select("id, reference, title, activity, status")
      .eq("org_id", orgId)
      .eq("job_id", jobId)
      .eq("status", "issued")
      .order("reference", { ascending: true }),
    admin
      .from("permits_to_work")
      .select("id, reference, title, permit_type, status, valid_until")
      .eq("org_id", orgId)
      .eq("job_id", jobId)
      .in("status", ["issued", "active"])
      .order("reference", { ascending: true }),
    admin
      .from("toolbox_talks")
      .select("id, reference, topic, presenter, status")
      .eq("org_id", orgId)
      .eq("job_id", jobId)
      .eq("status", "issued")
      .order("reference", { ascending: true }),
  ]);
  if (ras.error) throw readFailure("worker-portal: risk assessments", ras.error);
  if (permits.error) throw readFailure("worker-portal: permits", permits.error);
  if (talks.error) throw readFailure("worker-portal: toolbox talks", talks.error);

  const out: WorkerMaterial[] = [];

  for (const r of (ras.data ?? []) as Array<{ id: string; reference: string | null; title: string; activity: string | null }>) {
    if (!r.reference) continue;
    const signed = isSigned("risk_assessment", r.id, r.reference);
    out.push({
      subjectType: "risk_assessment",
      subjectId: r.id,
      reference: r.reference,
      title: r.title,
      meta: r.activity ?? null,
      acknowledged: !!signed,
      acknowledgedAt: signed?.acknowledged_at ?? null,
    });
  }
  for (const p of (permits.data ?? []) as Array<{ id: string; reference: string | null; title: string; permit_type: string; valid_until: string | null }>) {
    if (!p.reference) continue;
    const signed = isSigned("permit_to_work", p.id, p.reference);
    out.push({
      subjectType: "permit_to_work",
      subjectId: p.id,
      reference: p.reference,
      title: p.title,
      meta: p.permit_type.replace(/_/g, " "),
      acknowledged: !!signed,
      acknowledgedAt: signed?.acknowledged_at ?? null,
    });
  }
  for (const t of (talks.data ?? []) as Array<{ id: string; reference: string | null; topic: string; presenter: string | null }>) {
    if (!t.reference) continue;
    const signed = isSigned("toolbox_talk", t.id, t.reference);
    out.push({
      subjectType: "toolbox_talk",
      subjectId: t.id,
      reference: t.reference,
      title: t.topic,
      meta: t.presenter ? `Presented by ${t.presenter}` : null,
      acknowledged: !!signed,
      acknowledgedAt: signed?.acknowledged_at ?? null,
    });
  }

  return out;
}
