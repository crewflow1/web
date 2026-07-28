import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireOrgContext } from "@/server/auth/session";
import { updateFinanceSchema } from "@/lib/finances/schema";
import { financeWriteRefusal } from "@/lib/finances/errors";
import type { Database } from "@/lib/supabase/types";

type FinanceUpdate = Database["public"]["Tables"]["finances"]["Update"];

/**
 * Single-finance operations.
 *
 *   PATCH  /api/finances/[id]   update amount / vat_rate / category / notes / job_id
 *   DELETE /api/finances/[id]   admins only (RLS-enforced)
 *
 * org_id is intentionally NOT updatable.
 * receipt_url isn't updatable here either — re-uploading is a separate
 * concern (defer to a future endpoint if needed).
 */

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(request: NextRequest, { params }: Ctx) {
  const { ctx } = await requireOrgContext();
  const { id } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = updateFinanceSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", issues: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const patch: FinanceUpdate = {};
  if (parsed.data.amount !== undefined) patch.amount = parsed.data.amount;
  if (parsed.data.vat_rate !== undefined) patch.vat_rate = parsed.data.vat_rate;
  if (parsed.data.category !== undefined) patch.category = parsed.data.category ?? null;
  if (parsed.data.notes !== undefined) patch.notes = parsed.data.notes ?? null;
  if (parsed.data.job_id !== undefined) patch.job_id = parsed.data.job_id ?? null;

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "No fields to update" }, { status: 400 });
  }

  const supabase = await createClient();
  const { error, count } = await supabase
    .from("finances")
    .update(patch, { count: "exact" })
    .eq("id", id)
    // Active-org scope. RLS admits every org the caller belongs to, so a
    // dual-org user working in org A could otherwise restate the amount or
    // VAT rate on org B's bill — corrupting B's books and, under CIS, B's
    // deduction basis. The predicate matches ZERO rows for a foreign id, so
    // no DB guard fires and the request falls through to the 404 below; the
    // 409 refusal paths (financeWriteRefusal) are reached only by a genuine
    // in-org row, exactly as before.
    .eq("org_id", ctx.org.id)
    .select("id");

  if (error) {
    // A DB guard refusing the edit is a legitimate answer, not a server fault —
    // surface it with the recovery path instead of an opaque 500. Chief case: the
    // bill has been part-paid under CIS, so its value is frozen (20261053000000).
    const refusal = financeWriteRefusal(error.code, error.message);
    if (refusal) {
      return NextResponse.json({ error: refusal.error }, { status: refusal.status });
    }
    console.error("[finances] update failed", error);
    return NextResponse.json({ error: "Failed to update" }, { status: 500 });
  }
  if (count === 0) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}

export async function DELETE(_request: NextRequest, { params }: Ctx) {
  const { ctx } = await requireOrgContext();
  const { id } = await params;

  const supabase = await createClient();
  // Look up receipt path BEFORE deletion so we can clean storage too.
  // Active-org scoped: the count from the DELETE below is the gate for the
  // storage removal, and this read must agree with it — otherwise a foreign
  // id could yield another org's receipt path here while the delete no-ops.
  const { data: row } = await supabase
    .from("finances")
    .select("receipt_url")
    .eq("id", id)
    .eq("org_id", ctx.org.id)
    .maybeSingle();

  const { error, count } = await supabase
    .from("finances")
    .delete({ count: "exact" })
    .eq("id", id)
    // Active-org scope — see PATCH. Deleting another org's expense removes a
    // line from their books and their VAT position.
    .eq("org_id", ctx.org.id);

  if (error) {
    console.error("[finances] delete failed", error);
    return NextResponse.json({ error: "Failed to delete" }, { status: 500 });
  }
  if (count === 0) {
    // RLS blocked or row didn't exist.
    return NextResponse.json({ error: "Not found or not allowed" }, { status: 404 });
  }

  // Best-effort storage cleanup. RLS on the receipts bucket already grants
  // admins delete rights; this runs only after the DB delete succeeded so
  // RLS has already confirmed the caller is an admin.
  if (row?.receipt_url) {
    const admin = createAdminClient();
    const { error: rmErr } = await admin.storage
      .from("receipts")
      .remove([row.receipt_url]);
    if (rmErr) {
      console.error("[finances] receipt cleanup failed", rmErr);
    }
  }

  return NextResponse.json({ ok: true });
}
