import { NextResponse } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { readFailure } from "@/lib/supabase/read-failure";
import { guardPublicApiRequest } from "@/lib/public-api/guard";
import {
  CUSTOMER_DTO_SELECT,
  toPublicCustomerDto,
  type CustomerRowForDto,
} from "@/lib/public-api/customers";
import { updateCustomerSchema } from "@/lib/public-api/write-schemas";
import {
  parseJsonBody,
  okData,
  writeError,
  pickDefined,
} from "@/lib/public-api/write";

/**
 * /api/v1/customers/[id] — single-customer READ + UPDATE.
 *
 *   GET   requires read:customers.
 *   PATCH requires the DISTINCT write:customers scope.
 *
 * Both pin BOTH the id AND key.orgId, so a customer in ANOTHER org is
 * INDISTINGUISHABLE from one that does not exist — both return 404, never a
 * 403 that would confirm the id is real (the no-cross-org-oracle rule the jobs
 * by-id read established). PATCH is org-pinned on the WRITE predicate too:
 * `.eq("id").eq("org_id", key.orgId)` means a forged id from another tenant
 * updates ZERO rows and 404s. The update carries ONLY the fields the caller
 * sent (true PATCH semantics), from a strict, allowlisted column set.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const idSchema = z.string().uuid();

const notFound = (): Response =>
  NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });

/** The exact columns a PATCH may touch — the write allowlist (no org_id/id). */
const CUSTOMER_UPDATE_COLUMNS = [
  "name",
  "email",
  "phone",
  "address_line1",
  "address_line2",
  "city",
  "county",
  "postcode",
  "country",
  "notes",
] as const;

/** Minimal typed surface for the org-pinned by-id read. */
type CustomerByIdRead = {
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
          data: CustomerRowForDto | null;
          error: { message?: string | null } | null;
        }>;
      };
    };
  };
};

/** Minimal typed surface for the org-pinned update + allowlisted readback. */
type CustomerUpdateWrite = {
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
            data: CustomerRowForDto | null;
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
  const guard = await guardPublicApiRequest(request, "read:customers");
  if (!guard.ok) return guard.response;

  const { id } = await context.params;
  if (!idSchema.safeParse(id).success) return notFound();

  const admin = createAdminClient();
  const { data, error } = await (
    admin.from("customers") as unknown as CustomerByIdRead
  )
    .select(CUSTOMER_DTO_SELECT)
    .eq("id", id)
    .eq("org_id", guard.key.orgId)
    .maybeSingle();

  if (error) throw readFailure("public-api: customer by id", error);
  if (!data) return notFound();

  return NextResponse.json({ data: toPublicCustomerDto(data) });
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const guard = await guardPublicApiRequest(request, "write:customers");
  if (!guard.ok) return guard.response;

  const { id } = await context.params;
  if (!idSchema.safeParse(id).success) return notFound();

  const body = await parseJsonBody(request, updateCustomerSchema);
  if (!body.ok) return body.response;

  // Only the fields the caller actually sent, from the write allowlist. An
  // omitted field is left untouched — never nulled.
  const patch = pickDefined(
    body.value as Record<string, unknown>,
    CUSTOMER_UPDATE_COLUMNS,
  );

  const admin = createAdminClient();
  const { data, error } = await (
    admin.from("customers") as unknown as CustomerUpdateWrite
  )
    .update(patch)
    // ORG-PINNED WRITE: id AND the key's org — a foreign id updates 0 rows.
    .eq("id", id)
    .eq("org_id", guard.key.orgId)
    .select(CUSTOMER_DTO_SELECT)
    .maybeSingle();

  if (error) {
    console.error("[public-api] customer update failed", error.message);
    return writeError(500, "write_failed", "Couldn't update the customer.");
  }
  // Zero rows ⇒ not yours or not found — indistinguishable, no oracle.
  if (!data) return notFound();

  return okData(toPublicCustomerDto(data));
}
