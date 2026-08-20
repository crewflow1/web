import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { anonClient, describeIntegration, serviceClient, userClient } from "../_harness";
import {
  runMerchantCatalogueImport,
  submitPurchaseOrderToMerchantForOrg,
} from "@/server/services/merchant-writers";

/**
 * Merchant PERSISTENCE WRITERS — proven against real Postgres.
 *
 * The writers are dark-gated on the environment, so this suite ACTIVATES a
 * merchant (env flag + credentials + endpoint) and stubs ONLY the merchant HTTP
 * calls (a CSV price file / a cXML ack) — every Supabase call still hits the real
 * DB — to drive the true code path end-to-end:
 *
 *   1. CATALOGUE writer: fetch+parse → UPSERT into merchant_catalogue_items,
 *      IDEMPOTENT on (org_id, provider, sku) (a re-import updates, never dupes),
 *      ORG-SCOPED (org A's import never writes org B rows), member-read / no-anon.
 *   2. COMPOSITE FK: a catalogue row bound to ANOTHER org's connection is refused.
 *   3. PO SUBMIT writer: submit via the cXML seam → append a merchant_po_submissions
 *      row (acknowledged), IDEMPOTENT (a 2nd submit is `already_submitted`, no dup),
 *      ORG-PINNED (a foreign PO is not-found), ledger APPEND-ONLY (update refused).
 *   4. DARK-SAFE: with the env cleared BOTH writers return ran:false and write
 *      nothing — the code path itself, not just a source contract.
 */

type Res<T> = { data: T | null; error: { message: string } | null };
type Row = Record<string, unknown>;
interface Sel extends PromiseLike<Res<Row[]>> {
  eq(column: string, value: unknown): Sel;
  maybeSingle(): PromiseLike<Res<Row>>;
}
interface Ins extends PromiseLike<Res<Row[]>> {
  select(columns?: string): Ins;
  single(): PromiseLike<Res<Row>>;
}
interface Upd extends PromiseLike<Res<Row[]>> {
  eq(column: string, value: unknown): Upd;
  select(columns?: string): Upd;
}
interface Table {
  select(columns?: string, opts?: Record<string, unknown>): Sel;
  insert(rows: Row | Row[]): Ins;
  update(row: Row): Upd;
  delete(opts?: Record<string, unknown>): { eq(c: string, v: unknown): PromiseLike<unknown> };
}
const db = (client: unknown) => client as unknown as { from(t: string): Table };

const TOKEN = `it-merchwr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const PRICE_URL = "https://prices.example.com/jewson.csv";
const ENDPOINT = "https://gw.example.com/cxml";

/** A CSV price file the stub serves; the second import bumps the price. */
function csv(priceB: string): string {
  return `sku,description,price\nSKU-1,Cement 25kg,5.50\nSKU-2,Sand bulk bag,${priceB}\n`;
}

describeIntegration("merchant writers · catalogue + PO submit against real Postgres", () => {
  let orgA = "";
  let orgB = "";
  let ownerId = "";
  let memberToken = "";
  let outsiderToken = "";
  let connA = "";
  let connB = "";
  let poA = "";
  const envOriginal = { ...process.env };
  let sandPrice = "3.00"; // flips to prove upsert UPDATES rather than duplicates

  async function mintUser(label: string): Promise<{ id: string; token: string }> {
    const email = `${TOKEN}-${label}@example.test`;
    const password = `Pw-${TOKEN}-${Math.random().toString(36).slice(2)}`;
    const created = await serviceClient().auth.admin.createUser({ email, password, email_confirm: true });
    expect(created.error, created.error?.message).toBeNull();
    const id = created.data.user?.id ?? "";
    const mirrored = await db(serviceClient()).from("users").insert({ id, email, full_name: `MerchWr ${label}` }).select("id").single();
    expect(mirrored.error, mirrored.error?.message).toBeNull();
    const signedIn = await anonClient().auth.signInWithPassword({ email, password });
    expect(signedIn.error, signedIn.error?.message).toBeNull();
    return { id, token: signedIn.data.session?.access_token ?? "" };
  }

  async function seedConnection(orgId: string): Promise<string> {
    const res = await db(serviceClient())
      .from("merchant_connections")
      .insert({ org_id: orgId, provider: "jewson", status: "connected", external_account_id: `acct-${orgId.slice(0, 6)}` })
      .select("id")
      .single();
    expect(res.error, res.error?.message).toBeNull();
    return String(res.data?.id ?? "");
  }

  beforeAll(async () => {
    // createAdminClient reads NEXT_PUBLIC_SUPABASE_URL; the harness accepts the bare
    // name, so mirror it across for the service-role writer path.
    if (!process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_URL) {
      process.env.NEXT_PUBLIC_SUPABASE_URL = process.env.SUPABASE_URL;
    }

    const svc = db(serviceClient());
    const a = await svc.from("organizations").insert({ name: "MerchWr A", slug: `${TOKEN}-a` }).select("id").single();
    const b = await svc.from("organizations").insert({ name: "MerchWr B", slug: `${TOKEN}-b` }).select("id").single();
    orgA = String(a.data?.id ?? "");
    orgB = String(b.data?.id ?? "");
    if (!orgA || !orgB) throw new Error("failed to create probe orgs");

    const owner = await mintUser("owner");
    ownerId = owner.id;
    await svc.from("memberships").insert({ org_id: orgA, user_id: ownerId, role: "owner" });
    const member = await mintUser("member");
    memberToken = member.token;
    await svc.from("memberships").insert({ org_id: orgA, user_id: member.id, role: "staff" });
    outsiderToken = (await mintUser("outsider")).token;

    connA = await seedConnection(orgA);
    connB = await seedConnection(orgB);

    // A live, sent PO in org A with two lines whose descriptions match the price file.
    const po = await svc
      .from("purchase_orders")
      .insert({ org_id: orgA, number: `PO-${TOKEN}`, status: "sent", created_by: ownerId })
      .select("id")
      .single();
    expect(po.error, po.error?.message).toBeNull();
    poA = String(po.data?.id ?? "");
    const lines = await svc.from("purchase_order_line_items").insert([
      { org_id: orgA, purchase_order_id: poA, description: "Cement 25kg", qty: 10, unit: "bag", unit_price: 5.5, vat_rate: 20, line_total: 55, sort_order: 0 },
      { org_id: orgA, purchase_order_id: poA, description: "Sand bulk bag", qty: 4, unit: "bag", unit_price: 3, vat_rate: 20, line_total: 12, sort_order: 1 },
    ]);
    expect(lines.error, lines.error?.message).toBeNull();
  });

  afterAll(async () => {
    const svc = db(serviceClient());
    if (orgA) await svc.from("organizations").delete().eq("id", orgA);
    if (orgB) await svc.from("organizations").delete().eq("id", orgB);
    process.env = { ...envOriginal };
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Activate jewson + stub ONLY the merchant HTTP calls (Supabase still real). */
  function activate(): void {
    process.env.NEXT_PUBLIC_FEATURE_MERCHANTS = "true";
    process.env.MERCHANT_JEWSON_API_KEY = "test-key";
    process.env.MERCHANT_JEWSON_ENDPOINT = ENDPOINT;
    process.env.MERCHANT_JEWSON_PRICE_FILE_URL = PRICE_URL;
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: unknown, init?: { method?: string }) => {
      const url = String(input);
      // Everything that is NOT the merchant's own hosts goes to the real network
      // (this is how the Supabase client keeps talking to Postgres).
      if (!url.includes("example.com")) return realFetch(input as string, init as RequestInit);
      if (init?.method === "POST") {
        return new Response('<cXML><Response><Status code="200" text="MERCH-REF-1"/></Response></cXML>', { status: 200 });
      }
      return new Response(csv(sandPrice), { status: 200 });
    });
  }

  function deactivate(): void {
    delete process.env.NEXT_PUBLIC_FEATURE_MERCHANTS;
    delete process.env.MERCHANT_JEWSON_API_KEY;
    delete process.env.MERCHANT_JEWSON_ENDPOINT;
    delete process.env.MERCHANT_JEWSON_PRICE_FILE_URL;
  }

  // ── 1. CATALOGUE writer — imports, idempotent, org-scoped ──────────────────

  it("imports + upserts the parsed price file for org A only", async () => {
    activate();
    sandPrice = "3.00";
    const out = await runMerchantCatalogueImport({ orgId: orgA, provider: "jewson" });
    expect(out.status, out.message).toBe("imported");
    expect(out.written).toBe(2);

    const rowsA = await db(serviceClient())
      .from("merchant_catalogue_items")
      .select("sku, unit_price_pence, connection_id, org_id")
      .eq("org_id", orgA);
    expect(rowsA.error, rowsA.error?.message).toBeNull();
    expect((rowsA.data ?? []).length).toBe(2);
    const sku1 = (rowsA.data ?? []).find((r) => r.sku === "SKU-1");
    expect(sku1?.unit_price_pence).toBe(550);
    expect(sku1?.connection_id).toBe(connA);

    // Org B was never touched by org A's import.
    const rowsB = await db(serviceClient()).from("merchant_catalogue_items").select("id").eq("org_id", orgB);
    expect((rowsB.data ?? []).length).toBe(0);
  });

  it("re-import is IDEMPOTENT on (org, provider, sku) — updates, never duplicates", async () => {
    activate();
    sandPrice = "6.00"; // bump the second SKU's price on re-import
    const out = await runMerchantCatalogueImport({ orgId: orgA, provider: "jewson" });
    expect(out.status).toBe("imported");

    const rows = await db(serviceClient())
      .from("merchant_catalogue_items")
      .select("sku, unit_price_pence")
      .eq("org_id", orgA);
    // Still exactly two rows — the re-import UPDATED, it did not duplicate.
    expect((rows.data ?? []).length).toBe(2);
    const sku2 = (rows.data ?? []).find((r) => r.sku === "SKU-2");
    expect(sku2?.unit_price_pence).toBe(600); // price updated in place
  });

  it("catalogue is member-read, outsider-blind (RLS), no authenticated writer", async () => {
    const asMember = await db(userClient(memberToken)).from("merchant_catalogue_items").select("sku").eq("org_id", orgA);
    expect(asMember.error, asMember.error?.message).toBeNull();
    expect((asMember.data ?? []).length).toBe(2);

    const asOutsider = await db(userClient(outsiderToken)).from("merchant_catalogue_items").select("id").eq("org_id", orgA);
    expect((asOutsider.data ?? []).length).toBe(0);

    // A member cannot write the catalogue (no authenticated insert policy).
    const ins = await db(userClient(memberToken))
      .from("merchant_catalogue_items")
      .insert({ org_id: orgA, provider: "jewson", connection_id: connA, sku: "HACK", unit_price_pence: 1 })
      .select("id");
    expect(ins.error, "member catalogue insert must be refused").not.toBeNull();
  });

  it("COMPOSITE FK refuses a catalogue row bound to another org's connection", async () => {
    const bad = await db(serviceClient())
      .from("merchant_catalogue_items")
      .insert({ org_id: orgA, provider: "jewson", connection_id: connB, sku: "X", unit_price_pence: 1 })
      .select("id");
    expect(bad.error, "cross-tenant connection binding must be refused by the composite FK").not.toBeNull();
  });

  // ── 2. PO SUBMIT writer — persists, idempotent, org-pinned, append-only ────

  it("submits the PO and appends an acknowledged ledger row", async () => {
    activate();
    const out = await submitPurchaseOrderToMerchantForOrg({
      orgId: orgA,
      provider: "jewson",
      purchaseOrderId: poA,
      submittedBy: ownerId,
    });
    expect(out.status, out.message).toBe("acknowledged");
    expect(out.externalOrderRef).toBe("MERCH-REF-1");
    expect(out.submissionId).not.toBeNull();

    const ledger = await db(serviceClient())
      .from("merchant_po_submissions")
      .select("id, status, external_order_ref, connection_id, purchase_order_id")
      .eq("org_id", orgA);
    const ackd = (ledger.data ?? []).filter((r) => r.status === "acknowledged");
    expect(ackd.length).toBe(1);
    expect(ackd[0]?.external_order_ref).toBe("MERCH-REF-1");
    expect(ackd[0]?.connection_id).toBe(connA);
    expect(ackd[0]?.purchase_order_id).toBe(poA);
  });

  it("re-submit is IDEMPOTENT — already_submitted, no duplicate acknowledged row", async () => {
    activate();
    const out = await submitPurchaseOrderToMerchantForOrg({
      orgId: orgA,
      provider: "jewson",
      purchaseOrderId: poA,
      submittedBy: ownerId,
    });
    expect(out.status).toBe("already_submitted");

    const ledger = await db(serviceClient()).from("merchant_po_submissions").select("id, status").eq("org_id", orgA);
    expect((ledger.data ?? []).filter((r) => r.status === "acknowledged").length).toBe(1);
  });

  it("a foreign PO is not-found (org pin), never submitted", async () => {
    activate();
    // poA belongs to org A; submitting it under org B must not find it.
    const out = await submitPurchaseOrderToMerchantForOrg({
      orgId: orgB,
      provider: "jewson",
      purchaseOrderId: poA,
      submittedBy: null,
    });
    expect(out.status).toBe("not_found");
    const ledgerB = await db(serviceClient()).from("merchant_po_submissions").select("id").eq("org_id", orgB);
    expect((ledgerB.data ?? []).length).toBe(0);
  });

  it("the submission ledger is APPEND-ONLY — an UPDATE is refused", async () => {
    const upd = await db(serviceClient())
      .from("merchant_po_submissions")
      .update({ status: "rejected" })
      .eq("org_id", orgA)
      .eq("purchase_order_id", poA)
      .select("id");
    expect(upd.error, "ledger update must be refused by the immutability trigger").not.toBeNull();
  });

  // ── 3. DARK-SAFE — the real code path writes nothing while dark ─────────────

  it("both writers are dark-safe when the env is cleared (no write)", async () => {
    deactivate();
    const cat = await runMerchantCatalogueImport({ orgId: orgA, provider: "jewson" });
    expect(cat.ran).toBe(false);
    expect(cat.status).toBe("skipped_dark");

    // A fresh PO to prove no ledger row is appended while dark.
    const po = await db(serviceClient())
      .from("purchase_orders")
      .insert({ org_id: orgA, number: `PO-DARK-${TOKEN}`, status: "sent", created_by: ownerId })
      .select("id")
      .single();
    const darkPo = String(po.data?.id ?? "");
    const sub = await submitPurchaseOrderToMerchantForOrg({
      orgId: orgA,
      provider: "jewson",
      purchaseOrderId: darkPo,
      submittedBy: ownerId,
    });
    expect(sub.ran).toBe(false);
    expect(sub.status).toBe("skipped_dark");
    const ledger = await db(serviceClient()).from("merchant_po_submissions").select("id").eq("purchase_order_id", darkPo);
    expect((ledger.data ?? []).length).toBe(0);

    // Catalogue unchanged (still the two rows from the live imports above).
    const rows = await db(serviceClient()).from("merchant_catalogue_items").select("id").eq("org_id", orgA);
    expect((rows.data ?? []).length).toBe(2);
  });
});
