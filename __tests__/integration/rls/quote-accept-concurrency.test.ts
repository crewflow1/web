import { afterAll, beforeAll, expect, it } from "vitest";
import { describeIntegration, serviceClient } from "../_harness";
import { acceptQuoteByToken } from "@/app/(app)/quotes/actions";

/**
 * Quote re-accept backfill — CONCURRENCY proof (real Postgres) for PR #1082.
 *
 * Two SIMULTANEOUS re-accepts of the same already-accepted-but-invoice-less quote must
 * produce EXACTLY ONE invoice. The in-code reuse-check narrows the window; the partial
 * unique index invoices_quote_id_unique (quote_id WHERE quote_id IS NOT NULL) is the
 * atomic backstop — so even if both callers pass the reuse-check, only one INSERT wins.
 */

type Res<T> = { data: T | null; error: { message: string } | null };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = (c: unknown) => c as unknown as { from(t: string): any };
const svc = () => db(serviceClient());
const TOKEN = `it-qacc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const PUBLIC_TOKEN = `tok_${TOKEN}`;

let orgId = "";
let customerId = "";
let jobId = "";
let quoteId = "";

beforeAll(async () => {
  const org = await svc().from("organizations").insert({ name: `QAcc ${TOKEN}`, slug: `${TOKEN}-org` }).select("id").single();
  expect(org.error, org.error?.message).toBeNull();
  orgId = org.data.id as string;
  const cust = await svc().from("customers").insert({ org_id: orgId, name: "QAcc Customer" }).select("id").single();
  expect(cust.error, cust.error?.message).toBeNull();
  customerId = cust.data.id as string;
  const job = await svc().from("jobs").insert({ org_id: orgId, customer_id: customerId, status: "new" }).select("id").single();
  expect(job.error, job.error?.message).toBeNull();
  jobId = job.data.id as string;
  // An ALREADY-accepted quote with NO invoice yet (a partial first accept) + a job, so
  // the re-accept path goes straight to the invoice backfill (no job creation).
  const quote = await svc()
    .from("quotes")
    .insert({
      org_id: orgId,
      customer_id: customerId,
      number: `Q-${TOKEN}`,
      status: "accepted",
      subtotal: 1000,
      vat_total: 200,
      public_token: PUBLIC_TOKEN,
      job_id: jobId,
    })
    .select("id")
    .single();
  expect(quote.error, quote.error?.message).toBeNull();
  quoteId = quote.data.id as string;
});

afterAll(async () => {
  if (quoteId) await svc().from("invoices").delete().eq("quote_id", quoteId);
  if (orgId) await svc().from("organizations").delete().eq("id", orgId);
});

describeIntegration("quote re-accept backfill · concurrency (PR #1082)", () => {
  it("two SIMULTANEOUS re-accepts create EXACTLY ONE invoice (no duplicate)", async () => {
    const [a, b] = await Promise.all([
      acceptQuoteByToken(PUBLIC_TOKEN, "Concurrent A", null),
      acceptQuoteByToken(PUBLIC_TOKEN, "Concurrent B", null),
    ]);
    expect(a.ok, JSON.stringify(a)).toBe(true);
    expect(b.ok, JSON.stringify(b)).toBe(true);

    const inv = (await svc().from("invoices").select("id").eq("quote_id", quoteId)) as Res<{ id: string }[]>;
    expect(inv.error, inv.error?.message).toBeNull();
    expect((inv.data ?? []).length, "exactly one invoice for the quote after concurrent backfills").toBe(1);
  });
});
