"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireOrgContext, type OrgContext } from "@/server/auth/session";
import {
  quoteFormSchema,
  type LineItem,
  type QuoteFormInput,
} from "@/lib/quotes/schema";
import { computeTotals } from "@/lib/quotes/totals";
import { invoiceDueDate } from "@/lib/invoices/due-date";
import { sendInvoiceEmail } from "@/lib/email/send-invoice";
import { loadJobForOrg } from "@/lib/jobs/load";
import { dispatchAutomation } from "@/server/services/automation-dispatcher";
import type { Database } from "@/lib/supabase/types";
import {
  type FormState,
  formError,
  formSuccess,
} from "@/lib/forms/state";

/**
 * Quote CRUD + lifecycle server actions.
 *
 * Lifecycle:
 *   draft  (created)
 *     ↓ sendQuote()
 *   sent   (status updated; public_token allocated if not already)
 *     ↓ public view loaded (handled in /q/[token] page)
 *   viewed (viewed_at stamped)
 *     ↓ acceptQuote/declineQuote (public-portal or owner)
 *   accepted / declined
 *
 * Acceptance auto-creates an invoice via the existing invoices endpoint
 * pattern: copy amounts, allocate next_invoice_number, status=draft.
 */

type LineItemInsert = Database["public"]["Tables"]["quote_line_items"]["Insert"];

const idSchema = z.string().uuid();

function parseLineItemsJson(raw: FormDataEntryValue | null): LineItem[] {
  if (typeof raw !== "string") return [];
  try {
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

/**
 * Mirror the raw form payload into the `values` echo so the form can
 * re-render with what the user typed, even when validation fails. Line
 * items round-trip as the parsed array (best-effort) so the client can
 * restore them.
 */
function echoValuesFromForm(formData: FormData): Partial<QuoteFormInput> {
  return {
    customer_id: String(formData.get("customer_id") ?? ""),
    property_id: String(formData.get("property_id") ?? ""),
    lead_id: String(formData.get("lead_id") ?? ""),
    valid_until: String(formData.get("valid_until") ?? ""),
    notes: String(formData.get("notes") ?? ""),
    terms: String(formData.get("terms") ?? ""),
    line_items: parseLineItemsJson(formData.get("line_items")),
  };
}

function parseQuoteForm(formData: FormData) {
  return quoteFormSchema.safeParse({
    customer_id: formData.get("customer_id") ?? "",
    property_id: formData.get("property_id") ?? "",
    lead_id: formData.get("lead_id") ?? "",
    valid_until: formData.get("valid_until") ?? "",
    notes: formData.get("notes") ?? "",
    terms: formData.get("terms") ?? "",
    line_items: parseLineItemsJson(formData.get("line_items")),
  });
}

function quoteValidationFailure(
  parsed: z.SafeParseError<QuoteFormInput>,
  formData: FormData,
): FormState<QuoteFormInput> {
  const fieldErrors: Record<string, string> = {};
  for (const issue of parsed.error.issues) {
    const key = issue.path[0];
    if (typeof key === "string" && !fieldErrors[key]) {
      fieldErrors[key] = issue.message;
    }
  }
  return {
    ok: false,
    error: "Fix the highlighted fields and try again.",
    fieldErrors,
    values: echoValuesFromForm(formData),
    submittedAt: Date.now(),
  };
}

export async function createQuote(
  _prevState: FormState<QuoteFormInput>,
  formData: FormData,
): Promise<FormState<QuoteFormInput>> {
  const { user, ctx } = await requireOrgContext();
  const parsed = parseQuoteForm(formData);
  if (!parsed.success) return quoteValidationFailure(parsed, formData);

  const supabase = await createClient();

  // Allocate next per-org quote number via SECURITY DEFINER RPC.
  const { data: numberRpc, error: numErr } = await supabase.rpc(
    "next_quote_number",
    { target_org: ctx.org.id },
  );
  if (numErr || !numberRpc) {
    console.error("[quotes] number allocation failed", numErr);
    return formError(
      "Couldn't allocate a quote number. Try again.",
      echoValuesFromForm(formData),
    );
  }

  const totals = computeTotals(parsed.data.line_items);

  // Generate a public token now so the quote is shareable immediately
  // (we don't wait for send). crypto.randomUUID() is fine here — same
  // standard as the seed.
  const publicToken = crypto.randomUUID();

  const { data: quote, error: qErr } = await supabase
    .from("quotes")
    .insert({
      org_id: ctx.org.id,
      customer_id: parsed.data.customer_id,
      property_id: parsed.data.property_id ?? null,
      lead_id: parsed.data.lead_id ?? null,
      number: numberRpc as unknown as string,
      status: "draft",
      currency: "GBP",
      subtotal: totals.subtotal,
      vat_total: totals.vat_total,
      total: totals.total,
      notes: parsed.data.notes ?? null,
      terms: parsed.data.terms ?? null,
      valid_until: parsed.data.valid_until ?? null,
      public_token: publicToken,
      created_by: user.id,
    })
    .select("id")
    .single();

  if (qErr || !quote) {
    console.error("[quotes] insert failed", qErr);
    return formError(
      "Couldn't save the quote. Try again.",
      echoValuesFromForm(formData),
    );
  }

  // Insert line items.
  const rows: LineItemInsert[] = parsed.data.line_items.map((li, idx) => ({
    quote_id: quote.id,
    org_id: ctx.org.id,
    description: li.description,
    qty: li.qty,
    unit: li.unit,
    unit_price: li.unit_price,
    vat_rate: li.vat_rate,
    line_total: totals.lines[idx]?.line_total ?? 0,
    sort_order: idx,
  }));
  const { error: liErr } = await supabase.from("quote_line_items").insert(rows);
  if (liErr) {
    console.error("[quotes] line items insert failed", liErr);
    // Best-effort: parent row is saved; bounce the user to the edit page
    // with an explanatory banner. Input loss is moot — the quote exists.
    return formSuccess({
      successMessage: "Quote saved but line items didn't — open it and re-add.",
      redirectTo: `/quotes/${quote.id}?error=line_items_failed`,
    });
  }

  // Pipeline integration: if a lead was linked AND it's still in an
  // earlier stage, advance it to "quoted" so the kanban reflects reality.
  // Won/lost/job_booked are not overwritten.
  // `lead_id` arrives from the form, and the lead dropdown is populated by an
  // RLS-only query — which for a dual-org user blends BOTH orgs (the same
  // defect class as the jobs form-helpers fixed in #456). Scope both the read
  // and the write to the active org so a blended pick cannot re-stage another
  // org's lead.
  if (parsed.data.lead_id) {
    const { data: leadRow } = await supabase
      .from("leads")
      .select("status")
      .eq("id", parsed.data.lead_id)
      .eq("org_id", ctx.org.id)
      .maybeSingle();
    const stalled = leadRow?.status === "new" ||
      leadRow?.status === "contacted" ||
      leadRow?.status === "qualified";
    if (stalled) {
      await supabase
        .from("leads")
        .update({
          status: "quoted",
          last_activity_at: new Date().toISOString(),
        })
        .eq("id", parsed.data.lead_id)
        .eq("org_id", ctx.org.id);
    }
  }

  revalidatePath("/quotes");
  revalidatePath("/leads");
  return formSuccess({
    successMessage: "Quote saved.",
    redirectTo: `/quotes/${quote.id}`,
  });
}

export async function updateQuote(
  id: string,
  _prevState: FormState<QuoteFormInput>,
  formData: FormData,
): Promise<FormState<QuoteFormInput>> {
  const { ctx } = await requireOrgContext();
  if (!idSchema.safeParse(id).success) {
    return formError("Invalid quote id.");
  }

  const parsed = parseQuoteForm(formData);
  if (!parsed.success) return quoteValidationFailure(parsed, formData);

  const supabase = await createClient();
  const totals = computeTotals(parsed.data.line_items);

  // Wave 2 — if the quote is past the approval gate (approved/sent/viewed),
  // editing reverts it to pending_approval so the approver re-confirms the
  // new numbers. The trigger emits quote.changed_after_approval.
  const { data: existing } = await supabase
    .from("quotes")
    .select("status")
    .eq("id", id)
    // ACTIVE-ORG SCOPE. RLS's `current_org_ids()` spans EVERY org the caller
    // belongs to, so without this a dual-org user working in org A reads org
    // B's quote here — and then every write below lands on B's row. A foreign
    // quote reads as absent, and the UPDATE's own predicate makes it a no-op.
    .eq("org_id", ctx.org.id)
    .maybeSingle();

  // Not in the active org (or gone). Bail BEFORE the destructive line-item
  // replacement below — that delete is keyed on quote_id, so proceeding on a
  // quote we could not resolve in this org would wipe another org's priced
  // line items and leave the quote a shell. Same wording as the later
  // load-failure branch: a foreign quote is indistinguishable from a missing one.
  if (!existing) {
    return formError(
      "Couldn't load the quote. Try again.",
      echoValuesFromForm(formData),
    );
  }

  // Commercial integrity: an accepted quote/variation is a firm agreement — its
  // amounts and scope are frozen (the DB enforces this too, via triggers
  // quotes_freeze_accepted / quote_line_items_freeze_accepted). Refuse the edit
  // up front rather than let the DB reject the line-item re-insert mid-write.
  // To change agreed scope, the operator raises a variation.
  if (existing?.status === "accepted") {
    return formError(
      "This quote has been accepted and can't be edited. Raise a variation to change the agreed scope.",
      echoValuesFromForm(formData),
    );
  }

  const revertToPending =
    existing?.status === "approved" ||
    existing?.status === "sent" ||
    existing?.status === "viewed";

  // Update parent row.
  const { error: qErr } = await supabase
    .from("quotes")
    .update({
      customer_id: parsed.data.customer_id,
      property_id: parsed.data.property_id ?? null,
      lead_id: parsed.data.lead_id ?? null,
      subtotal: totals.subtotal,
      vat_total: totals.vat_total,
      total: totals.total,
      notes: parsed.data.notes ?? null,
      terms: parsed.data.terms ?? null,
      valid_until: parsed.data.valid_until ?? null,
      ...(revertToPending
        ? {
            status: "pending_approval" as const,
            approved_by: null,
            approved_at: null,
            // Keep the prior approval_comment as context — operator can
            // see why it had been approved before.
          }
        : {}),
    })
    .eq("id", id)
    .eq("org_id", ctx.org.id);
  if (qErr) {
    console.error("[quotes] update failed", qErr);
    return formError(
      "Couldn't save changes. Try again.",
      echoValuesFromForm(formData),
    );
  }

  // Replace line items (delete + insert is simpler than diffing for v1).
  const { error: delErr } = await supabase
    .from("quote_line_items")
    .delete()
    .eq("quote_id", id)
    .eq("org_id", ctx.org.id);
  if (delErr) {
    console.error("[quotes] line items delete failed", delErr);
    return formError(
      "Couldn't save line items. Try again.",
      echoValuesFromForm(formData),
    );
  }

  const rows: LineItemInsert[] = parsed.data.line_items.map((li, idx) => ({
    quote_id: id,
    // Stamp from the ACTIVE org, never from a row re-read by id. Re-reading
    // the parent's own org_id was the same shape as the retention-ledger bug
    // fixed in #456: it faithfully copies whichever org the row turned out to
    // belong to, so an unscoped resolve silently writes into that org instead
    // of refusing. The quote itself is proven in-org above.
    org_id: ctx.org.id,
    description: li.description,
    qty: li.qty,
    unit: li.unit,
    unit_price: li.unit_price,
    vat_rate: li.vat_rate,
    line_total: totals.lines[idx]?.line_total ?? 0,
    sort_order: idx,
  }));
  const { error: insErr } = await supabase.from("quote_line_items").insert(rows);
  if (insErr) {
    console.error("[quotes] line items re-insert failed", insErr);
    return formError(
      "Couldn't save line items. Try again.",
      echoValuesFromForm(formData),
    );
  }

  revalidatePath("/quotes");
  revalidatePath(`/quotes/${id}`);
  return formSuccess({ successMessage: "Saved." });
}

export async function sendQuote(id: string) {
  const { ctx } = await requireOrgContext();
  if (!idSchema.safeParse(id).success) redirect("/quotes");

  const supabase = await createClient();

  // Wave 2: cannot send a quote until it's been approved.
  // Active-org scoped: a quote in another of the caller's orgs must read as
  // not_found, so the status gate below can never be evaluated — much less
  // satisfied — against a row this session has no business sending.
  const { data: current } = await supabase
    .from("quotes")
    .select("status")
    .eq("id", id)
    .eq("org_id", ctx.org.id)
    .maybeSingle();
  if (!current) redirect(`/quotes/${id}?error=not_found`);
  if (current.status !== "approved") {
    redirect(
      `/quotes/${id}?error=${encodeURIComponent(
        current.status === "draft"
          ? "Request approval first — quotes can't be sent in draft."
          : current.status === "pending_approval"
            ? "Quote is awaiting approval. An owner or admin must approve before sending."
            : current.status === "rejected"
              ? "Quote was rejected. Edit and request approval again."
              : `Quote is in '${current.status}' status — only approved quotes can be sent.`,
      )}`,
    );
  }

  const { error } = await supabase
    .from("quotes")
    .update({
      status: "sent",
      sent_at: new Date().toISOString(),
    })
    .eq("id", id)
    .eq("org_id", ctx.org.id);

  if (error) {
    console.error("[quotes] send failed", error);
    redirect(`/quotes/${id}?error=send_failed`);
  }
  revalidatePath(`/quotes/${id}`);
  redirect(`/quotes/${id}?saved=sent`);
}

/**
 * Wave 2 — approval workflow actions.
 *
 * Lifecycle:
 *   draft ──(requestApproval)──► pending_approval
 *                                       │
 *                       ┌───────────────┼───────────────┐
 *               (approve)         (requestChanges)   (reject)
 *                  │                    │                │
 *                  ▼                    ▼                ▼
 *               approved           pending_approval   rejected
 *                                  + comment in log
 *
 *   approved ──(updateQuote ANY field)──► pending_approval (re-approval)
 *
 * Only owners + admins can approve / reject / request_changes. The DB
 * RLS allows any member to UPDATE the quotes row; the role gate is
 * enforced at the action layer (clearer error messages than RLS denial).
 */

function requireQuoteApprover(ctx: OrgContext): void {
  // ctx.membership is the caller's OWN row in the ACTIVE org, resolved by
  // requireOrgContext with a user_id filter. Don't re-query memberships
  // unfiltered here: org members can read each other's rows, so
  // `.eq("org_id", …).single()` returns every member and errors in any org
  // with ≥2 members — which read as "forbidden" for legitimate approvers.
  const role = ctx.membership.role;
  if (role !== "owner" && role !== "admin") {
    redirect("/dashboard?error=forbidden");
  }
}

export async function requestQuoteApproval(id: string) {
  const { ctx } = await requireOrgContext();
  if (!idSchema.safeParse(id).success) redirect("/quotes");

  const supabase = await createClient();
  // Active-org scoped — a quote in another of the caller's orgs is not_found.
  const { data: current } = await supabase
    .from("quotes")
    .select("status, org_id")
    .eq("id", id)
    .eq("org_id", ctx.org.id)
    .maybeSingle();
  if (!current) redirect(`/quotes/${id}?error=not_found`);
  if (current.status !== "draft" && current.status !== "rejected") {
    redirect(
      `/quotes/${id}?error=${encodeURIComponent(
        `Quote is in '${current.status}' status — only draft or rejected quotes can be sent for approval.`,
      )}`,
    );
  }

  // Clear any prior approval state — the trigger emits
  // quote.approval_requested.
  const { error } = await supabase
    .from("quotes")
    .update({
      status: "pending_approval",
      approved_by: null,
      approved_at: null,
      approval_comment: null,
    })
    .eq("id", id)
    .eq("org_id", ctx.org.id);
  if (error) {
    console.error("[quotes] requestApproval failed", error);
    redirect(`/quotes/${id}?error=request_failed`);
  }

  revalidatePath(`/quotes/${id}`);
  revalidatePath("/quotes");
  revalidatePath("/dashboard");
  redirect(`/quotes/${id}?saved=approval_requested`);
}

export async function reviewQuote(id: string, formData: FormData) {
  const { ctx, user } = await requireOrgContext();
  if (!idSchema.safeParse(id).success) redirect("/quotes");
  requireQuoteApprover(ctx);

  const action = String(formData.get("action") ?? "");
  if (action !== "approve" && action !== "reject" && action !== "request_changes") {
    redirect(`/quotes/${id}?error=invalid_action`);
  }
  const comment = String(formData.get("comment") ?? "").trim() || null;
  if ((action === "reject" || action === "request_changes") && !comment) {
    redirect(
      `/quotes/${id}?error=${encodeURIComponent(
        "Comment is required when rejecting or requesting changes.",
      )}`,
    );
  }

  const supabase = await createClient();
  // ACTIVE-ORG SCOPE — load-bearing for the authorisation above, not just for
  // tidiness. `requireQuoteApprover(ctx)` proves the caller is an
  // owner/admin of the ACTIVE org; an unscoped read here let that approval
  // right be spent on a quote belonging to a DIFFERENT org — one where the
  // same user may be only an ordinary member. The separation-of-duties count
  // below is likewise taken over the active org's memberships, so it would
  // have been answering a question about the wrong org entirely.
  const { data: current } = await supabase
    .from("quotes")
    .select("status, created_by")
    .eq("id", id)
    .eq("org_id", ctx.org.id)
    .maybeSingle();
  if (!current) redirect(`/quotes/${id}?error=not_found`);
  if (current.status !== "pending_approval") {
    redirect(
      `/quotes/${id}?error=${encodeURIComponent(
        `Only quotes in 'pending_approval' can be reviewed. This one is '${current.status}'.`,
      )}`,
    );
  }

  // M2 — separation of duties on quote approval. The person who created a
  // quote shouldn't rubber-stamp their own pricing when someone else could
  // review it, so we BLOCK self-approval whenever another owner/admin
  // exists in the org. For a sole owner/admin (the only eligible approver)
  // we ALLOW it — a hard block would brick the workflow for one-person
  // firms, which are common on CrewFlow — but we stamp it explicitly as a
  // self-approval in the activity log so the audit trail is honest.
  // Reject / request-changes by the creator are always fine; the control
  // objective is specifically self-*approval*.
  let selfApproved = false;
  if (
    action === "approve" &&
    current.created_by &&
    current.created_by === user.id
  ) {
    const { count: otherApprovers } = await supabase
      .from("memberships")
      .select("user_id", { count: "exact", head: true })
      .eq("org_id", ctx.org.id)
      .in("role", ["owner", "admin"])
      .neq("user_id", user.id);
    if ((otherApprovers ?? 0) > 0) {
      redirect(
        `/quotes/${id}?error=${encodeURIComponent(
          "You created this quote, so another owner or admin needs to approve it.",
        )}`,
      );
    }
    selfApproved = true;
  }

  if (action === "request_changes") {
    // Stay in pending_approval; only record the comment (trigger emits
    // quote.approval_requested again — that's fine, it's a re-request).
    const { error } = await supabase
      .from("quotes")
      .update({ approval_comment: comment })
      .eq("id", id)
      .eq("org_id", ctx.org.id);
    if (error) {
      console.error("[quotes] request_changes failed", error);
      redirect(`/quotes/${id}?error=review_failed`);
    }
    // Emit a dedicated activity event via the helper for clarity. The
    // _record_activity helper is SECURITY DEFINER so this works through
    // the user JWT.
    const admin = createAdminClient();
    await admin.rpc("_record_activity", {
      p_org_id: ctx.org.id,
      p_action: "quote.changes_requested",
      p_target_table: "quotes",
      p_target_id: id,
      p_metadata: { comment, reviewer_id: user.id },
    } as never);
    revalidatePath(`/quotes/${id}`);
    revalidatePath("/dashboard");
    redirect(`/quotes/${id}?saved=changes_requested`);
  }

  const nextStatus = action === "approve" ? "approved" : "rejected";
  const { error } = await supabase
    .from("quotes")
    .update({
      status: nextStatus,
      approved_by: user.id,
      approved_at: new Date().toISOString(),
      approval_comment: comment,
    })
    .eq("id", id)
    .eq("org_id", ctx.org.id);
  if (error) {
    console.error("[quotes] review failed", error);
    redirect(`/quotes/${id}?error=review_failed`);
  }

  // Audit trail for the sole-approver self-approval case (see M2 note
  // above). Best-effort: a misconfigured service-role key must not fail an
  // otherwise-successful approval, so we swallow errors here.
  if (selfApproved) {
    try {
      const admin = createAdminClient();
      await admin.rpc("_record_activity", {
        p_org_id: ctx.org.id,
        p_action: "quote.self_approved",
        p_target_table: "quotes",
        p_target_id: id,
        p_metadata: { approver_id: user.id, sole_approver: true, comment },
      } as never);
    } catch (e) {
      console.error("[quotes] self-approval audit log failed", e);
    }
  }

  revalidatePath(`/quotes/${id}`);
  revalidatePath("/quotes");
  revalidatePath("/dashboard");
  redirect(`/quotes/${id}?saved=${nextStatus}`);
}

export async function deleteQuote(id: string) {
  const { ctx } = await requireOrgContext();
  const supabase = await createClient();

  // INTEGRITY GUARD — refuse to delete a quote that invoices still depend on.
  //
  // `invoices.quote_id` is `on delete set null` (20260515190000_invoices.sql),
  // so deleting the quote does NOT fail. It silently orphans the invoice, and
  // every consequence is invisible from this screen:
  //   - the invoice disappears from the customer's portal (both the overview
  //     and the invoices list scope by the customer's quote ids);
  //   - its portal PDF 404s (ownership resolves through quote -> customer);
  //   - its PDF and emailed copy render with a correct total and NO line items
  //     (they read quote_line_items via quote_id);
  //   - the reminder cron stops chasing it FOREVER, because the recipient also
  //     resolves through quote -> customer, and a missing email is silently
  //     counted as skipped.
  // The money stays owed and nothing pursues it. The FK's stated intent —
  // "invoices outlive their source quote for audit" — is not delivered.
  //
  // Scoped to the ACTIVE org deliberately, not left to RLS: the invoices SELECT
  // policy is `org_id in (select current_org_ids())`, which spans EVERY org the
  // caller belongs to, so for a multi-org user another org's invoice could
  // otherwise decide this org's deletion.
  //
  // Fails CLOSED: if the check itself errors we refuse the delete rather than
  // fall through to it. A dependency check that fails open is worse than none —
  // it reads as a guarantee while silently permitting the damage.
  const { data: dependents, error: depErr } = await supabase
    .from("invoices")
    .select("id")
    .eq("quote_id", id)
    .eq("org_id", ctx.org.id)
    .limit(1);
  if (depErr) {
    console.error("[quotes] invoice dependency check failed", {
      quoteId: id,
      code: depErr.code,
      message: depErr.message,
    });
    redirect(`/quotes/${id}?error=delete_check_failed`);
  }
  if ((dependents ?? []).length > 0) {
    redirect(`/quotes/${id}?error=has_invoices`);
  }

  // RLS on quotes inherits from the broader members policy: DELETE allowed
  // for any member (no admin gating on quotes table by default).
  // quote_line_items cascade-delete via FK ON DELETE CASCADE.
  //
  // ACTIVE-ORG SCOPE — and note this predicate is what makes the guard above
  // MEAN anything. That dependency check is scoped to `ctx.org.id` (correctly,
  // and deliberately, per the note above). An unscoped delete therefore had it
  // exactly backwards for a foreign quote: the check looked for invoices in
  // the ACTIVE org referencing another org's quote, found none, declared the
  // quote safe to delete — and then deleted it, orphaning the very invoices
  // the guard exists to protect. The two must be scoped alike.
  const { error } = await supabase
    .from("quotes")
    .delete()
    .eq("id", id)
    .eq("org_id", ctx.org.id);
  if (error) {
    console.error("[quotes] delete failed", error);
    redirect(`/quotes/${id}?error=delete_failed`);
  }
  revalidatePath("/quotes");
  redirect("/quotes");
}

/**
 * Owner-side acceptance shortcut — handy for "client confirmed by phone"
 * cases. Same downstream behaviour as the public portal accept: stamps
 * accepted_at, status=accepted, then auto-creates an invoice from the
 * source quote.
 */
export async function acceptQuoteAsOwner(id: string, formData: FormData) {
  const { ctx } = await requireOrgContext();
  const signerName = String(formData.get("signer_name") ?? "Owner accepted on customer's behalf");

  const supabase = await createClient();
  const now = new Date().toISOString();

  // IDEMPOTENCY: re-accepting an already-accepted quote must NOT post a
  // second invoice (or re-create the job). This button is double-submittable,
  // and an owner may "confirm by phone" a quote the customer already accepted
  // via the public portal. acceptQuoteByToken guards this with a status
  // precondition (see below) — mirror it here: read first, and short-circuit
  // as an idempotent success when the quote is already accepted. RLS scopes
  // this read to the caller's org; a wrong-org/unknown id returns null and
  // falls through to the UPDATE, which no-ops and redirects accept_failed
  // exactly as before.
  const { data: preExisting } = await supabase
    .from("quotes")
    .select("status")
    .eq("id", id)
    .eq("org_id", ctx.org.id)
    .maybeSingle();
  if (preExisting?.status === "accepted") {
    redirect(`/quotes/${id}?saved=accepted`);
  }

  // ACTIVE-ORG SCOPE — the single most consequential predicate in this file.
  //
  // Everything downstream is stamped from `quote.org_id`, which an unscoped
  // update faithfully copies from whichever org the row turned out to belong
  // to. Accepting a quote belonging to another of the caller's orgs therefore
  // did not fail — it succeeded, in that other org: it created a JOB there,
  // burned a number from its `next_invoice_number` sequence, posted a draft
  // INVOICE against its books, EMAILED that invoice to its customer, advanced
  // its lead to "won", and dispatched automation under its id. All of it from
  // inside this org's screen, with nothing to show it had happened.
  //
  // Matching zero rows makes `quote` null, which falls through to the existing
  // accept_failed redirect — a foreign id behaves exactly like a missing one.
  const { data: quote, error } = await supabase
    .from("quotes")
    .update({
      status: "accepted",
      accepted_at: now,
      accept_signature: { name: signerName, signed_at: now, source: "owner" },
    })
    .eq("id", id)
    .eq("org_id", ctx.org.id)
    .select(
      "id, org_id, subtotal, vat_total, job_id, variation_number, customer_id, number, notes",
    )
    .single();

  if (error || !quote) {
    console.error("[quotes] accept failed", error);
    redirect(`/quotes/${id}?error=accept_failed`);
  }

  // Auto-create a job (status=new) from the accepted quote — mirrors the
  // public-portal path so an owner-accepted quote produces the same
  // job → invoice chain. Skipped for variations (they already carry the
  // parent's job_id) and for quotes with no customer to attach the job to.
  let jobId: string | null = quote.job_id;
  if (!quote.job_id && quote.customer_id) {
    const { data: newJob, error: jobErr } = await supabase
      .from("jobs")
      .insert({
        // Stamp from the ACTIVE org, not from the row we just read. The quote
        // is proven in-org above, so these are now the same value — saying
        // ctx.org.id keeps it that way if the resolve is ever loosened again.
        org_id: ctx.org.id,
        customer_id: quote.customer_id,
        status: "new",
        notes: `Auto-created from accepted quote ${quote.number}.${
          quote.notes ? `\n\nQuote notes:\n${quote.notes}` : ""
        }`,
      })
      .select("id")
      .single();
    if (jobErr) {
      console.error("[quotes] owner auto-job failed", jobErr);
    } else if (newJob?.id) {
      jobId = newJob.id;
      // Backlink so the quote knows which job it spawned.
      await supabase
        .from("quotes")
        .update({ job_id: jobId })
        .eq("id", quote.id)
        .eq("org_id", ctx.org.id);
    }
  }

  // Auto-create invoice using the next_invoice_number RPC (mirrors what
  // /api/invoices POST does — duplicated here so the owner gets one
  // round trip).
  //
  // IDEMPOTENCY: reuse any invoice already linked to this quote instead of
  // posting a second one. The status precondition above stops the common
  // double-submit before we reach here; this is the belt-and-braces guard
  // for the degenerate "accepted-but-no-invoice retried" / concurrent-submit
  // race, and is the in-code half of the partial unique index on
  // invoices(quote_id). Without it a re-run allocates a fresh number and
  // INSERTs a duplicate draft invoice for the same quote, double-billing the
  // customer. limit(1) keeps maybeSingle safe even if pre-fix duplicates
  // already exist.
  const { data: existingInvoice } = await supabase
    .from("invoices")
    .select("id")
    .eq("quote_id", quote.id)
    // Org-scoped so the idempotency check answers a question about THIS org's
    // books — an invoice found in another org must not suppress this one.
    .eq("org_id", ctx.org.id)
    .limit(1)
    .maybeSingle();

  let invoiceId: string | null = existingInvoice?.id ?? null;
  let createdInvoice = false;
  if (!invoiceId) {
    // Number allocation MUTATES a per-org sequence, so the target org must be
    // the active one — an unscoped accept burned a number out of another org's
    // invoice series, permanently leaving a gap in their numbering.
    const { data: invNumber, error: numErr } = await supabase.rpc(
      "next_invoice_number",
      { target_org: ctx.org.id },
    );
    if (numErr || !invNumber) {
      console.error("[quotes] invoice number alloc failed", numErr);
      redirect(`/quotes/${id}?saved=accepted&warn=invoice_skipped`);
    }
    // Pass job_id through so revenue from accepted quotes (including
    // variations) rolls up on the dashboard. due_date defaults to net-14
    // so the customer always sees a concrete payment deadline.
    const { data: newInvoice, error: invErr } = await supabase
      .from("invoices")
      .insert({
        org_id: ctx.org.id,
        quote_id: quote.id,
        // Denormalised customer anchor (Issue #349 Phase 1) — stamped from the
        // quote at creation so the invoice keeps its customer identity if the
        // quote is later deleted. Composite FK guarantees same-org.
        customer_id: quote.customer_id,
        number: invNumber as unknown as string,
        amount: quote.subtotal,
        vat_total: quote.vat_total,
        status: "draft",
        job_id: jobId,
        due_date: invoiceDueDate(now),
      })
      .select("id")
      .single();
    if (invErr || !newInvoice) {
      console.error("[quotes] auto-invoice failed", invErr);
      redirect(`/quotes/${id}?saved=accepted&warn=invoice_skipped`);
    }
    invoiceId = newInvoice.id;
    createdInvoice = true;
  }

  // Auto-email the invoice PDF to the customer. Best-effort: a send
  // failure (missing key, customer has no email, Resend rejection) does
  // NOT block the accept response — the invoice still exists and the
  // owner can manually re-send from /invoices/[id]. Only email a freshly
  // created invoice — reusing an existing one means the customer was
  // already sent it on the first accept.
  if (createdInvoice && invoiceId) {
    const emailRes = await sendInvoiceEmail(supabase, invoiceId, {
      orgId: ctx.org.id,
    });
    if (!emailRes.sent) {
      console.warn("[quotes] auto-email after accept skipped", emailRes);
    }
  }

  // Pipeline integration: if the quote was linked to a lead, advance
  // the lead to "won" so the kanban reflects the close.
  const { data: quoteWithLead } = await supabase
    .from("quotes")
    .select("lead_id")
    .eq("id", id)
    .eq("org_id", ctx.org.id)
    .maybeSingle();
  if (quoteWithLead?.lead_id) {
    await supabase
      .from("leads")
      .update({
        status: "won",
        last_activity_at: new Date().toISOString(),
      })
      .eq("id", quoteWithLead.lead_id)
      .eq("org_id", ctx.org.id);
  }

  // Phase 4 — dispatch `quote.accepted` so the automation OS can
  // run its rules (notification, audit, future actions). Idempotent
  // via (rule_id, correlation_id) in automation_runs. Best-effort —
  // never derails the accept flow.
  await dispatchAutomation({
    type: "quote.accepted",
    org_id: ctx.org.id,
    source_table: "quotes",
    source_id: quote.id,
    payload: { signer: signerName, accepted_at: now },
  }).catch((e) => {
    console.error("[quotes] automation dispatch failed", e);
  });

  revalidatePath("/quotes");
  revalidatePath(`/quotes/${id}`);
  revalidatePath("/leads");
  redirect(`/quotes/${id}?saved=accepted`);
}

export async function declineQuoteAsOwner(id: string) {
  const { ctx } = await requireOrgContext();
  const supabase = await createClient();
  const { error } = await supabase
    .from("quotes")
    .update({
      status: "declined",
      declined_at: new Date().toISOString(),
    })
    .eq("id", id)
    // Active-org scope — declining another org's live quote kills a deal they
    // are still working, and the customer portal reflects it immediately.
    .eq("org_id", ctx.org.id);
  if (error) {
    console.error("[quotes] decline failed", error);
    redirect(`/quotes/${id}?error=decline_failed`);
  }
  revalidatePath(`/quotes/${id}`);
  redirect(`/quotes/${id}?saved=declined`);
}

/**
 * Service-role helper used by the public portal (which has no user JWT).
 * Exposed via separate file at /q/[token]/actions.ts so this module
 * keeps user-context only.
 */
export async function acceptQuoteByToken(
  token: string,
  signerName: string,
  ipHash: string | null,
  customerComment: string | null = null,
  userAgent: string | null = null,
): Promise<{ ok: true; quoteId: string } | { ok: false; error: string }> {
  const admin = createAdminClient();
  const now = new Date().toISOString();

  const { data: quote, error: lookupErr } = await admin
    .from("quotes")
    .select(
      "id, org_id, status, subtotal, vat_total, valid_until, lead_id, job_id, variation_number, customer_id, number, notes",
    )
    .eq("public_token", token)
    .maybeSingle();

  if (lookupErr || !quote) return { ok: false, error: "Quote not found" };
  // Idempotency: a re-accept is a no-op. The first accept already created
  // (or linked) the invoice + job, so nothing to redo.
  if (quote.status === "accepted") return { ok: true, quoteId: quote.id };
  if (quote.status === "declined") return { ok: false, error: "Quote already declined" };
  if (quote.status === "expired") return { ok: false, error: "Quote has expired" };
  if (quote.valid_until && quote.valid_until < now.slice(0, 10)) {
    await admin.from("quotes").update({ status: "expired" }).eq("id", quote.id);
    return { ok: false, error: "Quote has expired" };
  }

  const { error: updErr } = await admin
    .from("quotes")
    .update({
      status: "accepted",
      accepted_at: now,
      accept_signature: { name: signerName, signed_at: now, ip_hash: ipHash, source: "public" },
      customer_comment: customerComment,
    })
    .eq("id", quote.id);
  if (updErr) {
    console.error("[quotes] public accept failed", updErr);
    return { ok: false, error: "Couldn't record acceptance" };
  }

  // Phase G — write into the polymorphic signatures table so the operator
  // can see the full e-sign audit trail on the quote detail page. Customer
  // is anonymous here so we use the admin client; the row gets its
  // org_id from the quote (RLS still segregates per-org reads).
  await (admin.from("signatures" as never) as unknown as {
    insert: (row: unknown) => Promise<{ error: { message: string } | null }>;
  })
    .insert({
      org_id: quote.org_id,
      target_table: "quotes",
      target_id: quote.id,
      signer_name: signerName,
      signer_email: null,
      signature_text: signerName,
      signed_at: now,
      ip_address: ipHash,
      user_agent: userAgent,
    })
    .then((r) => {
      if (r.error) {
        console.error("[quotes] signatures insert failed", r.error);
      }
    });

  // Auto-create a job (status=new) from the accepted quote — but only when
  // the quote isn't a variation against an existing job. Variations
  // already carry the parent's job_id; using it preserves the revenue
  // rollup on /jobs profitability.
  let newJobId: string | null = quote.job_id;
  let createdJob = false;
  if (!quote.job_id && quote.customer_id) {
    const { data: newJob, error: jobErr } = await admin
      .from("jobs")
      .insert({
        org_id: quote.org_id,
        customer_id: quote.customer_id,
        status: "new",
        notes: `Auto-created from accepted quote ${quote.number}.${
          quote.notes ? `\n\nQuote notes:\n${quote.notes}` : ""
        }`,
      })
      .select("id")
      .single();
    if (jobErr) {
      console.error("[quotes] public auto-job failed", jobErr);
    } else if (newJob?.id) {
      newJobId = newJob.id;
      createdJob = true;
      // Backlink so the quote knows which job it spawned.
      await admin.from("quotes").update({ job_id: newJobId }).eq("id", quote.id);
    }
  }

  // Auto-create invoice (draft) from the accepted quote. Picks up the
  // job_id we just resolved so revenue rolls up to the job on the
  // profitability dashboard.
  const { data: invNumber } = await admin.rpc("next_invoice_number", {
    target_org: quote.org_id,
  });
  let newInvoiceId: string | null = null;
  if (invNumber) {
    const { data: newInvoice, error: invErr } = await admin
      .from("invoices")
      .insert({
        org_id: quote.org_id,
        quote_id: quote.id,
        // Denormalised customer anchor (Issue #349 Phase 1) — see the owner
        // auto-invoice path above. Same composite-FK guarantee.
        customer_id: quote.customer_id,
        number: invNumber as unknown as string,
        amount: quote.subtotal,
        vat_total: quote.vat_total,
        status: "draft",
        job_id: newJobId,
        due_date: invoiceDueDate(now),
      })
      .select("id")
      .single();
    if (invErr) {
      console.error("[quotes] public auto-invoice failed", invErr);
    } else {
      newInvoiceId = newInvoice?.id ?? null;
    }
  }

  void createdJob;

  // Auto-email the invoice PDF to the customer. Best-effort — accept must
  // succeed even if Resend rejects, the customer email is missing, or
  // RESEND_API_KEY is not configured yet.
  if (newInvoiceId) {
    const emailRes = await sendInvoiceEmail(admin, newInvoiceId);
    if (!emailRes.sent) {
      console.warn("[quotes] public auto-email after accept skipped", emailRes);
    }
  }

  // Pipeline integration: advance the linked lead to "won" so the kanban
  // reflects the close — applies whether owner-accepted or public-accepted.
  if (quote.lead_id) {
    await admin
      .from("leads")
      .update({
        status: "won",
        last_activity_at: now,
      })
      .eq("id", quote.lead_id);
  }

  return { ok: true, quoteId: quote.id };
}

export async function declineQuoteByToken(
  token: string,
  reason: string | null,
  customerComment: string | null = null,
): Promise<{ ok: true; quoteId: string } | { ok: false; error: string }> {
  const admin = createAdminClient();
  const now = new Date().toISOString();

  const { data: quote } = await admin
    .from("quotes")
    .select("id, status, notes")
    .eq("public_token", token)
    .maybeSingle();
  if (!quote) return { ok: false, error: "Quote not found" };
  if (quote.status === "accepted") return { ok: false, error: "Quote already accepted" };
  if (quote.status === "declined") return { ok: true, quoteId: quote.id };

  // Append decline reason into the existing notes field for the audit trail.
  const nextNotes = reason
    ? `${quote.notes ?? ""}\n\n[Declined ${now}] ${reason}`.trim()
    : quote.notes;

  const { error } = await admin
    .from("quotes")
    .update({
      status: "declined",
      declined_at: now,
      notes: nextNotes,
      customer_comment: customerComment,
    })
    .eq("id", quote.id);
  if (error) {
    console.error("[quotes] public decline failed", error);
    return { ok: false, error: "Couldn't record decline" };
  }
  return { ok: true, quoteId: quote.id };
}



/**
 * Create a Variation Order — a quote scoped to a specific job with a
 * per-job sequence number. Uses the same quotes/quote_line_items
 * pipeline so PDF + public portal + accept/decline + auto-invoice all
 * work for free.
 *
 * The form captures the operator's cost breakdown (labour/materials/
 * subcontractors/misc) + desired margin %; revenue is derived. Each
 * non-zero cost bucket becomes a quote_line_item so the PDF reads
 * cleanly, while the customer-facing line shows the bucket as a
 * description and the bucket's net-of-margin price as the unit_price.
 *
 * For the customer the variation looks like a small quote with a few
 * line items. Internally we mark it as a variation via the new
 * quotes.variation_number column. On accept, an invoice is generated
 * exactly as for a normal quote — and because we carry the job_id
 * through, the new invoice automatically rolls up under the same job
 * on the profitability dashboard.
 */
export async function createVariation(jobId: string, formData: FormData) {
  const { user, ctx } = await requireOrgContext();
  if (!idSchema.safeParse(jobId).success) redirect("/jobs");

  const { variationFormSchema, computeVariation } = await import(
    "@/lib/variations/schema"
  );

  const parsed = variationFormSchema.safeParse({
    title: formData.get("title") ?? "",
    description: formData.get("description") ?? "",
    labour_cost: formData.get("labour_cost") ?? 0,
    materials_cost: formData.get("materials_cost") ?? 0,
    subcontractor_cost: formData.get("subcontractor_cost") ?? 0,
    misc_cost: formData.get("misc_cost") ?? 0,
    margin_pct: formData.get("margin_pct") ?? 0,
    vat_rate: formData.get("vat_rate") ?? 20,
    note: formData.get("note") ?? "",
    target_completion_date: formData.get("target_completion_date") ?? "",
  });

  if (!parsed.success) {
    const msg = parsed.error.issues[0]?.message ?? "Invalid variation";
    redirect(`/jobs/${jobId}/variations/new?error=${encodeURIComponent(msg)}`);
  }

  const computed = computeVariation(parsed.data);
  const supabase = await createClient();

  // Resolve job: org check + customer_id for the quote FK.
  //
  // The comment said "org check"; the query did not have one. Loading by id
  // alone let a dual-org user raise a variation against another org's job —
  // and because every stamp below was copied from `job.org_id`, the variation
  // quote, its number (drawn from that org's sequence) and its line items were
  // all created THERE. Routed through the same chokepoint the jobs domain got
  // in #456, so a job outside the active org is simply not found.
  const job = await loadJobForOrg<{ id: string; customer_id: string | null }>(
    supabase,
    jobId,
    ctx.org.id,
    "id, customer_id",
  );
  if (!job) redirect("/jobs?error=job_not_found");
  if (!job.customer_id) {
    redirect(`/jobs/${jobId}?error=variation_needs_customer`);
  }

  // Allocate per-org quote number AND per-job variation number.
  const [{ data: quoteNumber }, { data: varNumber }] = await Promise.all([
    supabase.rpc("next_quote_number", { target_org: ctx.org.id }),
    supabase.rpc("next_variation_number", { target_job: jobId }),
  ]);
  if (!quoteNumber || !varNumber) {
    console.error("[variations] number allocation failed", { quoteNumber, varNumber });
    redirect(`/jobs/${jobId}/variations/new?error=create_failed`);
  }

  const publicToken = crypto.randomUUID();

  // Insert the variation as a quote.
  const { data: variation, error: qErr } = await supabase
    .from("quotes")
    .insert({
      org_id: ctx.org.id,
      customer_id: job.customer_id,
      lead_id: null,
      job_id: jobId,
      variation_number: varNumber,
      number: quoteNumber as unknown as string,
      status: "draft",
      currency: "GBP",
      subtotal: computed.subtotal,
      vat_total: computed.vat_total,
      total: computed.total,
      notes: parsed.data.description
        ? `${parsed.data.title}\n\n${parsed.data.description}${parsed.data.note ? `\n\n${parsed.data.note}` : ""}`.trim()
        : `${parsed.data.title}${parsed.data.note ? `\n\n${parsed.data.note}` : ""}`.trim(),
      terms: null,
      valid_until: parsed.data.target_completion_date ?? null,
      public_token: publicToken,
      created_by: user.id,
    })
    .select("id")
    .single();

  if (qErr || !variation) {
    console.error("[variations] insert failed", qErr);
    redirect(`/jobs/${jobId}/variations/new?error=create_failed`);
  }

  // Build customer-facing line items from the cost breakdown. We split
  // the variation revenue across buckets in proportion to their costs
  // so the customer sees a meaningful breakdown rather than a single
  // opaque "variation" line.
  const { labour, materials, subcontractors, misc } = computed.cost_breakdown;
  const totalCost = computed.total_cost;
  type LIRow = { label: string; cost: number };
  const buckets: LIRow[] = [
    { label: "Labour", cost: labour },
    { label: "Materials", cost: materials },
    { label: "Subcontractors", cost: subcontractors },
    { label: "Other", cost: misc },
  ].filter((b) => b.cost > 0);

  let lineItems: LineItemInsert[];
  if (totalCost === 0 || buckets.length === 0) {
    // Fallback: a single line representing the whole revenue.
    lineItems = [
      {
        quote_id: variation.id,
        org_id: ctx.org.id,
        description: parsed.data.title,
        qty: 1,
        unit_price: computed.subtotal,
        vat_rate: parsed.data.vat_rate,
        line_total: computed.subtotal,
        sort_order: 0,
      },
    ];
  } else {
    lineItems = buckets.map((b, idx) => {
      const share = b.cost / totalCost;
      const unit_price = Math.round(computed.subtotal * share * 100) / 100;
      return {
        quote_id: variation.id,
        org_id: ctx.org.id,
        description: b.label,
        qty: 1,
        unit_price,
        vat_rate: parsed.data.vat_rate,
        line_total: unit_price,
        sort_order: idx,
      };
    });
    // Adjust the last line to ensure sum == computed.subtotal (rounding).
    const summed = lineItems.reduce((s, l) => s + Number(l.unit_price ?? 0), 0);
    const delta = Math.round((computed.subtotal - summed) * 100) / 100;
    if (delta !== 0 && lineItems.length > 0) {
      const last = lineItems[lineItems.length - 1]!;
      last.unit_price = Math.round((Number(last.unit_price ?? 0) + delta) * 100) / 100;
      last.line_total = last.unit_price;
    }
  }

  const { error: liErr } = await supabase
    .from("quote_line_items")
    .insert(lineItems);
  if (liErr) {
    console.error("[variations] line items insert failed", liErr);
    redirect(`/jobs/${jobId}?error=variation_line_items_failed`);
  }

  revalidatePath(`/jobs/${jobId}`);
  revalidatePath(`/quotes/${variation.id}`);
  redirect(`/quotes/${variation.id}?saved=variation_created`);
}
