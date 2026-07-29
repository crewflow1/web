"use server";

import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { recordAdminActivity } from "@/server/services/hq-audit";
import {
  checkOutSchema,
  friendlyAssignmentError,
  returnNeedsAttention,
  returnSchema,
  transferSchema,
} from "@/lib/assets/assignment";
import { formError, formSuccess, type FormState } from "@/lib/forms/state";

/**
 * Asset assignment (custody) actions.
 *
 * The DB is the source of truth for the invariant: a partial unique index makes
 * a second open assignment fail (23505), and a guard trigger enforces same-org
 * references + eligibility (23514). These actions translate those violations
 * into construction-language errors — never a raw SQL string — and NEVER do a
 * check-then-insert. Transfer goes through an atomic RPC.
 *
 * These actions return `FormState` (the client navigates via `redirectTo`
 * through <StateForm>, a full document load) instead of calling `redirect()`:
 * a same-route ?saved= redirect back to /assets/[id] swaps the page segment
 * itself and loses the Next 15.5 stranded-commit race (upstream
 * vercel/next.js#83386) — the row is written but the URL never changes and no
 * error surfaces. See components/forms/StateForm.tsx. No revalidatePath,
 * deliberately: these surfaces render per-request (cookie-authed reads, no
 * Next data cache), so revalidating only added weight to the racy action
 * response.
 */

type InsertResult = { error: { message: string; code?: string } | null };
type InsertChain = { insert: (row: unknown) => Promise<InsertResult> };
type CloseChain = {
  update: (
    patch: unknown,
    opts?: { count?: string },
  ) => {
    eq: (k: string, v: unknown) => {
      eq: (k: string, v: unknown) => {
        eq: (
          k: string,
          v: unknown,
        ) => Promise<{ error: { message: string } | null; count: number | null }>;
      };
    };
  };
};

function parseCheckout(formData: FormData) {
  return {
    asset_id: formData.get("asset_id") ?? "",
    assignment_type: formData.get("assignment_type") ?? "",
    job_id: formData.get("job_id") ?? "",
    assignee_id: formData.get("assignee_id") ?? "",
    vehicle_asset_id: formData.get("vehicle_asset_id") ?? "",
    site_id: formData.get("site_id") ?? "",
    location: formData.get("location") ?? "",
    issue_condition: formData.get("issue_condition") ?? "",
    issue_notes: formData.get("issue_notes") ?? "",
    expected_return_at: formData.get("expected_return_at") ?? "",
    issue_meter_reading: formData.get("issue_meter_reading") ?? "",
  };
}

export async function checkOutAsset(_prev: FormState, formData: FormData): Promise<FormState> {
  const { ctx, user } = await requireOrgContext();
  const parsed = checkOutSchema.safeParse(parseCheckout(formData));
  if (!parsed.success) {
    const first = Object.values(parsed.error.flatten().fieldErrors).flat()[0] ?? "Please check the form.";
    return formError(first);
  }
  const d = parsed.data;

  const tenant = await createClient();
  const { error } = await (
    tenant.from("asset_assignments" as never) as unknown as InsertChain
  ).insert({
    org_id: ctx.org.id,
    asset_id: d.asset_id,
    assignment_type: d.assignment_type,
    job_id: d.job_id ?? null,
    assignee_id: d.assignee_id ?? null,
    vehicle_asset_id: d.vehicle_asset_id ?? null,
    // The typed destination (public.sites). `tg_site_reference_org_integrity`
    // (20261061000000) refuses a site from another org for EVERY role, so this
    // needs no app-side check — a forged id is a DB refusal, translated below.
    site_id: d.site_id ?? null,
    location: d.location ?? null,
    issue_condition: d.issue_condition ?? null,
    issue_notes: d.issue_notes ?? null,
    expected_return_at: d.expected_return_at ?? null,
    issue_meter_reading: d.issue_meter_reading ?? null,
    assigned_by: user.id,
    status: "open",
  });
  if (error) {
    // The DB invariant (23505 unique / 23514 guard) is the gate — translate it.
    return formError(friendlyAssignmentError(error.code, error.message));
  }

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "asset.checked_out",
    targetTable: "assets",
    targetId: d.asset_id,
    metadata: { assignment_type: d.assignment_type },
  });

  return formSuccess({ redirectTo: `/assets/${d.asset_id}?saved=checked_out` });
}

export async function returnAsset(_prev: FormState, formData: FormData): Promise<FormState> {
  const { ctx, user } = await requireOrgContext();
  const assetId = String(formData.get("asset_id") ?? "");
  const parsed = returnSchema.safeParse({
    id: formData.get("id") ?? "",
    return_condition: formData.get("return_condition") ?? "",
    return_notes: formData.get("return_notes") ?? "",
    return_meter_reading: formData.get("return_meter_reading") ?? "",
  });
  if (!parsed.success) return formError("Please check the form.");
  const d = parsed.data;

  const tenant = await createClient();
  // Close the OPEN assignment only — the status='open' filter makes a repeated
  // return a no-op (count 0), never a double-close.
  const { error, count } = await (
    tenant.from("asset_assignments" as never) as unknown as CloseChain
  )
    .update(
      {
        status: "closed",
        actual_return_at: new Date().toISOString(),
        returned_by: user.id,
        return_condition: d.return_condition ?? null,
        return_notes: d.return_notes ?? null,
        return_meter_reading: d.return_meter_reading ?? null,
      },
      { count: "exact" },
    )
    .eq("id", d.id)
    .eq("org_id", ctx.org.id)
    .eq("status", "open");
  if (error) {
    console.error("[asset-assignments] return failed", error);
    return formError("Couldn't update the asset.");
  }
  if (!count) return formError("That asset isn't currently checked out.");

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "asset.returned",
    targetTable: "assets",
    targetId: assetId,
    metadata: {
      return_condition: d.return_condition ?? null,
      needs_attention: returnNeedsAttention(d.return_condition),
    },
  });

  return formSuccess({ redirectTo: `/assets/${assetId}?saved=returned` });
}

export async function transferAsset(_prev: FormState, formData: FormData): Promise<FormState> {
  const { ctx, user } = await requireOrgContext();
  const parsed = transferSchema.safeParse(parseCheckout(formData));
  if (!parsed.success) {
    const first = Object.values(parsed.error.flatten().fieldErrors).flat()[0] ?? "Please check the form.";
    return formError(first);
  }
  const d = parsed.data;

  const tenant = await createClient();
  // Atomic close-old + open-new (one transaction) — never two client calls.
  const { error } = await (
    tenant as unknown as {
      rpc: (
        fn: string,
        args: Record<string, unknown>,
      ) => Promise<{ error: { message: string; code?: string } | null }>;
    }
  ).rpc("transfer_asset_assignment", {
    p_asset_id: d.asset_id,
    p_org_id: ctx.org.id,
    p_assignment_type: d.assignment_type,
    p_job_id: d.job_id ?? null,
    p_assignee_id: d.assignee_id ?? null,
    p_vehicle_asset_id: d.vehicle_asset_id ?? null,
    p_site_id: d.site_id ?? null,
    p_location: d.location ?? null,
    p_issue_condition: d.issue_condition ?? null,
    p_issue_notes: d.issue_notes ?? null,
    p_expected_return_at: d.expected_return_at ?? null,
    p_assigned_by: user.id,
  });
  if (error) {
    return formError(friendlyAssignmentError(error.code, error.message));
  }

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "asset.transferred",
    targetTable: "assets",
    targetId: d.asset_id,
    metadata: { assignment_type: d.assignment_type },
  });

  return formSuccess({ redirectTo: `/assets/${d.asset_id}?saved=transferred` });
}
