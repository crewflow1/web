import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { readFailure } from "@/lib/supabase/read-failure";
import { guardPublicApiRequest } from "@/lib/public-api/guard";
import { verifyJobInOrg } from "@/lib/crm/reference-integrity";
import {
  EXPENSE_DTO_SELECT,
  toPublicExpenseDto,
  type ExpenseRowForDto,
} from "@/lib/public-api/expenses";
import { parsePagination, rangeFor } from "@/lib/public-api/jobs";
import { createExpenseSchema } from "@/lib/public-api/write-schemas";
import { parseJsonBody, created, writeError } from "@/lib/public-api/write";

/**
 * /api/v1/expenses — the public, key-authenticated EXPENSES surface.
 *
 *   GET  requires read:expenses.
 *   POST requires the DISTINCT write:expenses scope.
 *
 * Part of the Open-API breadth wave off the Train K jobs substrate. DARK BY
 * DEFAULT behind the one shared FEATURE_PUBLIC_API_JOBS flag: while off this
 * route 404s (see lib/public-api/guard.ts + lib/public-api/flag.ts). Mirrors
 * /api/v1/customers — same guard, same api-key auth, same org-pinning, same
 * read-only projection, same paginated envelope, same strict write.
 *
 * SECURITY: the read is pinned to key.orgId (never a client-supplied org), the
 * projection is an EXPLICIT allowlist — the org's own recorded cost figures, NO
 * internal FKs / receipt path / notes (see lib/public-api/expenses.ts). The
 * write is strictly validated (unknown keys rejected — no mass assignment),
 * org_id is pinned to the key's org, `vat_total` is a generated column that is
 * never set, and an optional job_id is verified in the key's org first.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Minimal typed surface for the org-pinned, ranged, ordered read. */
type ExpensesListRead = {
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
          ) => Promise<{ data: ExpenseRowForDto[] | null; error: { message?: string | null } | null }>;
        };
      };
    };
  };
};

export async function GET(request: Request): Promise<Response> {
  const guard = await guardPublicApiRequest(request, "read:expenses");
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
    admin.from("finances") as unknown as ExpensesListRead
  )
    .select(EXPENSE_DTO_SELECT)
    .eq("org_id", guard.key.orgId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .range(from, to);

  // Loud read: a failed query must throw, never masquerade as an empty page.
  if (error) throw readFailure("public-api: expenses list", error);

  const rows = data ?? [];
  // We asked for per_page + 1 rows; the extra one only tells us there is a next
  // page — it is never returned.
  const has_more = rows.length > pagination.per_page;
  const page = (has_more ? rows.slice(0, pagination.per_page) : rows).map(
    toPublicExpenseDto,
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

/** Minimal typed surface for the org-pinned insert + allowlisted readback. */
type ExpenseInsertWrite = {
  insert: (row: {
    org_id: string;
    amount: number;
    currency: string;
    vat_rate: number;
    category: string | null;
    notes: string | null;
    job_id: string | null;
  }) => {
    select: (cols: string) => {
      single: () => Promise<{
        data: ExpenseRowForDto | null;
        error: { message?: string | null } | null;
      }>;
    };
  };
};

/**
 * POST /api/v1/expenses — record a cost in the KEY'S org.
 *
 * Same dark flag + guard as the read; requires the DISTINCT `write:expenses`
 * scope (a read-only key cannot create). The body is strictly validated
 * (unknown keys rejected — no mass assignment, and `vat_total` can never be set
 * because it is a stored generated column), org_id is pinned to the key's org
 * (never taken from the body), an optional job_id is verified in the key's org
 * BEFORE the insert, and the created row is returned through the SAME read DTO
 * allowlist so a write can never expose a field a read would not.
 */
export async function POST(request: Request): Promise<Response> {
  const guard = await guardPublicApiRequest(request, "write:expenses");
  if (!guard.ok) return guard.response;

  const body = await parseJsonBody(request, createExpenseSchema);
  if (!body.ok) return body.response;
  const input = body.value;

  const admin = createAdminClient();

  // Cross-tenant reference integrity: a linked job must be in the key's org.
  // Verified before the write so a forged id is a clean 422, not a raw 23503.
  if (input.job_id) {
    const ref = await verifyJobInOrg(admin as never, input.job_id, guard.key.orgId);
    if (!ref.ok) return writeError(422, "invalid_reference", ref.message);
  }

  const { data, error } = await (
    admin.from("finances") as unknown as ExpenseInsertWrite
  )
    .insert({
      // ORG PINNING — the key's own org, never a client-supplied value.
      org_id: guard.key.orgId,
      amount: input.amount,
      // Currency is fixed by the API, not a client input.
      currency: "GBP",
      // Default to standard-rate VAT when the caller omits it (mirrors the DB
      // default); vat_total is generated from amount * vat_rate and never set.
      vat_rate: input.vat_rate ?? 20,
      category: input.category ?? null,
      notes: input.notes ?? null,
      job_id: input.job_id ?? null,
    })
    .select(EXPENSE_DTO_SELECT)
    .single();

  if (error || !data) {
    // Loud server-side; generic to the caller (raw Postgres text never leaks).
    console.error("[public-api] expense create failed", error?.message);
    return writeError(500, "write_failed", "Couldn't record the expense.");
  }

  return created(toPublicExpenseDto(data));
}
