import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { embeddingChecksum } from "@/lib/ai/embeddings/versioning";
import {
  SOURCE_MAPPERS,
  toDocument,
  type SourceMapper,
  type SourceRow,
} from "@/lib/search/semantic/mappers";

/**
 * Tenant Semantic Search — the corpus backfill / sync.
 *
 * Reads source rows through the ADMIN client (service-role; the corpus table is
 * RLS zero-policy), maps each to a money-free, allowlisted document via the TS
 * mappers, and UPSERTs it into tenant_search_documents keyed on
 * (org_id, source_table, source_id). The drift trigger re-queues a row for
 * embedding only when its content actually changed, so re-syncing unchanged rows
 * is cheap and never causes a requeue storm.
 *
 * DARK-SAFE and provider-INDEPENDENT: this populates CONTENT (which also feeds
 * the lexical channel); it never calls an embedding provider. Vector generation
 * is the separate worker, gated on the embeddings credential.
 *
 * BOUNDED: each run syncs at most `perTableLimit` most-recently-updated rows per
 * source table — enough to keep an active tenant's recent edits fresh on a
 * per-minute cron. (A full cursor-based incremental sweep is a follow-up; for a
 * dark feature this bounded refresh is sufficient and safe.)
 */

type ReadResult = { data: SourceRow[] | null; error: { message: string } | null };
type Reader = {
  from: (t: string) => {
    select: (c: string) => {
      order: (c: string, o: { ascending: boolean }) => {
        limit: (n: number) => Promise<ReadResult>;
      };
    };
  };
};
type Writer = {
  from: (t: string) => {
    upsert: (r: unknown[], o: { onConflict: string }) => Promise<{ error: { message: string } | null }>;
  };
};

export type BackfillSummary = {
  ok: boolean;
  /** Documents upserted, per source table. */
  upserted: Record<string, number>;
  /** Total documents upserted this run. */
  total: number;
  error?: string;
};

/** The columns a mapper needs read: org_id + its id + jobId + visibility + allowlist. */
function selectColumns(m: SourceMapper): string {
  const cols = new Set<string>(["org_id", m.sourceIdFrom, ...m.allowedColumns]);
  if (m.jobIdFrom) cols.add(m.jobIdFrom);
  // job_documents carry their own visibility; read it so the mapper can derive.
  if (m.sourceTable === "job_documents") cols.add("visibility");
  return [...cols].join(", ");
}

export async function runTenantSearchBackfill(
  opts: { perTableLimit?: number } = {},
): Promise<BackfillSummary> {
  // Provably clamped to the PostgREST max_rows (1000) so the F-1 static analyser
  // can prove the bound; the bounded-batch classification is in the F-1
  // BOUNDARY_ALLOWLIST (this is a refresh batch, not a completeness read).
  const perTableLimit = Math.max(1, Math.min(opts.perTableLimit ?? 500, 1000));
  const admin = createAdminClient();
  const reader = admin as unknown as Reader;
  const writer = admin as unknown as Writer;
  const upserted: Record<string, number> = {};
  let total = 0;

  try {
    for (const mapper of SOURCE_MAPPERS) {
      upserted[mapper.sourceTable] = 0;

      const { data, error } = await reader
        .from(mapper.sourceTable)
        .select(selectColumns(mapper))
        .order("updated_at", { ascending: false })
        .limit(perTableLimit);
      // One table failing (e.g. a column that does not exist on this deploy)
      // must not abort the whole sync — skip it and continue.
      if (error) continue;

      // Pair each row with its mapped document BEFORE filtering, so org_id (not
      // part of the embeddable document) stays attached to the right row.
      const payload: Array<Record<string, unknown>> = [];
      for (const row of data ?? []) {
        const doc = toDocument(mapper, row);
        if (!doc) continue;
        const orgId = typeof row.org_id === "string" ? row.org_id : null;
        if (!orgId) continue;
        payload.push({
          org_id: orgId,
          source_table: doc.sourceTable,
          source_id: doc.sourceId,
          job_id: doc.jobId,
          visibility: doc.visibility,
          content: doc.content,
          content_checksum: embeddingChecksum(doc.content),
        });
      }
      if (payload.length === 0) continue;

      const up = await writer
        .from("tenant_search_documents")
        .upsert(payload, { onConflict: "org_id,source_table,source_id" });
      if (up.error) continue;

      upserted[mapper.sourceTable] = payload.length;
      total += payload.length;
    }

    return { ok: true, upserted, total };
  } catch (e) {
    return { ok: false, upserted, total, error: e instanceof Error ? e.message : String(e) };
  }
}
