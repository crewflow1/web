import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { describeIntegration, serviceClient } from "../_harness";

/**
 * Wave A.5 hardening (A5.1) — CIS statement-email idempotency, proven against a
 * LIVE Postgres with migration 20261217000000 applied.
 *
 * THE DEFECT. server/services/cis-statement-emails.ts queues a subcontractor's
 * CIS payment & deduction statement onto the shared outbound email queue exactly
 * once. It used to enforce that with a check-then-insert in app code: read the
 * subjects already queued, then insert the rest. Two simultaneous admin clicks
 * (or a retried server action) can both read before either inserts, both miss the
 * other, and both queue the SAME statement — the subcontractor is emailed a tax
 * document twice.
 *
 * THE FIX, WHICH THIS TIER PROVES AT THE DATABASE. A dedicated
 * `cis_statement_key` column (the statement number) plus the unique index
 * `notification_email_queue_cis_statement_uniq (org_id, cis_statement_key)` makes
 * "one queued email per (org, statement)" a database invariant, and the service
 * writes with `upsert ... ON CONFLICT DO NOTHING`. What a mock cannot show, and
 * this proves against the real index:
 *
 *   • a duplicate request queues ONE row, not two;
 *   • two CONCURRENT requests for the same statement settle to ONE row with NO
 *     error surfaced to either caller (the loser is silently ignored);
 *   • a genuine second statement (a new number, e.g. a reissue) still queues —
 *     the guard is narrow, not a blanket lock;
 *   • the retry path is preserved: a row that FAILED to send is not re-queued
 *     (the drain retries it in place), so no duplicate email is manufactured;
 *   • tenant isolation: org B queuing the SAME statement number never collides
 *     with org A and never sees org A's row;
 *   • NON-CIS emails (NULL key) are exempt — the shared queue's other flows can
 *     still queue many rows with identical subjects.
 *
 * The service itself reads statements through the cookie-bound RLS client, which a
 * headless test cannot mint; this tier therefore drives the EXACT write path the
 * service uses — the service-role client's `upsert(onConflict, ignoreDuplicates)`
 * against `notification_email_queue` — and a source pin below proves the service
 * is wired to that path and populates `cis_statement_key`.
 *
 * Runs only against a live DB (describeIntegration): skips locally with no DB,
 * fails loudly in CI if the DB is missing. All fixtures are deleted on teardown
 * (queue rows cascade with their org).
 */

type Res<T> = { data: T | null; error: { message: string } | null };
type Thenable<T> = PromiseLike<Res<T>>;
type Row = Record<string, unknown>;
interface Sel extends Thenable<Row[]> {
  eq(column: string, value: unknown): Sel;
  in(column: string, values: ReadonlyArray<unknown>): Sel;
  order(column: string, opts?: { ascending?: boolean }): Sel;
}
interface UpsertChain extends Thenable<Row[]> {
  select(columns?: string): Sel;
}
interface UpdChain extends Thenable<Row[]> {
  eq(column: string, value: unknown): UpdChain;
}
interface DelChain extends PromiseLike<{ error: { message: string } | null }> {
  in(column: string, values: ReadonlyArray<unknown>): DelChain;
}
interface Table {
  select(columns?: string): Sel;
  insert(rows: Row | Row[]): { select(columns?: string): Sel };
  upsert(
    rows: Row | Row[],
    opts: { onConflict: string; ignoreDuplicates: boolean },
  ): UpsertChain;
  update(values: Row): UpdChain;
  delete(): DelChain;
}
interface Db {
  from(table: string): Table;
}
const db = (client: unknown): Db => client as unknown as Db;

const PREFIX = "Your CIS payment and deduction statement";
const rand = () => Math.random().toString(36).slice(2, 10);

/** A queue row exactly as server/services/cis-statement-emails.ts builds it. */
function cisRow(orgId: string, statementNumber: string, toEmail: string): Row {
  return {
    notification_id: null,
    org_id: orgId,
    user_id: null,
    to_email: toEmail,
    reply_to_email: null,
    subject: `${PREFIX} ${statementNumber}`,
    cis_statement_key: statementNumber,
    body_text: `statement ${statementNumber}`,
    body_html: null,
    status: "queued",
    retry_count: 0,
    last_error: null,
    provider: null,
    provider_message_id: null,
    scheduled_for: new Date().toISOString(),
  };
}

const UPSERT = { onConflict: "org_id,cis_statement_key", ignoreDuplicates: true } as const;

describeIntegration("CIS statement-email idempotency (real Postgres)", () => {
  const svc = db(serviceClient());
  const token = `a5cis${rand()}`;
  let orgA = "";
  let orgB = "";

  async function makeOrg(suffix: string): Promise<string> {
    const { data, error } = await svc
      .from("organizations")
      .insert({ name: `${token}-${suffix}`, slug: `${token}-${suffix}` })
      .select("id");
    if (error) throw new Error(`org fixture: ${error.message}`);
    const id = (data as Array<{ id: string }>)[0]?.id;
    if (!id) throw new Error("org fixture: no id returned");
    return String(id);
  }

  async function queueRowsFor(orgId: string, key: string): Promise<number> {
    const { data, error } = await svc
      .from("notification_email_queue")
      .select("id")
      .eq("org_id", orgId)
      .eq("cis_statement_key", key);
    if (error) throw new Error(`count: ${error.message}`);
    return (data ?? []).length;
  }

  beforeAll(async () => {
    orgA = await makeOrg("a");
    orgB = await makeOrg("b");
  });

  afterAll(async () => {
    // queue rows cascade on organizations delete (org_id FK on delete cascade).
    if (orgA || orgB) await svc.from("organizations").delete().in("id", [orgA, orgB]);
  });

  it("a duplicate request queues exactly one row", async () => {
    const key = `${token}-DUP`;
    const first = await svc
      .from("notification_email_queue")
      .upsert(cisRow(orgA, key, "sub@dup.test"), UPSERT)
      .select("id");
    expect(first.error, first.error?.message).toBeNull();
    expect(first.data).toHaveLength(1);

    const again = await svc
      .from("notification_email_queue")
      .upsert(cisRow(orgA, key, "sub@dup.test"), UPSERT)
      .select("id");
    expect(again.error, again.error?.message).toBeNull(); // no error surfaced
    expect(again.data).toHaveLength(0); // nothing new inserted

    expect(await queueRowsFor(orgA, key)).toBe(1);
  });

  it("two concurrent requests settle to one row with no error to either caller", async () => {
    const key = `${token}-RACE`;
    const [a, b] = await Promise.all([
      svc.from("notification_email_queue").upsert(cisRow(orgA, key, "r@x.test"), UPSERT).select("id"),
      svc.from("notification_email_queue").upsert(cisRow(orgA, key, "r@x.test"), UPSERT).select("id"),
    ]);
    expect(a.error, a.error?.message).toBeNull();
    expect(b.error, b.error?.message).toBeNull();
    // Exactly one of the two actually inserted; the other was a silent no-op.
    const inserted = (a.data?.length ?? 0) + (b.data?.length ?? 0);
    expect(inserted).toBe(1);
    expect(await queueRowsFor(orgA, key)).toBe(1);
  });

  it("a genuinely different statement (e.g. a reissue's new number) still queues", async () => {
    const orig = `${token}-0001`;
    const reissue = `${token}-0002`;
    await svc.from("notification_email_queue").upsert(cisRow(orgA, orig, "s@x.test"), UPSERT).select("id");
    // Re-run over the original: no new row.
    const rerun = await svc
      .from("notification_email_queue")
      .upsert(cisRow(orgA, orig, "s@x.test"), UPSERT)
      .select("id");
    expect(rerun.data).toHaveLength(0);
    // The reissue carries a NEW number → correctly queued again.
    const fresh = await svc
      .from("notification_email_queue")
      .upsert(cisRow(orgA, reissue, "s@x.test"), UPSERT)
      .select("id");
    expect(fresh.error, fresh.error?.message).toBeNull();
    expect(fresh.data).toHaveLength(1);
    expect(await queueRowsFor(orgA, orig)).toBe(1);
    expect(await queueRowsFor(orgA, reissue)).toBe(1);
  });

  it("a failed send is retried in place, never re-queued as a duplicate", async () => {
    const key = `${token}-FAIL`;
    await svc.from("notification_email_queue").upsert(cisRow(orgA, key, "f@x.test"), UPSERT).select("id");
    // The drain marks a genuine send failure on the SAME row (an UPDATE), leaving
    // it to be retried — it does not insert a new row.
    const failed = await svc
      .from("notification_email_queue")
      .update({ status: "failed", retry_count: 1, last_error: "smtp timeout" })
      .eq("org_id", orgA)
      .eq("cis_statement_key", key);
    expect((failed as unknown as Res<Row[]>).error).toBeNull();
    // Re-running the queue action does NOT manufacture a second email...
    const rerun = await svc
      .from("notification_email_queue")
      .upsert(cisRow(orgA, key, "f@x.test"), UPSERT)
      .select("id");
    expect(rerun.data).toHaveLength(0);
    // ...and the single row survives, still available for the drain to retry.
    expect(await queueRowsFor(orgA, key)).toBe(1);
    const { data } = await svc
      .from("notification_email_queue")
      .select("status")
      .eq("org_id", orgA)
      .eq("cis_statement_key", key);
    expect((data as Array<{ status: string }>)[0]?.status).toBe("failed");
  });

  it("tenant isolation: org B may queue the same statement number without colliding", async () => {
    const key = `${token}-SHARED`;
    const a = await svc.from("notification_email_queue").upsert(cisRow(orgA, key, "a@x.test"), UPSERT).select("id");
    const b = await svc.from("notification_email_queue").upsert(cisRow(orgB, key, "b@x.test"), UPSERT).select("id");
    expect(a.data).toHaveLength(1);
    expect(b.data, b.error?.message).toHaveLength(1); // different org, no collision
    expect(await queueRowsFor(orgA, key)).toBe(1);
    expect(await queueRowsFor(orgB, key)).toBe(1);
  });

  it("non-CIS emails (NULL key) are exempt — the shared queue's other flows are untouched", async () => {
    const base = {
      notification_id: null,
      org_id: orgA,
      user_id: null,
      to_email: "digest@x.test",
      subject: "Your weekly digest", // identical subject, twice — legitimate
      cis_statement_key: null,
      body_text: "digest",
      status: "queued",
      scheduled_for: new Date().toISOString(),
    } satisfies Row;
    const r = await svc
      .from("notification_email_queue")
      .upsert([base, { ...base }], UPSERT)
      .select("id");
    expect(r.error, r.error?.message).toBeNull();
    expect(r.data).toHaveLength(2); // NULLs are distinct — both coexist
  });

  it("the service is wired to the DB guard (source pin)", () => {
    const src = readFileSync(
      resolve(__dirname, "..", "..", "..", "server", "services", "cis-statement-emails.ts"),
      "utf8",
    );
    // Populates the idempotency key and writes via ON CONFLICT DO NOTHING.
    expect(src).toMatch(/cis_statement_key:\s*q\.statementNumber/);
    expect(src).toMatch(/\.upsert\(/);
    expect(src).toMatch(/onConflict:\s*"org_id,cis_statement_key"/);
    expect(src).toMatch(/ignoreDuplicates:\s*true/);
  });
});
