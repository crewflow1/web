import { createClient } from "@/lib/supabase/server";
import type { ReceivedQty } from "@/lib/purchase-orders/receiving";

/**
 * Goods-received readers for the purchase-order surface (Warehouse M1).
 *
 * EVERY read here is pinned to the ACTIVE org as well as filtered by RLS.
 * `current_org_ids()` returns every org the viewer belongs to, so for a
 * dual-org member an RLS-only read would blend both companies' deliveries onto
 * one order page and into one register — the defect class closed by
 * #456/#459/#461/#463/#464/#468 on the read side, which this new surface must
 * not reopen.
 *
 * goods_received_notes / goods_received_lines aren't in the generated Supabase
 * types yet, so the readers are cast (the established `as never` idiom).
 */

export type GrnLineRow = {
  id: string;
  purchase_order_line_item_id: string;
  qty_received: number | string | null;
  notes: string | null;
};

export type GrnRow = {
  id: string;
  number: string;
  status: string;
  delivery_date: string;
  delivery_note_reference: string | null;
  delivery_location: string | null;
  notes: string | null;
  void_reason: string | null;
  posted_at: string | null;
  created_at: string;
  received_by_user: { full_name: string | null; email: string | null } | null;
  lines: GrnLineRow[];
};

type Chain<T> = {
  select: (c: string) => Chain<T>;
  eq: (k: string, v: unknown) => Chain<T>;
  in: (k: string, v: readonly unknown[]) => Chain<T>;
  order: (k: string, o: { ascending: boolean }) => Chain<T>;
  limit: (n: number) => Promise<{ data: T[] | null; error: { message: string } | null }>;
};

function table<T>(supabase: Awaited<ReturnType<typeof createClient>>, name: string): Chain<T> {
  return supabase.from(name as never) as unknown as Chain<T>;
}

/** Every goods received note on one order, newest first, with its lines. */
export async function listPurchaseOrderReceipts(
  supabase: Awaited<ReturnType<typeof createClient>>,
  orgId: string,
  purchaseOrderId: string,
): Promise<{ notes: GrnRow[]; postedLines: ReceivedQty[] }> {
  const { data } = await table<GrnRow>(supabase, "goods_received_notes")
    .select(
      "id, number, status, delivery_date, delivery_note_reference, delivery_location, notes, void_reason, posted_at, created_at, " +
        "received_by_user:users!goods_received_notes_received_by_fkey ( full_name, email ), " +
        "lines:goods_received_lines ( id, purchase_order_line_item_id, qty_received, notes )",
    )
    .eq("purchase_order_id", purchaseOrderId)
    .eq("org_id", orgId) // ACTIVE-ORG PIN
    .order("created_at", { ascending: false })
    .limit(200);

  const notes = data ?? [];

  // Only POSTED notes count towards the receipt position — drafts have not
  // happened yet and voids have been retracted. This is the same filter
  // po_receipt_state() applies in the database; keeping them identical is what
  // makes the page agree with the status the database derived.
  const postedLines: ReceivedQty[] = notes
    .filter((n) => n.status === "posted")
    .flatMap((n) =>
      (n.lines ?? []).map((l) => ({
        purchase_order_line_item_id: l.purchase_order_line_item_id,
        qty_received: l.qty_received,
      })),
    );

  return { notes, postedLines };
}

/**
 * Posted-delivery counts for a page of orders, for the register's receipt
 * badges. ONE query for the whole page rather than one per row.
 */
export async function countPostedReceipts(
  supabase: Awaited<ReturnType<typeof createClient>>,
  orgId: string,
  purchaseOrderIds: string[],
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (purchaseOrderIds.length === 0) return counts;

  const { data } = await table<{ purchase_order_id: string }>(supabase, "goods_received_notes")
    .select("purchase_order_id")
    .eq("org_id", orgId) // ACTIVE-ORG PIN
    .eq("status", "posted")
    .in("purchase_order_id", purchaseOrderIds)
    // Delivery counts for one list page's POs — bounded. Honest cap: PostgREST
    // clamps every read to max_rows (1000) regardless.
    .limit(1000);

  for (const row of data ?? []) {
    counts.set(row.purchase_order_id, (counts.get(row.purchase_order_id) ?? 0) + 1);
  }
  return counts;
}

/**
 * Does this order have ANY goods received note at all (any status)?
 *
 * Used to decide whether the order's lines may still be edited or the order
 * deleted. It counts VOID notes too, deliberately: a void note still holds
 * received lines that reference the ordered lines, so the database will refuse
 * the delete either way — and letting the app promise something the database
 * refuses is worse than a slightly conservative rule.
 */
export async function purchaseOrderHasReceipts(
  supabase: Awaited<ReturnType<typeof createClient>>,
  orgId: string,
  purchaseOrderId: string,
): Promise<boolean> {
  const { data } = await table<{ id: string }>(supabase, "goods_received_notes")
    .select("id")
    .eq("purchase_order_id", purchaseOrderId)
    .eq("org_id", orgId) // ACTIVE-ORG PIN
    .limit(1);
  return (data ?? []).length > 0;
}
