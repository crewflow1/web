import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Phase 3 — Customer Portal verification.
 *
 * The directive's 8 steps map to:
 *   1. Token model           ← existing; unguessable UUID + scoped + revocable
 *   2. Quote portal          ← existing /q/[token] (accept/decline/PDF)
 *   3. Invoice portal        ← existing; this sprint adds payment-proof upload
 *   4. Job progress portal   ← NEW
 *   5. Documents (uploads)   ← NEW (portal_uploads table + bucket)
 *   6. Messaging from portal ← NEW (creates support_tickets row)
 *   7. Branding              ← existing PortalShell
 *   8. Tests                 ← this file
 *
 * Source-content pins each contract. The portal pages are server
 * components — runtime behaviour against the real DB is exercised by
 * the deploy smoke (HTTP 200/404 on the routes).
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

const MIGRATION = read(
  "supabase/migrations/20260620000000_portal_uploads.sql",
);
const PORTAL_BUCKET_LIMITS = read(
  "supabase/migrations/20260711000000_portal_uploads_bucket_limits.sql",
);
const JOBS_PAGE = read("app/customer-portal/[token]/jobs/page.tsx");
const MSG_PAGE = read("app/customer-portal/[token]/messages/page.tsx");
const INV_PAGE = read("app/customer-portal/[token]/invoices/page.tsx");
const MSG_ACTION = read("app/customer-portal/_message-action.ts");
const UPLOAD_ACTION = read("app/customer-portal/_upload-action.ts");
const SHELL = read("app/customer-portal/[token]/_shell.tsx");
const HELPERS = read("app/customer-portal/_helpers.ts");

// =====================================================================
// 1. Token model — pre-existing, but pin the invariants
// =====================================================================

describe("Phase 3 — token model", () => {
  it("portal helper validates UUID shape before DB lookup", () => {
    expect(HELPERS).toMatch(/\^\[0-9a-f\]\{8\}-\[0-9a-f\]\{4\}/);
  });

  it("portal token scopes to a single customer row (customers.portal_token)", () => {
    expect(HELPERS).toMatch(/\.eq\("portal_token", token\)/);
  });

  it("portal load fails closed (null = InvalidLinkPage)", () => {
    expect(HELPERS).toMatch(/if \(!data \|\| !data\.org\) return null/);
  });
});

// =====================================================================
// 2. portal_uploads schema
// =====================================================================

describe("Phase 3 — portal_uploads table + bucket", () => {
  it("migration exists", () => {
    expect(
      existsSync(
        resolve(ROOT, "supabase/migrations/20260620000000_portal_uploads.sql"),
      ),
    ).toBe(true);
  });

  it("polymorphic target with CHECK constraint", () => {
    expect(MIGRATION).toMatch(/target_table\s+text not null/);
    expect(MIGRATION).toMatch(/'invoices'/);
    expect(MIGRATION).toMatch(/'quotes'/);
    expect(MIGRATION).toMatch(/'jobs'/);
  });

  it("kind enum covers payment_proof + message_attachment", () => {
    expect(MIGRATION).toMatch(/'payment_proof'/);
    expect(MIGRATION).toMatch(/'message_attachment'/);
  });

  it("RLS enabled with NO policies (service-role only)", () => {
    expect(MIGRATION).toMatch(/enable row level security/);
    expect(MIGRATION).not.toMatch(/create policy/i);
  });

  it("storage bucket created idempotently", () => {
    expect(MIGRATION).toMatch(/insert into storage\.buckets/);
    expect(MIGRATION).toMatch(/'portal-uploads'/);
    expect(MIGRATION).toMatch(/on conflict \(id\) do nothing/);
  });

  it("bucket carries storage-layer limits matching the app layer", () => {
    // Hardening migration must exist and target the same bucket.
    expect(
      existsSync(
        resolve(
          ROOT,
          "supabase/migrations/20260711000000_portal_uploads_bucket_limits.sql",
        ),
      ),
    ).toBe(true);
    expect(PORTAL_BUCKET_LIMITS).toMatch(/insert into storage\.buckets/);
    expect(PORTAL_BUCKET_LIMITS).toMatch(/'portal-uploads'/);
    // 10 MB, mirroring MAX_BYTES (10 * 1024 * 1024) in _upload-action.ts.
    expect(PORTAL_BUCKET_LIMITS).toMatch(/file_size_limit/);
    expect(PORTAL_BUCKET_LIMITS).toMatch(/10485760/);
    // Allowlist must mirror ALLOWED_MIME exactly — including image/webp, which
    // the runtime Set admits even though the action's prose comment omits it.
    for (const mime of [
      "application/pdf",
      "image/jpeg",
      "image/png",
      "image/heic",
      "image/heif",
      "image/webp",
    ]) {
      expect(PORTAL_BUCKET_LIMITS).toContain(`'${mime}'`);
    }
  });

  it("bucket-limits migration is an idempotent upsert", () => {
    expect(PORTAL_BUCKET_LIMITS).toMatch(/on conflict \(id\) do update set/);
    expect(PORTAL_BUCKET_LIMITS).toMatch(
      /allowed_mime_types = excluded\.allowed_mime_types/,
    );
  });
});

// =====================================================================
// 3. Job portal
// =====================================================================

describe("Phase 3 — /customer-portal/[token]/jobs", () => {
  it("validates portal token + returns InvalidLinkPage on failure", () => {
    expect(JOBS_PAGE).toMatch(/loadCustomerByPortalToken/);
    expect(JOBS_PAGE).toMatch(/InvalidLinkPage/);
  });

  it("scopes the query by BOTH org_id AND customer_id (no cross-org leak)", () => {
    expect(JOBS_PAGE).toMatch(
      /\.eq\("org_id", customer\.org_id\)[\s\S]*\.eq\("customer_id", customer\.id\)/,
    );
  });

  it("renders status badges + assigned tech + scheduled date", () => {
    expect(JOBS_PAGE).toMatch(/STATUS_LABELS/);
    expect(JOBS_PAGE).toMatch(/STATUS_STYLES/);
    expect(JOBS_PAGE).toMatch(/Assigned/);
    expect(JOBS_PAGE).toMatch(/scheduled_date/);
  });

  it("empty state copy is useful (no dead-end)", () => {
    expect(JOBS_PAGE).toMatch(/No jobs scheduled yet/);
  });

  it("PortalShell.active='jobs' so the nav tab highlights", () => {
    expect(JOBS_PAGE).toMatch(/active="jobs"/);
  });
});

// =====================================================================
// 4. Portal messaging
// =====================================================================

describe("Phase 3 — /customer-portal/[token]/messages + sendPortalMessage", () => {
  it("page validates token + renders the message form", () => {
    expect(MSG_PAGE).toMatch(/loadCustomerByPortalToken/);
    expect(MSG_PAGE).toMatch(/<form\s+action=\{sendPortalMessage\}/);
  });

  it("server action uses zod to validate token + subject + body", () => {
    expect(MSG_ACTION).toMatch(/z\.object\(\{/);
    expect(MSG_ACTION).toMatch(
      /token:[\s\S]*\.regex\(\s*\/\^\[0-9a-f\]\{8\}/,
    );
    expect(MSG_ACTION).toMatch(/subject:[\s\S]*\.min\(3\)\.max\(200\)/);
    expect(MSG_ACTION).toMatch(/body:[\s\S]*\.min\(1\)\.max\(10_000\)/);
  });

  it("re-validates the token by loading the portal session", () => {
    expect(MSG_ACTION).toMatch(/loadCustomerByPortalToken\(token\)/);
    expect(MSG_ACTION).toMatch(/invalid_token/);
  });

  it("creates a support_tickets row + first support_messages row", () => {
    expect(MSG_ACTION).toMatch(/from\("support_tickets" as never\)/);
    expect(MSG_ACTION).toMatch(/from\("support_messages" as never\)/);
    expect(MSG_ACTION).toMatch(/author_kind: "customer"/);
    expect(MSG_ACTION).toMatch(/internal: false/);
  });

  it("audit-logs the portal message", () => {
    expect(MSG_ACTION).toMatch(/recordAdminActivity/);
    expect(MSG_ACTION).toMatch(/action: "portal\.message\.sent"/);
  });

  it("revalidates both HQ + tenant inboxes so the ticket surfaces", () => {
    expect(MSG_ACTION).toMatch(/revalidatePath\(`\/admin\/support`\)/);
    expect(MSG_ACTION).toMatch(/revalidatePath\(`\/support`\)/);
  });
});

// =====================================================================
// 5. Payment proof upload (invoices portal)
// =====================================================================

describe("Phase 3 — payment proof upload", () => {
  it("invoice page renders the upload form on non-paid invoices", () => {
    expect(INV_PAGE).toMatch(/uploadPaymentProof/);
    expect(INV_PAGE).toMatch(/encType="multipart\/form-data"/);
    expect(INV_PAGE).toMatch(/name="file"/);
    // Hidden on fully-paid invoices.
    expect(INV_PAGE).toMatch(/!isFullyPaid \? \(/);
  });

  it("file picker accepts PDF + image variants directive specified", () => {
    expect(INV_PAGE).toMatch(
      /accept="application\/pdf,image\/jpeg,image\/png,image\/heic,image\/heif,image\/webp"/,
    );
  });

  it("action validates MIME + size (10MB cap)", () => {
    expect(UPLOAD_ACTION).toMatch(/ALLOWED_MIME/);
    expect(UPLOAD_ACTION).toMatch(/10 \* 1024 \* 1024/);
    expect(UPLOAD_ACTION).toMatch(/file_too_large/);
    expect(UPLOAD_ACTION).toMatch(/bad_file_type/);
  });

  it("re-verifies invoice belongs to the customer (no cross-org abuse)", () => {
    expect(UPLOAD_ACTION).toMatch(/inv\.quote\?\.customer_id !== customer\.id/);
    expect(UPLOAD_ACTION).toMatch(/invoice_not_yours/);
  });

  it("uploads to Supabase Storage 'portal-uploads' bucket", () => {
    expect(UPLOAD_ACTION).toMatch(
      /admin\.storage[\s\S]{0,40}\.from\("portal-uploads"\)[\s\S]{0,40}\.upload\(/,
    );
  });

  it("inserts a portal_uploads row with kind='payment_proof'", () => {
    expect(UPLOAD_ACTION).toMatch(/kind: "payment_proof"/);
    expect(UPLOAD_ACTION).toMatch(/target_table: "invoices"/);
  });

  it("audit-logs the upload", () => {
    expect(UPLOAD_ACTION).toMatch(/recordAdminActivity/);
    expect(UPLOAD_ACTION).toMatch(/action: "portal\.upload\.payment_proof"/);
  });

  it("cleans up the orphan file if the DB insert fails", () => {
    expect(UPLOAD_ACTION).toMatch(/\.remove\(\[storagePath\]\)/);
  });
});

// =====================================================================
// 5b. Payment proof READ-BACK (invoices portal)
//
// The upload above is write-only unless the customer can see what they
// sent. This closes the loop: the invoices page reads `portal_uploads`
// back and lists submitted proofs per invoice, so a customer gets a
// persistent "received" record instead of a one-shot banner (and stops
// re-sending the same proof). The DB row stays the single source of
// truth — the page only reads it.
// =====================================================================

describe("Phase 3 — payment proof read-back", () => {
  it("reads submitted proofs from portal_uploads (same untyped-table cast as the writer)", () => {
    expect(INV_PAGE).toMatch(/from\("portal_uploads" as never\)/);
  });

  it("scopes the read to THIS org AND customer — never org-wide", () => {
    // Both filters must be present so a refactor can't widen the scope and
    // leak another customer's proofs on the RLS-bypassing service-role client.
    expect(INV_PAGE).toMatch(/\.eq\("org_id", customer\.org_id\)/);
    expect(INV_PAGE).toMatch(
      /from\("portal_uploads"[\s\S]*?\.eq\("customer_id", customer\.id\)/,
    );
  });

  it("narrows to this page's own uploads: invoices target + payment_proof kind", () => {
    expect(INV_PAGE).toMatch(/\.eq\("target_table", "invoices"\)/);
    expect(INV_PAGE).toMatch(/\.eq\("kind", "payment_proof"\)/);
  });

  it("only reads proofs for the invoices actually on the page (.in target_id)", () => {
    expect(INV_PAGE).toMatch(/\.in\("target_id", ids\)/);
  });

  it("renders a per-invoice 'proof received' record with filename + date", () => {
    expect(INV_PAGE).toMatch(/Payment proof/);
    expect(INV_PAGE).toMatch(/submittedProofs/);
    expect(INV_PAGE).toMatch(/pf\.filename/);
    expect(INV_PAGE).toMatch(/pf\.uploaded_at\.slice\(0, 10\)/);
  });

  it("degrades gracefully — nothing renders when no proof was submitted", () => {
    // Guarded on a length check off a `?? []` default, so an empty/absent
    // read collapses to no UI rather than an error.
    expect(INV_PAGE).toMatch(/proofsByInvoice\.get\(inv\.id\) \?\? \[\]/);
    expect(INV_PAGE).toMatch(/submittedProofs\.length > 0 \? \(/);
  });

  it("adds no new business logic — the read is a plain select, no re-derivation", () => {
    // Reuse over reinvention: this is a read of the authoritative table, not a
    // second copy of upload/matching logic.
    expect(INV_PAGE).not.toMatch(/ALLOWED_MIME|MAX_BYTES|10 \* 1024/);
  });
});

// =====================================================================
// 6. Shell + branding + tab nav
// =====================================================================

describe("Phase 3 — PortalShell wires Jobs + Messages tabs", () => {
  it("active union includes 'jobs' and 'messages'", () => {
    expect(SHELL).toMatch(/"jobs"/);
    expect(SHELL).toMatch(/"messages"/);
  });

  it("nav exposes Jobs + Messages tabs", () => {
    expect(SHELL).toMatch(/label: "Jobs"/);
    expect(SHELL).toMatch(/label: "Messages"/);
  });

  it("branding (org name + logo) is rendered", () => {
    expect(SHELL).toMatch(/org\.logo_url/);
    expect(SHELL).toMatch(/org\.name/);
  });
});

// =====================================================================
// 7. Cross-cutting: no cross-org leakage on any portal page
// =====================================================================

describe("Phase 3 — cross-tenant isolation", () => {
  const pages = [
    "app/customer-portal/[token]/page.tsx",
    "app/customer-portal/[token]/quotes/page.tsx",
    "app/customer-portal/[token]/invoices/page.tsx",
    "app/customer-portal/[token]/jobs/page.tsx",
    "app/customer-portal/[token]/messages/page.tsx",
  ];

  for (const p of pages) {
    it(`${p} resolves the customer via loadCustomerByPortalToken first`, () => {
      const src = read(p);
      expect(src).toMatch(/loadCustomerByPortalToken/);
      expect(src).toMatch(/InvalidLinkPage/);
    });

    it(`${p} scopes service-role queries by customer.org_id`, () => {
      const src = read(p);
      // Either eq("org_id", customer.org_id) or "org_id: customer.org_id".
      expect(src).toMatch(/customer\.org_id/);
    });
  }
});
