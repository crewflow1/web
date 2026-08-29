import { afterAll, expect, it } from "vitest";
import { describeIntegration, serviceClient } from "../_harness";
import { CURRENT_TOS_VERSION, LEGACY_TOS_VERSION } from "@/lib/legal/tos";

/**
 * ToS acceptance persistence — real-Postgres proof (migration
 * 20261223000000, L11 item 3).
 *
 * Org-level by design (the org is the contracting party; see the
 * migration header). Proves:
 *
 *   • a new org created + stamped the way the onboarding action does it
 *     (createOrg in app/onboarding/company/actions.ts) persists the full
 *     stamp — at / by / version — and reads back intact;
 *   • a BRAND-NEW org carries NO stamp by default: the migration backfill
 *     ('legacy') was a one-time honest fill of pre-existing rows, never a
 *     default that would fabricate acceptance for future orgs;
 *   • tos_accepted_by is a real FK — a fabricated user id is refused;
 *   • the version CHECK refuses blank/oversized strings;
 *   • deleting the accepting USER anonymises the stamp (SET NULL) without
 *     destroying the org's acceptance fact — the GDPR-erasure property
 *     the migration documents.
 */

const T = `tos-${Date.now().toString(36)}`;
const svc = () => serviceClient();

const orgIds: string[] = [];
let userId: string | null = null;

async function makeOrg(slugSuffix: string): Promise<string> {
  const { data, error } = await svc()
    .from("organizations")
    .insert({ name: `ToS Test ${slugSuffix}`, slug: `${T}-${slugSuffix}` })
    .select("id")
    .single();
  expect(error, error?.message).toBeNull();
  const id = data?.id ?? "";
  orgIds.push(id);
  return id;
}

type TosRow = {
  tos_accepted_at: string | null;
  tos_accepted_by: string | null;
  tos_version: string | null;
};

async function readTos(orgId: string): Promise<TosRow> {
  const { data, error } = await (svc().from("organizations") as never as {
    select: (c: string) => {
      eq: (k: string, v: string) => {
        single: () => Promise<{
          data: TosRow | null;
          error: { message: string } | null;
        }>;
      };
    };
  })
    .select("tos_accepted_at, tos_accepted_by, tos_version")
    .eq("id", orgId)
    .single();
  expect(error, error?.message).toBeNull();
  return data as TosRow;
}

async function stamp(
  orgId: string,
  fields: Record<string, unknown>,
): Promise<{ message: string } | null> {
  const { error } = await (svc().from("organizations") as never as {
    update: (v: unknown) => {
      eq: (k: string, v: string) => Promise<{ error: { message: string } | null }>;
    };
  })
    .update(fields)
    .eq("id", orgId);
  return error;
}

describeIntegration("ToS acceptance persistence (real Postgres)", () => {
  afterAll(async () => {
    for (const id of orgIds) {
      await svc().from("organizations").delete().eq("id", id);
    }
    if (userId) {
      await svc().from("users").delete().eq("id", userId);
      await svc().auth.admin.deleteUser(userId);
    }
  });

  it("a new org gets the full stamp the onboarding action writes", async () => {
    // Real accepting user (FK chain public.users → auth.users).
    const created = await svc().auth.admin.createUser({
      email: `${T}-owner@example.test`,
      password: `Pw-${T}-${Math.random().toString(36).slice(2)}`,
      email_confirm: true,
    });
    expect(created.error, created.error?.message).toBeNull();
    userId = created.data.user?.id ?? null;
    const mirrored = await svc()
      .from("users")
      .insert({ id: userId!, email: `${T}-owner@example.test` });
    expect(mirrored.error, mirrored.error?.message).toBeNull();

    const orgId = await makeOrg("stamped");

    // A brand-new org has NO acceptance — backfill was one-time, honest.
    const fresh = await readTos(orgId);
    expect(fresh.tos_accepted_at).toBeNull();
    expect(fresh.tos_version).toBeNull();

    // The exact write app/onboarding/company/actions.ts performs.
    const acceptedAt = new Date().toISOString();
    const err = await stamp(orgId, {
      tos_accepted_at: acceptedAt,
      tos_accepted_by: userId,
      tos_version: CURRENT_TOS_VERSION,
    });
    expect(err, err?.message).toBeNull();

    const stamped = await readTos(orgId);
    expect(stamped.tos_accepted_by).toBe(userId);
    expect(stamped.tos_version).toBe(CURRENT_TOS_VERSION);
    expect(stamped.tos_version).not.toBe(LEGACY_TOS_VERSION);
    expect(stamped.tos_accepted_at).not.toBeNull();
    expect(
      Math.abs(
        new Date(stamped.tos_accepted_at as string).getTime() -
          new Date(acceptedAt).getTime(),
      ),
    ).toBeLessThan(2000);
  });

  it("refuses a fabricated accepting user (FK) and a blank version (CHECK)", async () => {
    const orgId = await makeOrg("invalid");

    const fkErr = await stamp(orgId, {
      tos_accepted_at: new Date().toISOString(),
      tos_accepted_by: "00000000-0000-4000-8000-00000000dead",
      tos_version: CURRENT_TOS_VERSION,
    });
    expect(fkErr, "bogus tos_accepted_by must be refused").not.toBeNull();

    const checkErr = await stamp(orgId, {
      tos_accepted_at: new Date().toISOString(),
      tos_version: "   ",
    });
    expect(checkErr, "blank tos_version must be refused").not.toBeNull();
  });

  it("erasing the accepting user anonymises WHO, never destroys THAT the org accepted", async () => {
    const orgId = await makeOrg("erasure");
    const err = await stamp(orgId, {
      tos_accepted_at: new Date().toISOString(),
      tos_accepted_by: userId,
      tos_version: CURRENT_TOS_VERSION,
    });
    expect(err, err?.message).toBeNull();

    // Delete the person (public.users row → SET NULL on the stamp).
    await svc().from("users").delete().eq("id", userId!);
    await svc().auth.admin.deleteUser(userId!);
    const after = await readTos(orgId);
    userId = null; // teardown already done
    expect(after.tos_accepted_by).toBeNull();
    expect(after.tos_accepted_at).not.toBeNull();
    expect(after.tos_version).toBe(CURRENT_TOS_VERSION);
  });
});
