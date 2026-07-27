import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * First-impression sample data (Directive: First Impression Experience).
 *
 * A brand-new organisation lands on an empty app and has no idea what CrewFlow does. This seeds
 * ONE realistic, self-explanatory set of records — a customer, a draft quote with line items, and
 * a scheduled job — so the very first screen shows the product working end to end. It is the "aha"
 * in the first minute.
 *
 * DESIGN RULES:
 *  - IDEMPOTENT + SAFE: only seeds an org that has NO customers yet (a truly fresh org). Re-running,
 *    or running on an org that already has real data, is a no-op — sample data can never overwrite
 *    or duplicate a customer's real records.
 *  - BEST-EFFORT: the caller (createOrgWithOwner) wraps this so a seed failure NEVER breaks signup —
 *    the org is created whether or not the sample lands. Every step checks its {error}.
 *  - CLEARLY SAMPLE + DELETABLE: every record is tagged in its notes as sample data safe to delete,
 *    and uses obviously-illustrative values (example.com email, a `SAMPLE-` quote number that can
 *    never collide with the real numeric quote sequence). The customer owns it and can delete it.
 *  - NO SECRETS, NO EXTERNAL CALLS: pure inserts into the org's own tables.
 */

const SAMPLE_TAG = "Sample data added by CrewFlow so you can see how everything fits together — safe to delete anytime.";

export type SeedSampleResult =
  | { seeded: true; customerId: string; quoteId: string; jobId: string | null }
  | { seeded: false; reason: "org_not_empty" | "error"; error?: string };

type AdminInsert = {
  from: (t: string) => {
    insert: (row: unknown) => {
      select: (cols: string) => {
        single: () => Promise<{ data: { id: string } | null; error: { message: string } | null }>;
      };
    } & Promise<{ error: { message: string } | null }>;
    select: (cols: string) => {
      eq: (k: string, v: unknown) => {
        limit: (n: number) => Promise<{ data: unknown[] | null; error: { message: string } | null }>;
      };
    };
  };
};

/** A date `days` from now as an ISO `YYYY-MM-DD` (for the sample job's scheduled_date). */
function isoDatePlusDays(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export async function seedSampleData(orgId: string): Promise<SeedSampleResult> {
  const admin = createAdminClient() as unknown as AdminInsert;

  try {
    // Idempotency + safety: never seed an org that already holds any customer.
    const existing = await admin.from("customers").select("id").eq("org_id", orgId).limit(1);
    if (existing.error) {
      return { seeded: false, reason: "error", error: existing.error.message };
    }
    if ((existing.data?.length ?? 0) > 0) {
      return { seeded: false, reason: "org_not_empty" };
    }

    // 1) A realistic homeowner customer.
    const customer = await admin
      .from("customers")
      .insert({
        org_id: orgId,
        name: "Sarah & Tom Bennett",
        email: "sample.customer@example.com",
        phone: "+44 7700 900123",
        address_line1: "14 Oakfield Road",
        city: "Harrogate",
        county: "North Yorkshire",
        postcode: "HG1 4PP",
        notes: `👋 ${SAMPLE_TAG}`,
      })
      .select("id")
      .single();
    if (customer.error || !customer.data?.id) {
      return { seeded: false, reason: "error", error: customer.error?.message ?? "no customer id" };
    }
    const customerId = customer.data.id;

    // 2) A draft quote — SAMPLE- number can never collide with the real numeric sequence.
    const subtotal = 12000;
    const vatTotal = 2400;
    const total = 14400;
    const quote = await admin
      .from("quotes")
      .insert({
        org_id: orgId,
        customer_id: customerId,
        number: "SAMPLE-001",
        status: "draft",
        currency: "GBP",
        subtotal,
        vat_total: vatTotal,
        total,
        notes: `Example quote — single-storey kitchen extension. ${SAMPLE_TAG}`,
        valid_until: isoDatePlusDays(30),
      })
      .select("id")
      .single();
    if (quote.error || !quote.data?.id) {
      return { seeded: false, reason: "error", error: quote.error?.message ?? "no quote id" };
    }
    const quoteId = quote.data.id;

    // 3) Line items that make the quote read like a real job.
    const lines = [
      { description: "Single-storey rear extension — groundworks & shell", qty: 1, unit: "job", unit_price: 6500, vat_rate: 20, line_total: 6500, sort_order: 0 },
      { description: "Kitchen supply & installation", qty: 1, unit: "job", unit_price: 4200, vat_rate: 20, line_total: 4200, sort_order: 1 },
      { description: "Electrical first & second fix", qty: 1, unit: "job", unit_price: 1300, vat_rate: 20, line_total: 1300, sort_order: 2 },
    ];
    for (const line of lines) {
      const li = await admin.from("quote_line_items").insert({ org_id: orgId, quote_id: quoteId, ...line });
      if (li.error) {
        // Non-fatal: the quote is already useful without every line. Log and continue.
        console.error("[sample-data] line item insert failed", { orgId, message: li.error.message });
      }
    }

    // 4) A scheduled job so the calendar isn't empty either.
    const job = await admin
      .from("jobs")
      .insert({
        org_id: orgId,
        customer_id: customerId,
        status: "new",
        scheduled_date: isoDatePlusDays(14),
        notes: `Example job — kitchen extension for Sarah & Tom Bennett. ${SAMPLE_TAG}`,
      })
      .select("id")
      .single();
    // A job failure is non-fatal — the customer + quote are the core of the "aha".
    const jobId = job.error ? null : (job.data?.id ?? null);
    if (job.error) {
      console.error("[sample-data] job insert failed", { orgId, message: job.error.message });
    }

    return { seeded: true, customerId, quoteId, jobId };
  } catch (e) {
    return { seeded: false, reason: "error", error: e instanceof Error ? e.message : String(e) };
  }
}
