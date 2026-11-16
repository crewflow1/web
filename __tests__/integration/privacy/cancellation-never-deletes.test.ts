import { afterAll, afterEach, expect, it } from "vitest";
import { describeIntegration } from "../_harness";
import {
  admin,
  cleanup,
  countRows,
  db,
  mkOrg,
  mkUser,
  newMarkers,
  seedMemberFootprint,
  seedOrgBusinessData,
  snapshotOrg,
  stripeMock,
  uploadOrgObjects,
} from "./_fixtures";
import { drainDueDeletionRequests } from "@/server/services/privacy-deletion";

/**
 * CASE C — cancelling a subscription NEVER deletes data (founder policy
 * 2026-11-16). A cancelled company is held read-only (D-17) and keeps every
 * record and file; only an explicit company-deletion request, made by an owner
 * through the deletion flow, can remove it (that half is proven in
 * company-deletion.test.ts: "a CANCELLED … company can still be deleted").
 *
 * The scheduled paths that delete anything are the retention cron's three
 * sweeps. Two are table-scoped and can never name a company (proven statically
 * in __tests__/privacy/no-silent-company-deletion.test.ts); the third — the
 * deletion drain — is exercised here, switched ON, against a real cancelled
 * company with no deletion request.
 */
const created: { orgs: string[]; users: string[] } = { orgs: [], users: [] };
const FLAG = "FEATURE_ACCOUNT_DELETION";

describeIntegration("privacy · CASE C — subscription cancellation never deletes data", () => {
  afterEach(() => {
    delete process.env[FLAG];
  });
  afterAll(async () => {
    await cleanup(created.orgs, created.users);
  }, 120_000);

  it("a cancelled (held) company with a confirmed cancellation and no deletion request is untouched by the deletion drain", async () => {
    const m = newMarkers("cancelled");
    const owner = await mkUser(m, "owner");
    created.users.push(owner.id);
    const org = await mkOrg(m, "cancelled", [{ user: owner, role: "owner" }]);
    created.orgs.push(org.id);
    const seed = await seedOrgBusinessData(org, m);
    await seedMemberFootprint(org, seed, owner, m, { withPayroll: true });
    await uploadOrgObjects(org.id, m);
    const sub = await db()
      .from("organizations")
      .update({ stripe_customer_id: "cus_TESTcancelled01", stripe_subscription_id: "sub_TESTcancelled01" })
      .eq("id", org.id);
    expect(sub.error, sub.error?.message).toBeNull();
    // The billing workstream's cancellation record, where that table exists
    // (#1090). Its absence on a branch without #1090 does not weaken the test:
    // the company is cancelled either way.
    const record = await db()
      .from("subscription_cancellations")
      .insert({ org_id: org.id, source: "owner", state: "confirmed", access_revoked: true });
    if (record.error) {
      expect(record.error.message, "only a missing table is tolerated").toMatch(/does not exist|could not find the table/i);
    }
    const held = await db().from("organizations").update({ status: "cancelled" }).eq("id", org.id);
    expect(held.error, held.error?.message).toBeNull();

    const before = await snapshotOrg(org.id, [owner.id]);
    expect(await countRows("privacy_deletion_requests", { target_org_id: org.id })).toBe(0);

    // The drain, switched ON, runs only what the ledger holds — nothing here.
    process.env[FLAG] = "true";
    const stripe = stripeMock();
    const out = await drainDueDeletionRequests({ limit: 50 }, { admin: admin(), stripe });
    expect(out.enabled).toBe(true);
    expect(stripe.calls.filter((c) => c.includes("sub_TESTcancelled01"))).toEqual([]);

    // Byte-for-byte unchanged: rows, files, the owner's account — and still no request.
    expect(await snapshotOrg(org.id, [owner.id])).toBe(before);
    expect(await countRows("organizations", { id: org.id, status: "cancelled" })).toBe(1);
    expect(await countRows("privacy_deletion_requests", { target_org_id: org.id })).toBe(0);
  }, 180_000);
});
