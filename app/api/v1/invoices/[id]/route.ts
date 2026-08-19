import { NextResponse } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { readFailure } from "@/lib/supabase/read-failure";
import { guardPublicApiRequest } from "@/lib/public-api/guard";
import {
  INVOICE_DTO_SELECT,
  toPublicInvoiceDto,
  type InvoiceRowForDto,
} from "@/lib/public-api/invoices";
import { updateInvoiceSchema } from "@/lib/public-api/write-schemas";
import {
  parseJsonBody,
  okData,
  writeError,
  pickDefined,
} from "@/lib/public-api/write";

/**
 * /api/v1/invoices/[id] — single-invoice READ + a metadata/status UPDATE.
 *
 *   GET   requires read:invoices.
 *   PATCH requires the DISTINCT write:invoices scope.
 *
 * The invoices COLLECTION route stays read-only; this by-id route opens the ONE
 * sanctioned invoice write — a metadata + status PATCH. There is NO invoice
 * CREATE (raising an invoice is an accounting operation the public API does not
 * open), and the MONEY columns (amount / vat_total / total / number) are NOT in
 * the update schema or allowlist — a public key can never move a billed figure.
 * `status` is constrained to the WRITABLE set (`overdue` is derived, not
 * stored, and is rejected at validation).
 *
 * Both pin BOTH the id AND key.orgId, so an invoice in ANOTHER org is
 * INDISTINGUISHABLE from one that does not exist — both 404, never a 403 that
 * would confirm the id is real (the no-cross-org-oracle rule). PATCH is
 * org-pinned on the WRITE predicate too, and carries ONLY the fields the caller
 * sent (true PATCH semantics — re-sending the same body is IDEMPOTENT).
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const idSchema = z.string().uuid();

const notFound = (): Response =>
  NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });

/** The exact columns a PATCH may touch — the write allowlist (no money/id/org). */
const INVOICE_UPDATE_COLUMNS = ["status", "due_date", "notes"] as const;

/** Minimal typed surface for the org-pinned by-id read. */
type InvoiceByIdRead = {
  select: (cols: string) => {
    eq: (
      c: string,
      v: string,
    ) => {
      eq: (
        c: string,
        v: string,
      ) => {
        maybeSingle: () => Promise<{
          data: InvoiceRowForDto | null;
          error: { message?: string | null } | null;
        }>;
      };
    };
  };
};

/** Minimal typed surface for the org-pinned update + allowlisted readback. */
type InvoiceUpdateWrite = {
  update: (row: Record<string, unknown>) => {
    eq: (
      c: string,
      v: string,
    ) => {
      eq: (
        c: string,
        v: string,
      ) => {
        select: (cols: string) => {
          maybeSingle: () => Promise<{
            data: InvoiceRowForDto | null;
            error: { message?: string | null } | null;
          }>;
        };
      };
    };
  };
};

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const guard = await guardPublicApiRequest(request, "read:invoices");
  if (!guard.ok) return guard.response;

  const { id } = await context.params;
  if (!idSchema.safeParse(id).success) return notFound();

  const admin = createAdminClient();
  const { data, error } = await (
    admin.from("invoices") as unknown as InvoiceByIdRead
  )
    .select(INVOICE_DTO_SELECT)
    .eq("id", id)
    .eq("org_id", guard.key.orgId)
    .maybeSingle();

  if (error) throw readFailure("public-api: invoice by id", error);
  if (!data) return notFound();

  return NextResponse.json({ data: toPublicInvoiceDto(data) });
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const guard = await guardPublicApiRequest(request, "write:invoices");
  if (!guard.ok) return guard.response;

  const { id } = await context.params;
  if (!idSchema.safeParse(id).success) return notFound();

  const body = await parseJsonBody(request, updateInvoiceSchema);
  if (!body.ok) return body.response;

  // Only the fields the caller actually sent, from the write allowlist. An
  // omitted field is left untouched — never nulled. Re-sending the same body
  // therefore yields the same state (idempotent). Money columns are absent from
  // both the schema and this allowlist, so none can be carried through.
  const patch = pickDefined(
    body.value as Record<string, unknown>,
    INVOICE_UPDATE_COLUMNS,
  );

  const admin = createAdminClient();
  const { data, error } = await (
    admin.from("invoices") as unknown as InvoiceUpdateWrite
  )
    .update(patch)
    // ORG-PINNED WRITE: id AND the key's org — a foreign id updates 0 rows.
    .eq("id", id)
    .eq("org_id", guard.key.orgId)
    .select(INVOICE_DTO_SELECT)
    .maybeSingle();

  if (error) {
    console.error("[public-api] invoice update failed", error.message);
    return writeError(500, "write_failed", "Couldn't update the invoice.");
  }
  // Zero rows ⇒ not yours or not found — indistinguishable, no oracle.
  if (!data) return notFound();

  return okData(toPublicInvoiceDto(data));
}
