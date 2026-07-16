import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Overdue-invoice scheduler — domain-boundary + wiring contract.
 *
 * The behavioural proof (eligibility, once-ever, concurrency) is the
 * real-Postgres integration suite. This pins the boundaries that the CEO
 * directive drew in hard lines, on source, so a future edit can't quietly cross
 * them: no billing emitter, no invoice_reminders write, no status mutation, and
 * idempotency delegated to the dispatcher rather than reinvented.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

/**
 * Source with comments stripped.
 *
 * Negative assertions ("never touches invoice_reminders", "no sent_at
 * derivation") must run against CODE only: the scheduler legitimately NAMES
 * those forbidden things in its header to explain why it avoids them, and prose
 * describing a boundary must not be read as crossing it. This is the recurring
 * lesson from prior increments — a doc comment is not an implementation.
 */
const readCode = (p: string) =>
  read(p)
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    })
    .join("\n");

const SCHED = read("lib/invoices/overdue-scheduler.ts");
const SCHED_CODE = readCode("lib/invoices/overdue-scheduler.ts");
const ROUTE = read("app/api/cron/overdue-invoices/route.ts");
const VERCEL = read("vercel.json");

describe("overdue scheduler — uses the canonical authority", () => {
  it("queries with the shared collectable-status set + due_date predicate", () => {
    expect(SCHED).toMatch(/OVERDUE_COLLECTABLE_STATUSES/);
    expect(SCHED).toMatch(/\.lt\("due_date", todayIso\)/);
    expect(SCHED).toMatch(/from "@\/lib\/invoices\/overdue"/);
  });

  it("does not re-derive overdue — no inline predicate", () => {
    expect(SCHED_CODE).not.toMatch(/sent_at/);
    expect(SCHED_CODE).not.toMatch(/30 \* 86_400_000|thirtyDays/);
  });
});

describe("overdue scheduler — fires only the tenant event", () => {
  it("dispatches invoice.overdue through the shared dispatcher", () => {
    expect(SCHED).toMatch(/dispatchAutomation\(/);
    expect(SCHED).toMatch(/type: "invoice\.overdue"/);
  });

  it("delegates ALL idempotency to the dispatcher — no dedupe of its own", () => {
    // The scheduler must hold no state: it never reads automation_runs to
    // decide, never keeps its own "seen" ledger, never queries invoice_reminders
    // as a proxy. The dispatcher's atomic claim is the sole gate. (The
    // `skipped_already` field is just a COUNTER of what the dispatcher reported —
    // not a dedupe mechanism — so it's matched precisely rather than by keyword.)
    expect(SCHED_CODE).not.toMatch(/from\("automation_runs"\)/);
    expect(SCHED_CODE).not.toMatch(/new Set\(|seenIds|dispatchedIds/);
    // The scheduler reads exactly ONE table — invoices. Anything else would be
    // some form of its own dedupe/ledger. Pin the single reader precisely.
    const froms = [...SCHED_CODE.matchAll(/\.from\("(\w+)"\)/g)].map((m) => m[1]);
    expect(froms).toEqual(["invoices"]);
  });
});

describe("overdue scheduler — domain boundaries (the hard NOs)", () => {
  it("never calls the CrewFlow subscription-billing emitter", () => {
    expect(SCHED_CODE).not.toMatch(/notifyOnOverdueInvoice/);
    expect(SCHED_CODE).not.toMatch(/billing\.invoice_overdue/);
  });

  it("never writes to invoice_reminders", () => {
    expect(SCHED_CODE).not.toMatch(/invoice_reminders/);
  });

  it("never writes invoice status (least of all 'overdue')", () => {
    expect(SCHED_CODE).not.toMatch(/\.update\(/);
    expect(SCHED_CODE).not.toMatch(/status:\s*["']overdue["']/);
  });

  it("does not import the reminders route or its email path", () => {
    expect(SCHED_CODE).not.toMatch(/invoice-reminders|send-invoice|sendInvoiceEmail/);
  });
});

describe("overdue scheduler — surfaces DB errors, does not swallow them", () => {
  it("throws on a scan query error so telemetry records a failure", () => {
    expect(SCHED).toMatch(/if \(error\)/);
    expect(SCHED).toMatch(/throw new Error\(`overdue scan query failed/);
  });
});

describe("overdue cron route — auth + telemetry + its own schedule", () => {
  it("is gated by cron auth and returns 401 unauthorised", () => {
    expect(ROUTE).toMatch(/isCronAuthorised\(request\)/);
    expect(ROUTE).toMatch(/status: 401/);
  });

  it("runs inside withCronTelemetry (always JSON-safe, 500 on throw)", () => {
    expect(ROUTE).toMatch(/withCronTelemetry\("overdue-invoices"/);
    expect(ROUTE).toMatch(/runOverdueScan\(\)/);
  });

  it("is registered as its OWN cron, distinct from invoice-reminders", () => {
    expect(VERCEL).toMatch(/"\/api\/cron\/overdue-invoices"/);
    // Different path AND a different time from the reminders cron (0 9 vs 30 9).
    const cfg = JSON.parse(VERCEL) as { crons: Array<{ path: string; schedule: string }> };
    const overdue = cfg.crons.find((c) => c.path === "/api/cron/overdue-invoices");
    const reminders = cfg.crons.find((c) => c.path === "/api/cron/invoice-reminders");
    expect(overdue).toBeDefined();
    expect(reminders).toBeDefined();
    expect(overdue!.schedule).not.toBe(reminders!.schedule);
  });

  it("gives the scan real headroom, within the 15-minute claim lease", () => {
    expect(ROUTE).toMatch(/maxDuration = 300/);
  });
});
