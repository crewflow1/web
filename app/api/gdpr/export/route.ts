import { NextResponse } from "next/server";
import JSZip from "jszip";
import { requireOrgContext } from "@/server/auth/session";
import { buildOrgExport, recordGdprExport } from "@/server/services/gdpr-export";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * GDPR / DATA-PORTABILITY EXPORT — EXPORT ONLY. NO DELETION.
 * ═════════════════════════════════════════════════════════════════════════════
 *
 *   GET /api/gdpr/export
 *
 * Produces a downloadable ZIP archive of the requesting org's OWN data — the
 * data-controller / data-subject access-request (DSAR) EXPORT half of GDPR:
 *
 *   manifest.json          — export_kind, org id, generated-at, per-table row
 *                            counts, truncation flags, and the security
 *                            deny-list (what is deliberately NOT exported).
 *   README.txt             — the export-only boundary, in plain words.
 *   data/<table>.json      — one JSON document per exported org-scoped table.
 *
 * ── THIS ENDPOINT NEVER DELETES ANYTHING. ────────────────────────────────────
 * Subject ERASURE (GDPR Art. 17) and org-teardown storage-orphan cleanup are a
 * SEPARATE, legally-gated capability and are intentionally NOT implemented here.
 * This route only READS. Do not add deletion to this file — erasure requires a
 * legal/policy decision and its own controlled surface.
 *
 * SECURITY MODEL, in order:
 *   1. ADMIN-GATED — `requireOrgContext()` then an explicit owner/admin check.
 *      A member (or anon, already redirected by requireOrgContext) is refused
 *      403. Generating a whole-org export is an admin act.
 *   2. #456 ORG-PINNED — every underlying read is `.eq("org_id", ctx.org.id)`
 *      on the caller's ACTIVE org, behind the RLS boundary. An admin of org A
 *      can never pull org B's rows (RLS forbids foreign orgs; the pin narrows a
 *      multi-org member to the active org). Proven in the integration suite.
 *   3. NO SECRETS — credential/token tables are excluded wholesale and every
 *      exported row is column-redacted (see server/services/gdpr-export.ts).
 *   4. AUDITED — one best-effort `gdpr_export_log` row (status='generated').
 *   5. PRIVATE — `Cache-Control: private, no-store`; a per-org composite.
 *
 * JSZip renders on Node.
 */
export const runtime = "nodejs";

function isAdminRole(role: string): boolean {
  return role === "owner" || role === "admin";
}

export async function GET() {
  const { ctx, user } = await requireOrgContext();

  if (!isAdminRole(ctx.membership.role)) {
    return NextResponse.json(
      { error: "Only an owner or admin may export the organisation's data." },
      { status: 403 },
    );
  }

  const generatedAt = new Date().toISOString();
  const orgId = ctx.org.id;

  // Assemble the org's data — org-pinned + loud reads live in the service.
  const exported = await buildOrgExport({ orgId, generatedAt });

  // ── Build the archive ──────────────────────────────────────────────────────
  const zip = new JSZip();
  zip.file("manifest.json", JSON.stringify(exported.manifest, null, 2));
  zip.file("README.txt", readmeText(exported.manifest.generated_at));
  const data = zip.folder("data");
  for (const t of exported.tables) {
    data?.file(`${t.table}.json`, JSON.stringify(t.rows, null, 2));
  }

  const buffer = await zip.generateAsync({
    type: "uint8array",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });

  // Audit the export. Best-effort — never fail the download over the log write.
  await recordGdprExport({
    orgId,
    createdBy: user.id,
    format: "zip",
    tableCount: exported.manifest.table_count,
    rowCount: exported.manifest.total_rows,
    truncated: exported.manifest.any_truncated,
    note: exported.manifest.any_truncated
      ? `one or more tables truncated at MAX_ROWS_PER_TABLE=${exported.manifest.max_rows_per_table}`
      : null,
  });

  const ab = new ArrayBuffer(buffer.length);
  new Uint8Array(ab).set(buffer);
  const stamp = generatedAt.slice(0, 10);
  return new NextResponse(ab, {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="crewflow-data-export-${stamp}.zip"`,
      // A per-org composite of private data — never cached, never shared.
      "Cache-Control": "private, no-store",
      "X-Gdpr-Export-Tables": String(exported.manifest.table_count),
      "X-Gdpr-Export-Rows": String(exported.manifest.total_rows),
      "X-Gdpr-Export-Truncated": exported.manifest.any_truncated ? "1" : "0",
    },
  });
}

function readmeText(generatedAt: string): string {
  return [
    "CrewFlow — Data Export",
    "======================",
    "",
    `Generated: ${generatedAt}`,
    "",
    "WHAT THIS IS",
    "  A structured copy of your organisation's own data held in CrewFlow,",
    "  provided for GDPR data-portability / subject-access purposes. Each file",
    "  under data/ is one table as JSON; manifest.json lists every table, its",
    "  row count, and which tables are deliberately excluded (and why).",
    "",
    "WHAT IS EXCLUDED",
    "  Credentials and access tokens (OAuth tokens, API-key hashes, webhook",
    "  signing secrets), government identifiers, platform billing, and internal",
    "  service telemetry are NOT included. See manifest.json -> excluded_tables.",
    "",
    "THIS IS AN EXPORT ONLY",
    "  Producing this archive changed nothing in your account. It does NOT",
    "  delete or erase any data. Data erasure and account teardown are handled",
    "  separately — contact support to request them.",
    "",
  ].join("\n");
}
