import { afterAll, beforeAll, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { describeIntegration } from "../_harness";
import { as, createWorld, destroyWorld, svc, type World } from "./_fixture";

/**
 * CHILD-ROW INJECTION INTO ANOTHER TENANT'S CUSTOMER-FACING DOCUMENTS
 * (register: ST-01, ST-02, ST-03, ST-06).
 *
 * The class. RLS guards the row being WRITTEN (`org_id in current_org_ids()`), not the
 * row it POINTS AT. So where a child table references its parent through a BARE
 * single-column foreign key, a member of org A can insert a child row with
 * `org_id = A` (passes RLS) and `parent_id = <a row of org B>` (passes the FK). B's own
 * users never see it — their RLS filters on org_id. But every SERVICE-ROLE reader that
 * loads children "by parent id" (the public quote page, the quote PDF, the quote
 * email, the customer portal, the reminder cron) bypasses RLS and DOES see it.
 *
 * Before the fixes this suite pins, an admin of any tenant who knew a victim quote's
 * uuid could add line items to it — including to an ACCEPTED quote, because the
 * line-item freeze trigger reads the parent under the ATTACKER's RLS and so sees no
 * `accepted_at` — and those lines rendered on the victim's public /q/[token] page and
 * PDF. A staff member could plant a portal-visible "document" on a victim's job and
 * have its filename listed in the victim's customer portal, and any member could
 * pre-plant `invoice_reminders` rows to silence a victim's payment reminders.
 *
 * Fixes: migrations 20261301000000 (composite, same-org foreign keys
 * for quote_line_items.quote_id, invoice_reminders.invoice_id and
 * support_messages.ticket_id) + an org pin on the portal attachment list read
 * (app/customer-portal/_attachments.ts).
 *
 * Verdicts are ground truth read with the service role, exactly as the public readers
 * read: "children of B's parent" must contain only org B's rows.
 */
describeIntegration("ADVERSARIAL · cross-tenant child-row injection into customer-facing documents", () => {
  let w: World | null = null;
  let customerB = "";
  let quoteB = "";
  let acceptedQuoteB = "";
  let jobB = "";
  let invoiceB = "";

  const ins = async (table: string, row: Record<string, unknown>): Promise<string> => {
    const r = await svc().from(table).insert(row).select("id").single();
    if (r.error || !r.data) throw new Error(`seed ${table}: ${r.error?.message}`);
    return (r.data as { id: string }).id;
  };

  beforeAll(async () => {
    w = await createWorld("sectenant-inj");
    const t = w.tag;
    customerB = await ins("customers", { org_id: w.B.id, name: `Victim Customer ${t}` });
    jobB = await ins("jobs", { org_id: w.B.id, customer_id: customerB });
    quoteB = await ins("quotes", { org_id: w.B.id, customer_id: customerB, number: `Q-${t}-1`, status: "sent" });
    acceptedQuoteB = await ins("quotes", {
      org_id: w.B.id,
      customer_id: customerB,
      number: `Q-${t}-2`,
      status: "accepted",
      accepted_at: new Date().toISOString(),
    });
    invoiceB = await ins("invoices", { org_id: w.B.id, customer_id: customerB, number: `INV-${t}-1`, amount: 100, vat_total: 20, status: "sent" });
    // One genuine line so "B's own lines survive" is asserted, not assumed.
    await ins("quote_line_items", { org_id: w.B.id, quote_id: quoteB, description: "Genuine scope line", qty: 1, unit_price: 100 });
  }, 120_000);

  afterAll(async () => {
    // Attacker rows live in org A and are removed with it.
    await destroyWorld(w);
  }, 120_000);

  /** What the public quote page / PDF / email read: children by parent id, service role. */
  const linesOf = async (quoteId: string): Promise<{ org_id: string; description: string }[]> => {
    const r = await svc().from("quote_line_items").select("org_id, description").eq("quote_id", quoteId);
    if (r.error) throw new Error(r.error.message);
    return r.data as { org_id: string; description: string }[];
  };

  for (const role of ["owner", "admin", "staff"] as const) {
    it(`ST-01 · org A ${role} cannot add a line item to org B's SENT quote`, async () => {
      const world = w!;
      const r = await as(world.A[role].token)
        .from("quote_line_items")
        .insert({ org_id: world.A.id, quote_id: quoteB, description: `INJECTED by A-${role}`, qty: 1, unit_price: 999999 });
      expect(r.error, "the insert must be refused").not.toBeNull();
      const lines = await linesOf(quoteB);
      expect(lines.every((l) => l.org_id === world.B.id), JSON.stringify(lines)).toBe(true);
      expect(lines.map((l) => l.description)).toEqual(["Genuine scope line"]);
    });

    it(`ST-01 · org A ${role} cannot add a line item to org B's ACCEPTED (frozen) quote`, async () => {
      const world = w!;
      const r = await as(world.A[role].token)
        .from("quote_line_items")
        .insert({ org_id: world.A.id, quote_id: acceptedQuoteB, description: `INJECTED by A-${role}`, qty: 1, unit_price: 1 });
      expect(r.error, "the insert must be refused").not.toBeNull();
      expect(await linesOf(acceptedQuoteB)).toEqual([]);
    });
  }

  it("ST-01 · org A cannot RE-POINT one of its own line items at org B's quote (UPDATE path)", async () => {
    const world = w!;
    const custA = await ins("customers", { org_id: world.A.id, name: "A customer" });
    const quoteA = await ins("quotes", { org_id: world.A.id, customer_id: custA, number: `QA-${world.tag}` });
    const lineA = await ins("quote_line_items", { org_id: world.A.id, quote_id: quoteA, description: "A's own line", qty: 1, unit_price: 1 });
    const r = await as(world.A.owner.token).from("quote_line_items").update({ quote_id: quoteB }).eq("id", lineA).select("id");
    expect(r.error !== null || (r.data ?? []).length === 0, "the re-point must be refused").toBe(true);
    const lines = await linesOf(quoteB);
    expect(lines.every((l) => l.org_id === world.B.id), JSON.stringify(lines)).toBe(true);
  });

  it("ST-01 · the schema makes it an invariant: even the SERVICE ROLE cannot attach a foreign-org line to a quote", async () => {
    // The fix is a composite FK, not a policy — so no future service-role writer can
    // reintroduce the mismatch either.
    const world = w!;
    const r = await svc()
      .from("quote_line_items")
      .insert({ org_id: world.A.id, quote_id: quoteB, description: "service-role mismatch", qty: 1, unit_price: 1 });
    expect(r.error?.code, JSON.stringify(r.error)).toBe("23503");
  });

  it("ST-03 · org A (any member) cannot pre-plant invoice_reminders rows that silence org B's payment reminders", async () => {
    const world = w!;
    for (const role of ["owner", "staff"] as const) {
      const r = await as(world.A[role].token)
        .from("invoice_reminders")
        .insert({ org_id: world.A.id, invoice_id: invoiceB, stage: "day_7" });
      expect(r.error, `A-${role} insert must be refused`).not.toBeNull();
    }
    // What the reminder cron reads: reminders by invoice id, service role, no org filter.
    const seen = await svc().from("invoice_reminders").select("org_id, stage").eq("invoice_id", invoiceB);
    expect(seen.error).toBeNull();
    expect(seen.data).toEqual([]);
  });

  it("ST-06 · org A (any member) cannot inject a message into org B's support ticket, nor flip that ticket's status", async () => {
    // support_messages.ticket_id was a bare FK and _support_messages_after_insert is a
    // SECURITY DEFINER trigger that updates `support_tickets where id = new.ticket_id`
    // with no org check — so a foreign-org message both (a) appeared in the service-role
    // "last message" embed of B's customer-portal thread list and (b) rewrote B's ticket
    // status / last_reply_at. A real cross-tenant WRITE.
    const world = w!;
    const ticket = await svc()
      .from("support_tickets")
      .insert({ org_id: world.B.id, customer_id: customerB, subject: `Victim ticket ${world.tag}`, status: "open" })
      .select("id, status, last_reply_at, last_reply_kind, updated_at")
      .single();
    expect(ticket.error, JSON.stringify(ticket.error)).toBeNull();
    const before = ticket.data as Record<string, unknown>;

    for (const role of ["owner", "staff"] as const) {
      for (const author_kind of ["org", "customer"] as const) {
        const r = await as(world.A[role].token).from("support_messages").insert({
          org_id: world.A.id,
          ticket_id: before.id,
          author_kind,
          author_id: world.A[role].id,
          internal: false,
          body: `INJECTED by A-${role}`,
        });
        expect(r.error, `A-${role} (${author_kind}) insert must be refused`).not.toBeNull();
      }
    }
    // Ground truth, read as the portal reads it: messages by ticket id, service role.
    const msgs = await svc().from("support_messages").select("org_id, body").eq("ticket_id", before.id as string);
    expect(msgs.data).toEqual([]);
    const after = await svc()
      .from("support_tickets")
      .select("id, status, last_reply_at, last_reply_kind, updated_at")
      .eq("id", before.id as string)
      .single();
    expect(after.data, "org B's ticket must be untouched").toEqual(before);
  });

  it("ST-02 · a portal-visible attachment planted by org A on org B's job is NOT listed in B's customer portal", async () => {
    const world = w!;
    const plantedId = randomUUID();
    // tenant_attachments is polymorphic (target_table, target_id) — there is no FK to
    // make composite, so the plant itself lands (in org A). The defence is the reader.
    const plant = await as(world.A.staff.token).from("tenant_attachments").insert({
      id: plantedId,
      org_id: world.A.id,
      target_table: "jobs",
      target_id: jobB,
      filename: "URGENT - new bank details.pdf",
      storage_path: `${world.A.id}/jobs/${jobB}/${plantedId}.pdf`,
      mime_type: "application/pdf",
      portal_visible: true,
    });
    const landed = await svc().from("tenant_attachments").select("id, org_id").eq("id", plantedId).maybeSingle();
    // Record honestly what the database allowed (documented in the register as residual).
    expect(plant.error === null ? landed.data?.org_id : null, "if the plant lands it must be in the ATTACKER's org").toSatisfy(
      (v: unknown) => v === null || v === world.A.id,
    );

    const { listPortalAttachments, verifyPortalAttachment } = await import("@/app/customer-portal/_attachments");
    const listed = await listPortalAttachments(customerB, world.B.id);
    expect(listed.map((a) => a.id)).not.toContain(plantedId);
    expect(listed.map((a) => a.filename)).not.toContain("URGENT - new bank details.pdf");
    // And the download route's re-verification refuses it too (already org-pinned).
    expect(await verifyPortalAttachment(plantedId, customerB, world.B.id)).toBeNull();
  });

  it("ST-02 control · org B's OWN portal-visible attachment on that job IS listed (the reader still works)", async () => {
    const world = w!;
    const ownId = randomUUID();
    await ins("tenant_attachments", {
      id: ownId,
      org_id: world.B.id,
      target_table: "jobs",
      target_id: jobB,
      filename: "Handover pack.pdf",
      storage_path: `${world.B.id}/jobs/${jobB}/${ownId}.pdf`,
      mime_type: "application/pdf",
      portal_visible: true,
    });
    const { listPortalAttachments } = await import("@/app/customer-portal/_attachments");
    const listed = await listPortalAttachments(customerB, world.B.id);
    expect(listed.map((a) => a.id)).toContain(ownId);
  });
});
