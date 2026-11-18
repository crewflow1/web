import { afterAll, expect, it } from "vitest";
import { anonClient, describeIntegration } from "../_harness";
import { cleanup, mkUser, newMarkers, signIn } from "./_fixtures";
import { isSessionFresh, newestAuthentication, verifyReauthentication } from "@/server/auth/reauth";

/**
 * Re-authentication against REAL Supabase Auth (local GoTrue): the default
 * password check and the shape of a real access token's `amr` claim. Only the
 * cookie-session reader is injected (there is no request here).
 */
const created: { orgs: string[]; users: string[] } = { orgs: [], users: [] };

describeIntegration("privacy · re-authentication against real Supabase Auth", () => {
  afterAll(async () => {
    await cleanup(created.orgs, created.users);
  }, 60_000);

  it("verifies the real password, refuses a wrong one, and leaves the user's own session alive", async () => {
    const m = newMarkers("reauth");
    const u = await mkUser(m, "person");
    created.users.push(u.id);
    const sessionToken = await signIn(u); // the user's "browser" session
    const user = { id: u.id, email: u.email };

    expect(await verifyReauthentication({ user, password: u.password })).toEqual({ ok: true, method: "password" });
    expect(await verifyReauthentication({ user, password: `${u.password}x` })).toMatchObject({
      ok: false,
      code: "password_incorrect",
    });
    // A correct password for a DIFFERENT account proves nothing about this one.
    const other = await mkUser(m, "other");
    created.users.push(other.id);
    expect(await verifyReauthentication({ user, password: other.password })).toMatchObject({
      ok: false,
      code: "password_incorrect",
    });

    // The throw-away check session was discarded WITHOUT ending the real session.
    const still = await anonClient().auth.getUser(sessionToken);
    expect(still.data.user?.id).toBe(u.id);
  }, 60_000);

  it("a real, just-issued access token carries an amr timestamp and reads as fresh; an old one does not", async () => {
    const m = newMarkers("reauthamr");
    const u = await mkUser(m, "person");
    created.users.push(u.id);
    const token = await signIn(u);
    const newest = newestAuthentication(token);
    expect(newest?.sub).toBe(u.id);
    const nowSeconds = Math.floor(Date.now() / 1000);
    expect(Math.abs(nowSeconds - (newest?.at ?? 0))).toBeLessThan(120);

    const user = { id: u.id, email: u.email };
    const currentAccessToken = async () => token;
    expect(await verifyReauthentication({ user }, { currentAccessToken })).toEqual({
      ok: true,
      method: "recent_session",
    });
    // The same session, eleven minutes later, no longer authorises a deletion.
    const later = () => new Date(Date.now() + 11 * 60 * 1000);
    expect(await verifyReauthentication({ user }, { currentAccessToken, now: later })).toMatchObject({
      ok: false,
      code: "stale_session",
    });
    expect(isSessionFresh(token, "00000000-0000-4000-8000-000000000000", nowSeconds)).toBe(false);
  }, 60_000);
});
