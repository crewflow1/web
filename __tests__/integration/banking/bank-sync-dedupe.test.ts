import { afterAll, beforeAll, expect, it } from "vitest";
import { describeIntegration, serviceClient } from "../_harness";
import { createAdminGateway } from "@/server/services/bank-sync";
import {
  mapStatementToLines,
  type AggregatorStatement,
} from "@/lib/integrations/banking/statement-map";

/**
 * BANK-FEED DEDUPE — REAL POSTGRES regression (42P10).
 *
 * WHY THIS EXISTS. The hermetic banking-feed suite (__tests__/integrations/
 * banking-feed.test.ts) proves the engine's idempotency logic with an IN-MEMORY
 * gateway — the DB client is stubbed, so it never issues a real SQL statement.
 * That is exactly why it missed a live activation-breaker:
 *
 *   server/services/bank-sync.ts → createAdminGateway().insertLines() writes via
 *   PostgREST `.upsert(rows, { onConflict: "org_id,provider_tx_id",
 *   ignoreDuplicates: true })`, which Postgres executes as
 *   `INSERT ... ON CONFLICT (org_id, provider_tx_id) DO NOTHING`. Postgres
 *   cannot infer a PARTIAL unique index as the ON CONFLICT arbiter unless the
 *   statement repeats the index's exact WHERE predicate (PostgREST never emits
 *   one) — so the original PARTIAL `... WHERE provider_tx_id IS NOT NULL` index
 *   raised **42P10 ("no unique or exclusion constraint matching the ON CONFLICT
 *   specification")** on EVERY feed insert. The feed would have thrown on its
 *   first sync at activation.
 *
 * The migration now creates a PLAIN unique index; NULLs-distinct keeps the many
 * CSV-uploaded (provider_tx_id NULL) rows unaffected. This test drives the ACTUAL
 * gateway (real service-role client → real Postgres, migrations applied) so the
 * SQL is really executed, proving:
 *   (a) inserting new provider_tx rows succeeds (no 42P10),
 *   (b) a re-run with an overlapping provider_tx_id inserts ZERO duplicates,
 *   (c) multiple CSV NULL-provider_tx_id rows coexist,
 *   (d) #456 — dedupe is org-pinned: the same aggregator tx id in another org is
 *       neither seen by existingProviderTxIds nor blocked by the unique index.
 *
 * createAdminGateway() reads NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY;
 * beforeAll bridges NEXT_PUBLIC_SUPABASE_URL from SUPABASE_URL for local runs.
 */

type Row = Record<string, unknown>;
interface Sel extends PromiseLike<{ data: Row[] | null; error: { message: string } | null }> {
  eq(column: string, value: unknown): Sel;
  order(column: string, opts?: Record<string, unknown>): Sel;
}
interface Ins extends PromiseLike<{ data: Row[] | null; error: { message: string } | null }> {
  select(columns?: string): { single(): PromiseLike<{ data: Row | null; error: { message: string } | null }> };
}
interface Del extends PromiseLike<{ error: { message: string } | null }> {
  eq(column: string, value: unknown): Del;
}
interface Table {
  select(columns?: string, opts?: Record<string, unknown>): Sel;
  insert(rows: Row | Row[]): Ins;
  delete(): Del;
}
const db = (client: unknown) => client as unknown as { from(t: string): Table };

const TOKEN = `it-bsd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

function statementOf(txs: AggregatorStatement["transactions"]): AggregatorStatement {
  return { accountId: `acct-${TOKEN}`, transactions: txs };
}

describeIntegration("bank-feed dedupe · real Postgres (42P10 regression)", () => {
  let orgA = "";
  let orgB = "";

  beforeAll(async () => {
    // createAdminClient() (used by createAdminGateway) reads NEXT_PUBLIC_SUPABASE_URL.
    // In CI both names are exported; locally only SUPABASE_URL may be set.
    if (!process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_URL) {
      process.env.NEXT_PUBLIC_SUPABASE_URL = process.env.SUPABASE_URL;
    }
    const svc = db(serviceClient());

    const a = await svc
      .from("organizations")
      .insert({ name: "Bank Dedupe A", slug: `${TOKEN}-a` })
      .select("id")
      .single();
    expect(a.error, a.error?.message).toBeNull();
    orgA = String(a.data?.id ?? "");

    const b = await svc
      .from("organizations")
      .insert({ name: "Bank Dedupe B", slug: `${TOKEN}-b` })
      .select("id")
      .single();
    expect(b.error, b.error?.message).toBeNull();
    orgB = String(b.data?.id ?? "");
  });

  afterAll(async () => {
    const svc = db(serviceClient());
    // Cascade deletes bank_statements → bank_statement_lines.
    if (orgA) await svc.from("organizations").delete().eq("id", orgA);
    if (orgB) await svc.from("organizations").delete().eq("id", orgB);
  });

  /** Read back the provider_tx_id set + NULL count for an org (ground truth). */
  async function linesOf(org: string): Promise<{ ids: string[]; nullCount: number }> {
    const svc = db(serviceClient());
    const { data, error } = await svc
      .from("bank_statement_lines")
      .select("provider_tx_id")
      .eq("org_id", org);
    expect(error, error?.message).toBeNull();
    const ids: string[] = [];
    let nullCount = 0;
    for (const r of (data as Array<{ provider_tx_id: string | null }>) ?? []) {
      if (r.provider_tx_id) ids.push(r.provider_tx_id);
      else nullCount += 1;
    }
    return { ids, nullCount };
  }

  it("(a) inserts new provider_tx rows via the real upsert — no 42P10", async () => {
    const gw = createAdminGateway();
    const stmt = statementOf([
      { id: `${TOKEN}-tx-1`, bookedAt: "2026-01-15T09:00:00Z", amount: 100, direction: "credit", description: "invoice 1" },
      { id: `${TOKEN}-tx-2`, bookedAt: "2026-01-16T09:00:00Z", amount: 50, direction: "debit", description: "supplier" },
    ]);
    const statementId = await gw.createStatement(orgA, `${TOKEN} feed`, 2);
    const rows = mapStatementToLines(stmt, { orgId: orgA, bankStatementId: statementId });

    // The exact primitive that raised 42P10 against the partial index. If the
    // index were still partial this line throws; the assertion is that it does not.
    await expect(gw.insertLines(rows)).resolves.toBeUndefined();

    const { ids } = await linesOf(orgA);
    expect(ids.sort()).toEqual([`${TOKEN}-tx-1`, `${TOKEN}-tx-2`].sort());
  });

  it("(b) a re-run over an overlapping window inserts ZERO duplicates (DB-level dedupe)", async () => {
    const gw = createAdminGateway();

    // The engine's app-level dedupe read is org-pinned and sees the prior rows...
    const existing = await gw.existingProviderTxIds(orgA, [`${TOKEN}-tx-1`, `${TOKEN}-tx-3`]);
    expect(existing.has(`${TOKEN}-tx-1`)).toBe(true);
    expect(existing.has(`${TOKEN}-tx-3`)).toBe(false);

    // ...and even bypassing that filter, the ON CONFLICT DO NOTHING upsert is the
    // belt-and-suspenders: re-sending tx-1 (dup) + tx-3 (new) inserts only tx-3.
    const stmt = statementOf([
      { id: `${TOKEN}-tx-1`, bookedAt: "2026-01-15T09:00:00Z", amount: 100, direction: "credit", description: "invoice 1 (again)" },
      { id: `${TOKEN}-tx-3`, bookedAt: "2026-01-17T09:00:00Z", amount: 25, direction: "credit", description: "invoice 3" },
    ]);
    const statementId = await gw.createStatement(orgA, `${TOKEN} feed re-run`, 2);
    const rows = mapStatementToLines(stmt, { orgId: orgA, bankStatementId: statementId });
    await expect(gw.insertLines(rows)).resolves.toBeUndefined();

    const { ids } = await linesOf(orgA);
    // tx-1 not duplicated; tx-3 added.
    expect(ids.filter((id) => id === `${TOKEN}-tx-1`)).toHaveLength(1);
    expect(ids.sort()).toEqual(
      [`${TOKEN}-tx-1`, `${TOKEN}-tx-2`, `${TOKEN}-tx-3`].sort(),
    );
  });

  it("(c) multiple CSV NULL-provider_tx_id rows coexist under the unique index", async () => {
    const gw = createAdminGateway();
    const statementId = await gw.createStatement(orgA, `${TOKEN} csv`, 3);
    const nullRows = [0, 1, 2].map((i) => ({
      org_id: orgA,
      bank_statement_id: statementId,
      posted_at: "2026-02-01",
      amount: 10 + i,
      description: `csv row ${i}`,
      reference: null,
      provider_tx_id: null as string | null,
    }));
    await expect(gw.insertLines(nullRows)).resolves.toBeUndefined();

    const { nullCount } = await linesOf(orgA);
    expect(nullCount).toBe(3);
  });

  it("(d) #456 — dedupe is org-pinned: same tx id in another org neither seen nor blocked", async () => {
    const gw = createAdminGateway();

    // orgB has none of orgA's ids, even though they exist for orgA.
    const seenByB = await gw.existingProviderTxIds(orgB, [`${TOKEN}-tx-1`]);
    expect(seenByB.size).toBe(0);

    // The unique index is (org_id, provider_tx_id): the SAME aggregator tx id
    // inserts cleanly under orgB (no cross-tenant collision).
    const stmt = statementOf([
      { id: `${TOKEN}-tx-1`, bookedAt: "2026-01-15T09:00:00Z", amount: 100, direction: "credit", description: "org B, same tx id" },
    ]);
    const statementId = await gw.createStatement(orgB, `${TOKEN} feed B`, 1);
    const rows = mapStatementToLines(stmt, { orgId: orgB, bankStatementId: statementId });
    await expect(gw.insertLines(rows)).resolves.toBeUndefined();

    const { ids } = await linesOf(orgB);
    expect(ids).toEqual([`${TOKEN}-tx-1`]);
  });
});
