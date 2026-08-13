import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireOrgContext } from "@/server/auth/session";
import { verifyJobInOrg } from "@/lib/crm/reference-integrity";
import {
  createFinanceSchema,
  RECEIPT_MAX_BYTES,
  RECEIPT_ALLOWED_MIME,
  FINANCE_CATEGORIES,
  FINANCE_VAT_RATES,
} from "@/lib/finances/schema";

/**
 * Finances list + create.
 *
 *   GET  /api/finances                  list (paginated, filtered)
 *   POST /api/finances                  create (optional multipart receipt)
 *
 * All operations run under the caller's JWT — RLS scopes to their org.
 * For uploads we use the service-role client so we can write to storage
 * AFTER the finance row has been created (to derive the <org/finance> path);
 * uploads are validated server-side (size + MIME) before they ever leave
 * the function.
 */

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 50;

function isAllowedMime(mime: string | null | undefined): boolean {
  return !!mime && RECEIPT_ALLOWED_MIME.has(mime);
}

export async function GET(request: NextRequest) {
  const { ctx } = await requireOrgContext();
  const supabase = await createClient();
  const url = request.nextUrl;

  const limit = Math.min(
    Math.max(parseInt(url.searchParams.get("limit") ?? `${DEFAULT_LIMIT}`, 10) || DEFAULT_LIMIT, 1),
    MAX_LIMIT,
  );
  const offset = Math.max(parseInt(url.searchParams.get("offset") ?? "0", 10) || 0, 0);
  const category = url.searchParams.get("category");
  const vatRateRaw = url.searchParams.get("vat_rate");
  const from = url.searchParams.get("from"); // YYYY-MM-DD
  const to = url.searchParams.get("to");

  let q = supabase
    .from("finances")
    .select(
      "id, amount, currency, vat_rate, vat_total, category, receipt_url, notes, job_id, created_at, updated_at",
      { count: "exact" },
    )
    // ACTIVE-org pin + unique `id` tiebreaker — the POST half of this route
    // already stamps `org_id: ctx.org.id`; the GET list did not scope by it.
    .eq("org_id", ctx.org.id)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .range(offset, offset + limit - 1);

  if (
    category &&
    (FINANCE_CATEGORIES as readonly string[]).includes(category)
  ) {
    q = q.eq("category", category);
  }
  if (vatRateRaw !== null) {
    const r = Number(vatRateRaw);
    if ((FINANCE_VAT_RATES as readonly number[]).includes(r)) {
      q = q.eq("vat_rate", r);
    }
  }
  if (from && /^\d{4}-\d{2}-\d{2}$/.test(from)) {
    q = q.gte("created_at", `${from}T00:00:00Z`);
  }
  if (to && /^\d{4}-\d{2}-\d{2}$/.test(to)) {
    q = q.lte("created_at", `${to}T23:59:59Z`);
  }

  const { data, error, count } = await q;
  if (error) {
    console.error("[finances] list failed", error);
    return NextResponse.json({ error: "Failed to load finances" }, { status: 500 });
  }

  return NextResponse.json({ data: data ?? [], count: count ?? 0, limit, offset });
}

export async function POST(request: NextRequest) {
  const { ctx } = await requireOrgContext();
  const contentType = request.headers.get("content-type") ?? "";

  let fields: Record<string, FormDataEntryValue> = {};
  let receiptFile: File | null = null;

  if (contentType.startsWith("multipart/form-data")) {
    const form = await request.formData();
    for (const [k, v] of form.entries()) {
      if (k === "receipt" && v instanceof File && v.size > 0) {
        receiptFile = v;
      } else {
        fields[k] = v;
      }
    }
  } else {
    // JSON body — programmatic clients without file upload.
    try {
      fields = (await request.json()) as Record<string, FormDataEntryValue>;
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }
  }

  const parsed = createFinanceSchema.safeParse({
    amount: fields.amount,
    vat_rate: fields.vat_rate,
    category: fields.category,
    notes: fields.notes,
    job_id: fields.job_id,
  });
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", issues: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const supabase = await createClient();

  // Cross-org reference integrity (defence in depth over the composite FK added
  // in migration 20261119000000): a supplied job_id must belong to the caller's
  // ACTIVE org. The Zod schema only proves it is a uuid — it cannot know org
  // membership — so a caller in org A could otherwise attach org B's job_id and
  // contaminate that job's computed cost/margin/VAT. Mirrors the quotes usage.
  if (parsed.data.job_id) {
    const ref = await verifyJobInOrg(supabase, parsed.data.job_id, ctx.org.id);
    if (!ref.ok) {
      return NextResponse.json({ error: ref.message }, { status: 400 });
    }
  }

  if (receiptFile) {
    if (receiptFile.size > RECEIPT_MAX_BYTES) {
      return NextResponse.json(
        { error: `Receipt exceeds ${RECEIPT_MAX_BYTES} bytes` },
        { status: 413 },
      );
    }
    if (!isAllowedMime(receiptFile.type)) {
      return NextResponse.json(
        { error: `Unsupported receipt type: ${receiptFile.type}` },
        { status: 415 },
      );
    }
  }

  const { data: inserted, error: insertErr } = await supabase
    .from("finances")
    .insert({
      org_id: ctx.org.id,
      amount: parsed.data.amount,
      vat_rate: parsed.data.vat_rate,
      category: parsed.data.category ?? null,
      notes: parsed.data.notes ?? null,
      job_id: parsed.data.job_id ?? null,
    })
    .select("id")
    .single();

  if (insertErr || !inserted) {
    console.error("[finances] create failed", insertErr);
    return NextResponse.json({ error: "Failed to create finance" }, { status: 500 });
  }

  let receiptPath: string | null = null;
  if (receiptFile) {
    // Sanitise filename: keep extension + replace risky chars.
    const safeName = receiptFile.name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-100);
    receiptPath = `${ctx.org.id}/${inserted.id}/${safeName}`;
    const admin = createAdminClient();
    const arrayBuffer = await receiptFile.arrayBuffer();
    const { error: upErr } = await admin.storage
      .from("receipts")
      .upload(receiptPath, arrayBuffer, {
        contentType: receiptFile.type,
        upsert: true,
      });
    if (upErr) {
      console.error("[finances] receipt upload failed", upErr);
      // Don't fail the whole request — the row is saved. Surface the partial
      // failure so the client can prompt for re-upload.
      return NextResponse.json(
        { id: inserted.id, warning: "Finance saved, but receipt upload failed" },
        { status: 207 },
      );
    }
    const { error: patchErr } = await supabase
      .from("finances")
      .update({ receipt_url: receiptPath })
      .eq("id", inserted.id);
    if (patchErr) {
      console.error("[finances] post-upload patch failed", patchErr);
    }
  }

  return NextResponse.json({ id: inserted.id, receipt_url: receiptPath }, { status: 201 });
}
