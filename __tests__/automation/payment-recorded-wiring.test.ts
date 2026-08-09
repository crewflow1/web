import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { AUTOMATION_RULES, correlationIdFor } from "@/lib/automation/rules";
// The REAL recipient router (pure, unmocked) — used to prove the emitted
// directive routes to the CUSTOMER, never to organizations.email.
import { resolveEmailRecipient } from "@/lib/notifications/email-routing";

/**
 * `payment.recorded` — the wiring that makes the receipt-email automation real.
 *
 * The dead-rule finding: `send_email_queue`'s only rule
 * (`payment_recorded_email_receipt`, trigger `payment.recorded`) was fully built
 * but NO code ever dispatched `payment.recorded`. Every real payment-recording
 * site only wrote `payment.recorded` to the AUDIT log (recordAdminActivity),
 * never through dispatchAutomation — so enabling the rule did nothing.
 *
 * Two proofs:
 *   1. SOURCE-SCAN — every real customer-payment site now dispatches
 *      `payment.recorded` with the canonical event contract (org-pinned,
 *      best-effort). Mirrors phase4.test.ts §6 (quote.accepted), the established
 *      "is this event source wired?" pattern.
 *   2. BEHAVIOUR — the REAL dispatcher, given `payment.recorded` with the rule
 *      enabled (a per-org override), enqueues exactly ONE receipt email,
 *      idempotently on re-fire, scoped to the event's org. Hermetic: the
 *      automation_runs claim is an in-memory store, the notification bridge is a
 *      spy. (The live-Postgres proof lives in the integration tier.)
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

// =====================================================================
// 1. Source-scan — every real payment site dispatches payment.recorded
// =====================================================================

describe("payment.recorded is wired at every customer-payment site", () => {
  const sites: Array<{ label: string; path: string; source_table: string }> = [
    {
      label: "allocate flow (payments receipt)",
      path: "app/(app)/payments/allocate-actions.ts",
      source_table: '"payments"',
    },
    {
      label: "invoice-detail payment (invoice_payments direct)",
      path: "app/(app)/invoices/[id]/payment-actions.ts",
      source_table: '"invoice_payments"',
    },
    {
      label: "bank-match confirm (invoice_payments from CSV)",
      path: "app/(app)/payments/actions.ts",
      source_table: '"invoice_payments"',
    },
  ];

  for (const site of sites) {
    describe(site.label, () => {
      const src = read(site.path);

      it("imports and calls dispatchAutomation", () => {
        expect(src).toMatch(
          /import \{ dispatchAutomation \} from "@\/server\/services\/automation-dispatcher"/,
        );
        expect(src).toMatch(/dispatchAutomation\(\{/);
      });

      it('dispatches type "payment.recorded"', () => {
        expect(src).toMatch(/type: "payment\.recorded"/);
      });

      it("is org-pinned (org_id passed, never blended)", () => {
        expect(src).toMatch(/org_id: (ctx\.org\.id|inv\.org_id)/);
      });

      it("uses the expected source_table", () => {
        expect(src).toMatch(
          new RegExp(`source_table: ${site.source_table.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
        );
      });

      it("is best-effort — dispatch failure never derails the payment", () => {
        expect(src).toMatch(/dispatchAutomation\([\s\S]*?\}\)\.catch\(\(e\) =>/);
      });
    });
  }

  it("the allocate site keeps its audit write ALONGSIDE the dispatch (not replaced)", () => {
    const src = read("app/(app)/payments/allocate-actions.ts");
    // Both the historical audit AND the engine dispatch must be present.
    expect(src).toMatch(/recordAdminActivity\(\{[\s\S]*?action: "payment\.recorded"/);
    expect(src).toMatch(/dispatchAutomation\(\{[\s\S]*?type: "payment\.recorded"/);
  });

  it("the rule the wiring activates exists, targets payment.recorded, and ships dark", () => {
    const rule = AUTOMATION_RULES.find(
      (r) => r.id === "payment_recorded_email_receipt",
    );
    expect(rule, "payment_recorded_email_receipt must exist").toBeTruthy();
    expect(rule?.trigger).toBe("payment.recorded");
    expect(rule?.actions).toContain("send_email_queue");
    // Dark-safe: no live impact until an org opts in via a per-org override.
    expect(rule?.enabled).toBe(false);
  });
});

// =====================================================================
// 2. Behaviour — real dispatcher enqueues one email, idempotent, org-scoped
// =====================================================================

/**
 * In-memory `automation_runs` — models exactly the two facts the dispatcher's
 * claim depends on: the unique (rule_id, correlation_id) constraint, and that a
 * COMPLETED run (completed_at set) can never be reclaimed. That is enough to
 * prove sequential idempotency without a database. (The concurrent-race proof is
 * a database property and lives in the integration tier by design.)
 */
const hoisted = vi.hoisted(() => {
  type Run = { status: string; completed_at: string | null };
  const store = new Map<string, Run>();
  const key = (ruleId: unknown, corr: unknown) => `${ruleId}::${corr}`;

  // In-memory fixtures for payment → customer recipient resolution. Every table
  // is org-pinned: a read whose org_id filter doesn't match the row resolves to
  // nothing, exactly like the composite-org constraints in the real schema.
  type Row = Record<string, unknown>;
  const fixtures = {
    payments: new Map<string, Row>(),
    invoice_payments: new Map<string, Row>(),
    invoices: new Map<string, Row>(),
    customers: new Map<string, Row>(),
  };
  type FixtureTable = keyof typeof fixtures;
  const isFixtureTable = (t: string): t is FixtureTable => t in fixtures;

  function runsFrom() {
    let op: "insert" | "update" | null = null;
    let row: Record<string, unknown> = {};
    const filters: Record<string, unknown> = {};

    const builder: Record<string, unknown> = {
      insert(r: Record<string, unknown>) {
        op = "insert";
        row = r;
        return builder;
      },
      update(r: Record<string, unknown>) {
        op = "update";
        row = r;
        return builder;
      },
      eq(k: string, v: unknown) {
        filters[k] = v;
        return builder;
      },
      is(k: string, v: unknown) {
        filters[k] = v;
        return builder;
      },
      or() {
        return builder;
      },
      select() {
        if (op === "insert") {
          const k = key(row.rule_id, row.correlation_id);
          if (store.has(k)) return Promise.resolve({ data: [], error: null });
          store.set(k, {
            status: String(row.status),
            completed_at: (row.completed_at as string | null) ?? null,
          });
          return Promise.resolve({ data: [{ id: k }], error: null });
        }
        // update + select == the reclaim path (only reached on conflict).
        const k = key(filters.rule_id, filters.correlation_id);
        const existing = store.get(k);
        // A completed run is never reclaimable → no rows → caller skips.
        if (existing && existing.completed_at == null && existing.status === "failed") {
          existing.status = "running";
          return Promise.resolve({ data: [{ id: k }], error: null });
        }
        return Promise.resolve({ data: [], error: null });
      },
      // Thenable: finishRun awaits `.update().eq().eq()` with no select.
      then(resolveFn: (v: { error: null }) => void) {
        const k = key(filters.rule_id, filters.correlation_id);
        const existing = store.get(k);
        if (existing && op === "update") {
          if (typeof row.status === "string") existing.status = row.status;
          if ("completed_at" in row) {
            existing.completed_at = (row.completed_at as string | null) ?? null;
          }
        }
        resolveFn({ error: null });
        return Promise.resolve();
      },
    };
    return builder;
  }

  // Read builder for the resolution tables: select(cols).eq().eq().maybeSingle(),
  // org-pinned by the id + org_id filters the dispatcher applies on every hop.
  function readFrom(rows: Map<string, Row>) {
    const filters: Record<string, unknown> = {};
    const builder: Record<string, unknown> = {
      select() {
        return builder;
      },
      eq(k: string, v: unknown) {
        filters[k] = v;
        return builder;
      },
      maybeSingle() {
        const rowRec = rows.get(String(filters.id));
        if (!rowRec) return Promise.resolve({ data: null, error: null });
        // Org pin: a mismatched org_id filter reads as nothing.
        if ("org_id" in filters && rowRec.org_id !== filters.org_id) {
          return Promise.resolve({ data: null, error: null });
        }
        return Promise.resolve({ data: rowRec, error: null });
      },
    };
    return builder;
  }

  function makeAdmin() {
    function from(table: string) {
      if (table === "automation_runs") return runsFrom();
      if (isFixtureTable(table)) return readFrom(fixtures[table]);
      throw new Error(`unexpected admin table in test: ${table}`);
    }
    return { from };
  }

  return { store, fixtures, makeAdmin };
});

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => hoisted.makeAdmin(),
}));

vi.mock("@/server/services/notifications-service", () => ({
  emitNotifications: vi.fn(async () => {}),
}));

vi.mock("@/server/services/automation-rules", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/services/automation-rules")>();
  return {
    ...actual,
    // Enable the dark receipt rule for THIS org — the exact per-org override
    // mechanism an org would use from Settings → Automations.
    loadRuleOverridesBestEffort: vi.fn(async () =>
      new Map<string, boolean>([["payment_recorded_email_receipt", true]]),
    ),
  };
});

describe("dispatchAutomation(payment.recorded) — receipt email behaviour", () => {
  const ORG_A = "11111111-1111-1111-1111-111111111111";
  const ORG_B = "22222222-2222-2222-2222-222222222222";
  const CUST_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  const CUST_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
  const EMAIL_A = "alice@customer-a.test";
  const EMAIL_B = "bob@customer-b.test";
  // The org's OWN contact address. The defect emailed receipts HERE.
  const ORG_A_EMAIL = "hello@org-a.test";

  type Note = Record<string, unknown>;
  let dispatchAutomation: typeof import("@/server/services/automation-dispatcher").dispatchAutomation;
  let emitNotifications: ReturnType<typeof vi.fn>;

  /** Every note passed to emitNotifications, flattened across calls. */
  const emittedNotes = (): Note[] =>
    (emitNotifications.mock.calls as Array<[Note[]]>).flatMap((c) => c[0]);

  beforeEach(async () => {
    hoisted.store.clear();
    // Reset + seed the payment → customer resolution fixtures.
    for (const t of Object.values(hoisted.fixtures)) t.clear();
    hoisted.fixtures.payments.set("pay-1", { org_id: ORG_A, customer_id: CUST_A });
    hoisted.fixtures.payments.set("pay-A", { org_id: ORG_A, customer_id: CUST_A });
    hoisted.fixtures.payments.set("pay-B", { org_id: ORG_B, customer_id: CUST_B });
    hoisted.fixtures.customers.set(CUST_A, { org_id: ORG_A, email: EMAIL_A });
    hoisted.fixtures.customers.set(CUST_B, { org_id: ORG_B, email: EMAIL_B });

    const disp = await import("@/server/services/automation-dispatcher");
    dispatchAutomation = disp.dispatchAutomation;
    const notif = await import("@/server/services/notifications-service");
    emitNotifications = notif.emitNotifications as unknown as ReturnType<typeof vi.fn>;
    emitNotifications.mockClear();
  });

  const paymentEvent = (orgId: string, paymentId: string) => ({
    type: "payment.recorded" as const,
    org_id: orgId,
    source_table: "payments",
    source_id: paymentId,
    payload: { amount: 120, method: "bank_transfer", allocations: 1 },
  });

  it("a recorded payment enqueues exactly one receipt email addressed to the CUSTOMER", async () => {
    const res = await dispatchAutomation(paymentEvent(ORG_A, "pay-1"));

    const run = res.ran.find((r) => r.rule_id === "payment_recorded_email_receipt");
    expect(run?.status).toBe("ok");

    // Exactly one notification, carrying the email channel + THIS org.
    expect(emitNotifications).toHaveBeenCalledTimes(1);
    const note = emittedNotes()[0]!;
    expect(note.org_id).toBe(ORG_A);
    expect(note.type).toBe("automation.payment.recorded.email");
    expect(note.audience).toBe("customer");
    expect(note.source_id).toBe("pay-1");
    // The receipt is addressed to the paying CUSTOMER — an explicit `to`, not a
    // blank directive that would route to organizations.email.
    const directive = note.email as { to?: string | null } | undefined;
    expect(directive?.to).toBe(EMAIL_A);
  });

  it("is idempotent — re-firing the same payment does NOT double-queue", async () => {
    const first = await dispatchAutomation(paymentEvent(ORG_A, "pay-1"));
    expect(first.ran.find((r) => r.rule_id === "payment_recorded_email_receipt")?.status).toBe("ok");

    const second = await dispatchAutomation(paymentEvent(ORG_A, "pay-1"));
    // The completed claim is not reclaimable → skipped, no second email.
    expect(second.ran.find((r) => r.rule_id === "payment_recorded_email_receipt")?.status).toBe(
      "skipped",
    );
    expect(emitNotifications).toHaveBeenCalledTimes(1);

    // The correlation identity is stable + payment-id keyed.
    expect(correlationIdFor("payment.recorded", "payments", "pay-1")).toBe(
      "payment.recorded:payments:pay-1",
    );
  });

  it("is org-scoped — each org's payment queues ITS customer's email, never the other's", async () => {
    await dispatchAutomation(paymentEvent(ORG_A, "pay-A"));
    await dispatchAutomation(paymentEvent(ORG_B, "pay-B"));

    expect(emitNotifications).toHaveBeenCalledTimes(2);
    const notes = emittedNotes();
    const orgs = notes.map((n) => n.org_id);
    expect(orgs).toContain(ORG_A);
    expect(orgs).toContain(ORG_B);
    // The org A notification carries org A's id + customer, not org B's, & v.v.
    const a = notes.find((n) => n.source_id === "pay-A")!;
    const b = notes.find((n) => n.source_id === "pay-B")!;
    expect(a.org_id).toBe(ORG_A);
    expect(b.org_id).toBe(ORG_B);
    expect((a.email as { to?: string }).to).toBe(EMAIL_A);
    expect((b.email as { to?: string }).to).toBe(EMAIL_B);
  });

  // ===================================================================
  // 3. THE GUARD THAT FAILED — the receipt must go to the CUSTOMER, and
  //    when no customer email is resolvable it must SKIP, never fall back
  //    to organizations.email. (Red on the pre-fix blank-directive code.)
  // ===================================================================

  it("resolveEmailRecipient sends the emitted receipt to the CUSTOMER, NOT the org address", async () => {
    await dispatchAutomation(paymentEvent(ORG_A, "pay-1"));
    const note = emittedNotes()[0]!;

    // Feed the ACTUAL emitted directive through the REAL router, with the org's
    // own email available as the audience fallback. Pre-fix the directive was
    // blank, so the router returned the ORG address — the bug. Post-fix it must
    // return the customer's address.
    const resolved = resolveEmailRecipient({
      directive: note.email as { to?: string | null } | null,
      audience: "customer",
      orgEmail: ORG_A_EMAIL,
    });
    expect(resolved?.to).toBe(EMAIL_A);
    expect(resolved?.to).not.toBe(ORG_A_EMAIL);
  });

  it("resolves the payer via the invoice_payments → invoice → customer chain", async () => {
    hoisted.fixtures.invoice_payments.set("ip-1", {
      org_id: ORG_A,
      invoice_id: "inv-1",
    });
    hoisted.fixtures.invoices.set("inv-1", { org_id: ORG_A, customer_id: CUST_A });

    await dispatchAutomation({
      type: "payment.recorded",
      org_id: ORG_A,
      source_table: "invoice_payments",
      source_id: "ip-1",
      payload: { amount: 90, invoice_id: "inv-1", source: "manual" },
    });

    expect(emitNotifications).toHaveBeenCalledTimes(1);
    const note = emittedNotes()[0]!;
    expect((note.email as { to?: string }).to).toBe(EMAIL_A);
  });

  it("with NO resolvable customer email it skips-with-ok and NEVER emails the org", async () => {
    // A real payment whose customer has no email on file.
    hoisted.fixtures.payments.set("pay-noemail", {
      org_id: ORG_A,
      customer_id: CUST_A,
    });
    hoisted.fixtures.customers.set(CUST_A, { org_id: ORG_A, email: null });

    const res = await dispatchAutomation(paymentEvent(ORG_A, "pay-noemail"));

    // Skipped cleanly — the run succeeds, and NO notification/email is emitted,
    // so the org address can never receive the receipt as a silent fallback.
    expect(res.ran.find((r) => r.rule_id === "payment_recorded_email_receipt")?.status).toBe("ok");
    expect(emitNotifications).not.toHaveBeenCalled();
  });

  it("a customer-audience receipt directive is never delivered to the org address as a silent fallback", async () => {
    // End-to-end contract: whatever directive the dispatcher emits for a
    // payment.recorded receipt, routing it must NOT land on organizations.email.
    await dispatchAutomation(paymentEvent(ORG_A, "pay-1"));
    const note = emittedNotes()[0]!;
    const resolved = resolveEmailRecipient({
      directive: note.email as { to?: string | null } | null,
      audience: note.audience as "customer",
      orgEmail: ORG_A_EMAIL,
    });
    expect(resolved?.to).not.toBe(ORG_A_EMAIL);
  });
});
