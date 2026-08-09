import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { notifyOnPaymentProofUploaded } from "@/lib/notifications/events";
import { EVENT_HELPERS } from "@/lib/notifications/events";
import { NOTIFICATION_CATEGORY_LABEL } from "@/lib/notifications/types";

/**
 * Payment-proof submission notification.
 *
 * The portal tells a customer "{org} will confirm here once it's matched to
 * your payment", and the staff proof panel on the invoice exists — but nothing
 * announced that a proof had arrived, so the promise depended on someone
 * happening to open that invoice. This closes it with the EXISTING notification
 * substrate: one pure emitter + one emit call. No new table, no migration, no
 * second mechanism.
 *
 * The emitter is a pure function, so it is tested BEHAVIOURALLY here (unlike
 * the server action, which per repo convention is pinned on source — see the
 * header of __tests__/payments/record-payment.test.ts).
 *
 * The isolation argument: `customerOrgWide` sets audience 'customer' with
 * user_id null. In Support OS terms 'customer' means the CrewFlow customer =
 * THIS TENANT, and the notifications RLS resolves (audience customer, user_id
 * null, org_id) to every member of that org. So org_id is the entire isolation
 * boundary, and the end-customer — who has no user row and no org membership —
 * can never be a recipient.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

const ACTION = read("app/customer-portal/_upload-action.ts");
const EVENTS = read("lib/notifications/events.ts");

const sample = () =>
  notifyOnPaymentProofUploaded({
    org_id: "org-a",
    upload_id: "upload-1",
    invoice_id: "inv-1",
    invoice_number: "INV-1042",
    customer_id: "cust-1",
    customer_name: "Jane Homeowner",
    filename: "bank-transfer.pdf",
    customer_note: "Paid via Faster Payments",
  });

// =====================================================================
// The emitter — behavioural
// =====================================================================

describe("notifyOnPaymentProofUploaded — organisation-scoped, never the customer", () => {
  it("targets the ORG org-wide: audience 'customer', user_id null", () => {
    const n = sample();
    expect(n.org_id).toBe("org-a");
    expect(n.audience).toBe("customer");
    // user_id null + org_id is what the RLS resolves to "every member of this
    // org". A concrete user_id would narrow it to one person.
    expect(n.user_id).toBeNull();
  });

  it("carries no cross-organisation recipient — org_id is the only routing key", () => {
    const n = sample();
    expect(JSON.stringify(n)).not.toMatch(/org-b/);
    expect(n.org_id).toBe("org-a");
  });

  it("identifies the customer, the invoice AND the proof", () => {
    const n = sample();
    expect(n.title).toContain("Jane Homeowner");
    expect(n.title).toContain("INV-1042");
    expect(n.body).toContain("bank-transfer.pdf");
  });

  it("links staff to the existing invoice view that hosts the proof panel", () => {
    expect(sample().action_url).toBe("/invoices/inv-1");
  });

  it("ties the notification to exactly one upload via source_id", () => {
    // portal_uploads' primary key — the authoritative record's own id.
    const n = sample();
    expect(n.source_id).toBe("upload-1");
    expect(n.source_module).toBe("payments");
    expect(n.metadata).toMatchObject({
      invoice_id: "inv-1",
      customer_id: "cust-1",
      upload_id: "upload-1",
    });
  });

  it("surfaces the customer's own note when they left one", () => {
    expect(sample().body).toContain("Paid via Faster Payments");
  });

  it("degrades gracefully when the note or invoice number is absent", () => {
    const n = notifyOnPaymentProofUploaded({
      org_id: "org-a",
      upload_id: "u",
      invoice_id: "i",
      invoice_number: null,
      customer_id: "c",
      customer_name: "Jane",
      filename: "p.pdf",
      customer_note: null,
    });
    expect(n.title).toContain("an invoice");
    expect(n.body).not.toMatch(/Their note:/);
    expect(n.body).not.toMatch(/null|undefined/);
  });

  it("uses an existing category that labels correctly — no migration needed", () => {
    const n = sample();
    // The category CHECK cannot be widened without a migration, so this must be
    // an existing value. 'stripe' is CrewFlow's own subscription events; a
    // tenant's bank-transfer proof filed there would pollute that filter.
    expect(n.category).toBe("billing");
    expect(NOTIFICATION_CATEGORY_LABEL[n.category]).toBe("Billing");
    expect(n.priority).toBe("medium");
  });

  it("is registered in the stable helper list", () => {
    expect(EVENT_HELPERS).toContain("notifyOnPaymentProofUploaded");
  });

  it("stays pure — no I/O in the events module", () => {
    expect(EVENTS).not.toMatch(/createClient|createAdminClient|await /);
  });
});

// =====================================================================
// The wiring — source contract
// =====================================================================

describe("upload action — emits once, only on full success", () => {
  it("reuses the existing substrate: emitNotifications + the pure emitter", () => {
    expect(ACTION).toMatch(
      /import \{ emitNotifications \} from "@\/server\/services\/notifications-service"/,
    );
    expect(ACTION).toMatch(
      /import \{ notifyOnPaymentProofUploaded \} from "@\/lib\/notifications\/events"/,
    );
  });

  it("introduces no second notification mechanism", () => {
    // No bespoke insert into notifications, no new queue, no direct email.
    expect(ACTION).not.toMatch(/from\("notifications"/);
    expect(ACTION).not.toMatch(/notification_email_queue/);
    expect(ACTION).not.toMatch(/sendEmail|resend/i);
  });

  it("emits EXACTLY ONCE — a single call site", () => {
    const calls = ACTION.match(/emitNotifications\(/g) ?? [];
    expect(calls).toHaveLength(1);
  });

  it("emits only AFTER the authoritative portal_uploads insert", () => {
    const insertIdx = ACTION.indexOf('.insert({');
    const insErrIdx = ACTION.indexOf("if (insErr)");
    const emitIdx = ACTION.indexOf("emitNotifications(");
    expect(insertIdx).toBeGreaterThan(-1);
    expect(insErrIdx).toBeGreaterThan(insertIdx);
    // The record-failed branch sits between the insert and the emit, and
    // backTo() is typed `never`, so a failed record can never reach the emit.
    expect(emitIdx).toBeGreaterThan(insErrIdx);
  });

  it("a failed storage upload cannot notify", () => {
    const uploadFailIdx = ACTION.indexOf('backTo(token, invoiceId, "upload_failed")');
    const emitIdx = ACTION.indexOf("emitNotifications(");
    expect(uploadFailIdx).toBeGreaterThan(-1);
    expect(uploadFailIdx).toBeLessThan(emitIdx);
  });

  it("a failed record cannot notify (and still cleans up the orphan file)", () => {
    const recordFailIdx = ACTION.indexOf('backTo(token, invoiceId, "record_failed")');
    const emitIdx = ACTION.indexOf("emitNotifications(");
    expect(recordFailIdx).toBeGreaterThan(-1);
    expect(recordFailIdx).toBeLessThan(emitIdx);
    expect(ACTION).toMatch(/\.remove\(\[storagePath\]\)/);
  });

  it("keeps the failure branches terminal (backTo returns never)", () => {
    expect(ACTION).toMatch(/function backTo\([^)]*\): never/);
  });

  it("passes the upload's own id as the notification's key", () => {
    expect(ACTION).toMatch(/upload_id: uploadId/);
    expect(ACTION).toMatch(/id: uploadId/); // the portal_uploads insert
  });

  it("does not change payment matching or recording behaviour", () => {
    expect(ACTION).not.toMatch(/invoice_payments/);
    expect(ACTION).not.toMatch(/status:/);
  });

  it("leaves the upload's existing guards intact", () => {
    expect(ACTION).toMatch(/consume\("portal_write"/);
    expect(ACTION).toMatch(/ALLOWED_MIME/);
    expect(ACTION).toMatch(/MAX_BYTES/);
    expect(ACTION).toMatch(/invoice_not_yours/);
    expect(ACTION).toMatch(/recordAdminActivity/);
  });

  it("still scopes the invoice ownership check to this org AND customer", () => {
    expect(ACTION).toMatch(/\.eq\("org_id", customer\.org_id\)/);
    // Ownership resolves via the ONE authority (invoiceCustomerId), not the
    // quote-only chain — so a quote-less invoice still authorises its owner.
    expect(ACTION).toMatch(/invoiceCustomerId\(inv\) !== customer\.id/);
  });
});
