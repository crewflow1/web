import { NextResponse } from "next/server";
import JSZip from "jszip";
import { resolveBillingOwner } from "@/server/auth/billing-account";
import { buildOrgExport, recordGdprExport } from "@/server/services/gdpr-export";

/**
 * GET /api/account/export — the OWNER's data export, reachable WITHOUT active
 * workspace access.
 *
 * EXPORT ONLY: this route reads. It deletes nothing and changes nothing.
 *
 * Why it exists alongside /api/gdpr/export: that route is gated by
 * requireOrgContext(), which redirects a cancelled or suspended workspace to
 * /access-pending — so the customer lost the ability to take their data out at
 * exactly the moment the terms say they may ("You can export it … at any time";
 * "you have 30 days to pay or export"). This route serves the same archive,
 * built by the SAME service (buildOrgExport: org-pinned, RLS-backed, loud,
 * fully paged, secret tables excluded, every row column-redacted), behind the
 * billing-account guard instead.
 *
 * SECURITY MODEL:
 *   1. OWNER-ONLY, session-derived. resolveBillingOwner() takes the org from the
 *      caller's own membership row and requires role `owner`; there is no org
 *      parameter. HQ super-admins (and therefore impersonation) are refused.
 *      Anonymous → 401; any other member → 403.
 *   2. ORG-PINNED + RLS. buildOrgExport reads with the caller's own JWT and
 *      `.eq("org_id", …)`; RLS is membership-based, so it holds whatever the
 *      org's status is, and a foreign org is unreachable by construction.
 *   3. NO SECRETS — inherited from the export service's deny-list + redaction.
 *   4. AUDITED — one gdpr_export_log row (best-effort).
 *   5. PRIVATE — `Cache-Control: private, no-store`.
 *
 * The archive is assembled in memory, as in /api/gdpr/export; the two routes
 * should share one archive builder when that route is next touched.
 */
export const runtime = "nodejs";

export async function GET() {
  const owner = await resolveBillingOwner();
  if (!owner.ok) {
    return NextResponse.json(
      {
        error:
          owner.reason === "unauthenticated"
            ? "Sign in to download your data."
            : "Only the account owner may export the organisation's data.",
      },
      { status: owner.reason === "unauthenticated" ? 401 : 403 },
    );
  }

  const generatedAt = new Date().toISOString();
  const orgId = owner.ctx.org.id;
  const exported = await buildOrgExport({ orgId, generatedAt });

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

  await recordGdprExport({
    orgId,
    createdBy: owner.user.id,
    format: "zip",
    tableCount: exported.manifest.table_count,
    rowCount: exported.manifest.total_rows,
    truncated: false,
    note: `account export (org status: ${owner.ctx.org.status})`,
  });

  const ab = new ArrayBuffer(buffer.length);
  new Uint8Array(ab).set(buffer);
  return new NextResponse(ab, {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="crewflow-data-export-${generatedAt.slice(0, 10)}.zip"`,
      "Cache-Control": "private, no-store",
      "X-Gdpr-Export-Tables": String(exported.manifest.table_count),
      "X-Gdpr-Export-Rows": String(exported.manifest.total_rows),
      "X-Gdpr-Export-Complete": exported.manifest.complete ? "1" : "0",
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
    "  A structured copy of your organisation's own data held in CrewFlow. Each",
    "  file under data/ is one table as JSON; manifest.json lists every table, its",
    "  row count, and which tables are deliberately excluded (and why).",
    "",
    "WHAT IS EXCLUDED",
    "  Credentials and access tokens, government identifiers, CrewFlow's own",
    "  platform billing records, and internal service telemetry are NOT included.",
    "  Uploaded files (photos, drawings, documents) are not in this archive.",
    "  See manifest.json -> excluded_tables.",
    "",
    "THIS IS AN EXPORT ONLY",
    "  Producing this archive changed nothing in your account. It does NOT",
    "  delete or erase any data.",
    "",
  ].join("\n");
}
