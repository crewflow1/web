/**
 * Companies House FREE bulk-dataset importer — NI construction eligible-pool refresh.
 *
 * Runs OUTSIDE the Next app, in a scheduled GitHub-Actions Node process (see
 * .github/workflows/companies-house-bulk-sourcing.yml). Chosen over Vercel
 * because the monthly file is ~470 MB zipped / multi-GB CSV — far past serverless
 * memory/duration/ephemeral-storage limits. GitHub runners have ~14 GB RAM + ample
 * disk and generous free minutes; a monthly ~5–10 min job is near-£0.
 *
 * MEMORY SAFETY: the file is downloaded to a temp path, then decompressed with
 * `unzip -p` whose stdout is read ONE LINE AT A TIME (readline). The full CSV is
 * NEVER held in RAM; records are filtered + upserted in bounded batches and the
 * temp file is deleted at the end (success or failure).
 *
 * FLOW: resolve snapshot → idempotency check → download → stream/unzip → per-row
 * filter (NI + construction SIC + active) → normalize → batch upsert into
 * hq_sales_sourcing_pool → record counts in hq_sales_sourcing_imports → discard raw.
 *
 * SAFETY: writes ONLY to the two service-role-only pool tables. It does NOT create
 * prospects, send anything, or enrich officers — the weekly in-app lead_sourcing
 * worker promotes ≤10 pool rows into DRAFT prospects separately. Secrets (the
 * service-role key) are read from env and NEVER logged.
 *
 * USAGE:
 *   tsx scripts/sourcing/companies-house-bulk-import.ts [--dry-run] [--force] [--snapshot=YYYY-MM-01]
 *   env: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (required unless --dry-run)
 */

import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  bulkOneFileUrl,
  classifyRecord,
  currentSnapshotDate,
  mapHeader,
  normalizeRecord,
  parseCsvLine,
} from "../../lib/sourcing/companies-house-bulk";

type Args = { dryRun: boolean; force: boolean; snapshot: string };

function parseArgs(argv: string[]): Args {
  const get = (k: string) => argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1];
  return {
    dryRun: argv.includes("--dry-run"),
    force: argv.includes("--force"),
    snapshot: get("snapshot") || process.env.CH_BULK_SNAPSHOT || currentSnapshotDate(),
  };
}

type Counts = {
  scanned: number;
  ni_matched: number;
  sic_matched: number;
  active_matched: number;
  normalized: number;
  inserted: number;
  updated: number;
  rejected: number;
};

const BATCH = 500;

function log(msg: string, extra?: Record<string, unknown>) {
  // Structured, secret-free. Never interpolate env/keys.
  console.log(`[ch-bulk] ${msg}${extra ? " " + JSON.stringify(extra) : ""}`);
}

async function upsertBatch(
  db: SupabaseClient,
  rows: ReturnType<typeof normalizeRecord>[],
  snapshot: string,
  counts: Counts,
  dryRun: boolean,
): Promise<void> {
  if (rows.length === 0) return;
  const numbers = rows.map((r) => r.company_number);
  if (dryRun) {
    counts.normalized += rows.length;
    return;
  }
  // Classify insert-vs-update for honest counts: which numbers already exist?
  const { data: existing, error: exErr } = await db
    .from("hq_sales_sourcing_pool")
    .select("company_number")
    .in("company_number", numbers);
  if (exErr) throw new Error(`pool existence read failed: ${exErr.message}`);
  const known = new Set((existing ?? []).map((r) => (r as { company_number: string }).company_number));

  const nowIso = new Date().toISOString();
  const payload = rows.map((r) => ({
    company_number: r.company_number,
    name: r.name,
    status: r.status,
    company_category: r.company_category,
    postcode: r.postcode,
    country: r.country,
    incorporation_date: r.incorporation_date,
    sic_codes: r.sic_codes,
    matched_sic: r.matched_sic,
    geography: r.geography,
    reason_codes: r.reason_codes,
    last_snapshot_date: snapshot,
    last_seen_at: nowIso,
    active: true,
    updated_at: nowIso,
    // first_* only meaningful on insert; onConflict ignore keeps the original.
    first_snapshot_date: snapshot,
  }));
  // Upsert by the UNIQUE company_number. NOTE: we deliberately DO NOT touch
  // promoted / promoted_at / promoted_company_id / first_seen_at — on update the
  // existing values are preserved (not in the payload => Postgres keeps them),
  // so a monthly refresh never un-promotes or clobbers sales-owned promotion state.
  const { error } = await db
    .from("hq_sales_sourcing_pool")
    .upsert(payload, { onConflict: "company_number", ignoreDuplicates: false });
  if (error) throw new Error(`pool upsert failed: ${error.message}`);

  counts.normalized += rows.length;
  for (const n of numbers) {
    if (known.has(n)) counts.updated += 1;
    else counts.inserted += 1;
  }
}

async function run(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  log("start", { snapshot: args.snapshot, dryRun: args.dryRun, force: args.force });

  let db: SupabaseClient | null = null;
  if (!args.dryRun) {
    if (!url || !key) throw new Error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required (omit with --dry-run)");
    db = createClient(url, key, { auth: { persistSession: false } });

    // Idempotency: a prior SUCCESS for this snapshot => no-op unless --force.
    const { data: prior, error: priorErr } = await db
      .from("hq_sales_sourcing_imports")
      .select("snapshot_date, status")
      .eq("snapshot_date", args.snapshot)
      .maybeSingle();
    if (priorErr) throw new Error(`import-log read failed: ${priorErr.message}`);
    if (prior && (prior as { status: string }).status === "success" && !args.force) {
      log("snapshot already imported — skipping (idempotent). Use --force to re-run.", { snapshot: args.snapshot });
      return;
    }
    // Open/replace the run row as 'running'.
    const { error: runErr } = await db
      .from("hq_sales_sourcing_imports")
      .upsert(
        { snapshot_date: args.snapshot, source_file: `BasicCompanyDataAsOneFile-${args.snapshot}.zip`, status: "running", started_at: new Date().toISOString(), finished_at: null, error: null },
        { onConflict: "snapshot_date" },
      );
    if (runErr) throw new Error(`import-log open failed: ${runErr.message}`);
  }

  const counts: Counts = { scanned: 0, ni_matched: 0, sic_matched: 0, active_matched: 0, normalized: 0, inserted: 0, updated: 0, rejected: 0 };
  const dir = await mkdtemp(join(tmpdir(), "ch-bulk-"));
  const zipPath = join(dir, "data.zip");

  try {
    // --- stream download to disk (never buffer the whole file in RAM) ---
    const dlUrl = bulkOneFileUrl(args.snapshot);
    log("downloading", { url: dlUrl });
    const res = await fetch(dlUrl);
    if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`);
    await pipeline(Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(zipPath));

    // --- stream-decompress with `unzip -p` and read line-by-line ---
    const unzip = spawn("unzip", ["-p", zipPath], { stdio: ["ignore", "pipe", "inherit"] });
    const rl = createInterface({ input: unzip.stdout!, crlfDelay: Infinity });

    let header: ReturnType<typeof mapHeader> | null = null;
    let batch: ReturnType<typeof normalizeRecord>[] = [];

    for await (const line of rl) {
      if (!line) continue;
      if (!header) {
        header = mapHeader(line); // throws loud if a required column is missing
        continue;
      }
      counts.scanned += 1;
      let fields: string[];
      try {
        fields = parseCsvLine(line);
      } catch {
        counts.rejected += 1;
        continue;
      }
      const c = classifyRecord(fields, header);
      if (c.reasons.includes("active")) counts.active_matched += 1;
      if (c.reasons.includes("ni_registered_office")) counts.ni_matched += 1;
      if (c.matchedSic.length > 0) counts.sic_matched += 1;
      if (!c.eligible) {
        counts.rejected += 1;
        continue;
      }
      batch.push(normalizeRecord(fields, header));
      if (batch.length >= BATCH) {
        await upsertBatch(db as SupabaseClient, batch, args.snapshot, counts, args.dryRun);
        batch = [];
      }
    }
    await upsertBatch(db as SupabaseClient, batch, args.snapshot, counts, args.dryRun);

    const code: number = await new Promise((resolve) => unzip.on("close", resolve));
    if (code !== 0) throw new Error(`unzip exited ${code}`);
    if (!header) throw new Error("no header row parsed — empty or non-CSV archive");

    log("done", counts);
    if (db) {
      const { error } = await db
        .from("hq_sales_sourcing_imports")
        .update({ status: "success", finished_at: new Date().toISOString(), ...counts })
        .eq("snapshot_date", args.snapshot);
      if (error) throw new Error(`import-log finalize failed: ${error.message}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log("FAILED", { error: message, counts });
    if (db) {
      await db
        .from("hq_sales_sourcing_imports")
        .update({ status: "failed", finished_at: new Date().toISOString(), error: message.slice(0, 2000), ...counts })
        .eq("snapshot_date", args.snapshot)
        .then(() => undefined, () => undefined);
    }
    process.exitCode = 1;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

run().catch((e) => {
  console.error("[ch-bulk] fatal", e instanceof Error ? e.message : e);
  process.exit(1);
});
