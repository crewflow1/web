import { describe, it, expect } from "vitest";
import { toolJobFinancials } from "@/server/services/site-manager/tools";

/**
 * AI Site Manager — the REAL financial tool gate (no mocks, no DB).
 *
 * toolJobFinancials never touches the database for a denied caller: it checks
 * the role gate and returns `{ unauthorised:true }` with NO sources and NO
 * figure. This is the security-critical contract — a staff member asking a money
 * question can never get a number, regardless of what the question says. Proven
 * here against the real function (the orchestrator unit suite mocks the tools).
 */

const ownerCtx = { org: { id: "org-1" }, membership: { role: "owner" } };
const adminCtx = { org: { id: "org-1" }, membership: { role: "admin" } };
const staffCtx = { org: { id: "org-1" }, membership: { role: "staff" } };
const memberCtx = { org: { id: "org-1" }, membership: { role: "member" } };

describe("toolJobFinancials — role gate", () => {
  it("denies staff: unauthorised, no sources, no figure", async () => {
    const r = await toolJobFinancials(staffCtx, "J1");
    expect(r.unauthorised).toBe(true);
    expect(r.facts.authorised).toBe(false);
    expect(r.sources).toHaveLength(0);
    expect(JSON.stringify(r.facts)).not.toMatch(/£|budget|retention|profit|valuation/i);
  });

  it("denies a plain member too", async () => {
    const r = await toolJobFinancials(memberCtx, "J1");
    expect(r.unauthorised).toBe(true);
    expect(r.sources).toHaveLength(0);
  });

  it("owner is authorised and gets a Commercial-tab pointer (no fabricated number)", async () => {
    const r = await toolJobFinancials(ownerCtx, "J1");
    expect(r.unauthorised).toBeFalsy();
    expect(r.facts.authorised).toBe(true);
    expect(r.sources.some((s) => s.href?.includes("commercial"))).toBe(true);
    expect(JSON.stringify(r.facts)).not.toMatch(/\d{3,}/); // a pointer, not an aggregate
  });

  it("admin is authorised", async () => {
    const r = await toolJobFinancials(adminCtx, "J1");
    expect(r.unauthorised).toBeFalsy();
    expect(r.facts.authorised).toBe(true);
  });
});
