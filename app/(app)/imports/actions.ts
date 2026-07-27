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
import {
  ocrFileToSheet,
  isOcrFile,
  OcrUnavailableError,
} from "@/lib/imports/ocr";
import {
  detectEntityType,
  mapRow,
  remapRawToEntity,
  type EntityType,
} from "@/lib/imports/detect";
import { expandZips, type UploadItem } from "@/lib/imports/zip";
import {
  findCustomerDuplicate,
  findInvoiceDuplicate,
  findStaffDuplicate,
  findLeadDuplicate,
} from "@/lib/imports/duplicates";
import {
  type FormState,
  formError,
  formSuccess,
} from "@/lib/forms/state";

const uuid = z.string().uuid();

/**
 * Per-row confidence (0–100) at/above which we trust the automatic
 * extraction enough to queue the row for direct commit. Below it — or
 * when the entity type couldn't be detected at all — the row is parked
 * as `needs_review` for the operator to confirm, re-classify, or skip.
 * Shared by the upload router and the commit gate so the two never drift.
 */
const REVIEW_THRESHOLD = 50;

/**
 * Create a new import session. Step 1 of the wizard.
 */
export async function createImport(
  _prevState: FormState<Record<string, unknown>>,
  formData: FormData,
): Promise<FormState<Record<string, unknown>>> {
  const { ctx, user } = await requireOrgContext();
  if (!isAdmin(ctx.membership.role)) {
    return formError("Only admins/owners can create imports.");
  }

  const rawName = ((formData.get("name") as string) ?? "").trim();
  const name =
    rawName.length > 0
      ? rawName.slice(0, 200)
      : `Import ${new Date().toISOString().slice(0, 10)}`;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("imports")
    .insert({ org_id: ctx.org.id, name, created_by: user.id })
    .select("id")
    .single();
  if (error || !data) {
    console.error("[imports] create failed", error);
    return formError("Couldn't create the import. Try again.", { name: rawName });
  }
  return formSuccess({
    successMessage: "Import created.",
    redirectTo: `/imports/${data.id}`,
  });
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

  const rawFiles = formData.getAll("file") as File[];
  if (rawFiles.length === 0) redirect(`/imports/${importId}?error=no_files`);

  // Expand any ZIP archives into their supported inner files so the rest of
  // the pipeline treats them like directly-uploaded files.
  let files: UploadItem[] = [];
  try {
    files = await expandZips(rawFiles);
  } catch (e) {
    console.error("[imports] zip expansion failed", e);
    redirect(`/imports/${importId}?error=zip_failed`);
  }
  if (files.length === 0) redirect(`/imports/${importId}?error=no_files`);

  for (const file of files) {
    if (!file || file.size === 0) continue;
    const buffer = await file.arrayBuffer();
    const lower = (file.name ?? "").toLowerCase();
    let sheets: ParsedSheet[] = [];
    // Spreadsheet/workbook formats SheetJS reads natively (covers every common
    // accounting export): Excel, OpenDocument, Apple Numbers, SYLK, DIF, etc.
    const isSpreadsheet =
      /\.(xlsx|xlsm|xlsb|xls|xlt|xltx|xltm|ods|fods|numbers|dif|prn|slk|dbf)$/i.test(lower) ||
      file.type === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
      file.type === "application/vnd.ms-excel" ||
      file.type === "application/vnd.oasis.opendocument.spreadsheet";
    // Plain-text delimited formats — comma, tab, semicolon, pipe. SheetJS
    // sniffs the delimiter, which is more robust than assuming commas.
    const isDelimited =
      /\.(csv|tsv|tab|txt|psv)$/i.test(lower) ||
      file.type === "text/csv" ||
      file.type === "application/csv" ||
      file.type === "text/tab-separated-values" ||
      file.type === "text/plain";
    try {
      if (lower.endsWith(".csv") || file.type === "text/csv" || file.type === "application/csv") {
        const text = new TextDecoder().decode(new Uint8Array(buffer));
        sheets = [parseCsvFile(text, file.name)];
      } else if (isSpreadsheet || isDelimited) {
        // SheetJS handles xlsx/xls/ods/numbers AND delimited text (tsv/txt/…)
        // with automatic delimiter detection.
        sheets = parseXlsxBuffer(new Uint8Array(buffer));
      } else if (isOcrFile({ type: file.type, name: file.name })) {
        // Migration OS v2 — PDF / photo / screenshot OCR via Claude vision.
        // The OCR helper returns a ParsedSheet with the same canonical
        // header names so the existing detect/map pipeline works unchanged.
        const sheet = await ocrFileToSheet({
          filename: file.name,
          mimeType: file.type || "application/pdf",
          bytes: new Uint8Array(buffer),
        });
        sheets = [sheet];
      } else {
        // Unknown extension — try the workbook parser (it sniffs many formats),
        // then fall back to CSV best-effort. Accept anything; never hard-reject.
        try {
          sheets = parseXlsxBuffer(new Uint8Array(buffer));
        } catch {
          const text = new TextDecoder().decode(new Uint8Array(buffer));
          sheets = [parseCsvFile(text, file.name)];
        }
      }
    } catch (e) {
      if (e instanceof OcrUnavailableError) {
        console.error("[imports] OCR unavailable", e);
        redirect(`/imports/${importId}?error=ocr_unavailable`);
      }
      console.error("[imports] parse failed", e);
      redirect(`/imports/${importId}?error=parse_failed`);
    }

    // Store the raw bytes (admin-only path).
    const storagePath = `${ctx.org.id}/${importId}/${Date.now()}-${safeFilename(file.name)}`;
    // The `imports` bucket enforces an allowed_mime_types whitelist. The
    // browser-assigned MIME types for the formats we accept are wildly
    // inconsistent (tsv→text/tab-separated-values, txt→text/plain,
    // ods→…opendocument…, pdf→application/pdf, png→image/png — and many arrive
    // empty), and most are NOT on that whitelist, so a faithfully-typed upload
    // is rejected by storage *after* we've already parsed the file — surfacing
    // as a baffling upload_failed for everything except CSV/XLS/XLSX. These
    // bytes are an opaque archival copy (re-downloaded by filename, re-parsed
    // by extension), so the stored content-type carries no behaviour. Normalise
    // to the always-allowed octet-stream so every format we can parse we can
    // also store. NOTE: the OCR vision request above still uses the real
    // file.type — that path is intentionally unaffected.
    const { error: upErr } = await admin.storage
      .from("imports")
      .upload(storagePath, new Uint8Array(buffer), {
        contentType: "application/octet-stream",
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
        // Uncertain extraction → "needs_review", never silently dropped.
        // commitImport only processes `pending` rows, so anything we're not
        // confident about — an undetectable entity type, or a per-row
        // confidence under the threshold — is parked for the operator to
        // confirm / re-classify / skip in the wizard instead of vanishing
        // from the import. This is the guided-migration contract: uncertain
        // is "needs review", not "failed".
        const uncertain =
          detected.entity_type === "unknown" ||
          mapped.confidence < REVIEW_THRESHOLD;
        inserts.push({
          org_id: ctx.org.id,
          import_id: importId,
          file_id: fileRow.id,
          source_row_number: i + 1,
          raw: raw as unknown as Json,
          entity_type: detected.entity_type === "unknown" ? "unknown" : mapped.entity_type,
          confidence: mapped.confidence,
          mapped: mapped.mapped as unknown as Json,
          status: uncertain ? "needs_review" : "pending",
          error_message: mapped.warnings.length > 0 ? mapped.warnings.join("; ") : null,
        });
      }
      // Insert in chunks of 500 to avoid hitting the row-size limit on huge files.
      //
      // Per-row failure handling matches the CEO directive's "AI flags
      // issues but does not stop migration" rule. If a whole chunk hits
      // a CHECK violation or similar (e.g. an entity_type the DB
      // doesn't yet recognise — exactly the PR #90 regression that
      // 20260617000000_widen_import_rows_entity_check.sql fixed), fall
      // back to per-row inserts so the bad rows surface as `error` and
      // the rest commit. Never throw out of the upload.
      const CHUNK = 500;
      for (let i = 0; i < inserts.length; i += CHUNK) {
        const slice = inserts.slice(i, i + CHUNK);
        const { error: rowErr } = await supabase.from("import_rows").insert(slice);
        if (!rowErr) continue;
        console.error(
          "[imports] bulk row insert failed, falling back to per-row",
          rowErr,
        );
        for (const single of slice) {
          const { error: oneErr } = await supabase
            .from("import_rows")
            .insert(single);
          if (oneErr) {
            // Best-effort: write a sentinel `error`-status row so the
            // operator sees something in the preview rather than a
            // silent gap. We deliberately use a minimal payload to
            // avoid re-tripping the same constraint.
            console.error(
              "[imports] single row insert failed",
              oneErr,
              single.source_row_number,
            );
            await supabase
              .from("import_rows")
              .insert({
                org_id: single.org_id,
                import_id: single.import_id,
                file_id: single.file_id,
                source_row_number: single.source_row_number,
                raw: single.raw,
                entity_type: "unknown",
                confidence: 0,
                mapped: {},
                status: "error",
                error_message: `db rejected row: ${oneErr.message ?? "unknown"}`,
              });
          }
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

  // Only `pending` rows commit. `needs_review` rows are deliberately
  // excluded until the operator confirms them (which flips them to
  // `pending` with verified confidence). The confidence floor is a
  // belt-and-suspenders guard — uncertain rows never reach `pending` —
  // but it also documents the contract in one place.
  const { data: rows } = await admin
    .from("import_rows")
    .select("id, entity_type, mapped, confidence, status")
    .eq("import_id", importId)
    .in("status", ["pending"])
    .gte("confidence", REVIEW_THRESHOLD);

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

  // Insert in dependency order: parents before children. Jobs and
  // quotes need a customer to exist; payments need an invoice to
  // exist. Costs and supplier-shaped customers slot in alongside
  // their siblings.
  const ORDER: EntityType[] = [
    "customer",
    "supplier",
    "staff",
    "lead",
    "invoice",
    "cost",
    "quote",
    "job",
    "payment",
  ];
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
            .update({ status: "skipped", error_message: skipReason(entity) })
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
  // Reverse insertion order so children get removed before parents.
  // Payments first (FK to invoices), then jobs/quotes (FK to customers),
  // then invoices, then leads/memberships/finances, then customers.
  const REVERSE_ORDER = [
    "invoice_payments",
    "jobs",
    "quotes",
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

/**
 * Entity types an operator may assign to a row during review. Mirrors the
 * detector's EntityType union; kept as a runtime list so we can validate the
 * <select> value from the wizard form.
 */
const REVIEWABLE_ENTITIES: EntityType[] = [
  "customer",
  "supplier",
  "staff",
  "lead",
  "invoice",
  "cost",
  "quote",
  "job",
  "payment",
];

/**
 * Resolve a single `needs_review` row from the wizard. This is the
 * human-in-the-loop step that turns an uncertain extraction into an
 * explicit decision — never a silent drop:
 *
 *   - confirm → accept the row, optionally re-classifying its entity type.
 *               A re-classification re-derives the mapped fields from the
 *               stored raw record (remapRawToEntity). The row flips to
 *               `pending` with verified confidence so the next commit
 *               imports it. An unknown row MUST be classified first —
 *               otherwise commit's ORDER loop couldn't place it.
 *   - skip    → exclude the row from this import (`skipped`).
 */
export async function resolveReviewRow(rowId: string, formData: FormData) {
  const { ctx } = await requireOrgContext();
  if (!isAdmin(ctx.membership.role)) redirect("/imports?error=forbidden");
  if (!uuid.safeParse(rowId).success) redirect("/imports?error=bad_id");

  const supabase = await createClient();
  const { data: row } = await supabase
    .from("import_rows")
    .select("id, import_id, status, entity_type, mapped, raw")
    .eq("id", rowId)
    .maybeSingle();
  if (!row) redirect("/imports?error=not_found");

  const importId = row.import_id as string;
  // Only act on rows actually awaiting review — ignore stale double-submits.
  if (row.status !== "needs_review") {
    redirect(`/imports/${importId}`);
  }

  const intent = String(formData.get("intent") ?? "");

  if (intent === "skip") {
    await supabase
      .from("import_rows")
      .update({ status: "skipped", error_message: "skipped in review" })
      .eq("id", rowId);
    revalidatePath(`/imports/${importId}`);
    redirect(`/imports/${importId}?saved=review_skipped`);
  }

  if (intent === "confirm") {
    const chosenRaw = String(formData.get("entity_type") ?? "").trim();
    const chosen = REVIEWABLE_ENTITIES.find((e) => e === chosenRaw) ?? null;
    const current = REVIEWABLE_ENTITIES.find((e) => e === row.entity_type) ?? null;
    const finalEntity = chosen ?? current;

    // A committed row must resolve to a real entity type, or the commit
    // ORDER loop can't place it and it would silently never import. Force
    // the operator to classify an unknown row before confirming.
    if (!finalEntity) {
      redirect(`/imports/${importId}?error=pick_entity_type`);
    }

    if (finalEntity !== current) {
      // Re-classification → re-derive mapped fields for the chosen entity.
      const raw = (row.raw ?? {}) as Record<string, unknown>;
      const remapped = remapRawToEntity(raw, finalEntity);
      await supabase
        .from("import_rows")
        .update({
          status: "pending",
          entity_type: finalEntity,
          mapped: remapped.mapped as unknown as Json,
          // Human-verified: trust it past the commit gate. Keep any
          // missing-required warnings so the operator still sees them; the
          // row is `pending`, so commit attempts it and surfaces a precise
          // skipReason if a parent (customer/invoice) can't be resolved.
          confidence: 100,
          error_message:
            remapped.warnings.length > 0 ? remapped.warnings.join("; ") : null,
        })
        .eq("id", rowId);
    } else {
      // Confirm as-detected — keep the mapping, just trust it.
      await supabase
        .from("import_rows")
        .update({ status: "pending", confidence: 100, error_message: null })
        .eq("id", rowId);
    }
    revalidatePath(`/imports/${importId}`);
    redirect(`/imports/${importId}?saved=review_confirmed`);
  }

  // Unrecognised intent — no-op back to the wizard.
  redirect(`/imports/${importId}`);
}

// ---------------------------------------------------------------------------

/**
 * Wave 6 — send Supabase magic-link invites for staff rows that were
 * detected on import but couldn't be auto-provisioned (no auth.users
 * mapping exists yet). One invite email per unique address. Marks
 * each import_row as 'merged' with a note so the wizard doesn't keep
 * offering them.
 */
export async function sendStaffInvitesFromImport(importId: string) {
  const { ctx } = await requireOrgContext();
  if (!isAdmin(ctx.membership.role)) redirect(`/imports/${importId}?error=forbidden`);
  if (!uuid.safeParse(importId).success) redirect("/imports?error=bad_id");

  const supabase = await createClient();
  const admin = createAdminClient();

  const { data: rows } = await supabase
    .from("import_rows")
    .select("id, mapped, status")
    .eq("import_id", importId)
    .eq("entity_type", "staff")
    .in("status", ["pending", "skipped"]);
  if (!rows || rows.length === 0) {
    redirect(`/imports/${importId}?error=no_staff_to_invite`);
  }

  const sent: string[] = [];
  for (const r of rows) {
    const m = (r.mapped ?? {}) as { email?: string; full_name?: string };
    const email = (m.email ?? "").toLowerCase().trim();
    if (!email) {
      await supabase
        .from("import_rows")
        .update({ status: "skipped", error_message: "no email" })
        .eq("id", r.id);
      continue;
    }
    if (sent.includes(email)) {
      await supabase
        .from("import_rows")
        .update({ status: "merged", error_message: "duplicate email — invite already sent" })
        .eq("id", r.id);
      continue;
    }
    try {
      await admin.auth.admin.inviteUserByEmail(email, {
        // Must match the canonical staff-invite contract in
        // app/(app)/staff/actions.ts. The /onboarding join flow keys off
        // `invited_org_id` (+ a "staff_invite" source tag). The previous
        // payload used the key `org_id` and an "import" source tag, which
        // NOTHING consumed — so an imported staff member clicking their invite
        // wasn't recognised as invited, fell through to the create-company
        // form, and spun up a brand-new empty org instead of joining their
        // employer.
        data: {
          invited_org_id: ctx.org.id,
          invited_role: "staff",
          invited_full_name: m.full_name ?? null,
          source: "staff_invite",
        },
        redirectTo: process.env.NEXT_PUBLIC_APP_URL
          ? `${process.env.NEXT_PUBLIC_APP_URL}/onboarding/company?invited_org=${ctx.org.id}&invited_role=staff`
          : undefined,
      });
      sent.push(email);
      await supabase
        .from("import_rows")
        .update({ status: "merged", error_message: "invite sent" })
        .eq("id", r.id);
    } catch (e) {
      console.error("[imports] invite failed", e);
      await supabase
        .from("import_rows")
        .update({ status: "error", error_message: (e as Error).message ?? "invite failed" })
        .eq("id", r.id);
    }
  }

  revalidatePath(`/imports/${importId}`);
  redirect(`/imports/${importId}?saved=invites_sent&count=${sent.length}`);
}

/**
 * Human-readable reason a row was skipped during commit (insertOne returned
 * null). insertOne returns null for several distinct reasons, so a blanket
 * "missing required fields" was actively misleading — most painfully for staff
 * (which ALWAYS skips by design, yet had all its data) and for job/quote/
 * payment rows whose referenced customer/invoice simply couldn't be matched by
 * name. The operator needs to trust why a row didn't import, so point at the
 * real, actionable cause.
 */
function skipReason(entity: EntityType): string {
  switch (entity) {
    case "staff":
      return 'staff aren’t created on import — use “Send staff invites” to email them a sign-in link';
    case "job":
      return "couldn’t match a customer for this job — check the customer name";
    case "quote":
      return "couldn’t match a customer for this quote — check the customer name";
    case "payment":
      return "couldn’t match an invoice for this payment — check the invoice number";
    default:
      return "missing required fields";
  }
}

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
    case "job":
      return "jobs";
    case "quote":
      return "quotes";
    case "payment":
      return "invoice_payments";
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
    case "job": {
      // Jobs need a customer to be useful. Resolve customer_name to
      // an existing org customer (case-insensitive). If we can't,
      // skip rather than blocking the rest of the migration.
      const customerName = String(mapped.customer_name ?? "").trim();
      if (!customerName) return null;
      const customerId = await resolveCustomerByName(
        admin,
        orgId,
        customerName,
      );
      if (!customerId) return null;
      // Compose a notes field that preserves details the jobs table
      // doesn't have first-class columns for (title / address /
      // value), so nothing the migration extracted is lost.
      const noteParts: string[] = [];
      if (mapped.title) noteParts.push(`Title: ${mapped.title}`);
      if (mapped.address) noteParts.push(`Address: ${mapped.address}`);
      if (mapped.value != null && mapped.value !== "") {
        noteParts.push(`Value: ${mapped.value}`);
      }
      if (mapped.notes) noteParts.push(String(mapped.notes));
      const composedNotes = noteParts.join("\n") || null;
      const { data, error } = await admin
        .from("jobs")
        .insert({
          org_id: orgId,
          customer_id: customerId,
          status: (mapped.status as string) ?? "new",
          scheduled_date: (mapped.scheduled_date as string) ?? null,
          notes: composedNotes,
        })
        .select("id")
        .single();
      if (error) throw new Error(error.message);
      return data?.id ?? null;
    }
    case "quote": {
      // Quotes need both a number AND a resolvable customer.
      const number = String(mapped.number ?? "").trim();
      if (!number) return null;
      const customerName = String(mapped.customer_name ?? "").trim();
      if (!customerName) return null;
      const customerId = await resolveCustomerByName(
        admin,
        orgId,
        customerName,
      );
      if (!customerId) return null;
      const total = Number(mapped.total ?? 0);
      const { data, error } = await admin
        .from("quotes")
        .insert({
          org_id: orgId,
          customer_id: customerId,
          number,
          status: (mapped.status as string) ?? "draft",
          // v1: we don't split subtotal/vat from imported totals —
          // the operator can re-issue the quote in-app to recompute.
          subtotal: total,
          vat_total: 0,
          total,
          valid_until: (mapped.valid_until as string) ?? null,
          notes: (mapped.notes as string) ?? null,
        })
        .select("id")
        .single();
      if (error) throw new Error(error.message);
      return data?.id ?? null;
    }
    case "payment": {
      // Payments need a positive amount + a resolvable invoice.
      const amount = Number(mapped.amount ?? 0);
      if (!(amount > 0)) return null;
      const invoiceNumber = String(mapped.invoice_number ?? "").trim();
      if (!invoiceNumber) return null;
      const invoiceId = await resolveInvoiceByNumber(
        admin,
        orgId,
        invoiceNumber,
      );
      if (!invoiceId) return null;
      const paidAt =
        (mapped.paid_at as string) ?? new Date().toISOString().slice(0, 10);
      const noteParts: string[] = [];
      if (mapped.payment_method) {
        noteParts.push(`Method: ${mapped.payment_method}`);
      }
      if (mapped.notes) noteParts.push(String(mapped.notes));
      const { data, error } = await admin
        .from("invoice_payments")
        .insert({
          org_id: orgId,
          invoice_id: invoiceId,
          amount,
          paid_at: paidAt,
          reference: (mapped.reference as string) ?? null,
          notes: noteParts.join(" · ") || null,
          source: "manual",
        })
        .select("id")
        .single();
      if (error) throw new Error(error.message);
      return data?.id ?? null;
    }
  }
}

// ---------------------------------------------------------------------
// Parent-record resolvers — needed by jobs / quotes / payments.
// Service-role; gated upstream by isAdmin + RLS-scoped imports table.
// ---------------------------------------------------------------------

async function resolveCustomerByName(
  admin: ReturnType<typeof createAdminClient>,
  orgId: string,
  name: string,
): Promise<string | null> {
  const { data } = await admin
    .from("customers")
    .select("id")
    .eq("org_id", orgId)
    .ilike("name", name)
    .limit(1)
    .maybeSingle();
  return (data as { id?: string } | null)?.id ?? null;
}

async function resolveInvoiceByNumber(
  admin: ReturnType<typeof createAdminClient>,
  orgId: string,
  number: string,
): Promise<string | null> {
  const { data } = await admin
    .from("invoices")
    .select("id")
    .eq("org_id", orgId)
    .ilike("number", number)
    .limit(1)
    .maybeSingle();
  return (data as { id?: string } | null)?.id ?? null;
}

type InvoiceStatusEnum =
  | "draft"
  | "sent"
  | "awaiting_payment"
  | "partially_paid"
  | "paid";

/**
 * Map an imported status cell onto a WRITABLE invoice status.
 *
 * `overdue` is deliberately not accepted. It is derived from `due_date` plus
 * the trigger-owned payment status (lib/invoices/overdue.ts), so importing it
 * would store a value nothing keeps current — the row would read "overdue"
 * forever, including after payment.
 *
 * A legacy CSV column saying "overdue" is not discarded information: such an
 * invoice is unpaid and past its date, which is exactly what `sent` + its
 * `due_date` already expresses. It will be shown as overdue by the derived
 * authority, on the same terms as every other invoice — so the import lands on
 * `sent` (the existing fallback) and the truth is recovered from the facts.
 */
function normaliseInvoiceStatus(raw: unknown): InvoiceStatusEnum {
  if (typeof raw !== "string") return "sent";
  const allowed: InvoiceStatusEnum[] = [
    "draft",
    "sent",
    "awaiting_payment",
    "partially_paid",
    "paid",
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
