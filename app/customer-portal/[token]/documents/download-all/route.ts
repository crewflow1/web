import { NextResponse, type NextRequest } from "next/server";
import JSZip from "jszip";
import { loadCustomerByPortalToken } from "@/app/customer-portal/_helpers";
import { collectPortalDocumentPdfs } from "@/lib/customers/portal-bulk-download";
import { bulkZipFilename } from "@/lib/customers/portal-bulk-plan";
import type { PortalDocType } from "@/lib/customers/portal-documents";

// JSZip + react-pdf render on Node.
export const runtime = "nodejs";

/**
 * Customer-portal BULK document download.
 *
 *   GET /customer-portal/[token]/documents/download-all
 *   GET /customer-portal/[token]/documents/download-all?type=invoice
 *
 * Streams every PDF this customer can already download individually, zipped into
 * one archive. Security model, in order:
 *
 *   1. TOKEN CHOKEPOINT — the URL token is resolved to a customer through the ONE
 *      authority (loadCustomerByPortalToken). An unknown / malformed / expired
 *      token 404s here exactly like every other portal route; nothing downstream
 *      re-checks, so it can't drift.
 *   2. NO CLIENT IDS — the route takes NO document-id input. The set is derived
 *      server-side from the token-resolved customer (collectPortalDocumentPdfs),
 *      each doc scoped by org_id + customer_id and re-verified per row. The only
 *      accepted input is an OPTIONAL `type` category filter, validated against a
 *      fixed allow-list; anything else is ignored (treated as "all").
 *   3. BOUNDED — the collector caps document count and total bytes, so a runaway
 *      set can't balloon memory.
 *   4. PRIVATE — `Cache-Control: private, no-store`; the zip filename carries no
 *      customer/org identity or internal id.
 */

const TYPES: readonly PortalDocType[] = ["quote", "invoice", "report", "certificate"];

type Ctx = { params: Promise<{ token: string }> };

export async function GET(request: NextRequest, { params }: Ctx) {
  const { token } = await params;

  const loaded = await loadCustomerByPortalToken(token);
  if (!loaded) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const { customer, org } = loaded;

  // The ONLY input beyond the token-resolved identity — validated to the fixed
  // allow-list. An unknown value falls back to "all", never an error surface.
  const rawType = request.nextUrl.searchParams.get("type");
  const filter = TYPES.includes(rawType as PortalDocType)
    ? (rawType as PortalDocType)
    : null;

  const { files, capped, total } = await collectPortalDocumentPdfs({
    customer,
    org,
    filter,
  });

  if (files.length === 0) {
    // Nothing to download (no matching documents) — an honest empty result, not
    // an error. A query failure would have thrown upstream (loud reads).
    return NextResponse.json({ error: "No documents available" }, { status: 404 });
  }

  const zip = new JSZip();
  for (const f of files) {
    zip.file(f.filename, f.bytes);
  }
  const buffer = await zip.generateAsync({
    type: "uint8array",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });

  const ab = new ArrayBuffer(buffer.length);
  new Uint8Array(ab).set(buffer);
  return new NextResponse(ab, {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${bulkZipFilename()}"`,
      // Never cached, never shared — a per-customer composite of private docs.
      "Cache-Control": "private, no-store",
      // Signal truncation to any client that inspects headers (UI shows a note).
      "X-Bulk-Total": String(total),
      "X-Bulk-Included": String(files.length),
      "X-Bulk-Capped": capped ? "1" : "0",
    },
  });
}
