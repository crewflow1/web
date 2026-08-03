"use server";

import { createClient } from "@/lib/supabase/server";
import { requireOrgContext, type OrgContext } from "@/server/auth/session";
import { type FormState, formError, formSuccess } from "@/lib/forms/state";
import { stockIdSchema } from "@/lib/stock/schema";
import { materialRequestFormSchema } from "@/lib/material-requests/schema";
import { createMaterialRequestDraftRecord } from "@/server/services/material-request-writes";
import {
  replenishmentSuggestionsForItems,
  type ReplenishmentSuggestion,
} from "@/server/services/stock-reorder";
import type { StockClient } from "@/server/services/stock";

/**
 * OPERATIONAL STOCK — the REPLENISHMENT → MATERIAL-REQUEST handoff.
 *
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  THE ACCOUNTING BOUNDARY. This action writes NO cost and NO `finances`   ║
 * ║  row. It raises a DRAFT material request (quantities only); the office   ║
 * ║  prices it later on the PO. Purchased materials are already expensed by  ║
 * ║  recordSupplierBill, so a cost here would double-count. D1 undecided.    ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * ── REUSES THE EXISTING MATERIAL-REQUEST AUTHORITY — no new ordering path ─────
 * The write goes through `createMaterialRequestDraftRecord`
 * (server/services/material-request-writes.ts), the SAME shared core the
 * worker form (app/(app)/materials/requests/actions.ts) and the offline replay
 * queue both use. That core owns the per-org number allocator, the born-draft
 * database rule, the active-org stock-item guard and the idempotency key. This
 * action therefore invents NOTHING about ordering: it only decides WHICH items
 * to ask for and re-derives HOW MANY. There is deliberately no bare insert into
 * material_requests / material_request_lines / purchase_orders here — a new
 * write path would have to re-earn every guard that core already holds.
 *
 * ── HONEST QUANTITIES, RE-DERIVED SERVER-SIDE ────────────────────────────────
 * The form posts only item ids. The quantity for each is recomputed HERE from
 * the current ledger (replenishmentSuggestionsForItems → the pure reorder rule),
 * never taken from the client — so a stale page or a tampered field can only ask
 * for a quantity the live balance actually justifies, and an item that has since
 * been restocked above its reorder point silently drops out.
 *
 * ── ROLE-GATED ───────────────────────────────────────────────────────────────
 * Raising a replenishment request is a purchasing decision, so it is owner/admin
 * only — the same posture as createPoDraftFromRequest. The database's own
 * material-request rules still apply underneath (belt and braces).
 *
 * ── NAVIGATION: redirectTo, never revalidatePath ─────────────────────────────
 * /stock is force-dynamic and this posts through useActionState; a revalidate
 * in the action response stalls the state commit (the Next 15.5 deep-swap
 * commit race the stock and materials lanes both document). Success returns
 * `redirectTo`, which StateForm turns into a full-document navigation.
 */

function isAdmin(ctx: OrgContext): boolean {
  return ctx.membership.role === "owner" || ctx.membership.role === "admin";
}

/** Parse the posted item ids — a JSON array, deduped, each a valid uuid. */
function parseItemIds(formData: FormData): string[] {
  let raw: unknown = [];
  try {
    raw = JSON.parse(String(formData.get("item_ids") ?? "[]"));
  } catch {
    raw = [];
  }
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  for (const v of raw) {
    if (typeof v === "string" && stockIdSchema.safeParse(v).success) seen.add(v);
  }
  return [...seen];
}

/** Build the material-request payload from server-recomputed suggestions. */
function toMaterialRequestInput(suggestions: readonly ReplenishmentSuggestion[]) {
  return materialRequestFormSchema.safeParse({
    // A warehouse restock is not tied to a job — the office assigns it later.
    job_id: "",
    needed_by: "",
    priority: "normal",
    notes:
      "Raised from stock replenishment — items at or below their reorder point. " +
      "Quantities are suggestions; adjust before ordering.",
    lines: suggestions.map((s) => ({
      description: s.name,
      qty: s.suggestedQuantity,
      unit: s.unit,
      stock_item_id: s.itemId,
    })),
  });
}

/**
 * Turn the selected below-reorder items into a DRAFT material request through
 * the existing authority. Draft, not submitted: the office reviews it, prices
 * it, and either fulfils from stock or raises a PO on the material-requests
 * surface — the ordinary flow this hands off into.
 */
export async function createReplenishmentRequest(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const { ctx, user } = await requireOrgContext();
  if (!isAdmin(ctx)) {
    return formError("Only an owner or admin can raise a replenishment request.");
  }

  const itemIds = parseItemIds(formData);
  if (itemIds.length === 0) {
    return formError("Pick at least one item to re-order.");
  }

  const supabase = await createClient();
  // Re-derive the honest quantities from the live ledger, ACTIVE-ORG PINNED.
  const suggestions = await replenishmentSuggestionsForItems(
    supabase as unknown as StockClient,
    ctx.org.id, // ACTIVE-ORG PIN
    itemIds,
  );
  if (suggestions.length === 0) {
    return formError(
      "None of those items are below their reorder point any more. Refresh and try again.",
    );
  }

  const parsed = toMaterialRequestInput(suggestions);
  if (!parsed.success) {
    // A stock unit longer than a material-request unit allows is the only
    // realistic cause; surface it rather than writing a malformed line.
    return formError(parsed.error.issues[0]?.message ?? "Couldn't build the request.");
  }

  // THE HANDOFF — the shared material-request write core, exactly as the worker
  // form calls it. No bare insert, no finances, org pinned inside via ctx.
  const outcome = await createMaterialRequestDraftRecord({
    ctx,
    user,
    input: parsed.data,
  });
  if (outcome.status === "rejected") {
    if (outcome.reason === "stock_item_missing") {
      return formError("One of those items isn't in this company any more.");
    }
    return formError("Couldn't save the request. Try again.");
  }
  if (outcome.status === "retry") {
    return formError("Couldn't save the request. Try again.");
  }

  // Draft created — hand off to the material-requests surface to review/price.
  // redirectTo → full-document navigation (no revalidatePath; see file header).
  return formSuccess({ redirectTo: `/materials/requests/${outcome.id}?saved=1` });
}
