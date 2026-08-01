import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Completion certificates — the customer-facing surface is safe by construction.
 *
 * The portal runs on the RLS-bypassing admin client, so the cert loader MUST
 * scope every read by customer_id AND org_id and re-check visibility, and the
 * PDF routes MUST render from the frozen snapshot (never live job data). These
 * are source contracts — a refactor that drops a scope fails here.
 */
const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

describe("completion certificate portal delivery — scoped + snapshot-only", () => {
  it("the portal cert loader scopes by customer_id AND org_id AND visibility", () => {
    const code = read("app/customer-portal/_certificates.ts");
    expect(code).toMatch(/\.eq\("customer_id", customerId\)/);
    expect(code).toMatch(/\.eq\("org_id", orgId\)/);
    expect(code).toMatch(/isPortalVisible/);
    // never returns a cert without a frozen snapshot
    expect(code).toMatch(/!data\.snapshot|!c\.snapshot|c\.snapshot &&/);
  });

  it("the portal PDF route goes through the token authority + scoped loader, renders from snapshot", () => {
    const code = read("app/customer-portal/[token]/certificates/[id]/pdf/route.tsx");
    expect(code).toMatch(/loadCustomerByPortalToken/);
    expect(code).toMatch(/loadPortalCertificate/);
    expect(code).toMatch(/cert\.snapshot/);
    // 404 (not 403/500) for anything not the customer's own visible cert — no enumeration
    expect(code).toMatch(/status:\s*404/);
  });

  it("the operator PDF route is RLS-gated (requireOrgContext) and renders from snapshot when issued", () => {
    const code = read("app/api/completion-certificates/[id]/pdf/route.tsx");
    expect(code).toMatch(/requireOrgContext/);
    expect(code).toMatch(/cert\.snapshot/);
  });
});
