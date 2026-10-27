"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireHqPage } from "@/server/auth/hq";
import {
  operatorRemapColumns,
  operatorCommitImport,
  operatorRollbackImport,
} from "@/lib/admin/operator-imports";

/**
 * Operator column-remap action (super-admin). Re-gates via requireHqPage()
 * (defence in depth — the data layer gates too), parses field→header overrides
 * from the form (the data layer re-validates every field against the entity's
 * canonical allow-list), and applies the remap to the explicit target org. All
 * navigation stays within the operator surface.
 */
export async function operatorRemapColumnsAction(formData: FormData): Promise<void> {
  await requireHqPage();

  const orgId = String(formData.get("orgId") ?? "");
  const importId = String(formData.get("importId") ?? "");
  const entity = String(formData.get("entity") ?? "");

  // Collect map.<field> = <source header>; the data layer allow-lists the fields.
  const overrides: Record<string, string> = {};
  for (const [k, v] of formData.entries()) {
    if (k.startsWith("map.") && typeof v === "string" && v.trim().length > 0) {
      overrides[k.slice(4)] = v.trim();
    }
  }

  const base = `/admin/imports/${encodeURIComponent(orgId)}/${encodeURIComponent(importId)}`;
  const res = await operatorRemapColumns({ targetOrgId: orgId, importId, entity, overrides });
  revalidatePath(base);
  if (!res.ok) redirect(`${base}?error=${res.error}`);
  redirect(`${base}?saved=remapped&count=${res.changed}`);
}

/**
 * Operator COMMIT — insert the target org's staged rows into live business
 * tables as that org's data. Re-gates; the data layer pins every write to the
 * explicit target org. High consequence — the UI gates this behind a confirm.
 */
export async function operatorCommitAction(formData: FormData): Promise<void> {
  await requireHqPage();
  const orgId = String(formData.get("orgId") ?? "");
  const importId = String(formData.get("importId") ?? "");
  const base = `/admin/imports/${encodeURIComponent(orgId)}/${encodeURIComponent(importId)}`;
  const res = await operatorCommitImport(orgId, importId);
  revalidatePath(base);
  if (!res.ok) redirect(`${base}?error=${res.error}`);
  redirect(`${base}?saved=committed&imported=${res.imported}&skipped=${res.skipped}`);
}

/**
 * Operator ROLLBACK — delete every record the target org's committed import
 * created. Re-gates; the data layer pins every delete to the explicit target
 * org. Destructive — the UI gates this behind a confirm.
 */
export async function operatorRollbackAction(formData: FormData): Promise<void> {
  await requireHqPage();
  const orgId = String(formData.get("orgId") ?? "");
  const importId = String(formData.get("importId") ?? "");
  const base = `/admin/imports/${encodeURIComponent(orgId)}/${encodeURIComponent(importId)}`;
  const res = await operatorRollbackImport(orgId, importId);
  revalidatePath(base);
  if (!res.ok) redirect(`${base}?error=${res.error}`);
  redirect(`${base}?saved=rolled_back`);
}
