import { NextResponse } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { readFailure } from "@/lib/supabase/read-failure";
import { guardPublicApiRequest } from "@/lib/public-api/guard";
import {
  EXPENSE_DTO_SELECT,
  toPublicExpenseDto,
  type ExpenseRowForDto,
} from "@/lib/public-api/expenses";
import { updateExpenseSchema } from "@/lib/public-api/write-schemas";
import {
  parseJsonBody,
  okData,
  writeError,
  pickDefined,
} from "@/lib/public-api/write";

/**
 * /api/v1/expenses/[id] — single-expense READ + UPDATE.
 *
 *   GET   requires read:expenses.
 *   PATCH requires the DISTINCT write:expenses scope.
 *
 * Both pin BOTH the id AND key.orgId, so an expense in ANOTHER org is
 * INDISTINGUISHABLE from one that does not exist — both return 404, never a
 * 403 that would confirm the id is real (the no-cross-org-oracle rule). PATCH is
 * org-pinned on the WRITE predicate too: `.eq("id").eq("org_id", key.orgId)`
 * means a forged id from another tenant updates ZERO rows and 404s. The update
 * carries ONLY the fields the caller sent (true PATCH semantics — so re-sending
 * the same body is IDEMPOTENT), from a strict, allowlisted column set; the
 * generated `vat_total` and internal `job_id` are never touched.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const idSchema = z.string().uuid();

const notFound = (): Response =>
  NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });

/** The exact columns a PATCH may touch — the write allowlist (no org_id/id). */
const EXPENSE_UPDATE_COLUMNS = ["amount", "vat_rate", "category", "notes"] as const;

/** Minimal typed surface for the org-pinned by-id read. */
type ExpenseByIdRead = {
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
          data: ExpenseRowForDto | null;
          error: { message?: string | null } | null;
        }>;
      };
    };
  };
};

/** Minimal typed surface for the org-pinned update + allowlisted readback. */
type ExpenseUpdateWrite = {
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
            data: ExpenseRowForDto | null;
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
  const guard = await guardPublicApiRequest(request, "read:expenses");
  if (!guard.ok) return guard.response;

  const { id } = await context.params;
  if (!idSchema.safeParse(id).success) return notFound();

  const admin = createAdminClient();
  const { data, error } = await (
    admin.from("finances") as unknown as ExpenseByIdRead
  )
    .select(EXPENSE_DTO_SELECT)
    .eq("id", id)
    .eq("org_id", guard.key.orgId)
    .maybeSingle();

  if (error) throw readFailure("public-api: expense by id", error);
  if (!data) return notFound();

  return NextResponse.json({ data: toPublicExpenseDto(data) });
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const guard = await guardPublicApiRequest(request, "write:expenses");
  if (!guard.ok) return guard.response;

  const { id } = await context.params;
  if (!idSchema.safeParse(id).success) return notFound();

  const body = await parseJsonBody(request, updateExpenseSchema);
  if (!body.ok) return body.response;

  // Only the fields the caller actually sent, from the write allowlist. An
  // omitted field is left untouched — never nulled. Re-sending the same body
  // therefore yields the same state (idempotent).
  const patch = pickDefined(
    body.value as Record<string, unknown>,
    EXPENSE_UPDATE_COLUMNS,
  );

  const admin = createAdminClient();
  const { data, error } = await (
    admin.from("finances") as unknown as ExpenseUpdateWrite
  )
    .update(patch)
    // ORG-PINNED WRITE: id AND the key's org — a foreign id updates 0 rows.
    .eq("id", id)
    .eq("org_id", guard.key.orgId)
    .select(EXPENSE_DTO_SELECT)
    .maybeSingle();

  if (error) {
    console.error("[public-api] expense update failed", error.message);
    return writeError(500, "write_failed", "Couldn't update the expense.");
  }
  // Zero rows ⇒ not yours or not found — indistinguishable, no oracle.
  if (!data) return notFound();

  return okData(toPublicExpenseDto(data));
}
