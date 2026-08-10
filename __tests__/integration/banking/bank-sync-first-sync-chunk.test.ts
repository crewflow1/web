import { afterAll, beforeAll, expect, it } from "vitest";
import { describeIntegration, serviceClient } from "../_harness";
import { createAdminGateway } from "@/server/services/bank-sync";

/**
 * FIRST-SYNC DEDUPE CHUNKING — REAL POSTGRES regression (URL-length 414/400).
 *
 * WHY THIS EXISTS. On first sync the engine feeds the FULL candidate list (every
 * fetched line — see bank-sync.ts candidateIds) into the dedupe read
 * `existingProviderTxIds`. That gateway method issues supabase-js
 * `.select('provider_tx_id').eq('org_id',…).in('provider_tx_id', ids)`, which is
 * a GET: all ids are serialised into the URL query string. With NO chunking a
 * real account's first sync (thousands of ~50-char TrueLayer ids) overflowed the
 * ~8KB request-line limit → PostgREST returned 414/400 → the read threw → the
 * connection was marked `error` and ZERO transactions were imported.
 *
 * This drives the ACTUAL gateway (real service-role client → real Postgres) with
 * WELL OVER a thousand ids in one call and asserts:
 *   (a) the read does NOT throw a URL-length failure (proves the .in() is chunked
 *       into batches, each well under the limit), and
 *   (b) it returns EXACTLY the ids that exist for this org — no chunk dropped,
 *       none double-counted — while ids that do not exist are absent.
 *
 * A single unchunked .in() over this many ids fails here; the chunked union does
 * not. Org-pinning per chunk is covered by the sibling dedupe suite.
 */

type Row = Record<string, unknown>;
interface Ins extends PromiseLike<{ data: Row[] | null; error: { message: string } | null }> {
  select(columns?: string): { single(): PromiseLike<{ data: Row | null; error: { message: string } | null }> };
}
interface Del extends PromiseLike<{ error: { message: string } | null }> {
  eq(column: string, value: unknown): Del;
}
interface Table {
  insert(rows: Row | Row[]): Ins;
  delete(): Del;
}
const db = (client: unknown) => client as unknown as { from(t: string): Table };

const TOKEN = `it-bsfsc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

// > 1000 ids in a single dedupe read. Each id is ~50 chars, mirroring a real
// TrueLayer transaction_id, so the unchunked URL would blow past ~8KB many times.
const EXISTING_COUNT = 1200;
const existingId = (i: number) =>
  `${TOKEN}-txxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx-${String(i).padStart(6, "0")}`;

describeIntegration("bank-feed first-sync dedupe chunking · real Postgres (414 regression)", () => {
  let orgId = "";

  beforeAll(async () => {
    if (!process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_URL) {
      process.env.NEXT_PUBLIC_SUPABASE_URL = process.env.SUPABASE_URL;
    }
    const svc = db(serviceClient());
    const org = await svc
      .from("organizations")
      .insert({ name: "Bank First-Sync Chunk", slug: `${TOKEN}-org` })
      .select("id")
      .single();
    expect(org.error, org.error?.message).toBeNull();
    orgId = String(org.data?.id ?? "");

    // Seed > 1000 real lines for this org via the actual gateway insert path.
    const gw = createAdminGateway();
    const statementId = await gw.createStatement(orgId, `${TOKEN} seed`, EXISTING_COUNT);
    const rows = Array.from({ length: EXISTING_COUNT }, (_, i) => ({
      org_id: orgId,
      bank_statement_id: statementId,
      posted_at: "2026-01-15",
      amount: 1 + (i % 100),
      description: `seed ${i}`,
      reference: null,
      provider_tx_id: existingId(i),
    }));
    // All 1200 seed lines land across the chunked write (no 42P10, no failure). The
    // write chunks the upsert bodies; the URL-length (414) regression under test is
    // on the dedupe READ below, which stays chunked.
    const seedWrite = await gw.insertLines(rows);
    expect(seedWrite.transientError, "seed insert must not fail").toBeNull();
    expect(seedWrite.constraintError).toBeNull();
    expect(seedWrite.inserted).toBe(EXISTING_COUNT);
  });

  afterAll(async () => {
    const svc = db(serviceClient());
    if (orgId) await svc.from("organizations").delete().eq("id", orgId);
  });

  it("dedupes > 1000 ids in one call with NO URL-length failure and the exact existing set", async () => {
    const gw = createAdminGateway();

    // Candidate list = every seeded (existing) id PLUS a block of ids that do not
    // exist — exactly the shape of a first sync feeding the full fetched history.
    const missing = Array.from({ length: 300 }, (_, i) => `${TOKEN}-absent-${i}`);
    const candidates = [
      ...Array.from({ length: EXISTING_COUNT }, (_, i) => existingId(i)),
      ...missing,
    ];
    expect(candidates.length).toBeGreaterThan(1000);

    // The primitive that raised 414/400 when unchunked. The assertion is that it
    // RESOLVES (chunked) rather than throwing on the URL.
    const existing = await gw.existingProviderTxIds(orgId, candidates);

    expect(existing.size).toBe(EXISTING_COUNT);
    // Every seeded id is seen; no absent id leaks in.
    for (let i = 0; i < EXISTING_COUNT; i += 137) {
      expect(existing.has(existingId(i))).toBe(true);
    }
    for (const m of missing) expect(existing.has(m)).toBe(false);
  });
});
