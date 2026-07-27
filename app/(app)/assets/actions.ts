"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { randomUUID } from "node:crypto";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { recordAdminActivity } from "@/server/services/hq-audit";
import { deleteTenantAttachment } from "@/server/services/tenant-attachments";
import {
  ASSET_STATUSES,
  assetIdSchema,
  createAssetSchema,
  type AssetStatus,
} from "@/lib/assets/schema";

/**
 * Asset register actions. `assets` is newer than the generated Supabase types,
 * so queries are cast through minimal precise shapes (the snags/toolbox idiom).
 * All writes go through the tenant (user-JWT) client so RLS scopes them; every
 * mutation is count-gated.
 */

type InsertChain = {
  insert: (row: unknown) => Promise<{ error: { message: string } | null }>;
};
type UpdateChain = {
  update: (
    patch: unknown,
    opts?: { count?: string },
  ) => {
    eq: (k: string, v: unknown) => {
      eq: (
        k: string,
        v: unknown,
      ) => Promise<{ error: { message: string } | null; count: number | null }>;
    };
  };
};
type DeleteChain = {
  delete: (opts?: { count?: string }) => {
    eq: (k: string, v: unknown) => {
      eq: (
        k: string,
        v: unknown,
      ) => Promise<{ error: { message: string } | null; count: number | null }>;
    };
  };
};
type AttachmentIdsChain = {
  select: (cols: string) => {
    eq: (k: string, v: unknown) => {
      eq: (k: string, v: unknown) => {
        eq: (k: string, v: unknown) => Promise<{ data: { id: string }[] | null }>;
      };
    };
  };
};

export async function createAsset(formData: FormData): Promise<void> {
  const { ctx, user } = await requireOrgContext();

  const parsed = createAssetSchema.safeParse({
    name: formData.get("name") ?? "",
    category: formData.get("category") ?? "",
    asset_ref: formData.get("asset_ref") ?? "",
    manufacturer: formData.get("manufacturer") ?? "",
    model: formData.get("model") ?? "",
    serial_number: formData.get("serial_number") ?? "",
    registration: formData.get("registration") ?? "",
    ownership: formData.get("ownership") ?? "owned",
    status: formData.get("status") ?? "active",
    supplier_id: formData.get("supplier_id") ?? "",
    purchase_date: formData.get("purchase_date") ?? "",
    purchase_price: formData.get("purchase_price") ?? "",
    current_value: formData.get("current_value") ?? "",
    warranty_expires_at: formData.get("warranty_expires_at") ?? "",
    hire_start: formData.get("hire_start") ?? "",
    hire_end: formData.get("hire_end") ?? "",
    hire_rate: formData.get("hire_rate") ?? "",
    notes: formData.get("notes") ?? "",
  });
  if (!parsed.success) {
    const issues = parsed.error.flatten().fieldErrors;
    const firstError = Object.values(issues).flat()[0] ?? "validation";
    redirect(`/assets/new?error=${encodeURIComponent(firstError)}`);
  }
  const d = parsed.success ? parsed.data : null;

  const id = randomUUID();
  const tenant = await createClient();
  const { error } = await (
    tenant.from("assets" as never) as unknown as InsertChain
  ).insert({
    id,
    org_id: ctx.org.id,
    name: d?.name,
    category: d?.category ?? null,
    asset_ref: d?.asset_ref ?? null,
    manufacturer: d?.manufacturer ?? null,
    model: d?.model ?? null,
    serial_number: d?.serial_number ?? null,
    registration: d?.registration ?? null,
    ownership: d?.ownership ?? "owned",
    status: d?.status ?? "active",
    supplier_id: d?.supplier_id ?? null,
    purchase_date: d?.purchase_date ?? null,
    purchase_price: d?.purchase_price ?? null,
    current_value: d?.current_value ?? null,
    warranty_expires_at: d?.warranty_expires_at ?? null,
    hire_start: d?.hire_start ?? null,
    hire_end: d?.hire_end ?? null,
    hire_rate: d?.hire_rate ?? null,
    notes: d?.notes ?? null,
    created_by: user.id,
  });
  if (error) {
    console.error("[assets] insert failed", error);
    redirect(`/assets/new?error=record_failed`);
  }

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "asset.created",
    targetTable: "assets",
    targetId: id,
    metadata: { name: d?.name, ownership: d?.ownership ?? "owned" },
  });

  revalidatePath("/assets");
  redirect(`/assets/${id}?saved=created`);
}

export async function updateAssetStatus(formData: FormData): Promise<void> {
  const { ctx, user } = await requireOrgContext();
  const id = String(formData.get("id") ?? "");
  const status = String(formData.get("status") ?? "");
  if (!assetIdSchema.safeParse(id).success) redirect(`/assets?error=bad_id`);
  if (!(ASSET_STATUSES as readonly string[]).includes(status)) {
    redirect(`/assets/${id}?error=bad_status`);
  }

  const tenant = await createClient();
  const { error, count } = await (
    tenant.from("assets" as never) as unknown as UpdateChain
  )
    .update({ status: status as AssetStatus }, { count: "exact" })
    .eq("id", id)
    .eq("org_id", ctx.org.id);
  if (error) {
    console.error("[assets] status update failed", error);
    redirect(`/assets/${id}?error=update_failed`);
  }
  if (!count) redirect(`/assets?error=not_found`);

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "asset.status_changed",
    targetTable: "assets",
    targetId: id,
    metadata: { to: status },
  });

  revalidatePath(`/assets/${id}`);
  revalidatePath("/assets");
  redirect(`/assets/${id}?saved=status`);
}

export async function deleteAsset(id: string): Promise<void> {
  const { ctx, user } = await requireOrgContext();
  if (!assetIdSchema.safeParse(id).success) redirect(`/assets?error=bad_id`);
  if (ctx.membership.role !== "owner" && ctx.membership.role !== "admin") {
    redirect(`/assets?error=forbidden`);
  }

  const tenant = await createClient();

  const { data: atts } = await (
    tenant.from("tenant_attachments" as never) as unknown as AttachmentIdsChain
  )
    .select("id")
    .eq("target_table", "assets")
    .eq("target_id", id)
    .eq("org_id", ctx.org.id);
  for (const a of atts ?? []) {
    await deleteTenantAttachment(a.id).catch(() => undefined);
  }

  const { error, count } = await (
    tenant.from("assets" as never) as unknown as DeleteChain
  )
    .delete({ count: "exact" })
    .eq("id", id)
    .eq("org_id", ctx.org.id);
  if (error) {
    console.error("[assets] delete failed", error);
    redirect(`/assets?error=delete_failed`);
  }
  if (!count) redirect(`/assets?error=not_found`);

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "asset.deleted",
    targetTable: "assets",
    targetId: id,
    metadata: { org_id: ctx.org.id },
  });

  revalidatePath("/assets");
  redirect(`/assets?saved=deleted`);
}
