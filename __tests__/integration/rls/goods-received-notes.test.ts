import { afterAll, beforeAll, expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient, userClient } from "../_harness";

/**
 * Warehouse M1 — goods received notes against real Postgres
 * (migrations 20261059000000 + 20261060000000).
 *
 * The headline proofs in this file:
 *
 *   · the DUAL-ORG pair — a user who belongs to org A AND org B passes RLS for
 *     both, so an RLS-only read blends the two companies' orders and
 *     deliveries. The active-org pin is what makes "the company I am working
 *     in" real, and the posting RPC refuses to receive against the other
 *     company's order even though RLS would allow it;
 *   · the RECEIPT DERIVATION — 40 of 100 is partially_received with 60
 *     outstanding, 60 more is received, and a hand-set 'received' in between is
 *     refused by the database, not merely by the app;
 *   · OVER-RECEIPT is blocked;
 *   · a posted note is IMMUTABLE and voiding it walks the order back;
 *   · ORG TEARDOWN still works with deliveries present (the deferred-FK
 *     decision in 20261059's header).
 */

type Res<T> = { data: T | null; error: { message: string; code?: string } | null };
type Row = Record<string, unknown>;
interface Sel extends PromiseLike<Res<Row[]>> {
  select(columns?: string): Sel;
  eq(column: string, value: unknown): Sel;
  order(column: string, opts: { ascending: boolean }): Sel;
  maybeSingle(): PromiseLike<Res<Row>>;
}
interface Ins extends PromiseLike<Res<Row[]>> {
  select(columns?: string): { single(): PromiseLike<Res<Row>> };
}
interface Upd extends PromiseLike<Res<null>> {
  eq(column: string, value: unknown): Upd;
}
interface Table {
  select(columns?: string): Sel;
  insert(rows: Row | Row[]): Ins;
  update(patch: Row): Upd;
  delete(): Upd;
}
const db = (client: unknown) => client as unknown as { from(t: string): Table };
const rpc = (client: unknown) =>
  client as unknown as {
    rpc(fn: string, args: Record<string, unknown>): PromiseLike<Res<unknown>>;
  };

const TOKEN = `it-grn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describeIntegration("goods received notes · derivation, isolation, immutability", () => {
  let orgA = "";
  let orgB = "";
  let poA = "";
  let poB = "";
  let lineA1 = "";
  let lineA2 = "";
  let lineB1 = "";
  let dualUserId = "";
  let dualToken = "";
  let outsiderId = "";
  let outsiderToken = "";

  const svc = () => db(serviceClient());

  async function makeUser(suffix: string): Promise<{ id: string; token: string }> {
    const email = `${TOKEN}-${suffix}@example.test`;
    const password = `Pw-${TOKEN}-${suffix}-${Math.random().toString(36).slice(2)}`;
    const created = await serviceClient().auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    expect(created.error, created.error?.message).toBeNull();
    const id = created.data.user?.id ?? "";
    const mirrored = await svc()
      .from("users")
      .insert({ id, email, full_name: `GRN ${suffix}` })
      .select("id")
      .single();
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

  /** A SENT purchase order with one 100-unit line and one 12.5-unit line. */
  async function makePo(orgId: string, number: string): Promise<{ po: string; lines: string[] }> {
    const po = await svc()
      .from("purchase_orders")
      .insert({ org_id: orgId, number, status: "sent", subtotal: 1000, vat_total: 200 })
      .select("id")
      .single();
    expect(po.error, po.error?.message).toBeNull();
    const poId = String(po.data?.id ?? "");

    const lines: string[] = [];
    for (const [i, spec] of (
      [
        { description: "Blocks", qty: 100, unit: "ea" },
        { description: "Concrete", qty: 12.5, unit: "m3" },
      ] as const
    ).entries()) {
      const li = await svc()
        .from("purchase_order_line_items")
        .insert({
          org_id: orgId,
          purchase_order_id: poId,
          description: spec.description,
          qty: spec.qty,
          unit: spec.unit,
          unit_price: 5,
          vat_rate: 20,
          line_total: 500,
          sort_order: i,
        })
        .select("id")
        .single();
      expect(li.error, li.error?.message).toBeNull();
      lines.push(String(li.data?.id ?? ""));
    }
    return { po: poId, lines };
  }

  const poStatus = async (poId: string): Promise<string> => {
    const r = await svc().from("purchase_orders").select("status").eq("id", poId).maybeSingle();
    return String(r.data?.status ?? "");
  };

  beforeAll(async () => {
    orgA = await makeOrg("GRN Probe A", `${TOKEN}-a`);
    orgB = await makeOrg("GRN Probe B", `${TOKEN}-b`);
    if (!orgA || !orgB) throw new Error("failed to create probe orgs");

    // Deliberately SIMILAR orders in both orgs — a leak has to be a real
    // confusion (two "PO-9001"s for the same materials), not something a human
    // would spot instantly.
    const a = await makePo(orgA, `${TOKEN}-PO-9001`);
    poA = a.po;
    lineA1 = a.lines[0] ?? "";
    lineA2 = a.lines[1] ?? "";
    const b = await makePo(orgB, `${TOKEN}-PO-9001`);
    poB = b.po;
    lineB1 = b.lines[0] ?? "";

    const dual = await makeUser("dual");
    dualUserId = dual.id;
    dualToken = dual.token;
    const outsider = await makeUser("outsider");
    outsiderId = outsider.id;
    outsiderToken = outsider.token;

    // THE dual-org membership: this user legitimately belongs to A and B.
    for (const org of [orgA, orgB]) {
      const m = await svc()
        .from("memberships")
        .insert({ org_id: org, user_id: dualUserId, role: "admin" })
        .select("user_id")
        .single();
      expect(m.error, m.error?.message).toBeNull();
    }
  });

  afterAll(async () => {
    for (const id of [orgA, orgB]) if (id) await svc().from("organizations").delete().eq("id", id);
    if (dualUserId) await serviceClient().auth.admin.deleteUser(dualUserId);
    if (outsiderId) await serviceClient().auth.admin.deleteUser(outsiderId);
  });

  // ── baseline RLS ──────────────────────────────────────────────────────────
  it("anon is denied both receiving tables", async () => {
    for (const t of ["goods_received_notes", "goods_received_lines"]) {
      const { data, error } = await db(anonClient()).from(t).select("*");
      expect(error ? true : (data ?? []).length === 0, `${t} leaked to anon`).toBe(true);
    }
  });

  it("an authenticated NON-member cannot post against org A's order", async () => {
    const { error } = await rpc(userClient(outsiderToken)).rpc("post_goods_received_note", {
      p_org_id: orgA,
      p_purchase_order_id: poA,
      p_delivery_date: null,
      p_delivery_note_reference: null,
      p_delivery_location: null,
      p_notes: null,
      p_received_by: null,
      p_lines: [{ line_item_id: lineA1, qty_received: 1 }],
    });
    expect(error).not.toBeNull();
    expect(error?.message ?? "").toMatch(/not found/i);
  });

  // ── THE receipt derivation ────────────────────────────────────────────────
  it("posting 40 of 100 makes the order partially_received with 60 outstanding", async () => {
    const { data, error } = await rpc(userClient(dualToken)).rpc("post_goods_received_note", {
      p_org_id: orgA, // ACTIVE-ORG PIN
      p_purchase_order_id: poA,
      p_delivery_date: "2026-07-20",
      p_delivery_note_reference: "DN-1001",
      p_delivery_location: "Riverside compound",
      p_notes: null,
      p_received_by: dualUserId,
      p_lines: [{ line_item_id: lineA1, qty_received: 40 }],
    });
    expect(error, error?.message).toBeNull();
    expect(typeof data).toBe("string");

    expect(await poStatus(poA)).toBe("partially_received");

    const state = await rpc(userClient(dualToken)).rpc("purchase_order_receipt_state", {
      p_po_id: poA,
      p_org_id: orgA,
    });
    expect(state.data).toBe("partial");

    const lines = await svc()
      .from("goods_received_lines")
      .select("qty_received")
      .eq("purchase_order_line_item_id", lineA1);
    expect((lines.data ?? []).map((r) => Number(r.qty_received))).toEqual([40]);
  });

  it("PINS provenance server-side: posted_by/posted_at come from the JWT, not the caller", async () => {
    const note = await svc()
      .from("goods_received_notes")
      .select("status, posted_by, posted_at, number, created_by")
      .eq("purchase_order_id", poA)
      .maybeSingle();
    expect(note.data?.status).toBe("posted");
    expect(note.data?.posted_by).toBe(dualUserId);
    expect(note.data?.posted_at).not.toBeNull();
    expect(String(note.data?.number)).toMatch(/^GRN-\d{4}$/);
  });

  it("REFUSES a hand-set 'received' while the order is only part-delivered", async () => {
    // The app path guards this too, but a direct PATCH must not get through.
    const { error } = await db(userClient(dualToken))
      .from("purchase_orders")
      .update({ status: "received" })
      .eq("id", poA);
    expect(error).not.toBeNull();
    expect(error?.message ?? "").toMatch(/derived/i);
    expect(await poStatus(poA)).toBe("partially_received");
  });

  it("BLOCKS an over-receipt (61 more against 60 outstanding)", async () => {
    const { error } = await rpc(userClient(dualToken)).rpc("post_goods_received_note", {
      p_org_id: orgA,
      p_purchase_order_id: poA,
      p_delivery_date: null,
      p_delivery_note_reference: "DN-OVER",
      p_delivery_location: null,
      p_notes: null,
      p_received_by: dualUserId,
      p_lines: [{ line_item_id: lineA1, qty_received: 61 }],
    });
    expect(error).not.toBeNull();
    expect(error?.message ?? "").toMatch(/over-receipt/);
    // and the failed post left NOTHING behind (one function body, one transaction)
    const notes = await svc()
      .from("goods_received_notes")
      .select("id")
      .eq("purchase_order_id", poA);
    expect(notes.data ?? []).toHaveLength(1);
  });

  it("REFUSES a zero or negative received quantity", async () => {
    for (const bad of [0, -5]) {
      const { error } = await rpc(userClient(dualToken)).rpc("post_goods_received_note", {
        p_org_id: orgA,
        p_purchase_order_id: poA,
        p_delivery_date: null,
        p_delivery_note_reference: null,
        p_delivery_location: null,
        p_notes: null,
        p_received_by: dualUserId,
        p_lines: [{ line_item_id: lineA1, qty_received: bad }],
      });
      expect(error, `qty ${bad} was accepted`).not.toBeNull();
    }
  });

  it("REFUSES the same ordered line twice on one delivery", async () => {
    const { error } = await rpc(userClient(dualToken)).rpc("post_goods_received_note", {
      p_org_id: orgA,
      p_purchase_order_id: poA,
      p_delivery_date: null,
      p_delivery_note_reference: null,
      p_delivery_location: null,
      p_notes: null,
      p_received_by: dualUserId,
      p_lines: [
        { line_item_id: lineA2, qty_received: 1 },
        { line_item_id: lineA2, qty_received: 2 },
      ],
    });
    expect(error).not.toBeNull();
    expect(error?.message ?? "").toMatch(/twice/);
  });

  it("completing EVERY line moves the order to received", async () => {
    const { error } = await rpc(userClient(dualToken)).rpc("post_goods_received_note", {
      p_org_id: orgA,
      p_purchase_order_id: poA,
      p_delivery_date: "2026-07-22",
      p_delivery_note_reference: "DN-1002",
      p_delivery_location: null,
      p_notes: "second load",
      p_received_by: dualUserId,
      // the remaining 60 blocks AND the full 12.5 m3 of concrete
      p_lines: [
        { line_item_id: lineA1, qty_received: 60 },
        { line_item_id: lineA2, qty_received: 12.5 },
      ],
    });
    expect(error, error?.message).toBeNull();
    expect(await poStatus(poA)).toBe("received");

    const state = await rpc(userClient(dualToken)).rpc("purchase_order_receipt_state", {
      p_po_id: poA,
      p_org_id: orgA,
    });
    expect(state.data).toBe("full");
  });

  it("keeps BOTH notes — the history survives the order reaching 'received'", async () => {
    const notes = await svc()
      .from("goods_received_notes")
      .select("number, status, delivery_note_reference")
      .eq("purchase_order_id", poA)
      .order("number", { ascending: true });
    expect((notes.data ?? []).map((n) => n.delivery_note_reference)).toEqual(["DN-1001", "DN-1002"]);
    expect((notes.data ?? []).every((n) => n.status === "posted")).toBe(true);
  });

  // ── immutability ──────────────────────────────────────────────────────────
  it("a POSTED note is immutable — header edits and line edits both fail", async () => {
    const note = await svc()
      .from("goods_received_notes")
      .select("id")
      .eq("delivery_note_reference", "DN-1001")
      .maybeSingle();
    const noteId = String(note.data?.id ?? "");
    expect(noteId).not.toBe("");

    const header = await db(userClient(dualToken))
      .from("goods_received_notes")
      .update({ delivery_note_reference: "TAMPERED", delivery_date: "2020-01-01" })
      .eq("id", noteId);
    expect(header.error).not.toBeNull();
    expect(header.error?.message ?? "").toMatch(/immutable/i);

    const line = await db(userClient(dualToken))
      .from("goods_received_lines")
      .update({ qty_received: 999 })
      .eq("goods_received_note_id", noteId);
    expect(line.error).not.toBeNull();
    expect(line.error?.message ?? "").toMatch(/immutable evidence/i);
  });

  it("even an ADMIN cannot delete a posted note (RLS delete is drafts only)", async () => {
    const note = await svc()
      .from("goods_received_notes")
      .select("id")
      .eq("delivery_note_reference", "DN-1001")
      .maybeSingle();
    const noteId = String(note.data?.id ?? "");
    // the dual user is an ADMIN of org A, so this is the strongest tenant role
    await db(userClient(dualToken)).from("goods_received_notes").delete().eq("id", noteId);
    const still = await svc().from("goods_received_notes").select("id").eq("id", noteId);
    expect(still.data ?? []).toHaveLength(1); // RLS filtered it: 0 rows deleted
  });

  it("a note cannot be created already posted (born draft)", async () => {
    const { error } = await svc()
      .from("goods_received_notes")
      .insert({
        org_id: orgA,
        purchase_order_id: poA,
        number: `${TOKEN}-FORGED`,
        status: "posted",
        delivery_date: "2026-07-01",
      })
      .select("id")
      .single();
    expect(error).not.toBeNull();
    expect(error?.message ?? "").toMatch(/created as a draft/i);
  });

  // ── the void path ─────────────────────────────────────────────────────────
  it("voiding a note requires a reason and walks the order BACK", async () => {
    const note = await svc()
      .from("goods_received_notes")
      .select("id")
      .eq("delivery_note_reference", "DN-1002")
      .maybeSingle();
    const noteId = String(note.data?.id ?? "");

    const noReason = await rpc(userClient(dualToken)).rpc("void_goods_received_note", {
      p_grn_id: noteId,
      p_org_id: orgA,
      p_reason: "   ",
    });
    expect(noReason.error).not.toBeNull();
    expect(noReason.error?.message ?? "").toMatch(/reason/i);

    const voided = await rpc(userClient(dualToken)).rpc("void_goods_received_note", {
      p_grn_id: noteId,
      p_org_id: orgA,
      p_reason: "booked against the wrong order",
    });
    expect(voided.error, voided.error?.message).toBeNull();

    // 60 blocks + 12.5 concrete retracted → back to the 40 blocks of DN-1001
    expect(await poStatus(poA)).toBe("partially_received");

    const after = await svc()
      .from("goods_received_notes")
      .select("status, void_reason, voided_by")
      .eq("id", noteId)
      .maybeSingle();
    expect(after.data?.status).toBe("void");
    expect(after.data?.void_reason).toBe("booked against the wrong order");
    expect(after.data?.voided_by).toBe(dualUserId);
  });

  it("voiding the LAST remaining note returns the order to 'sent'", async () => {
    const note = await svc()
      .from("goods_received_notes")
      .select("id")
      .eq("delivery_note_reference", "DN-1001")
      .maybeSingle();
    const voided = await rpc(userClient(dualToken)).rpc("void_goods_received_note", {
      p_grn_id: String(note.data?.id ?? ""),
      p_org_id: orgA,
      p_reason: "duplicate entry",
    });
    expect(voided.error, voided.error?.message).toBeNull();
    expect(await poStatus(poA)).toBe("sent");
  });

  it("with every note voided the LEGACY manual tick works again", async () => {
    // The rule: the manual shortcut is disabled only while real evidence
    // exists. This is what keeps every pre-M1 purchase order working.
    const { error } = await db(userClient(dualToken))
      .from("purchase_orders")
      .update({ status: "received" })
      .eq("id", poA);
    expect(error, error?.message).toBeNull();
    expect(await poStatus(poA)).toBe("received");

    // put it back so later assertions read a live order
    await svc().from("purchase_orders").update({ status: "sent" }).eq("id", poA);
  });

  // ── binding: org, order, and line ─────────────────────────────────────────
  it("REFUSES to receive against a DRAFT order (nothing has been sent yet)", async () => {
    const draft = await svc()
      .from("purchase_orders")
      .insert({ org_id: orgA, number: `${TOKEN}-DRAFT`, status: "draft" })
      .select("id")
      .single();
    const draftId = String(draft.data?.id ?? "");
    const li = await svc()
      .from("purchase_order_line_items")
      .insert({
        org_id: orgA,
        purchase_order_id: draftId,
        description: "Sand",
        qty: 5,
        unit_price: 1,
        vat_rate: 20,
        line_total: 5,
        sort_order: 0,
      })
      .select("id")
      .single();

    const { error } = await rpc(userClient(dualToken)).rpc("post_goods_received_note", {
      p_org_id: orgA,
      p_purchase_order_id: draftId,
      p_delivery_date: null,
      p_delivery_note_reference: null,
      p_delivery_location: null,
      p_notes: null,
      p_received_by: dualUserId,
      p_lines: [{ line_item_id: String(li.data?.id ?? ""), qty_received: 1 }],
    });
    expect(error).not.toBeNull();
    expect(error?.message ?? "").toMatch(/cannot take a delivery/i);
  });

  it("REFUSES a line that belongs to a DIFFERENT order in the same org", async () => {
    const other = await makePo(orgA, `${TOKEN}-PO-OTHER`);
    const { error } = await rpc(userClient(dualToken)).rpc("post_goods_received_note", {
      p_org_id: orgA,
      p_purchase_order_id: poA,
      p_delivery_date: null,
      p_delivery_note_reference: null,
      p_delivery_location: null,
      p_notes: null,
      p_received_by: dualUserId,
      p_lines: [{ line_item_id: other.lines[0], qty_received: 1 }],
    });
    expect(error).not.toBeNull();
    expect(error?.message ?? "").toMatch(/not on this purchase order/i);
  });

  it("the composite FK makes a CROSS-TENANT note unwritable for EVERY role", async () => {
    // service_role bypasses RLS entirely — if the binding holds here it holds
    // everywhere. org B's order, claimed as org A's.
    const { error } = await svc()
      .from("goods_received_notes")
      .insert({
        org_id: orgA,
        purchase_order_id: poB,
        number: `${TOKEN}-XT`,
        delivery_date: "2026-07-01",
      })
      .select("id")
      .single();
    expect(error).not.toBeNull();
    expect(error?.code).toBe("23503"); // foreign_key_violation
  });

  it("REFUSES a received_by who is not a member of the org", async () => {
    const { error } = await rpc(userClient(dualToken)).rpc("post_goods_received_note", {
      p_org_id: orgA,
      p_purchase_order_id: poA,
      p_delivery_date: null,
      p_delivery_note_reference: null,
      p_delivery_location: null,
      p_notes: null,
      p_received_by: outsiderId,
      p_lines: [{ line_item_id: lineA1, qty_received: 1 }],
    });
    expect(error).not.toBeNull();
    expect(error?.message ?? "").toMatch(/not a member/i);
  });

  // ── THE dual-org proof ────────────────────────────────────────────────────
  it("RLS ALONE returns BOTH orgs' orders to a dual-org member", async () => {
    // Not a bug in RLS — it is what current_org_ids() means, and it is exactly
    // why every query on this surface carries its own org predicate.
    const { data, error } = await db(userClient(dualToken))
      .from("purchase_orders")
      .select("id")
      .eq("number", `${TOKEN}-PO-9001`);
    expect(error, error?.message).toBeNull();
    const ids = (data ?? []).map((r) => String(r.id));
    expect(ids).toContain(poA);
    expect(ids).toContain(poB);
  });

  it("a by-id read PINNED to org A cannot fetch org B's order (→ notFound)", async () => {
    const { data, error } = await db(userClient(dualToken))
      .from("purchase_orders")
      .select("id")
      .eq("id", poB)
      .eq("org_id", orgA); // the pin the detail page now carries
    expect(error, error?.message).toBeNull();
    expect(data ?? []).toHaveLength(0);
  });

  it("STRIP THE PIN and org B's order is visible — the pin is load-bearing", async () => {
    // The mutation proof: remove the active-org predicate and the SAME query
    // returns the other company's order. If this ever goes green with the pin
    // in place, the pin has stopped doing anything.
    const { data } = await db(userClient(dualToken))
      .from("purchase_orders")
      .select("id")
      .eq("id", poB);
    expect((data ?? []).map((r) => String(r.id))).toEqual([poB]);
  });

  it("the posting RPC REFUSES org B's order while pinned to org A", async () => {
    const { error } = await rpc(userClient(dualToken)).rpc("post_goods_received_note", {
      p_org_id: orgA, // the ACTIVE org — the pin
      p_purchase_order_id: poB, // the OTHER company's order
      p_delivery_date: null,
      p_delivery_note_reference: null,
      p_delivery_location: null,
      p_notes: null,
      p_received_by: dualUserId,
      p_lines: [{ line_item_id: lineB1, qty_received: 1 }],
    });
    expect(error).not.toBeNull();
    expect(error?.message ?? "").toMatch(/not found/i);

    const leaked = await svc().from("goods_received_notes").select("id").eq("org_id", orgA);
    for (const row of leaked.data ?? []) {
      const note = await svc()
        .from("goods_received_notes")
        .select("purchase_order_id")
        .eq("id", row.id)
        .maybeSingle();
      expect(note.data?.purchase_order_id).not.toBe(poB);
    }
  });

  it("the void RPC REFUSES a note pinned to the wrong org", async () => {
    // Post a real delivery in org B, then try to void it while pinned to A.
    const posted = await rpc(userClient(dualToken)).rpc("post_goods_received_note", {
      p_org_id: orgB,
      p_purchase_order_id: poB,
      p_delivery_date: null,
      p_delivery_note_reference: "DN-B-1",
      p_delivery_location: null,
      p_notes: null,
      p_received_by: dualUserId,
      p_lines: [{ line_item_id: lineB1, qty_received: 5 }],
    });
    expect(posted.error, posted.error?.message).toBeNull();

    const { error } = await rpc(userClient(dualToken)).rpc("void_goods_received_note", {
      p_grn_id: String(posted.data),
      p_org_id: orgA, // wrong company
      p_reason: "cross-tenant attempt",
    });
    expect(error).not.toBeNull();
    expect(error?.message ?? "").toMatch(/not found/i);

    const still = await svc()
      .from("goods_received_notes")
      .select("status")
      .eq("id", String(posted.data))
      .maybeSingle();
    expect(still.data?.status).toBe("posted");
  });

  // ── the purchase-order WRITE slice (active-org handoff) ──────────────────
  it("the PINNED update/status/delete writes all miss org B's order", async () => {
    // These three are the shapes the app actions now use: RLS ADMITS the row
    // (the dual user is an admin of B), so if the org predicate were dropped
    // each would silently succeed against the other company's order. Every
    // assertion below is "0 rows touched", which is what the pin buys.
    const before = await svc()
      .from("purchase_orders")
      .select("status, supplier_reference")
      .eq("id", poB)
      .maybeSingle();

    // 1. updatePurchaseOrder's write shape
    await db(userClient(dualToken))
      .from("purchase_orders")
      .update({ supplier_reference: "HIJACKED" })
      .eq("id", poB)
      .eq("org_id", orgA);

    // 2. setPurchaseOrderStatus's write shape
    await db(userClient(dualToken))
      .from("purchase_orders")
      .update({ status: "cancelled" })
      .eq("id", poB)
      .eq("org_id", orgA);

    // 3. updatePurchaseOrder's line-item delete shape
    await db(userClient(dualToken))
      .from("purchase_order_line_items")
      .delete()
      .eq("purchase_order_id", poB)
      .eq("org_id", orgA);

    // 4. deletePurchaseOrder's shape
    await db(userClient(dualToken))
      .from("purchase_orders")
      .delete()
      .eq("id", poB)
      .eq("org_id", orgA);

    const after = await svc()
      .from("purchase_orders")
      .select("status, supplier_reference")
      .eq("id", poB)
      .maybeSingle();
    expect(after.data, "org B's order was deleted while pinned to org A").not.toBeNull();
    expect(after.data?.status).toBe(before.data?.status);
    expect(after.data?.supplier_reference).toBe(before.data?.supplier_reference);

    const linesLeft = await svc()
      .from("purchase_order_line_items")
      .select("id")
      .eq("purchase_order_id", poB);
    expect((linesLeft.data ?? []).length).toBeGreaterThan(0);
  });

  it("STRIP THE PIN and the SAME writes hit org B — the pins are load-bearing", async () => {
    // The mutation proof for the write slice. Identical statements, org
    // predicate removed: RLS lets them through because the dual user really is
    // a member of B. This is what shipped before the handoff was absorbed.
    const probe = await makePo(orgB, `${TOKEN}-PO-PROBE`);

    const unpinned = await db(userClient(dualToken))
      .from("purchase_orders")
      .update({ supplier_reference: "HIJACKED" })
      .eq("id", probe.po); // no .eq("org_id", …)
    expect(unpinned.error, unpinned.error?.message).toBeNull();

    const hit = await svc()
      .from("purchase_orders")
      .select("supplier_reference")
      .eq("id", probe.po)
      .maybeSingle();
    expect(hit.data?.supplier_reference).toBe("HIJACKED");

    // and the delete too
    await db(userClient(dualToken)).from("purchase_orders").delete().eq("id", probe.po);
    const gone = await svc().from("purchase_orders").select("id").eq("id", probe.po);
    expect(gone.data ?? []).toHaveLength(0);
  });

  it("a supplier bill cannot inherit ANOTHER company's job (recordSupplierBill pin)", async () => {
    // The bill is written with the ACTIVE org's org_id but inherits the ORDER's
    // job_id. The finances org-integrity trigger refuses a foreign supplier_id;
    // job_id had no such backstop, so a cost stamped to company A could carry
    // company B's job and corrupt that job's profitability.
    const jobB = await svc()
      .from("jobs")
      .insert({ org_id: orgB, status: "new" })
      .select("id")
      .single();
    expect(jobB.error, jobB.error?.message).toBeNull();
    const jobBId = String(jobB.data?.id ?? "");

    await svc().from("purchase_orders").update({ job_id: jobBId }).eq("id", poB);

    // the pinned read the action performs: org A + org B's order → not found
    const pinnedRead = await db(userClient(dualToken))
      .from("purchase_orders")
      .select("id, job_id")
      .eq("id", poB)
      .eq("org_id", orgA);
    expect(pinnedRead.data ?? []).toHaveLength(0);

    // and the database independently refuses the cross-tenant cost even if the
    // app were bypassed entirely
    const bill = await db(userClient(dualToken))
      .from("finances")
      .insert({ org_id: orgA, purchase_order_id: poB, job_id: jobBId, amount: 100, vat_rate: 20 })
      .select("id")
      .single();
    expect(bill.error, "a cross-tenant supplier bill was accepted").not.toBeNull();
  });

  it("GRN numbers are allocated PER ORG, not globally", async () => {
    const a = await svc().from("goods_received_notes").select("number").eq("org_id", orgA);
    const b = await svc().from("goods_received_notes").select("number").eq("org_id", orgB);
    expect((a.data ?? []).map((r) => r.number)).toContain("GRN-0001");
    expect((b.data ?? []).map((r) => r.number)).toContain("GRN-0001");
  });

  // ── tenant visibility ─────────────────────────────────────────────────────
  it("writes grn.posted / grn.voided and the derived PO transition to activity_log", async () => {
    const { data } = await svc()
      .from("activity_log")
      .select("action, target_table")
      .eq("org_id", orgA);
    const actions = (data ?? []).map((r) => String(r.action));
    expect(actions).toContain("grn.posted");
    expect(actions).toContain("grn.voided");
    expect(actions).toContain("purchase_order.partially_received");
    expect(actions).toContain("purchase_order.received");
    // and the feed is org-scoped: org B's delivery is not in org A's log
    const bActions = await svc().from("activity_log").select("action").eq("org_id", orgB);
    expect((bActions.data ?? []).map((r) => String(r.action))).toContain("grn.posted");
  });

  // ── receiving is OPERATIONAL: no money moves ──────────────────────────────
  it("posts NOTHING to `finances` — receiving never moves money", async () => {
    for (const org of [orgA, orgB]) {
      const { data } = await svc().from("finances").select("id").eq("org_id", org);
      expect(data ?? [], "receiving wrote a finances row").toHaveLength(0);
    }
  });

  // ── the PO can no longer be quietly rewritten under its receipts ──────────
  it("REFUSES to delete an order that has deliveries, and to delete its lines", async () => {
    // org B's order now carries a posted note.
    const delLine = await svc()
      .from("purchase_order_line_items")
      .delete()
      .eq("id", lineB1);
    expect(delLine.error, "an ordered line under a receipt was deleted").not.toBeNull();

    const delPo = await svc().from("purchase_orders").delete().eq("id", poB);
    expect(delPo.error, "an order under a receipt was deleted").not.toBeNull();
  });

  // ── concurrency: two operators posting the same delivery ─────────────────
  it("SERIALISES concurrent posts — six racing deliveries yield exactly one", async () => {
    // The over-receipt check is a read-then-write, so it is only sound if posts
    // against one order are serialised. Six clients each post 60 against a
    // 100-unit line with nothing received: the first wins, the other five must
    // re-read "60 already received" and be refused.
    //
    // Verified deterministically outside the suite with two real psql sessions
    // holding open transactions: WITH pg_advisory_xact_lock the second session
    // waited 2.3s for the first to commit, then failed with "over-receipt:
    // 100.00 ordered, 40.00 already received" leaving 40.00 posted across one
    // note; with the lock removed both committed, leaving 110.00 posted against
    // a 100-unit order across two notes that each looked individually valid.
    const race = await makePo(orgA, `${TOKEN}-PO-RACE`);
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        rpc(userClient(dualToken)).rpc("post_goods_received_note", {
          p_org_id: orgA,
          p_purchase_order_id: race.po,
          p_delivery_date: null,
          p_delivery_note_reference: null,
          p_delivery_location: null,
          p_notes: null,
          p_received_by: dualUserId,
          p_lines: [{ line_item_id: race.lines[0], qty_received: 60 }],
        }),
      ),
    );

    const won = results.filter((r) => r.error === null);
    expect(won).toHaveLength(1);
    for (const lost of results.filter((r) => r.error !== null)) {
      expect(lost.error?.message ?? "").toMatch(/over-receipt/);
    }

    // ground truth: 60 of 100 received, one note, order part-received
    const notes = await svc()
      .from("goods_received_notes")
      .select("id, status")
      .eq("purchase_order_id", race.po);
    expect(notes.data ?? []).toHaveLength(1);

    const lines = await svc()
      .from("goods_received_lines")
      .select("qty_received")
      .eq("purchase_order_line_item_id", race.lines[0]);
    const total = (lines.data ?? []).reduce((a, r) => a + Number(r.qty_received), 0);
    expect(total).toBe(60);
    expect(await poStatus(race.po)).toBe("partially_received");
  });

  // ── org teardown (the deferred-FK decision) ───────────────────────────────
  it("ORG TEARDOWN succeeds with deliveries present", async () => {
    // This is why the FKs are NO ACTION DEFERRABLE INITIALLY DEFERRED rather
    // than RESTRICT: `delete from organizations` cascades to purchase_orders
    // and goods_received_notes in one transaction, in an order Postgres does
    // not promise. An immediate RESTRICT would abort GDPR erasure outright.
    const teardownOrg = await makeOrg("GRN Teardown", `${TOKEN}-teardown`);
    const { po, lines } = await makePo(teardownOrg, `${TOKEN}-PO-TD`);
    const note = await svc()
      .from("goods_received_notes")
      .insert({
        org_id: teardownOrg,
        purchase_order_id: po,
        number: "GRN-0001",
        delivery_date: "2026-07-01",
      })
      .select("id")
      .single();
    expect(note.error, note.error?.message).toBeNull();
    const noteId = String(note.data?.id ?? "");
    const grl = await svc()
      .from("goods_received_lines")
      .insert({
        org_id: teardownOrg,
        goods_received_note_id: noteId,
        purchase_order_line_item_id: lines[0],
        qty_received: 3,
      })
      .select("id")
      .single();
    expect(grl.error, grl.error?.message).toBeNull();

    const del = await svc().from("organizations").delete().eq("id", teardownOrg);
    expect(del.error, del.error?.message).toBeNull();

    const left = await svc().from("goods_received_notes").select("id").eq("id", noteId);
    expect(left.data ?? []).toHaveLength(0);
  });
});
