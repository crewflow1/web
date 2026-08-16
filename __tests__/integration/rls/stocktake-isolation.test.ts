import { afterAll, beforeAll, expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient, userClient } from "../_harness";

/**
 * STOCKTAKE / CYCLE-COUNT against real Postgres
 * (migrations 20261144000000 + 20261144000001, on top of the O3 stock schema).
 *
 * The behaviours proven here (the ones the task names):
 *
 *   · LIFECYCLE — open → counting → posted, with illegal transitions refused;
 *   · VARIANCE → MOVEMENT — a counted line whose count differs from its frozen
 *     snapshot posts exactly one adjustment movement, the balance moves to the
 *     counted figure, and NOT ONE `finances` row is written;
 *   · IDEMPOTENT POST — a second post of the same session is refused (it is no
 *     longer `counting`), so variances can never be posted twice;
 *   · ADMIN-ONLY POST — a plain member cannot post; an admin can;
 *   · BARCODE — a scanned code resolves to the item by barcode OR sku, and a
 *     duplicate barcode in the same org is refused;
 *   · ORG ISOLATION — a dual-org member working in A cannot open/post a count in
 *     B even with a crafted org id, and the snapshot only sees A's items.
 */

type Res<T> = { data: T | null; error: { message: string; code?: string } | null };
type Row = Record<string, unknown>;
interface Sel extends PromiseLike<Res<Row[]>> {
  select(columns?: string): Sel;
  eq(column: string, value: unknown): Sel;
  or(filter: string): Sel;
  order(column: string, opts: { ascending: boolean }): Sel;
  limit(n: number): Sel;
  maybeSingle(): PromiseLike<Res<Row>>;
}
interface Ins extends PromiseLike<Res<Row[]>> {
  select(columns?: string): { single(): PromiseLike<Res<Row>> };
}
interface Table {
  select(columns?: string): Sel;
  insert(rows: Row | Row[]): Ins;
}
const db = (client: unknown) => client as unknown as { from(t: string): Table };
const rpc = (client: unknown) =>
  client as unknown as {
    rpc(fn: string, args: Record<string, unknown>): PromiseLike<Res<unknown>>;
  };

const TOKEN = `it-stocktake-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describeIntegration("stocktake · lifecycle, variance→movement, idempotency, barcode, isolation", () => {
  let orgA = "";
  let orgB = "";
  let siteA = "";
  let siteB = "";
  let itemA = "";
  let dualId = "";
  let dualToken = "";
  let memberToken = "";

  const svc = () => db(serviceClient());

  const balance = async (org: string, item: string, site: string): Promise<number> => {
    const r = await rpc(serviceClient()).rpc("stock_balance", {
      p_org_id: org,
      p_item_id: item,
      p_site_id: site,
    });
    return Number(r.data ?? 0);
  };

  async function makeUser(suffix: string): Promise<{ id: string; token: string }> {
    const email = `${TOKEN}-${suffix}@example.test`;
    const password = `Pw-${TOKEN}-${suffix}-${Math.random().toString(36).slice(2)}`;
    const created = await serviceClient().auth.admin.createUser({ email, password, email_confirm: true });
    expect(created.error, created.error?.message).toBeNull();
    const id = created.data.user?.id ?? "";
    const mirrored = await svc().from("users").insert({ id, email, full_name: `Stocktake ${suffix}` }).select("id").single();
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
  async function makeItem(org: string, name: string, extra: Row = {}): Promise<string> {
    const r = await svc().from("stock_items").insert({ org_id: org, name, unit: "ea", ...extra }).select("id").single();
    expect(r.error, r.error?.message).toBeNull();
    return String(r.data?.id ?? "");
  }
  // Seed a starting balance through the ledger's own adjustment path (service
  // role bypasses the admin gate — it is trusted server-side code, not a tenant).
  async function seedBalance(org: string, item: string, site: string, qty: number): Promise<void> {
    const r = await rpc(serviceClient()).rpc("record_stock_adjustment", {
      p_org_id: org,
      p_item_id: item,
      p_site_id: site,
      p_delta: qty,
      p_reason: "seed opening count",
    });
    expect(r.error, r.error?.message).toBeNull();
  }

  beforeAll(async () => {
    orgA = await makeOrg("Stocktake A", `${TOKEN}-a`);
    orgB = await makeOrg("Stocktake B", `${TOKEN}-b`);
    siteA = await makeSite(orgA, "Main yard");
    siteB = await makeSite(orgB, "Main yard");
    itemA = await makeItem(orgA, "Blocks 100mm", { barcode: "5012345678900", sku: "BLK-100" });
    await makeItem(orgB, "Blocks 100mm"); // B's own item, must never appear in A's snapshot

    const dual = await makeUser("dual");
    dualId = dual.id;
    dualToken = dual.token;
    const member = await makeUser("member");
    memberToken = member.token;

    for (const org of [orgA, orgB]) {
      const m = await svc().from("memberships").insert({ org_id: org, user_id: dualId, role: "admin" }).select("user_id").single();
      expect(m.error, m.error?.message).toBeNull();
    }
    const mm = await svc().from("memberships").insert({ org_id: orgA, user_id: member.id, role: "staff" }).select("user_id").single();
    expect(mm.error, mm.error?.message).toBeNull();

    // Expected balance of 40 at site A.
    await seedBalance(orgA, itemA, siteA, 40);
  });

  afterAll(async () => {
    for (const org of [orgA, orgB]) {
      if (org) await serviceClient().from("organizations").delete().eq("id", org);
    }
  });

  it("opens a session, freezes expected quantities, and only snapshots the active org's items", async () => {
    const opened = await rpc(userClient(dualToken)).rpc("open_stocktake_session", {
      p_org_id: orgA,
      p_site_id: siteA,
      p_reference: "Q3 yard",
      p_notes: null,
    });
    expect(opened.error, opened.error?.message).toBeNull();
    const session = String(opened.data);

    const lines = await svc().from("stocktake_lines").select("stock_item_id, expected_qty").eq("session_id", session);
    expect(lines.error).toBeNull();
    const rows = lines.data ?? [];
    // Only org A's item, and its expected is the frozen ledger balance (40).
    expect(rows.every((r) => r.stock_item_id === itemA)).toBe(true);
    expect(Number(rows.find((r) => r.stock_item_id === itemA)?.expected_qty)).toBe(40);
  });

  it("runs the full lifecycle and posts a variance as ONE adjustment movement", async () => {
    const opened = await rpc(userClient(dualToken)).rpc("open_stocktake_session", {
      p_org_id: orgA,
      p_site_id: siteA,
      p_reference: "count-1",
      p_notes: null,
    });
    const session = String(opened.data);

    // Counting is refused before the session is moved to `counting`.
    const early = await rpc(userClient(dualToken)).rpc("record_stocktake_count", {
      p_org_id: orgA,
      p_session_id: session,
      p_stock_item_id: itemA,
      p_counted_qty: 37,
    });
    expect(early.error?.message).toMatch(/not open for counting/i);

    const started = await rpc(userClient(dualToken)).rpc("start_stocktake_counting", {
      p_org_id: orgA,
      p_session_id: session,
    });
    expect(started.error, started.error?.message).toBeNull();

    // Counted 37 against an expected 40 → variance −3.
    const counted = await rpc(userClient(dualToken)).rpc("record_stocktake_count", {
      p_org_id: orgA,
      p_session_id: session,
      p_stock_item_id: itemA,
      p_counted_qty: 37,
    });
    expect(counted.error, counted.error?.message).toBeNull();

    const before = await balance(orgA, itemA, siteA);
    const financesBefore = await svc().from("finances").select("id").eq("org_id", orgA);

    const posted = await rpc(userClient(dualToken)).rpc("post_stocktake_session", {
      p_org_id: orgA,
      p_session_id: session,
    });
    expect(posted.error, posted.error?.message).toBeNull();
    expect(Number(posted.data)).toBe(1); // one variance posted

    // The balance moved to the counted figure.
    expect(await balance(orgA, itemA, siteA)).toBe(before - 3);

    // Exactly one adjustment movement, linked back onto the line.
    const line = await svc()
      .from("stocktake_lines")
      .select("posted_movement_id, posted_variance")
      .eq("session_id", session)
      .eq("stock_item_id", itemA)
      .maybeSingle();
    expect(line.error).toBeNull();
    expect(line.data?.posted_movement_id).toBeTruthy();
    expect(Number(line.data?.posted_variance)).toBe(-3);

    const mv = await svc()
      .from("stock_movements")
      .select("movement_type, qty")
      .eq("id", String(line.data?.posted_movement_id))
      .maybeSingle();
    expect(mv.data?.movement_type).toBe("adjustment_out");
    expect(Number(mv.data?.qty)).toBe(3);

    // THE ACCOUNTING BOUNDARY: posting a variance wrote NOT ONE finances row.
    const financesAfter = await svc().from("finances").select("id").eq("org_id", orgA);
    expect((financesAfter.data ?? []).length).toBe((financesBefore.data ?? []).length);

    // The session is now posted.
    const s = await svc().from("stocktake_sessions").select("status").eq("id", session).maybeSingle();
    expect(s.data?.status).toBe("posted");

    // IDEMPOTENT: a second post is refused — it is no longer counting.
    const again = await rpc(userClient(dualToken)).rpc("post_stocktake_session", {
      p_org_id: orgA,
      p_session_id: session,
    });
    expect(again.error?.message).toMatch(/cannot be posted|is final/i);
  });

  it("refuses posting to a plain member (admin-only)", async () => {
    const opened = await rpc(userClient(dualToken)).rpc("open_stocktake_session", {
      p_org_id: orgA,
      p_site_id: siteA,
      p_reference: "count-member",
      p_notes: null,
    });
    const session = String(opened.data);
    await rpc(userClient(dualToken)).rpc("start_stocktake_counting", { p_org_id: orgA, p_session_id: session });
    await rpc(userClient(dualToken)).rpc("record_stocktake_count", {
      p_org_id: orgA,
      p_session_id: session,
      p_stock_item_id: itemA,
      p_counted_qty: 10,
    });
    const posted = await rpc(userClient(memberToken)).rpc("post_stocktake_session", {
      p_org_id: orgA,
      p_session_id: session,
    });
    expect(posted.error?.message).toMatch(/owner or admin/i);
  });

  it("resolves a scanned code by barcode OR sku, and refuses a duplicate barcode", async () => {
    const byBarcode = await svc()
      .from("stock_items")
      .select("id")
      .eq("org_id", orgA)
      .or("barcode.ilike.5012345678900,sku.ilike.5012345678900")
      .limit(1);
    expect((byBarcode.data ?? [])[0]?.id).toBe(itemA);

    const bySku = await svc()
      .from("stock_items")
      .select("id")
      .eq("org_id", orgA)
      .or("barcode.ilike.blk-100,sku.ilike.blk-100")
      .limit(1);
    expect((bySku.data ?? [])[0]?.id).toBe(itemA);

    // A second item cannot claim the same barcode (case-insensitively).
    const dup = await svc()
      .from("stock_items")
      .insert({ org_id: orgA, name: "Dupe", unit: "ea", barcode: "5012345678900" })
      .select("id")
      .single();
    expect(dup.error?.message).toMatch(/duplicate key|stock_items_org_barcode_unique/i);
  });

  it("refuses a cross-org count: working in A cannot open or reach B", async () => {
    // A dual-org member working in A tries to count B's site — refused.
    const crossSite = await rpc(userClient(dualToken)).rpc("open_stocktake_session", {
      p_org_id: orgA,
      p_site_id: siteB,
      p_reference: "leak",
      p_notes: null,
    });
    expect(crossSite.error?.message).toMatch(/site not found/i);

    // A session opened in B cannot be posted while claiming org A.
    const inB = await rpc(userClient(dualToken)).rpc("open_stocktake_session", {
      p_org_id: orgB,
      p_site_id: siteB,
      p_reference: "b-count",
      p_notes: null,
    });
    expect(inB.error, inB.error?.message).toBeNull();
    const crossPost = await rpc(userClient(dualToken)).rpc("post_stocktake_session", {
      p_org_id: orgA,
      p_session_id: String(inB.data),
    });
    expect(crossPost.error?.message).toMatch(/stocktake not found/i);
  });
});
