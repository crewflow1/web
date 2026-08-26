import { type NextRequest } from "next/server";
import * as respond from "@/lib/api/respond";
import { createClient } from "@/lib/supabase/server";
import { requireManagementApi } from "@/server/auth/session";
import { updateInvoiceSchema } from "@/lib/invoices/schema";
import { verifyJobInOrg } from "@/lib/crm/reference-integrity";
import type { Database } from "@/lib/supabase/types";

/**
 * Single-invoice operations.
 *
 *   PATCH  /api/invoices/[id]   update status / due_date / notes.
 *                               Setting status transitions stamps the
 *                               corresponding _at timestamp (sent_at /
 *                               paid_at) so the audit trail is preserved
 *                               even if status is changed back later.
 *
 *   DELETE /api/invoices/[id]   admins only via RLS.
 */

type InvoiceUpdate = Database["public"]["Tables"]["invoices"]["Update"];

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(request: NextRequest, { params }: Ctx) {
  // Management-only (first-customer fix 1): this surface carries money.
  const guard = await requireManagementApi();
  if (guard instanceof Response) return guard;
  const { ctx } = guard;
  const { id } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return respond.error(400, "Invalid JSON body");
  }
  const parsed = updateInvoiceSchema.safeParse(body);
  if (!parsed.success) {
    return respond.error(400, "Invalid input", { extra: { issues: parsed.error.flatten() } });
  }

  const patch: InvoiceUpdate = {};
  const now = new Date().toISOString();
  if (parsed.data.status !== undefined) {
    patch.status = parsed.data.status;
    if (parsed.data.status === "sent") patch.sent_at = now;
    if (parsed.data.status === "paid") patch.paid_at = now;
  }
  if (parsed.data.due_date !== undefined) patch.due_date = parsed.data.due_date ?? null;
  if (parsed.data.notes !== undefined) patch.notes = parsed.data.notes ?? null;
  if (parsed.data.job_id !== undefined) patch.job_id = parsed.data.job_id;

  if (Object.keys(patch).length === 0) {
    return respond.error(400, "No fields to update");
  }

  const supabase = await createClient();

  // Cross-org reference integrity (defence in depth over the composite FK added
  // in migration 20261119000000): re-pointing an invoice at a NEW job_id must
  // land a job in the caller's ACTIVE org. The UPDATE below is org-pinned on the
  // invoice ROW, but that never validates the job the row is being pointed AT —
  // so a caller in org A could otherwise attach org B's job_id and contaminate
  // that job's revenue/VAT rollup. Only a non-null job_id needs the check; an
  // explicit null (unlink) is always allowed. Mirrors the quotes usage.
  if (patch.job_id != null) {
    const ref = await verifyJobInOrg(supabase, patch.job_id, ctx.org.id);
    if (!ref.ok) {
      return respond.error(400, ref.message);
    }
  }

  const { error, count } = await supabase
    .from("invoices")
    .update(patch, { count: "exact" })
    .eq("id", id)
    // Active-org scope. RLS proves membership of the invoice's OWN org, which
    // for a dual-org user passes for BOTH — so without this predicate a PATCH
    // issued while working in org A can mark org B's invoice paid, or move it
    // onto a job it has nothing to do with. Zero rows matched falls through to
    // the existing 404, so a foreign id looks exactly like a missing one.
    .eq("org_id", ctx.org.id)
    .select("id");

  if (error) {
    console.error("[invoices] update failed", error);
    return respond.error(500, "Failed to update");
  }
  if (count === 0) {
    return respond.error(404, "Not found");
  }
  return respond.json({ ok: true });
}

export async function DELETE(_request: NextRequest, { params }: Ctx) {
  // Management-only (first-customer fix 1): this surface carries money.
  const guard = await requireManagementApi();
  if (guard instanceof Response) return guard;
  const { ctx } = guard;
  const { id } = await params;

  const supabase = await createClient();
  const { error, count } = await supabase
    .from("invoices")
    .delete({ count: "exact" })
    .eq("id", id)
    // Active-org scope — see PATCH. A delete is irreversible and this one
    // destroys a billing record, so it is the most important predicate here.
    .eq("org_id", ctx.org.id);

  if (error) {
    console.error("[invoices] delete failed", error);
    return respond.error(500, "Failed to delete");
  }
  if (count === 0) {
    return respond.error(404, "Not found or not allowed");
  }
  return respond.json({ ok: true });
}
