import { afterAll, beforeAll, expect, it } from "vitest";
import {
  anonClient,
  describeIntegration,
  serviceClient,
  userClient,
} from "../_harness";
import { sendStaffInvite } from "@/server/services/staff-invite";
import { buildCallbackMagicLink } from "@/lib/auth/magic-link";

/**
 * END-TO-END staff invite → magic link → accept → tenant association, against
 * REAL local Supabase (Postgres + GoTrue).
 *
 * This is the regression lock for the action_link vs token_hash defect:
 * sendStaffInvite / promoteDemoToCustomer used to embed GoTrue's hosted
 * `properties.action_link`, whose click verifies the one-time token server-side
 * and returns the session in a URL HASH FRAGMENT (implicit flow). A hash
 * fragment never reaches the server /auth/callback route handler, so the token
 * was burned and the invitee bounced to /login — the invite could never be
 * accepted through application routes. The fix embeds
 * {appUrl}/auth/callback?token_hash=<hashed>&type=magiclink, which the callback
 * exchanges via verifyOtp (PKCE-less, cross-device).
 *
 * What this proves against real GoTrue:
 *   · the invite anchor (org + role) lands in admin-only app_metadata, NOT the
 *     user-writable user_metadata (privilege-escalation guard);
 *   · generateLink's hashed_token, verified via verifyOtp (exactly what the
 *     callback does), yields a real session for the invited email;
 *   · the token is strictly one-time (second verify fails);
 *   · an invalid/expired token_hash fails closed;
 *   · after the accept writes the membership, the invited user's RLS-bound
 *     client can read ONLY the inviting org (correct tenant + role), never a
 *     different org.
 *
 * NOTE: sendStaffInvite's email send goes via Resend; with RESEND_API_KEY unset
 * locally it reports ok:false (reason "no_key") AFTER creating the auth user +
 * generating the link — see the readiness report. We therefore drive the link
 * exchange through the same primitives the service uses (generateLink +
 * buildCallbackMagicLink + verifyOtp) and separately assert the service's
 * user-provisioning + metadata-placement side effects.
 */

type InsertOne = {
  select(c: string): { single(): PromiseLike<{ data: { id: string } | null; error: unknown }> };
};
const db = (c: unknown) =>
  c as unknown as {
    from(t: string): {
      insert(r: Record<string, unknown>): InsertOne;
      select(c: string): {
        eq(c: string, v: unknown): PromiseLike<{ data: Array<Record<string, unknown>> | null; error: unknown }>;
      };
      delete(): { eq(c: string, v: unknown): PromiseLike<unknown> };
    };
  };

const T = `it-invite-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const APP = (process.env.NEXT_PUBLIC_APP_URL ?? "http://127.0.0.1:3000").replace(/\/$/, "");

describeIntegration("staff invite → magic link → accept (real Supabase)", () => {
  let orgA = "";
  let orgB = "";
  const inviteEmail = `${T}-invitee@x.test`;
  let inviteeId = "";
  const svc = () => db(serviceClient());

  beforeAll(async () => {
    orgA = String(
      (await svc().from("organizations").insert({ name: "Invite CO A", slug: `${T}-a` }).select("id").single()).data?.id,
    );
    orgB = String(
      (await svc().from("organizations").insert({ name: "Invite CO B", slug: `${T}-b` }).select("id").single()).data?.id,
    );
  });

  afterAll(async () => {
    const s = serviceClient();
    if (inviteeId) {
      await s.from("memberships").delete().eq("user_id", inviteeId);
      await s.from("users").delete().eq("id", inviteeId);
      await s.auth.admin.deleteUser(inviteeId).catch(() => {});
    }
    for (const org of [orgA, orgB]) {
      if (org) await s.from("organizations").delete().eq("id", org);
    }
  });

  it("sendStaffInvite provisions an UNCONFIRMED auth user with the invite anchor in app_metadata (not user_metadata)", async () => {
    const res = await sendStaffInvite({
      email: inviteEmail,
      fullName: "Ivy Invitee",
      orgName: "Invite CO A",
      metadata: {
        invited_org_id: orgA,
        invited_role: "admin",
        invited_full_name: "Ivy Invitee",
        invited_phone: null,
        invited_employment_type: null,
        invited_hourly_pay: 21.5,
        invited_emergency_contact: null,
        source: "staff_invite",
      },
    });
    // Locally RESEND_API_KEY is unset, so the EMAIL send is the only failing
    // step; the auth user + metadata + link generation all happened first.
    if (res.ok) {
      expect(res.alreadyExisted).toBe(false);
    } else {
      expect(res.reason).toBe("no_key");
    }

    const admin = serviceClient();
    const { data } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
    const u = data.users.find((x) => x.email === inviteEmail);
    expect(u, "invited auth user must exist").toBeTruthy();
    inviteeId = u!.id;

    // Authorization anchor lives in admin-only app_metadata ...
    expect(u!.app_metadata?.invited_org_id).toBe(orgA);
    expect(u!.app_metadata?.invited_role).toBe("admin");
    expect(u!.app_metadata?.source).toBe("staff_invite");
    expect(u!.app_metadata?.invited_hourly_pay).toBe(21.5);
    // ... and NEVER in the user-writable user_metadata bucket.
    expect(u!.user_metadata?.invited_org_id).toBeUndefined();
    expect(u!.user_metadata?.invited_role).toBeUndefined();
    expect(u!.user_metadata?.invited_hourly_pay).toBeUndefined();

    // Still UNCONFIRMED (pending) → shows in the staff directory before accept.
    expect(u!.email_confirmed_at ?? null).toBeNull();
  });

  it("the token_hash callback link (verifyOtp) signs the invited email in, and is strictly one-time", async () => {
    const admin = serviceClient();
    const { data: link, error: linkErr } = await admin.auth.admin.generateLink({
      type: "magiclink",
      email: inviteEmail,
      options: { redirectTo: `${APP}/auth/callback` },
    });
    expect(linkErr).toBeFalsy();

    // The URL we embed must point at OUR callback with token_hash + type, and
    // must NOT be the hosted GoTrue verify URL.
    const url = buildCallbackMagicLink({ appUrl: APP, properties: link!.properties, type: "magiclink" });
    expect(url).toContain("/auth/callback?token_hash=");
    expect(url).toContain("type=magiclink");
    expect(url).not.toContain("/auth/v1/verify");

    const tokenHash = new URL(url!).searchParams.get("token_hash")!;

    // First verify (exactly what /auth/callback does) → a real session.
    const first = await anonClient().auth.verifyOtp({ token_hash: tokenHash, type: "magiclink" });
    expect(first.error, "fresh token_hash must verify").toBeFalsy();
    expect(first.data.session?.access_token).toBeTruthy();
    expect(first.data.user?.email).toBe(inviteEmail);

    // One-time: the SAME token can't be replayed.
    const replay = await anonClient().auth.verifyOtp({ token_hash: tokenHash, type: "magiclink" });
    expect(replay.error, "a consumed token must not verify again").toBeTruthy();
    expect(replay.data.session).toBeNull();
  });

  it("an invalid / expired token_hash fails closed", async () => {
    const bogus = "deadbeef".repeat(7); // 56 hex chars, never issued
    const res = await anonClient().auth.verifyOtp({ token_hash: bogus, type: "magiclink" });
    expect(res.error).toBeTruthy();
    expect(res.data.session).toBeNull();
  });

  it("after accept (membership insert from the app_metadata anchor) the invitee is bound to the inviting org only, with the invited role", async () => {
    // Re-issue a fresh link (the previous one was consumed) and verify to get a
    // user-JWT session — the state /onboarding/join runs in.
    const admin = serviceClient();
    const { data: link } = await admin.auth.admin.generateLink({
      type: "magiclink",
      email: inviteEmail,
      options: { redirectTo: `${APP}/auth/callback` },
    });
    const url = buildCallbackMagicLink({ appUrl: APP, properties: link!.properties });
    const tokenHash = new URL(url!).searchParams.get("token_hash")!;
    const verified = await anonClient().auth.verifyOtp({ token_hash: tokenHash, type: "magiclink" });
    const token = verified.data.session!.access_token;
    const authedUser = verified.data.user!;

    // Mirror acceptOrgInvite's authorization: role is derived from the
    // admin-only app_metadata anchor, never from client input.
    const role = authedUser.app_metadata?.invited_role === "admin" ? "admin" : "staff";
    expect(role).toBe("admin");
    const anchorOrg = authedUser.app_metadata?.invited_org_id as string;
    expect(anchorOrg).toBe(orgA);

    // ensureUserRow + membership insert happen via the service role (the new
    // user has no RLS relationship to the org yet).
    await svc().from("users").insert({ id: inviteeId, email: inviteEmail, full_name: "Ivy Invitee" });
    await svc().from("memberships").insert({ org_id: anchorOrg, user_id: inviteeId, role });

    // Now the RLS-bound user client must see org A ...
    const asUser = db(userClient(token));
    const visible = await asUser.from("organizations").select("id").eq("id", orgA);
    expect(visible.error).toBeFalsy();
    expect((visible.data ?? []).map((r) => r.id)).toContain(orgA);

    // ... and NEVER org B (correct tenant isolation).
    const hidden = await asUser.from("organizations").select("id").eq("id", orgB);
    expect((hidden.data ?? []).length).toBe(0);

    // The membership row carries the invited role in the inviting org.
    const mem = await svc().from("memberships").select("org_id, role").eq("user_id", inviteeId);
    expect(mem.data).toEqual([expect.objectContaining({ org_id: orgA, role: "admin" })]);
  });

  it("a repeat invite to the same pending email is idempotent (refreshes the anchor, no second account)", async () => {
    const before = await serviceClient().auth.admin.listUsers({ page: 1, perPage: 1000 });
    const countBefore = before.data.users.filter((u) => u.email === inviteEmail).length;

    const res = await sendStaffInvite({
      email: inviteEmail,
      fullName: "Ivy Invitee",
      orgName: "Invite CO A",
      metadata: {
        invited_org_id: orgA,
        invited_role: "staff", // changed role → must refresh on the SAME user
        invited_full_name: "Ivy Invitee",
        invited_phone: null,
        invited_employment_type: null,
        invited_hourly_pay: null,
        invited_emergency_contact: null,
        source: "staff_invite",
      },
    });
    // ok:true(alreadyExisted) with Resend, or no_key locally — either way the
    // already-exists branch ran (no throw, no new account).
    if (res.ok) expect(res.alreadyExisted).toBe(true);
    else expect(res.reason).toBe("no_key");

    const after = await serviceClient().auth.admin.listUsers({ page: 1, perPage: 1000 });
    const matches = after.data.users.filter((u) => u.email === inviteEmail);
    expect(matches.length).toBe(countBefore); // no duplicate account
    expect(matches[0]?.app_metadata?.invited_role).toBe("staff"); // anchor refreshed
  });
});
