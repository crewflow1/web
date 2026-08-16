import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { readFailure } from "@/lib/supabase/read-failure";
import { isSuperAdminEmail } from "@/server/auth/superadmin";
import { recordAdminActivity } from "@/server/services/hq-audit";
import type { CeoBriefingCompetitorIntel } from "@/lib/hq/ceo-briefing";

/**
 * CrewFlow HQ — the Competitor Intelligence service (the CEO-briefing intel gap).
 *
 * The thin, super-admin-gated server API over the operator-authored competitor note
 * store (`hq_competitor_notes`, migration 20261161000000). Competitor references live
 * elsewhere only as marketing SEO copy; this is the live intel store the daily CEO
 * briefing reads.
 *
 * The boundary, made explicit:
 *   • Authoring a note (addCompetitorNote) is gated on isSuperAdminEmail HERE, in code —
 *     the write uses the service-role admin client, which BYPASSES RLS, so the gate
 *     cannot live in an RLS policy (the same reason all HQ access is a request-path
 *     gate). The note itself is written through the SECURITY DEFINER RPC
 *     `hq_competitor_note_add`, never a bare insert.
 *   • DETERMINISTIC + HONEST. No model call, no scraping, no inference — a note records
 *     exactly what an operator authored. The briefing projection copies fields verbatim
 *     and reports an honest "insufficient" when the store is empty.
 *
 * Every function returns a discriminated result; none throw on a business outcome.
 * The read fails LOUDLY (readFailure) rather than masking a query error as an empty
 * store — an unreadable signal must never look like "no competitors".
 */

type AdminClient = ReturnType<typeof createAdminClient>;

/** A persisted competitor note row (mirrors the hq_competitor_notes columns). */
export type CompetitorNoteRow = {
  id: string;
  competitor_name: string;
  headline: string;
  detail: string;
  category: string | null;
  source_url: string | null;
  memory_type: string;
  importance: string;
  status: string;
  captured_by: string | null;
  created_at: string;
  updated_at: string;
};

const NOTE_COLUMNS =
  "id, competitor_name, headline, detail, category, source_url, memory_type, importance, status, captured_by, created_at, updated_at";

/** The human authoring a note. The write is gated on this email's HQ status. */
export type Actor = { id: string | null; email: string | null };

export type AddCompetitorNoteInput = {
  actor: Actor;
  competitorName: string;
  headline: string;
  detail?: string;
  category?: string | null;
  sourceUrl?: string | null;
  importance?: "low" | "normal" | "high" | "critical";
};

export type AddCompetitorNoteResult =
  | { ok: true; note: CompetitorNoteRow }
  | {
      ok: false;
      reason:
        | "forbidden"
        | "name_required"
        | "headline_required"
        | "invalid_category"
        | "invalid_importance"
        | "error";
      error?: string;
    };

// hq_competitor_notes / hq_competitor_note_add are service-role-only HQ objects, not in
// the generated Supabase types — cast past the typed client (the same `as unknown as`
// shim the other HQ services use; a typing convenience, not logic).
type NoteEnvelope = { ok?: boolean; note?: CompetitorNoteRow | null; reason?: string };

function notes(admin: AdminClient) {
  return admin.from("hq_competitor_notes" as never) as unknown as {
    select(columns: string): {
      eq(column: string, value: unknown): {
        order(column: string, opts?: { ascending?: boolean }): {
          limit(count: number): PromiseLike<{
            data: CompetitorNoteRow[] | null;
            error: { message: string } | null;
          }>;
        };
      };
    };
  };
}

async function callRpc(
  admin: AdminClient,
  fn: string,
  args: Record<string, unknown>,
): Promise<{ data: NoteEnvelope | null; error: { message: string } | null }> {
  const rpc = admin.rpc.bind(admin) as unknown as (
    f: string,
    a: Record<string, unknown>,
  ) => PromiseLike<{ data: NoteEnvelope | null; error: { message: string } | null }>;
  return rpc(fn, args);
}

/**
 * Record an operator-authored competitor note through the sanctioned SECURITY DEFINER
 * writer. Super-admin only. Deterministic — records exactly what was supplied.
 */
export async function addCompetitorNote(
  input: AddCompetitorNoteInput,
): Promise<AddCompetitorNoteResult> {
  if (!isSuperAdminEmail(input.actor.email)) return { ok: false, reason: "forbidden" };

  const admin = createAdminClient();
  const { data, error } = await callRpc(admin, "hq_competitor_note_add", {
    p_competitor_name: input.competitorName,
    p_headline: input.headline,
    p_detail: input.detail ?? "",
    p_category: input.category ?? null,
    p_source_url: input.sourceUrl ?? null,
    p_importance: input.importance ?? "normal",
    p_captured_by: input.actor.email,
  });

  if (error) return { ok: false, reason: "error", error: error.message };
  if (data?.ok === true && data.note) {
    await recordAdminActivity({
      actorId: input.actor.id,
      actorEmail: input.actor.email,
      action: "competitor_note.added",
      targetTable: "hq_competitor_notes",
      targetId: data.note.id,
      metadata: { competitor: data.note.competitor_name, importance: data.note.importance },
    });
    return { ok: true, note: data.note };
  }
  const reason = data?.reason;
  if (
    reason === "name_required" ||
    reason === "headline_required" ||
    reason === "invalid_category" ||
    reason === "invalid_importance"
  ) {
    return { ok: false, reason };
  }
  return { ok: false, reason: "error", error: "hq_competitor_note_add: malformed response" };
}

/** How many notes the briefing shows — a bounded, recent window. */
export const BRIEFING_COMPETITOR_LIMIT = 8;

/**
 * Read the most recent ACTIVE competitor notes and project them onto the briefing's
 * competitor snapshot. LOUD read: a query error throws (never masked as an empty store).
 * `total` is the count of returned notes; the composer reports honest "insufficient"
 * when empty.
 */
export async function loadCompetitorIntelForBriefing(
  limit: number = BRIEFING_COMPETITOR_LIMIT,
): Promise<CeoBriefingCompetitorIntel> {
  const admin = createAdminClient();
  const bounded = Math.min(Math.max(limit, 1), 50);
  const { data, error } = await notes(admin)
    .select(NOTE_COLUMNS)
    .eq("status", "active")
    .order("created_at", { ascending: false })
    .limit(bounded);
  if (error) throw readFailure("hq-competitor-intel: active notes", error);

  const rows = Array.isArray(data) ? data : [];
  return {
    total: rows.length,
    notes: rows.map((r) => ({
      name: r.competitor_name,
      headline: r.headline,
      category: r.category,
      importance: r.importance,
      capturedAt: r.created_at.slice(0, 10),
    })),
  };
}
