import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { readFailure } from "@/lib/supabase/read-failure";
import { guardPublicApiRequest } from "@/lib/public-api/guard";
import {
  INVOICE_DTO_SELECT,
  toPublicInvoiceDto,
  type InvoiceRowForDto,
} from "@/lib/public-api/invoices";
import { parsePagination, rangeFor } from "@/lib/public-api/jobs";
import { createInvoiceSchema } from "@/lib/public-api/write-schemas";
import { parseJsonBody, created, writeError } from "@/lib/public-api/write";
import { invoiceDueDate } from "@/lib/invoices/due-date";

/**
 * GET /api/v1/invoices — the public, key-authenticated INVOICES READ.
 *
 * Part of the Open-API expansion off the Train K jobs substrate. DARK BY
 * DEFAULT behind the one shared FEATURE_PUBLIC_API_JOBS flag: while off this
 * route 404s (see lib/public-api/guard.ts + lib/public-api/flag.ts). Mirrors
 * /api/v1/jobs exactly — same guard, same api-key auth, same org-pinning, same
 * read-only projection, same paginated envelope.
 *
 * Contract (all enforced by guardPublicApiRequest):
 *   - 404 when the flag is off (the surface does not exist yet).
 *   - 401 on missing / malformed / unknown / REVOKED / EXPIRED key.
 *   - 403 without the read:invoices scope.
 *   - 429 over the api_v1 budget (120/min, keyed by KEY ID).
 *   - 200 → { data: PublicInvoiceDto[], pagination: { page, per_page, has_more } }.
 *
 * SECURITY: the read is pinned to key.orgId (never a client-supplied org), the
 * projection is an EXPLICIT allowlist — the customer-facing billed amounts only
 * (amount/vat_total/total), NO internal FKs or notes, and `invoices` carries no
 * cost/margin columns at all (see lib/public-api/invoices.ts). Page size is
 * bounded, and the order is stable.
 *
 * POST /api/v1/invoices — create a DRAFT invoice from an accepted quote. This
 * mirrors the app's ONLY invoice-creation path (app/api/invoices POST →
 * quotes/actions auto-invoice): the client names a quote its org already
 * accepted, and the money (amount/vat_total), customer anchor, job link and
 * line-item snapshot all come from that quote server-side — never the body.
 * Requires the DISTINCT `write:invoices` scope; metres fail-CLOSED via the
 * guard (a mutation, not a read). See the POST handler below.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Minimal typed surface for the org-pinned, ranged, ordered read. */
type InvoicesListRead = {
  select: (cols: string) => {
    eq: (
      col: string,
      value: string,
    ) => {
      order: (
        col: string,
        opts: { ascending: boolean },
      ) => {
        order: (
          col: string,
          opts: { ascending: boolean },
        ) => {
          range: (
            from: number,
            to: number,
          ) => Promise<{ data: InvoiceRowForDto[] | null; error: { message?: string | null } | null }>;
        };
      };
    };
  };
};

export async function GET(request: Request): Promise<Response> {
  const guard = await guardPublicApiRequest(request, "read:invoices");
  if (!guard.ok) return guard.response;

  const url = new URL(request.url);
  const pagination = parsePagination(
    url.searchParams.get("page"),
    url.searchParams.get("per_page"),
  );
  const { from, to } = rangeFor(pagination);

  const admin = createAdminClient();
  // Service-role read (the key IS the credential; there is no user JWT). The
  // org boundary is enforced HERE, in the query, by pinning to the key's own
  // org — RLS is not the scoper on this path. Stable order: created_at then id
  // as a tiebreak so pages never overlap or skip a row.
  const { data, error } = await (
    admin.from("invoices") as unknown as InvoicesListRead
  )
    .select(INVOICE_DTO_SELECT)
    .eq("org_id", guard.key.orgId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .range(from, to);

  // Loud read: a failed query must throw, never masquerade as an empty page.
  if (error) throw readFailure("public-api: invoices list", error);

  const rows = data ?? [];
  // We asked for per_page + 1 rows; the extra one only tells us there is a next
  // page — it is never returned.
  const has_more = rows.length > pagination.per_page;
  const page = (has_more ? rows.slice(0, pagination.per_page) : rows).map(
    toPublicInvoiceDto,
  );

  return NextResponse.json({
    data: page,
    pagination: {
      page: pagination.page,
      per_page: pagination.per_page,
      has_more,
    },
  });
}

/** Minimal typed surface for the org-scoped quote lookup (the billable source). */
type QuoteForInvoiceRead = {
  select: (cols: string) => {
    eq: (
      col: string,
      value: string,
    ) => {
      eq: (
        col: string,
        value: string,
      ) => {
        maybeSingle: () => Promise<{
          data: {
            id: string;
            org_id: string;
            status: string;
            customer_id: string | null;
            job_id: string | null;
            subtotal: number | null;
            vat_total: number | null;
          } | null;
          error: { message?: string | null } | null;
        }>;
      };
    };
  };
};

/** Minimal typed surface for the org-pinned invoice insert + allowlisted readback. */
type InvoiceInsertWrite = {
  insert: (row: {
    org_id: string;
    quote_id: string;
    customer_id: string | null;
    job_id: string | null;
    number: string;
    amount: number;
    vat_total: number;
    status: string;
    due_date: string;
    notes: string | null;
  }) => {
    select: (cols: string) => {
      single: () => Promise<{
        data: InvoiceRowForDto | null;
        error: { message?: string | null } | null;
      }>;
    };
  };
};

/**
 * POST /api/v1/invoices — create a draft invoice from an accepted quote.
 *
 * Requires the DISTINCT `write:invoices` scope. The body names ONLY the quote to
 * bill plus two optional document fields (due_date, notes); `.strict()` refuses
 * amount/vat_total/status/number/org_id/customer_id/etc., so no price, status or
 * tenant can be injected. The source quote is looked up PINNED to the key's org
 * (a foreign quote_id reads as "not found", never bills another tenant) and must
 * be `accepted` — only an accepted quote is billable (mirrors the in-app 409
 * gate). amount/vat_total/customer_id/job_id are copied from the quote; the
 * per-org invoice number is allocated by the same next_invoice_number RPC the
 * app uses; the AFTER-INSERT trigger snapshots the quote's line items. Created
 * as `draft`. The result is projected through the same read DTO allowlist.
 */
export async function POST(request: Request): Promise<Response> {
  const guard = await guardPublicApiRequest(request, "write:invoices");
  if (!guard.ok) return guard.response;

  const body = await parseJsonBody(request, createInvoiceSchema);
  if (!body.ok) return body.response;
  const input = body.value;

  const admin = createAdminClient();

  // Look up the source quote PINNED to the key's org — cross-tenant safety is
  // enforced here (never RLS on the service-role path). A foreign quote reads as
  // absent, so it can never be billed into this org.
  const { data: quote, error: qErr } = await (
    admin.from("quotes") as unknown as QuoteForInvoiceRead
  )
    .select("id, org_id, status, customer_id, job_id, subtotal, vat_total")
    .eq("id", input.quote_id)
    .eq("org_id", guard.key.orgId)
    .maybeSingle();
  if (qErr) throw readFailure("public-api: invoice source quote", qErr);
  if (!quote) {
    return writeError(422, "invalid_reference", "That quote isn't in your organisation.");
  }

  // Only an ACCEPTED quote is billable — a draft/sent/declined quote the
  // customer never accepted must not become an invoice (mirrors the app gate).
  if (quote.status !== "accepted") {
    return writeError(
      422,
      "quote_not_accepted",
      "Only an accepted quote can be invoiced.",
    );
  }

  // Per-org invoice number via the SECURITY DEFINER RPC (same as the app).
  const { data: numberRpc, error: numErr } = await admin.rpc(
    "next_invoice_number",
    { target_org: guard.key.orgId },
  );
  if (numErr || !numberRpc) {
    console.error("[public-api] invoice number allocation failed", numErr?.message);
    return writeError(500, "write_failed", "Couldn't allocate an invoice number.");
  }

  const { data: invoice, error: invErr } = await (
    admin.from("invoices") as unknown as InvoiceInsertWrite
  )
    .insert({
      // ORG PINNING — the key's own org, never a client-supplied value.
      org_id: guard.key.orgId,
      quote_id: quote.id,
      // Denormalised customer anchor + job link copied from the quote; the
      // composite FK (customer_id, org_id) guarantees a same-org customer.
      customer_id: quote.customer_id ?? null,
      job_id: quote.job_id ?? null,
      number: numberRpc as unknown as string,
      // MONEY FROM THE QUOTE — never the request body. total is DB-generated.
      amount: Number(quote.subtotal ?? 0),
      vat_total: Number(quote.vat_total ?? 0),
      status: "draft",
      // Honour an explicit due date; else net-14 so no blank deadline ships.
      due_date: input.due_date ?? invoiceDueDate(new Date().toISOString()),
      notes: input.notes ?? null,
    })
    .select(INVOICE_DTO_SELECT)
    .single();

  if (invErr || !invoice) {
    console.error("[public-api] invoice create failed", invErr?.message);
    return writeError(500, "write_failed", "Couldn't create the invoice.");
  }

  return created(toPublicInvoiceDto(invoice));
}
