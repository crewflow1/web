"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext, type OrgContext } from "@/server/auth/session";
import { type FormState, formError, formSuccess } from "@/lib/forms/state";
import {
  materialRequestFormSchema,
  materialRequestRejectSchema,
  type MaterialRequestFormInput,
} from "@/lib/material-requests/schema";
import { emitNotifications } from "@/server/services/notifications-service";
import type { NotificationCreate } from "@/lib/notifications/types";
import {
  notifyAdminsOfMaterialRequest,
  notifyRequesterOfMaterialDecision,
  type MaterialRequestEmailInfo,
} from "@/lib/email/send-material-request";
import { isStockItemInOrg, type StockSeamClient } from "@/server/services/material-fulfilment";
import { loadMaterialRequest } from "@/server/services/material-requests";
import { computeTotals } from "@/lib/quotes/totals";

/**
 * Material-request server actions.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT THIS FILE MAY AND MAY NOT WRITE
 * ═══════════════════════════════════════════════════════════════════════════
 * NOTHING HERE EVER WRITES 'partially_fulfilled' OR 'fulfilled'. Those two
 * statuses are DERIVED from stock issue movements and are applied only by
 * `advance_material_request_fulfilment` (20261067), which the database's
 * transition trigger will refuse from any other path.
 * __tests__/security/material-requests.test.ts greps this file to keep it
 * true — a hand-set fulfilment status is the one bug that would make the
 * product lie about whether a site has its materials.
 *
 * AUTHORISATION IS ENFORCED TWICE, ON PURPOSE. The database's transition
 * trigger is the real backstop (it also covers direct PostgREST). The
 * `requireAdmin` check here exists for a clean error message and so the UI
 * never offers a button the database will refuse — the same
 * belt-and-braces posture as staff/actions.ts and expense-drafts.ts.
 *
 * Neither material_requests nor material_request_lines is in the generated
 * Supabase types yet, so writers are cast — the established `as never` idiom.
 */

const idSchema = z.string().uuid();

/**
 * ctx.membership is the caller's OWN row in the ACTIVE org, resolved by
 * requireOrgContext with a user_id filter. NEVER re-query memberships
 * unfiltered here: org members can read each other's rows, so
 * `.eq("org_id", …).single()` returns every member and errors in any org with
 * ≥2 members — the bug that locked every admin out of staff management (#471).
 */
function isAdmin(ctx: OrgContext): boolean {
  return ctx.membership.role === "owner" || ctx.membership.role === "admin";
}

type Res<T> = { data: T | null; error: { message: string; code?: string } | null };
type Chain<T> = {
  select: (c: string) => Chain<T>;
  eq: (k: string, v: unknown) => Chain<T>;
  in: (k: string, v: readonly unknown[]) => Chain<T>;
  limit: (n: number) => PromiseLike<Res<T[]>>;
  maybeSingle: () => PromiseLike<Res<T>>;
  single: () => PromiseLike<Res<T>>;
};
type Table = {
  select: (c: string) => Chain<Record<string, unknown>>;
  insert: (rows: unknown) => {
    select: (c: string) => { single: () => PromiseLike<Res<{ id: string }>> };
  } & PromiseLike<Res<null>>;
  update: (patch: unknown) => Chain<Record<string, unknown>> & PromiseLike<Res<null>>;
};
const tbl = (c: unknown, name: string) =>
  (c as { from: (t: string) => Table }).from(name);

function parseForm(formData: FormData) {
  let lines: unknown = [];
  try {
    lines = JSON.parse(String(formData.get("lines") ?? "[]"));
  } catch {
    lines = [];
  }
  return materialRequestFormSchema.safeParse({
    job_id: formData.get("job_id") ?? "",
    needed_by: formData.get("needed_by") ?? "",
    priority: formData.get("priority") ?? "normal",
    notes: formData.get("notes") ?? "",
    lines,
  });
}

/**
 * How this product names a job: by its CUSTOMER. `jobs` has no title column
 * (the job page renders `job.customer?.name ?? "Job"`), so anything that
 * selects `title` here would fail the read and silently drop the job name out
 * of every approval email.
 */
async function readJobLabel(
  supabase: unknown,
  orgId: string,
  jobId: string | null,
): Promise<string | null> {
  if (!jobId) return null;
  const { data, error } = await tbl(supabase, "jobs")
    .select("id, site_address_line1, customer:customers ( name )")
    .eq("org_id", orgId) // ACTIVE-ORG PIN
    .eq("id", jobId)
    .maybeSingle();
  if (error) {
    console.error("[material-requests] job label read failed", error);
    return null;
  }
  const row = data as unknown as {
    site_address_line1: string | null;
    customer: { name: string | null } | null;
  } | null;
  if (!row) return null;
  return row.customer?.name?.trim() || row.site_address_line1?.trim() || null;
}

/** Compact email/notification payload — built from rows already in hand. */
function emailInfo(
  request: { number: string; needed_by: string | null; priority: string },
  jobTitle: string | null,
  lines: ReadonlyArray<{ description: string; qty: number | string | null; unit: string | null }>,
): MaterialRequestEmailInfo {
  return {
    number: request.number,
    jobTitle,
    neededBy: request.needed_by,
    priority: request.priority,
    lineCount: lines.length,
    preview: lines.slice(0, 4).map((l) => `${l.qty} ${l.unit ?? "ea"} — ${l.description}`),
  };
}

/**
 * In-app notification to the people who must decide.
 *
 * TARGETED PER ADMIN, not org-wide. The `notifications` RLS predicate
 * (20260611) admits a row when `user_id = auth.uid()` OR it is org-wide and
 * the viewer is a member — so a per-user row reaches exactly the approvers and
 * nobody else. Org-wide would put "materials need approving" in front of every
 * labourer on site, which is how a notification centre becomes wallpaper.
 *
 * The membership read is org-pinned (the #468-fixed seam) and runs on the
 * caller's RLS-scoped client — members may read their own org's memberships.
 */
async function notifyApprovers(
  supabase: unknown,
  orgId: string,
  requestId: string,
  info: MaterialRequestEmailInfo,
  requesterId: string | null,
): Promise<void> {
  try {
    const { data, error } = await tbl(supabase, "memberships")
      .select("user_id, role")
      .eq("org_id", orgId) // ACTIVE-ORG PIN
      .in("role", ["owner", "admin"])
      .limit(200);
    if (error) {
      console.error("[material-requests] approver lookup failed", error);
      return;
    }
    const admins = (data ?? []) as Array<{ user_id: string }>;
    if (admins.length === 0) return;

    const urgent = info.priority === "urgent";
    const notes: NotificationCreate[] = admins.map((a) => ({
      org_id: orgId,
      user_id: a.user_id,
      audience: "customer",
      type: "material_request.submitted",
      category: "system",
      priority: urgent ? "high" : "medium",
      title: `Materials requested — ${info.number}${info.jobTitle ? ` (${info.jobTitle})` : ""}`,
      body:
        info.preview.slice(0, 2).join("; ") +
        (info.lineCount > 2 ? ` +${info.lineCount - 2} more` : ""),
      action_url: `/materials/requests/${requestId}`,
      source_module: "material_requests",
      source_id: requestId,
      metadata: { number: info.number, priority: info.priority, needed_by: info.neededBy },
    }));
    await emitNotifications(notes);
  } catch (e) {
    console.error("[material-requests] approver notify failed", e);
  }
  // Email rides the SAME internal-approval pattern as leave requests. Never
  // throws; the in-app row above is the reliable channel.
  await notifyAdminsOfMaterialRequest({ orgId, requesterId, request: info });
}

/** In-app + email to the one person whose request it was. */
async function notifyRequester(
  orgId: string,
  requestId: string,
  requesterId: string | null,
  decision: "approved" | "rejected",
  info: MaterialRequestEmailInfo,
  reason: string | null,
): Promise<void> {
  if (requesterId) {
    await emitNotifications([
      {
        org_id: orgId,
        user_id: requesterId, // targeted — it is their request, nobody else's
        audience: "customer",
        type: `material_request.${decision}`,
        category: "system",
        priority: decision === "rejected" ? "high" : "medium",
        title: `Materials ${decision} — ${info.number}`,
        body: reason ?? (decision === "approved" ? "The office is sourcing these." : null),
        action_url: `/materials/requests/${requestId}`,
        source_module: "material_requests",
        source_id: requestId,
        metadata: { number: info.number, decision },
      },
    ]).catch((e) => console.error("[material-requests] requester notify failed", e));
  }
  await notifyRequesterOfMaterialDecision({
    requesterId,
    decision,
    request: info,
    reason,
  });
}

// ── Create ──────────────────────────────────────────────────────────────────

/**
 * Raise a request. `intent=submit` (the worker's "Send request") creates it
 * and submits it in one action — 'draft' is the database's born-draft rule
 * (20261066), not a step anyone on site should have to think about.
 */
export async function createMaterialRequest(
  _prev: FormState<MaterialRequestFormInput>,
  formData: FormData,
): Promise<FormState<MaterialRequestFormInput>> {
  const { ctx, user } = await requireOrgContext();
  const parsed = parseForm(formData);
  if (!parsed.success) {
    return formError(parsed.error.issues[0]?.message ?? "Check the request and try again.");
  }
  const submitNow = String(formData.get("intent") ?? "submit") !== "draft";
  const supabase = await createClient();

  // THE APP-LAYER HALF OF THE DEFERRED-FK DEBT. stock_item_id is a plain uuid
  // with NO database FK (the frozen cross-lane contract), so nothing in
  // Postgres stops a member of org A writing org B's item id. This is the
  // check that stands in for the missing constraint. When the stock module is
  // absent the field is never offered and the helper returns true.
  for (const line of parsed.data.lines) {
    if (!line.stock_item_id) continue;
    const ok = await isStockItemInOrg(
      supabase as unknown as StockSeamClient,
      ctx.org.id,
      line.stock_item_id,
    );
    if (!ok) return formError("One of those catalogue items isn't in this company.");
  }

  const { data: number, error: numberError } = await (
    supabase as unknown as {
      rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<Res<string>>;
    }
  ).rpc("next_material_request_number", { target_org: ctx.org.id });
  if (numberError) console.error("[material-requests] number allocation failed", numberError);
  if (!number) return formError("Couldn't allocate a request number. Try again.");

  const { data: created, error } = await tbl(supabase, "material_requests")
    .insert({
      org_id: ctx.org.id,
      job_id: parsed.data.job_id ?? null,
      number,
      status: "draft", // born draft — the database refuses anything else
      requested_by: user.id,
      needed_by: parsed.data.needed_by ?? null,
      priority: parsed.data.priority,
      notes: parsed.data.notes ?? null,
      created_by: user.id,
    })
    .select("id")
    .single();
  if (error || !created) {
    console.error("[material-requests] create failed", error);
    return formError("Couldn't save the request. Try again.");
  }
  const requestId = created.id;

  const { error: lineErr } = await tbl(supabase, "material_request_lines").insert(
    parsed.data.lines.map((l, idx) => ({
      org_id: ctx.org.id,
      material_request_id: requestId,
      description: l.description,
      qty: l.qty,
      unit: l.unit,
      stock_item_id: l.stock_item_id ?? null,
      sort_order: idx,
    })),
  );
  if (lineErr) {
    console.error("[material-requests] lines insert failed", lineErr);
    return formError("Couldn't save what you asked for. Try again.");
  }

  if (submitNow) {
    const sent = await submitRequestRow(supabase, ctx, requestId);
    if (!sent.ok) return formError(sent.error);
  }

  revalidatePath("/materials/requests");
  if (parsed.data.job_id) revalidatePath(`/jobs/${parsed.data.job_id}`);
  // FormState + redirectTo → StateForm does window.location.assign. NEVER
  // redirect() from a deep server action: Next 15.5 silently drops the
  // navigation at route-swap depth ≥4 (docs/… deep-swap commit race).
  return formSuccess({ redirectTo: `/materials/requests/${requestId}?saved=1` });
}

/** The shared submit path — used by create-and-send and by the explicit button. */
async function submitRequestRow(
  supabase: unknown,
  ctx: OrgContext,
  requestId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { error, data } = await tbl(supabase, "material_requests")
    .update({ status: "submitted" })
    .eq("id", requestId)
    .eq("org_id", ctx.org.id) // ACTIVE-ORG PIN
    .eq("status", "draft")
    .select("id, number, needed_by, priority, requested_by, job_id")
    .maybeSingle();
  if (error) {
    console.error("[material-requests] submit failed", error);
    return { ok: false, error: "Couldn't send the request. Try again." };
  }
  const row = data as unknown as {
    id: string;
    number: string;
    needed_by: string | null;
    priority: string;
    requested_by: string | null;
    job_id: string | null;
  } | null;
  if (!row) return { ok: false, error: "That request can no longer be sent." };

  // Best-effort by design: these lines are only the email/notification
  // PREVIEW. The request itself has already been submitted, so a failure here
  // must not undo that — it costs a nicer email, nothing more. Bound and
  // logged rather than discarded, so the failure is visible in the logs.
  const { data: lineRows, error: lineErr } = await tbl(supabase, "material_request_lines")
    .select("description, qty, unit")
    .eq("org_id", ctx.org.id) // ACTIVE-ORG PIN
    .eq("material_request_id", requestId)
    .limit(200);
  if (lineErr) console.error("[material-requests] submit preview lines failed", lineErr);
  const lines = (lineRows ?? []) as Array<{
    description: string;
    qty: number | string | null;
    unit: string | null;
  }>;

  const jobTitle = await readJobLabel(supabase, ctx.org.id, row.job_id);

  await notifyApprovers(
    supabase,
    ctx.org.id,
    requestId,
    emailInfo(row, jobTitle, lines),
    row.requested_by,
  );
  return { ok: true };
}

export async function submitMaterialRequest(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const { ctx } = await requireOrgContext();
  const id = String(formData.get("id") ?? "");
  if (!idSchema.safeParse(id).success) return formError("Invalid request.");

  const supabase = await createClient();
  const sent = await submitRequestRow(supabase, ctx, id);
  if (!sent.ok) return formError(sent.error);

  revalidatePath("/materials/requests");
  revalidatePath(`/materials/requests/${id}`);
  return formSuccess({ successMessage: "Request sent for approval." });
}

// ── Decide ──────────────────────────────────────────────────────────────────

/**
 * Approve or reject. OWNER/ADMIN ONLY — mirrors approveExpenseDraft and
 * reviewLeaveRequest, and mirrored again by the database's transition trigger
 * so direct PostgREST cannot route around it.
 */
export async function decideMaterialRequest(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const { ctx } = await requireOrgContext();
  if (!isAdmin(ctx)) return formError("Only an owner or admin can decide a materials request.");

  const id = String(formData.get("id") ?? "");
  if (!idSchema.safeParse(id).success) return formError("Invalid request.");
  const decision = String(formData.get("decision") ?? "");
  if (decision !== "approved" && decision !== "rejected") {
    return formError("Pick approve or reject.");
  }

  let reason: string | null = null;
  if (decision === "rejected") {
    const parsed = materialRequestRejectSchema.safeParse({
      rejection_reason: formData.get("rejection_reason") ?? "",
    });
    if (!parsed.success) {
      return {
        ok: false,
        error: "Add a reason so they know what to change.",
        fieldErrors: { rejection_reason: parsed.error.issues[0]?.message ?? "Required" },
        values: {},
        submittedAt: Date.now(),
      };
    }
    reason = parsed.data.rejection_reason;
  }

  const supabase = await createClient();
  // decided_by / decided_at are PINNED SERVER-SIDE by the lifecycle trigger
  // (20261066) — deliberately not sent from here, so the decision's provenance
  // can be neither forged nor back-dated.
  const { data, error } = await tbl(supabase, "material_requests")
    .update({ status: decision, rejection_reason: reason })
    .eq("id", id)
    .eq("org_id", ctx.org.id) // ACTIVE-ORG PIN
    .eq("status", "submitted") // only a submitted request can be decided
    .select("id, number, needed_by, priority, requested_by, job_id")
    .maybeSingle();
  if (error) {
    console.error("[material-requests] decision failed", error);
    return formError("Couldn't record the decision. Try again.");
  }
  const row = data as unknown as {
    number: string;
    needed_by: string | null;
    priority: string;
    requested_by: string | null;
    job_id: string | null;
  } | null;
  if (!row) return formError("That request has already been decided.");

  // Best-effort: the decision is already recorded. These lines only enrich the
  // notification the requester receives (see submitRequestRow's note).
  const { data: lineRows, error: lineErr } = await tbl(supabase, "material_request_lines")
    .select("description, qty, unit")
    .eq("org_id", ctx.org.id) // ACTIVE-ORG PIN
    .eq("material_request_id", id)
    .limit(200);
  if (lineErr) console.error("[material-requests] decision preview lines failed", lineErr);

  const jobTitle = await readJobLabel(supabase, ctx.org.id, row.job_id);

  await notifyRequester(
    ctx.org.id,
    id,
    row.requested_by,
    decision,
    emailInfo(
      row,
      jobTitle,
      (lineRows ?? []) as Array<{
        description: string;
        qty: number | string | null;
        unit: string | null;
      }>,
    ),
    reason,
  );

  revalidatePath("/materials/requests");
  revalidatePath(`/materials/requests/${id}`);
  if (row.job_id) revalidatePath(`/jobs/${row.job_id}`);
  return formSuccess({
    successMessage: decision === "approved" ? "Request approved." : "Request rejected.",
  });
}

// ── Cancel ──────────────────────────────────────────────────────────────────

/**
 * Stand a request down.
 *
 * The database decides who may: pre-approval the requester may withdraw their
 * own ask, post-approval it is an admin-only decision (the office has already
 * committed to sourcing it). We don't restate that rule here — we let the
 * trigger answer and translate its refusal.
 */
export async function cancelMaterialRequest(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const { ctx } = await requireOrgContext();
  const id = String(formData.get("id") ?? "");
  if (!idSchema.safeParse(id).success) return formError("Invalid request.");

  const supabase = await createClient();
  const { data, error } = await tbl(supabase, "material_requests")
    .update({ status: "cancelled" })
    .eq("id", id)
    .eq("org_id", ctx.org.id) // ACTIVE-ORG PIN
    .select("id, job_id")
    .maybeSingle();
  if (error) {
    // insufficient_privilege / check_violation from the transition trigger.
    console.error("[material-requests] cancel failed", error);
    return formError(
      error.code === "42501" || /only|cannot|final/i.test(error.message ?? "")
        ? "You can't cancel this request — ask an admin."
        : "Couldn't cancel the request. Try again.",
    );
  }
  if (!data) return formError("That request can no longer be cancelled.");

  revalidatePath("/materials/requests");
  revalidatePath(`/materials/requests/${id}`);
  const jobId = (data as { job_id?: string | null }).job_id;
  if (jobId) revalidatePath(`/jobs/${jobId}`);
  return formSuccess({ successMessage: "Request cancelled." });
}

// ── Procurement handoff ─────────────────────────────────────────────────────

/**
 * Turn an approved request's SHORTFALL into a DRAFT purchase order.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE LINKAGE DECISION, RECORDED HONESTLY
 * ═══════════════════════════════════════════════════════════════════════════
 * `purchase_orders` has no column for a material-request id, and adding one is
 * NOT this lane's to add. So the provenance is stamped into the PO's existing
 * free-text `notes` field, prefixed with a stable marker.
 *
 * Be clear about what that buys and what it does not:
 *   · It is HUMAN provenance — the buyer opening the PO can see which site ask
 *     it came from, which is the actual job-to-be-done here.
 *   · It is NOT a structural link. `notes` is user-editable free text, so the
 *     linkage can be edited away, and nothing reconciles "PO raised" against
 *     "request outstanding". Any future feature that needs a real join needs a
 *     real column, added by whoever owns purchase_orders.
 *   · `supplier_reference` was rejected for this: it means the SUPPLIER'S own
 *     reference, and overloading it would corrupt a field the buyer prints on
 *     the order.
 *
 * DRAFT ONLY, NEVER SENT. The office picks the supplier and the prices; a site
 * request cannot commit spend on its own. The PO is created with no supplier
 * and zero prices precisely so it cannot be mistaken for a priced order.
 *
 * Quantities are the OUTSTANDING shortfall, not the full request: anything
 * already issued from stock does not need buying.
 */
export async function createPoDraftFromRequest(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const { ctx, user } = await requireOrgContext();
  if (!isAdmin(ctx)) return formError("Only an owner or admin can raise a purchase order.");

  const id = String(formData.get("id") ?? "");
  if (!idSchema.safeParse(id).success) return formError("Invalid request.");

  const detail = await loadMaterialRequest(ctx.org.id, id);
  if (!detail) return formError("That request isn't available.");
  if (detail.request.status !== "approved" && detail.request.status !== "partially_fulfilled") {
    return formError("Only an approved request can be turned into a purchase order.");
  }

  // Buy the SHORTFALL. When the stock module is pending nothing has been
  // measured as issued, so the shortfall is the whole request — which is the
  // right conservative answer: better to order it and cancel a line than to
  // leave a site short on the strength of a number we could not read.
  const wanted = detail.fulfilment.lines
    .map((l) => ({ line: l, qty: l.outstanding }))
    .filter((x) => x.qty > 0);
  if (wanted.length === 0) return formError("Nothing is outstanding on this request.");

  const supabase = await createClient();
  const { data: number, error: numberError } = await (
    supabase as unknown as {
      rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<Res<string>>;
    }
  ).rpc("next_po_number", { target_org: ctx.org.id });
  if (numberError) console.error("[material-requests] PO number allocation failed", numberError);
  if (!number) return formError("Couldn't allocate a PO number. Try again.");

  // Zero prices: the site asks for quantities, the office prices them.
  const lineItems = wanted.map((w) => ({
    description: w.line.description,
    qty: w.qty,
    unit: w.line.unit,
    unit_price: 0,
    vat_rate: 20,
  }));
  const totals = computeTotals(lineItems);

  const provenance =
    `Raised from materials request ${detail.request.number}` +
    ` (id: ${detail.request.id}).` +
    (detail.request.notes ? `\n\nSite notes: ${detail.request.notes}` : "");

  const { data: po, error } = await tbl(supabase, "purchase_orders")
    .insert({
      org_id: ctx.org.id,
      supplier_id: null,
      job_id: detail.request.job_id,
      number,
      status: "draft", // DRAFT ONLY — never 'sent'
      subtotal: totals.subtotal,
      vat_total: totals.vat_total,
      notes: provenance, // the linkage — free text, see the note above
      expected_date: detail.request.needed_by,
      created_by: user.id,
    })
    .select("id")
    .single();
  if (error || !po) {
    console.error("[material-requests] PO draft create failed", error);
    return formError("Couldn't raise the purchase order. Try again.");
  }

  const { error: liErr } = await tbl(supabase, "purchase_order_line_items").insert(
    lineItems.map((li, idx) => ({
      org_id: ctx.org.id,
      purchase_order_id: po.id,
      description: li.description,
      qty: li.qty,
      unit: li.unit,
      unit_price: 0,
      vat_rate: 20,
      line_total: totals.lines[idx]?.line_total ?? 0,
      sort_order: idx,
    })),
  );
  if (liErr) {
    console.error("[material-requests] PO draft lines failed", liErr);
    return formError("Couldn't copy the lines onto the purchase order.");
  }

  revalidatePath("/purchase-orders");
  revalidatePath(`/materials/requests/${id}`);
  return formSuccess({ redirectTo: `/purchase-orders/${po.id}?saved=1` });
}
