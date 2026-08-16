import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  notifyOnCustomerFileUploaded,
  EVENT_HELPERS,
} from "@/lib/notifications/events";

/**
 * Portal completion R4 — general "send us a file" upload + staff inbox.
 *
 * Extends the proven portal_uploads / portal-uploads bucket pattern beyond
 * kind='payment_proof' to a customer-scoped general file, anchored to the
 * customer themselves (target_table='customers'), with a staff-visible inbox on
 * the customer detail page. Every read/write is customer + org + kind scoped so
 * a customer only ever touches their OWN files and staff only ever see the
 * active org's. Pure emitter tested behaviourally; IO pinned on SOURCE.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

const UPLOAD = read("app/customer-portal/_customer-file-action.ts");
const PORTAL_READ = read("app/customer-portal/_customer-files.ts");
const STAFF_INBOX = read("lib/customers/portal-file-inbox.ts");
const CUSTOMER_PAGE = read("app/(app)/customers/[id]/page.tsx");
const MIGRATION = read(
  "supabase/migrations/20261167000000_portal_completion.sql",
);
const ORG_TABLES = read("lib/gdpr/org-tables.json");

// =====================================================================
// The upload action — token-derived scope, never request input
// =====================================================================

describe("uploadCustomerFile — token-resolved scope, validated, rate-limited", () => {
  it("resolves the customer via the ONE portal authority", () => {
    expect(UPLOAD).toMatch(/loadCustomerByPortalToken\(token\)/);
  });

  it("rate-limits portal writes", () => {
    expect(UPLOAD).toMatch(/consume\("portal_write", token/);
  });

  it("validates MIME allowlist + a 10MB cap", () => {
    expect(UPLOAD).toMatch(/ALLOWED_MIME/);
    expect(UPLOAD).toMatch(/MAX_BYTES = 10 \* 1024 \* 1024/);
  });

  it("keys org, customer AND storage path off the RESOLVED customer, not the body", () => {
    expect(UPLOAD).toMatch(/org_id: customer\.org_id/);
    expect(UPLOAD).toMatch(/customer_id: customer\.id/);
    expect(UPLOAD).toMatch(
      /storagePath = `\$\{customer\.org_id\}\/\$\{customer\.id\}\//,
    );
  });

  it("anchors to the customer with the dedicated kind (not payment_proof)", () => {
    expect(UPLOAD).toMatch(/target_table: "customers"/);
    expect(UPLOAD).toMatch(/target_id: customer\.id/);
    expect(UPLOAD).toMatch(/kind: "customer_file"/);
    expect(UPLOAD).not.toMatch(/kind: "payment_proof"/);
  });

  it("cleans up the orphan file if the row insert fails", () => {
    expect(UPLOAD).toMatch(/\.remove\(\[storagePath\]\)/);
  });

  it("notifies the org exactly once, only after both writes land", () => {
    const calls = UPLOAD.match(/emitNotifications\(/g) ?? [];
    expect(calls).toHaveLength(1);
    const insertIdx = UPLOAD.indexOf('.insert({');
    const emitIdx = UPLOAD.indexOf("emitNotifications(");
    expect(emitIdx).toBeGreaterThan(insertIdx);
  });
});

// =====================================================================
// The portal read-back — customer sees only their OWN files
// =====================================================================

describe("listCustomerFiles / customerFileSignedUrl — customer+org+kind scoped", () => {
  it("filters the list by customer_id AND org_id AND kind", () => {
    expect(PORTAL_READ).toMatch(/\.eq\("customer_id", customerId\)/);
    expect(PORTAL_READ).toMatch(/\.eq\("org_id", orgId\)/);
    expect(PORTAL_READ).toMatch(/\.eq\("kind", "customer_file"\)/);
  });

  it("scopes the signed-URL lookup identically before minting a URL", () => {
    expect(PORTAL_READ).toMatch(/\.eq\("id", uploadId\)/);
    expect(PORTAL_READ).toMatch(/\.eq\("customer_id", customerId\)/);
    expect(PORTAL_READ).toMatch(/\.eq\("org_id", orgId\)/);
    expect(PORTAL_READ).toMatch(/\.eq\("kind", "customer_file"\)/);
    expect(PORTAL_READ).toMatch(/createSignedUrl\(row\.storage_path, 60\)/);
  });
});

// =====================================================================
// The staff inbox — active-org isolation on the RLS-bypassing client
// =====================================================================

describe("listStaffCustomerFiles — org isolation is the boundary", () => {
  it("runs on the admin client scoped by org_id, customer_id AND kind", () => {
    expect(STAFF_INBOX).toMatch(/createAdminClient/);
    expect(STAFF_INBOX).toMatch(/\.eq\("org_id", orgId\)/);
    expect(STAFF_INBOX).toMatch(/\.eq\("customer_id", customerId\)/);
    expect(STAFF_INBOX).toMatch(/\.eq\("kind", "customer_file"\)/);
  });

  it("is invoked with the ACTIVE org pin from the customer page", () => {
    expect(CUSTOMER_PAGE).toMatch(
      /listStaffCustomerFiles\(ctx\.org\.id, customer\.id\)/,
    );
  });

  it("mints only short-lived signed URLs (private bucket)", () => {
    expect(STAFF_INBOX).toMatch(/createSignedUrl\(f\.storage_path, 60\)/);
  });
});

// =====================================================================
// Migration + GDPR — additive
// =====================================================================

describe("migration widens kind additively; gdpr already covers the table", () => {
  it("adds customer_file while preserving every prior kind value", () => {
    for (const k of [
      "payment_proof",
      "site_photo",
      "signed_doc",
      "message_attachment",
      "customer_file",
      "other",
    ]) {
      expect(MIGRATION).toContain(`'${k}'`);
    }
  });

  it("adds no new column/table — only widens the CHECK", () => {
    expect(MIGRATION).toMatch(/drop constraint if exists portal_uploads_kind_check/);
    expect(MIGRATION).toMatch(/add constraint portal_uploads_kind_check/);
    expect(MIGRATION).not.toMatch(/add column|create table/i);
  });

  it("portal_uploads is already GDPR-registered (no new table to add)", () => {
    expect(ORG_TABLES).toMatch(/"portal_uploads"/);
  });
});

// =====================================================================
// The notification emitter
// =====================================================================

describe("notifyOnCustomerFileUploaded — org-scoped, never another customer", () => {
  const n = notifyOnCustomerFileUploaded({
    org_id: "org-a",
    upload_id: "up-1",
    customer_id: "cust-1",
    customer_name: "Jane",
    filename: "spec.pdf",
  });

  it("targets the org org-wide (audience customer, user_id null)", () => {
    expect(n.org_id).toBe("org-a");
    expect(n.audience).toBe("customer");
    expect(n.user_id).toBeNull();
  });

  it("links staff to the customer detail page (the inbox)", () => {
    expect(n.action_url).toBe("/customers/cust-1");
    expect(n.source_id).toBe("up-1");
  });

  it("carries no cross-org routing", () => {
    expect(JSON.stringify(n)).not.toMatch(/org-b/);
  });

  it("is registered in the stable helper list", () => {
    expect(EVENT_HELPERS).toContain("notifyOnCustomerFileUploaded");
  });
});
