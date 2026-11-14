import { afterAll, afterEach, expect, it } from "vitest";
import { describeIntegration } from "../_harness";
import { admin, cleanup, countRows, db, ledger, makeDue, mkOrg, mkUser, newMarkers, stripeMock } from "./_fixtures";
import { drainDueDeletionRequests, requestOrgDeletion } from "@/server/services/privacy-deletion";

/**
 * The scheduled drain (called by /api/cron/retention-purge): the thing that
 * actually executes a company deletion once its cooling-off has ended.
 */
const created: { orgs: string[]; users: string[] } = { orgs: [], users: [] };
const FLAG = "FEATURE_ACCOUNT_DELETION";

describeIntegration("privacy · scheduled drain of due deletion requests", () => {
  afterEach(() => {
    delete process.env[FLAG];
  });
  afterAll(async () => {
    await cleanup(created.orgs, created.users);
  }, 120_000);

  it("is inert while the capability is dark; when on, runs what is due and leaves what is cooling off", async () => {
    const m = newMarkers("drain");
    const mk = async (label: string) => {
      const owner = await mkUser(m, `owner${label}`);
      created.users.push(owner.id);
      const org = await mkOrg(m, label, [{ user: owner, role: "owner" }]);
      created.orgs.push(org.id);
      const req = await requestOrgDeletion({ orgId: org.id, actorUserId: owner.id, confirmName: org.name }, { admin: admin() });
      expect(req.ok).toBe(true);
      return { org, requestId: req.ok ? req.requestId : "" };
    };
    const due = await mk("due");
    const cooling = await mk("cooling");
    await makeDue(due.requestId);

    // DARK (flag unset): nothing is read, nothing runs.
    delete process.env[FLAG];
    expect(await drainDueDeletionRequests({}, { admin: admin(), stripe: stripeMock() })).toEqual({
      enabled: false,
      considered: 0,
      results: [],
    });
    expect(await countRows("organizations", { id: due.org.id })).toBe(1);

    process.env[FLAG] = "true";
    const out = await drainDueDeletionRequests({ limit: 50 }, { admin: admin(), stripe: stripeMock() });
    expect(out.enabled).toBe(true);
    expect(out.results).toContainEqual({ requestId: due.requestId, status: "completed" });
    expect(out.results.map((r) => r.requestId)).not.toContain(cooling.requestId);

    expect(await countRows("organizations", { id: due.org.id })).toBe(0);
    expect(await countRows("organizations", { id: cooling.org.id })).toBe(1);
    expect((await ledger(cooling.requestId)).status).toBe("scheduled");
    // tidy: cancel the still-cooling request so no live request outlives the test
    const owner = await db().from("memberships").select("user_id").eq("org_id", cooling.org.id).single();
    await db().rpc("privacy_request_cancel", {
      p_request_id: cooling.requestId,
      p_actor_user_id: (owner.data as { user_id: string }).user_id,
    });
  }, 120_000);
});
