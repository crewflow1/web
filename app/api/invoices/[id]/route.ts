import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { updateInvoiceSchema } from "@/lib/invoices/schema";
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
  await requireOrgContext();
  const { id } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = updateInvoiceSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", issues: parsed.error.flatten() },
      { status: 400 },
    );
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
    return NextResponse.json({ error: "No fields to update" }, { status: 400 });
  }

  const supabase = await createClient();
  const { error, count } = await supabase
    .from("invoices")
    .update(patch, { count: "exact" })
    .eq("id", id)
    .select("id");

  if (error) {
    console.error("[invoices] update failed", error);
    return NextResponse.json({ error: "Failed to update" }, { status: 500 });
  }
  if (count === 0) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}

export async function DELETE(_request: NextRequest, { params }: Ctx) {
  await requireOrgContext();
  const { id } = await params;

  const supabase = await createClient();
  const { error, count } = await supabase
    .from("invoices")
    .delete({ count: "exact" })
    .eq("id", id);

  if (error) {
    console.error("[invoices] delete failed", error);
    return NextResponse.json({ error: "Failed to delete" }, { status: 500 });
  }
  if (count === 0) {
    return NextResponse.json(
      { error: "Not found or not allowed" },
      { status: 404 },
    );
  }
  return NextResponse.json({ ok: true });
}
