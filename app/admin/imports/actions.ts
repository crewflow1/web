"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireHqPage } from "@/server/auth/hq";
import { operatorRemapColumns } from "@/lib/admin/operator-imports";

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
