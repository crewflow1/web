import { afterAll, beforeAll, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { anonClient, describeIntegration, serviceClient, userClient } from "../_harness";
import { loadReplenishmentSuggestions } from "@/server/services/stock-reorder";
import type { StockClient } from "@/server/services/stock";

/**
 * STOCK REPLENISHMENT against real Postgres (migration 20261107000000, on top of
 * the stock milestone 20261063–71 and material-requests 20261066–67).
 *
 * The proofs in this file:
 *
 *   · DETERMINISTIC READ — an item is surfaced exactly when its folded balance
 *     is at/below reorder_level AND it has a quantity to suggest (a fixed
 *     reorder_quantity, or the target_level shortfall). Above the point, no
 *     threshold, or no quantity source → not surfaced. The fold is the real one
 *     (server/services/stock.ts), so this is the same balance /stock shows;
 *   · CROSS-ORG ISOLATION — a dual-org admin reading replenishment for org A
 *     never sees org B's below-reorder item, and the pin is proven load-bearing;
 *   · THE HANDOFF REUSES THE MATERIAL-REQUEST AUTHORITY — a draft raised from a
 *     suggestion (the core's own statements: allocate number → born-draft header
 *     → lines carrying stock_item_id) lands as a draft with the suggested
 *     quantity, and the born-draft lifecycle rule REFUSES a bare submitted
 *     insert — so the handoff cannot be a free insert that bypasses authority;
 *   · THE ACCOUNTING BOUNDARY — the entire flow writes NOT ONE `finances` row.
 */

type Res<T> = { data: T | null; error: { message: string; code?: string } | null };
type Row = Record<string, unknown>;
interface Sel extends PromiseLike<Res<Row[]>> {
  select(columns?: string): Sel;
  eq(column: string, value: unknown): Sel;
  maybeSingle(): PromiseLike<Res<Row>>;
}
interface Ins extends PromiseLike<Res<Row[]>> {
  select(columns?: string): { single(): PromiseLike<Res<Row>> };
}
interface Del extends PromiseLike<Res<null>> {
  eq(column: string, value: unknown): Del;
}
interface Table {
  select(columns?: string): Sel;
  insert(rows: Row | Row[]): Ins;
  delete(): Del;
}
const db = (client: unknown) => client as unknown as { from(t: string): Table };
const rpc = (client: unknown) =>
  client as unknown as {
    rpc(fn: string, args: Record<string, unknown>): PromiseLike<Res<unknown>>;
  };

const TOKEN = `it-reorder-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describeIntegration("stock replenishment · determinism, isolation, handoff, boundary", () => {
  let orgA = "";
  let orgB = "";
  let siteA = "";
  let siteB = "";
  // org A items, each with a distinct reorder posture:
  let lowBatch = ""; // below point, fixed reorder_quantity
  let lowTarget = ""; // below point, no batch, has target_level
  let atPoint = ""; // exactly at point (inclusive) → surfaced
  let abovePoint = ""; // above point → not surfaced
  let noThreshold = ""; // no reorder_level → never surfaced
  let noQtySource = ""; // below point but no batch and no target → not surfaced
  let itemB = ""; // org B, below point — must never leak into A
  let dualUserId = "";
  let dualToken = "";

  const svc = () => db(serviceClient());

  async function makeUser(suffix: string): Promise<{ id: string; token: string }> {
    const email = `${TOKEN}-${suffix}@example.test`;
    const password = `Pw-${TOKEN}-${suffix}-${Math.random().toString(36).slice(2)}`;
    const created = await serviceClient().auth.admin.createUser({ email, password, email_confirm: true });
    expect(created.error, created.error?.message).toBeNull();
    const id = created.data.user?.id ?? "";
    const mirrored = await svc().from("users").insert({ id, email, full_name: `Reorder ${suffix}` }).select("id").single();
    expect(mirrored.error, mirrored.error?.message).toBeNull();
    const signedIn = await anonClient().auth.signInWithPassword({ email, password });
    expect(signedIn.error, signedIn.error?.message).toBeNull();
    const token = signedIn.data.session?.access_token ?? "";
    if (!id || !token) throw new Error(`failed to mint user ${suffix}`);
    return { id, token };
  }

  async function makeOrg(name: string, slug: string): Promise<string> {
    const org = await svc().from("organizations").insert({ name, slug }).select("id").single();
    expect(org.error, org.error?.message).toBeNull();
    return String(org.data?.id ?? "");
  }
  async function makeSite(org: string, name: string): Promise<string> {
    const r = await svc().from("sites").insert({ org_id: org, name, kind: "depot" }).select("id").single();
    expect(r.error, r.error?.message).toBeNull();
    return String(r.data?.id ?? "");
  }
  async function makeItem(
    org: string,
    name: string,
    cfg: { reorder_level?: number | null; target_level?: number | null; reorder_quantity?: number | null } = {},
  ): Promise<string> {
    const r = await svc()
      .from("stock_items")
      .insert({
        org_id: org,
        name,
        unit: "bag",
        reorder_level: cfg.reorder_level ?? null,
        target_level: cfg.target_level ?? null,
        reorder_quantity: cfg.reorder_quantity ?? null,
      })
      .select("id")
      .single();
    expect(r.error, r.error?.message).toBeNull();
    return String(r.data?.id ?? "");
  }
  async function seed(org: string, item: string, site: string, qty: number): Promise<void> {
    if (qty === 0) return;
    const r = await rpc(serviceClient()).rpc("record_stock_adjustment", {
      p_org_id: org,
      p_item_id: item,
      p_site_id: site,
      p_delta: qty,
      p_reason: "opening count",
    });
    expect(r.error, r.error?.message).toBeNull();
  }

  beforeAll(async () => {
    orgA = await makeOrg("Reorder A", `${TOKEN}-a`);
    orgB = await makeOrg("Reorder B", `${TOKEN}-b`);
    siteA = await makeSite(orgA, "Main yard");
    siteB = await makeSite(orgB, "Main yard");

    lowBatch = await makeItem(orgA, "Cement", { reorder_level: 20, reorder_quantity: 50, target_level: 100 });
    lowTarget = await makeItem(orgA, "Sand", { reorder_level: 20, target_level: 100 });
    atPoint = await makeItem(orgA, "Blocks", { reorder_level: 20, reorder_quantity: 200 });
    abovePoint = await makeItem(orgA, "Screws", { reorder_level: 20, reorder_quantity: 500 });
    noThreshold = await makeItem(orgA, "Ally trim", { target_level: 100 }); // no reorder_level
    noQtySource = await makeItem(orgA, "Oddment", { reorder_level: 20 }); // point but nothing to buy
    itemB = await makeItem(orgB, "Cement", { reorder_level: 20, reorder_quantity: 50 });

    // Balances: below / at / above the point.
    await seed(orgA, lowBatch, siteA, 10); // 10 <= 20 → +50 (fixed batch)
    await seed(orgA, lowTarget, siteA, 30); // wait: 30 > 20 → above; corrected below
    await seed(orgA, atPoint, siteA, 20); // exactly 20 → +200
    await seed(orgA, abovePoint, siteA, 900); // above → nothing
    await seed(orgA, noThreshold, siteA, 5); // untracked → nothing
    await seed(orgA, noQtySource, siteA, 5); // below but no qty → nothing
    await seed(orgB, itemB, siteB, 1); // org B, below → must not leak into A

    const dual = await makeUser("dual");
    dualUserId = dual.id;
    dualToken = dual.token;
    for (const org of [orgA, orgB]) {
      const m = await svc().from("memberships").insert({ org_id: org, user_id: dualUserId, role: "admin" }).select("user_id").single();
      expect(m.error, m.error?.message).toBeNull();
    }
  });

  afterAll(async () => {
    for (const id of [orgA, orgB]) if (id) await svc().from("organizations").delete().eq("id", id);
    if (dualUserId) await serviceClient().auth.admin.deleteUser(dualUserId);
  });

  const client = () => userClient(dualToken) as unknown as StockClient;

  it("fix the lowTarget seed to be genuinely below its point", async () => {
    // 30 was above 20; issue 20 to land it at 10 (below), with a target of 100.
    const r = await rpc(userClient(dualToken)).rpc("record_stock_issue", {
      p_org_id: orgA,
      p_item_id: lowTarget,
      p_site_id: siteA,
      p_qty: 20,
      p_job_id: null,
      p_material_request_line_id: null,
      p_notes: null,
    });
    expect(r.error, r.error?.message).toBeNull();
  });

  it("surfaces exactly the below-point items, with honest quantities", async () => {
    const suggestions = await loadReplenishmentSuggestions(client(), orgA);
    const byId = new Map(suggestions.map((s) => [s.itemId, s]));

    // lowBatch: 10 <= 20, fixed batch 50 wins over target shortfall (90).
    expect(byId.get(lowBatch)?.suggestedQuantity).toBe(50);
    expect(byId.get(lowBatch)?.basis).toBe("fixed_batch");
    // lowTarget: 10 <= 20, no batch → order up to 100 = 90.
    expect(byId.get(lowTarget)?.suggestedQuantity).toBe(90);
    expect(byId.get(lowTarget)?.basis).toBe("order_up_to");
    // atPoint: 20 == 20 (inclusive) → +200.
    expect(byId.get(atPoint)?.suggestedQuantity).toBe(200);

    // and NOTHING else is surfaced.
    expect(byId.has(abovePoint)).toBe(false);
    expect(byId.has(noThreshold)).toBe(false);
    expect(byId.has(noQtySource)).toBe(false);
    expect(byId.has(itemB)).toBe(false); // org B never appears in an org-A read
    expect(suggestions.map((s) => s.itemId).sort()).toEqual([lowBatch, lowTarget, atPoint].sort());
  });

  it("CROSS-ORG: a dual-org admin's org-B read shows B's item and not A's", async () => {
    const suggestionsB = await loadReplenishmentSuggestions(client(), orgB);
    const ids = suggestionsB.map((s) => s.itemId);
    expect(ids).toContain(itemB);
    for (const a of [lowBatch, lowTarget, atPoint]) expect(ids).not.toContain(a);
  });

  it("MUTATION PROOF: the underlying item read is org-pinned — unpinned it blends both", async () => {
    // If the pin inside loadStockPositions ever stopped working, org B's item
    // would appear in an org-A replenishment read. Prove the pin is load-bearing
    // at the row level the reader folds over.
    const pinned = await db(userClient(dualToken)).from("stock_items").select("id").eq("org_id", orgA);
    const unpinned = await db(userClient(dualToken)).from("stock_items").select("id");
    const pinnedIds = new Set((pinned.data ?? []).map((r) => String(r.id)));
    const unpinnedIds = new Set((unpinned.data ?? []).map((r) => String(r.id)));
    expect(pinnedIds.has(itemB), "org B item leaked into a pinned org-A read").toBe(false);
    expect(unpinnedIds.has(itemB), "the pin is load-bearing").toBe(true);
  });

  it("THE HANDOFF reuses the material-request authority — draft with the suggested line", async () => {
    const suggestions = await loadReplenishmentSuggestions(client(), orgA);
    const pick = suggestions.find((s) => s.itemId === lowBatch);
    expect(pick, "no suggestion to hand off").toBeTruthy();

    // The core's OWN statements (server/services/material-request-writes.ts):
    // allocate the per-org number, insert a BORN-DRAFT header, then the lines.
    const num = await rpc(userClient(dualToken)).rpc("next_material_request_number", { target_org: orgA });
    expect(num.error, num.error?.message).toBeNull();
    const requestId = randomUUID();
    const header = await db(userClient(dualToken))
      .from("material_requests")
      .insert({
        id: requestId,
        org_id: orgA,
        job_id: null,
        number: String(num.data),
        status: "draft",
        requested_by: dualUserId,
        priority: "normal",
        notes: "Raised from stock replenishment",
        created_by: dualUserId,
        client_write_key: randomUUID(),
      })
      .select("id")
      .single();
    expect(header.error, header.error?.message).toBeNull();

    const line = await db(userClient(dualToken)).from("material_request_lines").insert({
      org_id: orgA,
      material_request_id: requestId,
      description: pick!.name,
      qty: pick!.suggestedQuantity,
      unit: pick!.unit,
      stock_item_id: pick!.itemId,
      sort_order: 0,
    });
    expect(line.error, line.error?.message).toBeNull();

    // It lands as a DRAFT carrying the stock-item link and the suggested qty.
    const back = await svc()
      .from("material_request_lines")
      .select("qty, stock_item_id, material_request_id")
      .eq("material_request_id", requestId)
      .maybeSingle();
    expect(Number(back.data?.qty)).toBe(50);
    expect(back.data?.stock_item_id).toBe(lowBatch);
    const status = await svc().from("material_requests").select("status").eq("id", requestId).maybeSingle();
    expect(status.data?.status).toBe("draft");
  });

  it("the born-draft lifecycle rule REFUSES a bare submitted insert — authority is not bypassable", async () => {
    // The handoff must go through the born-draft path; a free insert that tries
    // to skip it (status 'submitted' with no lifecycle transition) is refused by
    // the database's own material-request authority.
    const num = await rpc(userClient(dualToken)).rpc("next_material_request_number", { target_org: orgA });
    const bare = await db(userClient(dualToken)).from("material_requests").insert({
      id: randomUUID(),
      org_id: orgA,
      number: String(num.data),
      status: "submitted", // NOT born-draft
      requested_by: dualUserId,
      priority: "normal",
      created_by: dualUserId,
      client_write_key: randomUUID(),
    });
    expect(bare.error, "a bare submitted insert bypassed the born-draft authority").not.toBeNull();
  });

  it("THE ACCOUNTING BOUNDARY: the whole flow writes NOT ONE `finances` row", async () => {
    const fin = await svc().from("finances").select("id").eq("org_id", orgA);
    expect((fin.data ?? []).length, "replenishment posted a cost — materials double-counted").toBe(0);
  });
});
