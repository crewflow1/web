import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ACTION-LEVEL authorisation for the deletion entry points.
 *
 * The engine and the database primitives are proved against real Postgres in
 * __tests__/integration/privacy. What is pinned HERE is the request layer in
 * front of them: the order of the gates (flag → session → role → re-auth →
 * service), and that authority comes from the SESSION — a forged org id, user id
 * or request id in the posted form changes nothing.
 */

const SESSION_USER = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", email: "owner@example.test" };
const SESSION_ORG = { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", name: "Session Co Ltd", slug: "session-co" };
const FOREIGN = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const STAFF = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

const h = vi.hoisted(() => ({
  order: [] as string[],
  role: "owner",
  enabled: true,
  reauth: { ok: true, method: "password" } as { ok: boolean; method?: string; code?: string; message?: string },
  live: null as null | { requestId: string; status: string; scheduledFor: string; createdAt: string },
  requestAccountDeletion: vi.fn(),
  requestOrgDeletion: vi.fn(),
  cancelOrgDeletion: vi.fn(),
  requestStaffErasure: vi.fn(),
  verifyReauthentication: vi.fn(),
  signOut: vi.fn(async () => ({ error: null })),
}));

vi.mock("@/server/services/privacy-deletion", () => ({
  accountDeletionEnabled: () => {
    h.order.push("flag");
    return h.enabled;
  },
  getLiveOrgDeletion: async (orgId: string) => {
    h.order.push(`live:${orgId}`);
    return h.live;
  },
  requestAccountDeletion: h.requestAccountDeletion,
  requestOrgDeletion: h.requestOrgDeletion,
  cancelOrgDeletion: h.cancelOrgDeletion,
  requestStaffErasure: h.requestStaffErasure,
}));
vi.mock("@/server/auth/session", () => ({
  requireUser: async () => {
    h.order.push("session");
    return SESSION_USER;
  },
  requireOrgContext: async () => {
    h.order.push("session");
    return { user: SESSION_USER, ctx: { org: SESSION_ORG, membership: { org_id: SESSION_ORG.id, role: h.role } } };
  },
}));
vi.mock("@/server/auth/reauth", () => ({ verifyReauthentication: h.verifyReauthentication }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ auth: { signOut: h.signOut } }) }));

import {
  cancelCompanyDeletionAction,
  deleteMyAccountAction,
  requestCompanyDeletionAction,
} from "@/app/(app)/settings/account/actions";
import { eraseStaffMemberAction } from "@/app/(app)/staff/erasure-actions";
import { INITIAL_FORM_STATE } from "@/lib/forms/state";

function form(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}
/** Every id an attacker might try to smuggle in. None may be honoured. */
const FORGED = { org_id: FOREIGN, orgId: FOREIGN, user_id: FOREIGN, userId: FOREIGN, request_id: FOREIGN, actor: FOREIGN };

beforeEach(() => {
  h.order.length = 0;
  h.role = "owner";
  h.enabled = true;
  h.reauth = { ok: true, method: "password" };
  h.live = null;
  h.verifyReauthentication.mockImplementation(async () => {
    h.order.push("reauth");
    return h.reauth;
  });
  for (const fn of [h.requestAccountDeletion, h.requestOrgDeletion, h.requestStaffErasure]) {
    fn.mockImplementation(async () => {
      h.order.push("service");
      return { ok: true, requestId: "r1", status: "scheduled", scheduledFor: "2026-11-21T00:00:00Z", created: true, run: { status: "completed" } };
    });
  }
  h.cancelOrgDeletion.mockImplementation(async () => {
    h.order.push("service");
    return { ok: true, changed: true };
  });
});
afterEach(() => vi.clearAllMocks());

describe("dark by default: the flag is consulted FIRST and nothing else runs", () => {
  it.each([
    ["deleteMyAccountAction", () => deleteMyAccountAction(INITIAL_FORM_STATE, form({ confirm_email: SESSION_USER.email, password: "pw" }))],
    ["requestCompanyDeletionAction", () => requestCompanyDeletionAction(INITIAL_FORM_STATE, form({ confirm_name: SESSION_ORG.name, acknowledge: "on", password: "pw" }))],
    ["cancelCompanyDeletionAction", () => cancelCompanyDeletionAction(INITIAL_FORM_STATE, form({}))],
    ["eraseStaffMemberAction", () => eraseStaffMemberAction(STAFF, INITIAL_FORM_STATE, form({ confirm_email: "s@example.test", password: "pw" }))],
  ])("%s", async (_name, run) => {
    h.enabled = false;
    const state = await run();
    expect(state.ok).toBe(false);
    expect(state.error).toMatch(/not available/i);
    expect(h.order).toEqual(["flag"]); // no session read, no re-auth, no service
  });
});

describe("company deletion — owner only, re-authenticated, org from the session", () => {
  const submit = (extra: Record<string, string> = {}) =>
    requestCompanyDeletionAction(
      INITIAL_FORM_STATE,
      form({ confirm_name: SESSION_ORG.name, acknowledge: "on", password: "pw", ...extra }),
    );

  it.each(["admin", "staff"])("a %s is refused before re-auth and before the service", async (role) => {
    h.role = role;
    const state = await submit();
    expect(state.error).toMatch(/only the owner/i);
    expect(h.order).toEqual(["flag", "session"]);
    expect(h.requestOrgDeletion).not.toHaveBeenCalled();
  });

  it("the consequences box must be ticked", async () => {
    const state = await requestCompanyDeletionAction(INITIAL_FORM_STATE, form({ confirm_name: SESSION_ORG.name, password: "pw" }));
    expect(state.error).toMatch(/tick the box/i);
    expect(h.verifyReauthentication).not.toHaveBeenCalled();
    expect(h.requestOrgDeletion).not.toHaveBeenCalled();
  });

  it("a failed re-authentication stops it — the service is never called", async () => {
    h.reauth = { ok: false, code: "password_incorrect", message: "That password is not correct. Nothing was deleted." };
    const state = await submit();
    expect(state.error).toBe("That password is not correct. Nothing was deleted.");
    expect(h.order).toEqual(["flag", "session", "reauth"]);
    expect(h.requestOrgDeletion).not.toHaveBeenCalled();
  });

  it("uses the SESSION org and user — forged ids in the form are ignored", async () => {
    const state = await submit(FORGED);
    expect(state.ok).toBe(true);
    expect(h.order).toEqual(["flag", "session", "reauth", "service"]);
    expect(h.verifyReauthentication).toHaveBeenCalledWith({ user: SESSION_USER, password: "pw" });
    expect(h.requestOrgDeletion).toHaveBeenCalledTimes(1);
    expect(h.requestOrgDeletion).toHaveBeenCalledWith({
      orgId: SESSION_ORG.id,
      actorUserId: SESSION_USER.id,
      confirmName: SESSION_ORG.name,
    });
    expect(JSON.stringify(h.requestOrgDeletion.mock.calls)).not.toContain(FOREIGN);
  });

  it("surfaces the database's refusals without claiming success", async () => {
    h.requestOrgDeletion.mockResolvedValueOnce({ ok: false, code: "confirmation", message: "x" });
    expect((await submit()).error).toMatch(/does not match exactly/i);
    h.requestOrgDeletion.mockResolvedValueOnce({ ok: false, code: "forbidden", message: "x" });
    expect((await submit()).error).toMatch(/only the owner/i);
  });
});

describe("cancelling — the request is looked up for the SESSION org, never taken from the form", () => {
  it("cancels the session org's live request and ignores a posted request id", async () => {
    h.live = { requestId: "live-request-for-session-org", status: "scheduled", scheduledFor: "x", createdAt: "x" };
    const state = await cancelCompanyDeletionAction(INITIAL_FORM_STATE, form(FORGED));
    expect(state.ok).toBe(true);
    expect(h.order).toEqual(["flag", "session", `live:${SESSION_ORG.id}`, "service"]);
    expect(h.cancelOrgDeletion).toHaveBeenCalledWith({
      requestId: "live-request-for-session-org",
      actorUserId: SESSION_USER.id,
    });
  });

  it("a non-owner cannot cancel; nothing pending → nothing to cancel", async () => {
    h.role = "admin";
    expect((await cancelCompanyDeletionAction(INITIAL_FORM_STATE, form({}))).error).toMatch(/only an owner/i);
    expect(h.cancelOrgDeletion).not.toHaveBeenCalled();
    h.role = "owner";
    expect((await cancelCompanyDeletionAction(INITIAL_FORM_STATE, form({}))).error).toMatch(/no pending deletion/i);
    expect(h.cancelOrgDeletion).not.toHaveBeenCalled();
  });
});

describe("account deletion — only ever the session user's own account", () => {
  const submit = (extra: Record<string, string> = {}) =>
    deleteMyAccountAction(INITIAL_FORM_STATE, form({ confirm_email: SESSION_USER.email, password: "pw", ...extra }));

  it("targets the SESSION user regardless of posted ids, then signs out and leaves", async () => {
    const state = await submit(FORGED);
    expect(state.ok).toBe(true);
    expect(state.redirectTo).toBe("/login?deleted=account");
    expect(h.order).toEqual(["flag", "session", "reauth", "service"]);
    expect(h.requestAccountDeletion).toHaveBeenCalledWith({ userId: SESSION_USER.id, confirmEmail: SESSION_USER.email });
    expect(JSON.stringify(h.requestAccountDeletion.mock.calls)).not.toContain(FOREIGN);
    expect(h.signOut).toHaveBeenCalledWith({ scope: "local" });
  });

  it("re-authentication failure → no deletion, no sign-out", async () => {
    h.reauth = { ok: false, code: "stale_session", message: "confirm it is you" };
    const state = await submit();
    expect(state.error).toBe("confirm it is you");
    expect(h.requestAccountDeletion).not.toHaveBeenCalled();
    expect(h.signOut).not.toHaveBeenCalled();
  });

  it("the sole-owner guard is reported and nothing is signed out", async () => {
    h.requestAccountDeletion.mockResolvedValueOnce({ ok: false, code: "sole_owner", message: "You are the only owner of a company." });
    const state = await submit();
    expect(state.ok).toBe(false);
    expect(state.error).toMatch(/only owner/i);
    expect(h.signOut).not.toHaveBeenCalled();
    // …including when it only becomes true at run time (the request is cancelled).
    h.requestAccountDeletion.mockResolvedValueOnce({ ok: true, requestId: "r", status: "scheduled", scheduledFor: "x", created: true, run: { status: "cancelled", reason: "sole_owner" } });
    const raced = await submit();
    expect(raced.ok).toBe(false);
    expect(raced.error).toMatch(/only owner/i);
    expect(h.signOut).not.toHaveBeenCalled();
  });

  it("a wrong confirmation email is reported as such", async () => {
    h.requestAccountDeletion.mockResolvedValueOnce({ ok: false, code: "confirmation", message: "x" });
    expect((await submit()).error).toMatch(/does not match your account email/i);
  });
});

describe("staff erasure — owner/admin of the SESSION org", () => {
  const submit = (target = STAFF, extra: Record<string, string> = {}) =>
    eraseStaffMemberAction(target, INITIAL_FORM_STATE, form({ confirm_email: "staff@example.test", password: "pw", ...extra }));

  it("ordinary staff are refused before re-auth and before the service", async () => {
    h.role = "staff";
    const state = await submit();
    expect(state.error).toMatch(/only an owner or admin/i);
    expect(h.order).toEqual(["flag", "session"]);
    expect(h.requestStaffErasure).not.toHaveBeenCalled();
  });

  it.each([
    ["the viewer themselves", SESSION_USER.id],
    ["not a uuid", "1; drop table users"],
    ["empty", ""],
  ])("refuses a target that is %s", async (_label, target) => {
    const state = await submit(target);
    expect(state.ok).toBe(false);
    expect(h.verifyReauthentication).not.toHaveBeenCalled();
    expect(h.requestStaffErasure).not.toHaveBeenCalled();
  });

  it.each(["owner", "admin"])("a %s may request it — for the session org only, forged org ids ignored", async (role) => {
    h.role = role;
    const state = await submit(STAFF, FORGED);
    expect(state.ok).toBe(true);
    expect(state.redirectTo).toBe("/staff?saved=erased");
    expect(h.order).toEqual(["flag", "session", "reauth", "service"]);
    expect(h.requestStaffErasure).toHaveBeenCalledWith({
      orgId: SESSION_ORG.id,
      actorUserId: SESSION_USER.id,
      staffUserId: STAFF,
      confirmEmail: "staff@example.test",
    });
    expect(JSON.stringify(h.requestStaffErasure.mock.calls)).not.toContain(FOREIGN);
  });

  it("re-authentication failure and database refusals never read as success", async () => {
    h.reauth = { ok: false, code: "password_incorrect", message: "nope" };
    expect((await submit()).error).toBe("nope");
    expect(h.requestStaffErasure).not.toHaveBeenCalled();
    h.reauth = { ok: true, method: "password" };
    h.requestStaffErasure.mockResolvedValueOnce({ ok: false, code: "forbidden", message: "x" });
    expect((await submit()).error).toMatch(/not allowed/i);
    h.requestStaffErasure.mockResolvedValueOnce({ ok: true, requestId: "r", status: "failed", scheduledFor: "x", created: true, run: { status: "failed", errorCode: "erase_org:x" } });
    const partial = await submit();
    expect(partial.ok).toBe(false);
    expect(partial.error).toMatch(/has not finished/i);
  });
});
