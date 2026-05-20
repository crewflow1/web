"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/types";
import { requireOrgContext } from "@/server/auth/session";
import {
  parseCsvFile,
  parseXlsxBuffer,
  rowToRecord,
  type ParsedSheet,
} from "@/lib/imports/parsers";
import { detectEntityType, mapRow, type EntityType } from "@/lib/imports/detect";
import {
  findCustomerDuplicate,
  findInvoiceDuplicate,
  findStaffDuplicate,
  findLeadDuplicate,
} from "@/lib/imports/duplicates";

const uuid = z.string().uuid();

/**
 * Create a new import session. Step 1 of the wizard.
 */
export async function createImport(formData: FormData) {
  const { ctx, user } = await requireOrgContext();
  if (!isAdmin(ctx.membership.role)) redirect("/imports?error=forbidden");

  const rawName = ((formData.get("name") as string) ?? "").trim();
  const name = rawName.length > 0 ? rawName.slice(0, 200) : `Import ${new Date().toISOString().slice(0, 10)}`;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("imports")
    .insert({ org_id: ctx.org.id, name, created_by: user.id })
    .select("id")
    .single();
  if (error || !data) {
    console.error("[imports] create failed", error);
    redirect("/imports?error=create_failed");
  }
  redirect(`/imports/${data.id}`);
}

/**
 * Step 2: upload one or more files into the session. Parses each in-memory,
 * stores raw bytes in `imports` storage bucket, writes import_rows + sets
 * the session status to 'detected' once parsing is complete.
 */
export async function uploadImportFiles(importId: string, formData: FormData) {
  const { ctx } = await requireOrgContext();
  if (!isAdmin(ctx.membership.role)) redirect(`/imports/${importId}?error=forbidden`);
  if (!uuid.safeParse(importId).success) redirect("/imports?error=bad_id");

  const supabase = await createClient();
  const admin = createAdminClient();

  const { data: importRow } = await supabase
    .from("imports")
    .select("id, org_id, status")
    .eq("id", importId)
    .maybeSingle();
  if (!importRow) redirect("/imports?error=not_found");
  if (importRow.status === "committed") {
    redirect(`/imports/${importId}?error=already_committed`);
  }

  const files = formData.getAll("file") as File[];
  if (files.length === 0) redirect(`/imports/${importId}?error=no_files`);

  for (const file of files) {
    if (!file || file.size === 0) continue;
    const buffer = await file.arrayBuffer();
    const lower = (file.name ?? "").toLowerCase();
    let sheets: ParsedSheet[] = [];
    try {
      if (lower.endsWith(".csv") || file.type === "text/csv" || file.type === "application/csv") {
        const text = new TextDecoder().decode(new Uint8Array(buffer));
        sheets = [parseCsvFile(text, file.name)];
      } else if (
        lower.endsWith(".xlsx") ||
        lower.endsWith(".xls") ||
        file.type === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
        file.type === "application/vnd.ms-excel"
      ) {
        sheets = parseXlsxBuffer(new Uint8Array(buffer));
      } else {
        // Treat as CSV best-effort.
        const text = new TextDecoder().decode(new Uint8Array(buffer));
        sheets = [parseCsvFile(text, file.name)];
      }
    } catch (e) {
      console.error("[imports] parse failed", e);
      redirect(`/imports/${importId}?error=parse_failed`);
    }

    // Store the raw bytes (admin-only path).
    const storagePath = `${ctx.org.id}/${importId}/${Date.now()}-${safeFilename(file.name)}`;
    const { error: upErr } = await admin.storage
      .from("imports")
      .upload(storagePath, new Uint8Array(buffer), {
        contentType: file.type || "application/octet-stream",
        upsert: false,
      });
    if (upErr) {
      console.error("[imports] storage upload failed", upErr);
      redirect(`/imports/${importId}?error=upload_failed`);
    }

    const totalRows = sheets.reduce((s, sh) => s + sh.rows.length, 0);

    const { data: fileRow, error: fErr } = await supabase
      .from("import_files")
      .insert({
        org_id: ctx.org.id,
        import_id: importId,
        filename: file.name,
        storage_path: storagePath,
        mime_type: file.type || null,
        size_bytes: file.size,
        row_count: totalRows,
      })
      .select("id")
      .single();
    if (fErr || !fileRow) {
      console.error("[imports] file row failed", fErr);
      redirect(`/imports/${importId}?error=file_record_failed`);
    }

    // Detect + parse every row.
    for (const sheet of sheets) {
      const detected = detectEntityType(sheet);
      type ImportRowInsert = {
        org_id: string;
        import_id: string;
        file_id: string;
        source_row_number: number;
        raw: Json;
        entity_type: string;
        confidence: number;
        mapped: Json;
        status: string;
        error_message: string | null;
      };
      const inserts: ImportRowInsert[] = [];
      for (let i = 0; i < sheet.rows.length; i++) {
        const row = sheet.rows[i]!;
        const raw = rowToRecord(sheet, row);
        const mapped = mapRow(detected, row);
        inserts.push({
          org_id: ctx.org.id,
          import_id: importId,
          file_id: fileRow.id,
          source_row_number: i + 1,
          raw: raw as unknown as Json,
          entity_type: detected.entity_type === "unknown" ? "unknown" : mapped.entity_type,
          confidence: mapped.confidence,
          mapped: mapped.mapped as unknown as Json,
          status: "pending",
          error_message: mapped.warnings.length > 0 ? mapped.warnings.join("; ") : null,
        });
      }
      // Insert in chunks of 500 to avoid hitting the row-size limit on huge files.
      const CHUNK = 500;
      for (let i = 0; i < inserts.length; i += CHUNK) {
        const slice = inserts.slice(i, i + CHUNK);
        const { error: rowErr } = await supabase.from("import_rows").insert(slice);
        if (rowErr) {
          console.error("[imports] row insert failed", rowErr);
          redirect(`/imports/${importId}?error=row_insert_failed`);
        }
      }
    }
  }

  // Run duplicate detection (admin client so we can see all org rows).
  await annotateDuplicates(importId, ctx.org.id);

  await supabase
    .from("imports")
    .update({ status: "detected" })
    .eq("id", importId);

  revalidatePath(`/imports/${importId}`);
  revalidatePath("/imports");
  redirect(`/imports/${importId}?saved=uploaded`);
}

async function annotateDuplicates(importId: string, orgId: string) {
  const admin = createAdminClient();
  const { data: rows } = await admin
    .from("import_rows")
    .select("id, entity_type, mapped")
    .eq("import_id", importId)
    .eq("status", "pending");
  if (!rows || rows.length === 0) return;

  // Load existing rows once per entity type that's actually present.
  const types = new Set(rows.map((r) => r.entity_type ?? "unknown"));
  const customers = types.has("customer")
    ? (await admin.from("customers").select("id, name, email, phone").eq("org_id", orgId)).data ?? []
    : [];
  const invoices = types.has("invoice")
    ? (await admin.from("invoices").select("id, number").eq("org_id", orgId)).data ?? []
    : [];
  const memberships = types.has("staff")
    ? (await admin
        .from("memberships")
        .select("user_id, user:users ( id, email, full_name )")
        .eq("org_id", orgId)).data ?? []
    : [];
  const staffUsers = memberships
    .map((m) => (m as { user?: { id: string; email: string; full_name: string | null } }).user)
    .filter((u): u is { id: string; email: string; full_name: string | null } => !!u);
  const leadsRaw = types.has("lead")
    ? (await admin
        .from("leads")
        .select("id, customer:customers ( email, phone )")
        .eq("org_id", orgId)).data ?? []
    : [];
  const leads = leadsRaw.map((l) => ({
    id: l.id,
    email: (l as { customer?: { email: string | null } | null }).customer?.email ?? null,
    phone: (l as { customer?: { phone: string | null } | null }).customer?.phone ?? null,
  }));

  for (const r of rows) {
    let match = null as { target_id: string; reason: string; score: number } | null;
    const mapped = r.mapped as Record<string, unknown>;
    switch (r.entity_type) {
      case "customer":
        match = findCustomerDuplicate(mapped, customers);
        break;
      case "invoice":
        match = findInvoiceDuplicate(mapped, invoices);
        break;
      case "staff":
        match = findStaffDuplicate(mapped, staffUsers);
        break;
      case "lead":
        match = findLeadDuplicate(mapped, leads);
        break;
    }
    if (match) {
      await admin
        .from("import_rows")
        .update({
          status: "duplicate",
          duplicate_of_id: match.target_id,
          error_message: match.reason,
        })
        .eq("id", r.id);
    }
  }
}

/**
 * Step 5: commit the import. Inserts non-duplicate, non-error rows into
 * their target tables, writes audit rows for rollback.
 */
export async function commitImport(importId: string) {
  const { ctx } = await requireOrgContext();
  if (!isAdmin(ctx.membership.role)) redirect(`/imports/${importId}?error=forbidden`);
  if (!uuid.safeParse(importId).success) redirect("/imports?error=bad_id");

  const supabase = await createClient();
  const admin = createAdminClient();

  const { data: importRow } = await supabase
    .from("imports")
    .select("id, org_id, status")
    .eq("id", importId)
    .maybeSingle();
  if (!importRow) redirect("/imports?error=not_found");
  if (importRow.status !== "detected") {
    redirect(`/imports/${importId}?error=not_ready`);
  }

  const { data: rows } = await admin
    .from("import_rows")
    .select("id, entity_type, mapped, confidence, status")
    .eq("import_id", importId)
    .in("status", ["pending"])
    .gte("confidence", 50);

  let imported = 0;
  let skipped = 0;
  // We do customers first so invoices/leads/etc. can reference them. v1
  // imports don't link invoices to customers automatically — that's a
  // v2 polish — so order is just nice-to-have here.
  const byEntity: Record<string, typeof rows> = {};
  for (const r of rows ?? []) {
    const k = r.entity_type ?? "unknown";
    (byEntity[k] = byEntity[k] ?? []).push(r);
  }

  const ORDER: EntityType[] = ["customer", "supplier", "staff", "lead", "invoice", "cost"];
  for (const entity of ORDER) {
    const list = byEntity[entity] ?? [];
    for (const r of list) {
      const mapped = (r.mapped ?? {}) as Record<string, unknown>;
      try {
        const targetId = await insertOne(entity, mapped, ctx.org.id, admin);
        if (!targetId) {
          skipped++;
          await admin
            .from("import_rows")
            .update({ status: "skipped", error_message: "missing required fields" })
            .eq("id", r.id);
          continue;
        }
        await admin.from("import_audit").insert({
          org_id: ctx.org.id,
          import_id: importId,
          import_row_id: r.id,
          target_table: tableFor(entity),
          target_id: targetId,
        });
        await admin
          .from("import_rows")
          .update({ status: "imported", target_table: tableFor(entity), target_id: targetId })
          .eq("id", r.id);
        imported++;
      } catch (e) {
        skipped++;
        await admin
          .from("import_rows")
          .update({ status: "error", error_message: (e as Error).message ?? "unknown" })
          .eq("id", r.id);
      }
    }
  }

  await supabase
    .from("imports")
    .update({ status: "committed", committed_at: new Date().toISOString() })
    .eq("id", importId);

  revalidatePath(`/imports/${importId}`);
  revalidatePath("/imports");
  revalidatePath("/dashboard");
  redirect(`/imports/${importId}?saved=committed&imported=${imported}&skipped=${skipped}`);
}

/**
 * Step 6 (optional): roll the whole thing back. Deletes every audited
 * target row + marks the session 'rolled_back'.
 */
export async function rollbackImport(importId: string) {
  const { ctx } = await requireOrgContext();
  if (!isAdmin(ctx.membership.role)) redirect(`/imports/${importId}?error=forbidden`);
  if (!uuid.safeParse(importId).success) redirect("/imports?error=bad_id");

  const supabase = await createClient();
  const admin = createAdminClient();

  const { data: importRow } = await supabase
    .from("imports")
    .select("id, status")
    .eq("id", importId)
    .maybeSingle();
  if (!importRow) redirect("/imports?error=not_found");
  if (importRow.status !== "committed") {
    redirect(`/imports/${importId}?error=not_committed`);
  }

  const { data: audit } = await admin
    .from("import_audit")
    .select("target_table, target_id")
    .eq("import_id", importId);
  // Reverse insertion order so children get removed before parents.
  const grouped = new Map<string, string[]>();
  for (const a of audit ?? []) {
    const arr = grouped.get(a.target_table) ?? [];
    arr.push(a.target_id);
    grouped.set(a.target_table, arr);
  }
  const REVERSE_ORDER = [
    "invoices",
    "finances",
    "leads",
    "memberships",
    "customers",
  ];
  for (const table of REVERSE_ORDER) {
    const ids = grouped.get(table);
    if (!ids || ids.length === 0) continue;
    await admin.from(table as never).delete().in("id", ids);
  }
  await admin.from("import_audit").delete().eq("import_id", importId);
  await admin
    .from("import_rows")
    .update({ status: "skipped", target_id: null, target_table: null })
    .eq("import_id", importId)
    .eq("status", "imported");
  await supabase
    .from("imports")
    .update({ status: "rolled_back", rolled_back_at: new Date().toISOString() })
    .eq("id", importId);

  revalidatePath(`/imports/${importId}`);
  revalidatePath("/imports");
  revalidatePath("/dashboard");
  redirect(`/imports/${importId}?saved=rolled_back`);
}

/**
 * Mark an individual row to merge into an existing record instead of
 * creating a duplicate. Used on the preview screen.
 */
export async function ignoreDuplicateRow(rowId: string) {
  const { ctx } = await requireOrgContext();
  if (!isAdmin(ctx.membership.role)) redirect("/imports?error=forbidden");
  if (!uuid.safeParse(rowId).success) redirect("/imports?error=bad_id");
  const supabase = await createClient();
  const { data: row } = await supabase
    .from("import_rows")
    .select("import_id")
    .eq("id", rowId)
    .maybeSingle();
  if (!row) redirect("/imports?error=not_found");
  await supabase
    .from("import_rows")
    .update({ status: "skipped", error_message: "duplicate — kept existing" })
    .eq("id", rowId);
  void ctx;
  revalidatePath(`/imports/${row.import_id}`);
  redirect(`/imports/${row.import_id}?saved=duplicate_skipped`);
}

// ---------------------------------------------------------------------------

function tableFor(entity: EntityType): string {
  switch (entity) {
    case "customer":
      return "customers";
    case "invoice":
      return "invoices";
    case "lead":
      return "leads";
    case "staff":
      return "memberships";
    case "cost":
      return "finances";
    case "supplier":
      return "customers"; // v1: suppliers live alongside customers
  }
}

async function insertOne(
  entity: EntityType,
  mapped: Record<string, unknown>,
  orgId: string,
  admin: ReturnType<typeof createAdminClient>,
): Promise<string | null> {
  switch (entity) {
    case "customer":
    case "supplier": {
      const name = String(mapped.name ?? "").trim();
      if (!name) return null;
      const { data, error } = await admin
        .from("customers")
        .insert({
          org_id: orgId,
          name,
          email: (mapped.email as string) ?? null,
          phone: (mapped.phone as string) ?? null,
          notes: (mapped.notes as string) ?? null,
        })
        .select("id")
        .single();
      if (error) throw new Error(error.message);
      return data?.id ?? null;
    }
    case "invoice": {
      const number = String(mapped.number ?? "").trim();
      const total = Number(mapped.total ?? 0);
      if (!number || total <= 0) return null;
      const vat = Number(mapped.vat_total ?? 0);
      const amount = Number(mapped.amount ?? Math.max(0, total - vat));
      const { data, error } = await admin
        .from("invoices")
        .insert({
          org_id: orgId,
          number,
          amount,
          vat_total: vat,
          total,
          status: normaliseInvoiceStatus(mapped.status),
          due_date: (mapped.due_date as string) ?? null,
          paid_at: (mapped.paid_at as string) ?? null,
          notes: (mapped.notes as string) ?? null,
        })
        .select("id")
        .single();
      if (error) throw new Error(error.message);
      return data?.id ?? null;
    }
    case "lead": {
      const name = String(mapped.name ?? "").trim();
      if (!name) return null;
      // Leads need a customer; create one inline if not supplied.
      const { data: cust } = await admin
        .from("customers")
        .insert({
          org_id: orgId,
          name,
          email: (mapped.email as string) ?? null,
          phone: (mapped.phone as string) ?? null,
        })
        .select("id")
        .single();
      const { data, error } = await admin
        .from("leads")
        .insert({
          org_id: orgId,
          customer_id: cust?.id ?? null,
          source: ((mapped.source as string) ?? "import"),
          service: (mapped.service as string) ?? null,
          urgency: (mapped.urgency as string) ?? null,
          postcode: (mapped.postcode as string) ?? null,
          estimated_value: (mapped.estimated_value as number) ?? null,
          notes: (mapped.notes as string) ?? null,
        })
        .select("id")
        .single();
      if (error) throw new Error(error.message);
      return data?.id ?? null;
    }
    case "cost": {
      const amount = Number(mapped.amount ?? 0);
      if (amount <= 0) return null;
      const { data, error } = await admin
        .from("finances")
        .insert({
          org_id: orgId,
          amount,
          vat_total: Number(mapped.vat_total ?? 0),
          category: (mapped.category as string) ?? null,
          notes: (mapped.notes as string) ?? null,
        })
        .select("id")
        .single();
      if (error) throw new Error(error.message);
      return data?.id ?? null;
    }
    case "staff": {
      // Importing staff with full auth-user provisioning is a deeper
      // workflow than v1 covers (email invite + magic-link). v1 records
      // the row in import_rows + a stub customer row so the wizard still
      // surfaces them as imported — but does NOT create auth users.
      // Skip insertion; surface as 'skipped' with a note.
      return null;
    }
  }
}

type InvoiceStatusEnum =
  | "draft"
  | "sent"
  | "awaiting_payment"
  | "partially_paid"
  | "paid"
  | "overdue";

function normaliseInvoiceStatus(raw: unknown): InvoiceStatusEnum {
  if (typeof raw !== "string") return "sent";
  const allowed: InvoiceStatusEnum[] = [
    "draft",
    "sent",
    "awaiting_payment",
    "partially_paid",
    "paid",
    "overdue",
  ];
  const v = raw.toLowerCase().trim() as InvoiceStatusEnum;
  return allowed.includes(v) ? v : "sent";
}

function safeFilename(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 120) || "file";
}

function isAdmin(role: string): boolean {
  return role === "owner" || role === "admin";
}
