import "server-only";
import { createClient } from "@/lib/supabase/server";
import { fetchAllRows, type PageResult } from "@/lib/supabase/paginate";
import { readFailure, type SupabaseReadError } from "@/lib/supabase/read-failure";
import {
  QUALIFICATION_EXPIRY_WINDOW_DAYS,
  addDaysIso,
  daysUntil,
  qualificationExpiryStatus,
} from "@/lib/staff/qualifications";

/**
 * Staff qualifications — the READ layer (server/services/staff-qualifications.ts).
 *
 * FETCHES only; it never writes. Two consumers:
 *   1. the staff detail page — the full list for one member (loud);
 *   2. the daily briefing — org-wide expired/expiring COUNTS (loud).
 *
 * SCOPING: RLS admits any org member to SELECT, and every read here ALSO pins
 * `org_id` on top of RLS — current_org_ids() returns every org the viewer
 * belongs to, so an RLS-only read would blend a dual-org member's tenants (the
 * #456 class). Paged via fetchAllRows with the unique `id` tiebreak so a busy
 * org is never silently truncated at the 1000-row cap.
 */

type Row = Record<string, unknown>;

/**
 * Loose, self-returning READ view of the PostgREST builder — enough for the
 * chains below without fighting the generated types. Mirrors the briefing
 * service's LooseClient.
 */
type QualBuilder = PromiseLike<{ data: Row[] | null; error: unknown }> & {
  select: (c: string) => QualBuilder;
  eq: (k: string, v: unknown) => QualBuilder;
  not: (k: string, op: string, v: null) => QualBuilder;
  gte: (k: string, v: unknown) => QualBuilder;
  lte: (k: string, v: unknown) => QualBuilder;
  order: (k: string, o: { ascending: boolean }) => QualBuilder;
  range: (f: number, t: number) => PromiseLike<PageResult<Row>>;
};
export type StaffQualificationsClient = { from: (t: string) => QualBuilder };

export interface StaffQualificationRow {
  id: string;
  user_id: string;
  qualification_type: string;
  title: string;
  reference_no: string | null;
  issued_on: string | null;
  expires_on: string | null;
  document_bucket: string | null;
  document_path: string | null;
  notes: string | null;
  created_at: string;
}

/**
 * Every qualification recorded for ONE member of ONE org, newest expiry first
 * (rows with no expiry last), then by title. LOUD: a read error throws
 * readFailure so the staff page shows its error boundary rather than a false
 * "no qualifications" empty state.
 */
export async function listStaffQualifications(
  orgId: string,
  userId: string,
): Promise<StaffQualificationRow[]> {
  const supabase = await createClient();
  const db = supabase as unknown as StaffQualificationsClient;
  const { data, error } = await fetchAllRows<Row>((from, to) =>
    db
      .from("staff_qualifications")
      .select(
        "id, user_id, qualification_type, title, reference_no, issued_on, expires_on, document_bucket, document_path, notes, created_at",
      )
      .eq("org_id", orgId)
      .eq("user_id", userId)
      .order("id", { ascending: true })
      .range(from, to),
  );
  if (error) throw readFailure("staff detail: qualifications", error as SupabaseReadError);

  const rows = (data as unknown as StaffQualificationRow[]).slice();
  // Deterministic display order: soonest expiry first, no-expiry last, then
  // title, then id — total and reproducible.
  rows.sort((a, b) => {
    const ax = a.expires_on ?? "￿";
    const bx = b.expires_on ?? "￿";
    if (ax !== bx) return ax < bx ? -1 : 1;
    if (a.title !== b.title) return a.title < b.title ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return rows;
}

export interface StaffQualificationSignal {
  expired: number;
  expiring: { count: number; soonestDays: number | null };
}

export const EMPTY_STAFF_QUAL_SIGNAL: StaffQualificationSignal = {
  expired: 0,
  expiring: { count: 0, soonestDays: null },
};

/**
 * Org-wide expired + expiring qualification counts for the daily briefing.
 *
 * LOUD (throws on read error): qualifications are an EXPIRY signal, and a
 * swallowed error would render a false all-clear on a lapsed CSCS card while the
 * rest of the briefing looks healthy — the exact silent-under-count the briefing's
 * compliance read was hardened against. The caller's outer catch degrades the
 * WHOLE briefing to its honest empty state instead.
 *
 * Bounded like the compliance read: only rows with `expires_on <= today + window`
 * are read (everything still comfortably valid is irrelevant and never crowds the
 * page), then each is classified deterministically against `todayIso`.
 */
export async function loadStaffQualificationSignal(
  db: StaffQualificationsClient,
  orgId: string,
  todayIso: string,
): Promise<StaffQualificationSignal> {
  const cutoffIso = addDaysIso(todayIso, QUALIFICATION_EXPIRY_WINDOW_DAYS);
  const { data, error } = await fetchAllRows<Row>((from, to) =>
    db
      .from("staff_qualifications")
      .select("id, expires_on")
      .eq("org_id", orgId)
      .not("expires_on", "is", null)
      .lte("expires_on", cutoffIso)
      .order("expires_on", { ascending: true })
      .order("id", { ascending: true })
      .range(from, to),
  );
  if (error) throw readFailure("briefing: staff qualifications", error as SupabaseReadError);

  let expired = 0;
  let expiringCount = 0;
  let soonestDays: number | null = null;
  for (const r of data) {
    const exp = (r.expires_on as string | null) ?? null;
    const status = qualificationExpiryStatus(exp, todayIso);
    if (status === "expired") {
      expired += 1;
    } else if (status === "expiring" && exp) {
      expiringCount += 1;
      const d = Math.max(0, daysUntil(exp, todayIso) ?? 0);
      soonestDays = soonestDays == null ? d : Math.min(soonestDays, d);
    }
  }
  return { expired, expiring: { count: expiringCount, soonestDays } };
}
