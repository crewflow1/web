import { afterAll, beforeAll, expect, it } from "vitest";
import {
  anonClient,
  describeIntegration,
  serviceClient,
  userClient,
} from "../_harness";
import { resolveScannedAssetForOrg } from "@/lib/assets/scan";
import { isValidTokenFormat } from "@/lib/assets/qr";

/**
 * QR SCAN · ACTIVE-ORG ISOLATION — proven against real Postgres with a genuine
 * MULTI-ORG user, driving the REAL resolver (`lib/assets/scan.ts`), not a replica.
 *
 * Why this file exists. `__tests__/integration/rls/asset-qr-scan.test.ts`
 * asserted the scan's tenant safety by REPLICATING the resolver on the
 * service-role client with an explicit `.eq("org_id", …)` that the shipped code
 * did NOT have. It therefore proved a resolver shape that did not exist, and
 * went green while `app/(app)/assets/_scan.ts` resolved a token using RLS alone.
 * This suite drives the real function with real JWTs so the proof cannot drift
 * from the implementation again.
 *
 * The defect class (#456): `current_org_ids()` returns EVERY org the viewer
 * belongs to — correct for RLS, which enforces the OUTER boundary — so a lookup
 * keyed only by token/PK is NOT constrained to the ACTIVE org. A user working
 * in org A could scan org B's label and have B's asset render inside A's shell,
 * then hand off to `/assets/<id>` where the custody actions live.
 *
 * Four properties are pinned here:
 *   1. OUTER BOUNDARY — a user in NEITHER org gets nothing (RLS, untouched).
 *   2. ACTIVE-ORG SCOPING — a dual-org user active in A cannot resolve B's token.
 *   3. NO OVER-SCOPING — the same user active in B still resolves it (the org
 *      switcher must keep working), and A's own token still resolves in A.
 *   4. INDISTINGUISHABILITY — foreign-org, unknown, revoked and malformed tokens
 *      all return the byte-identical `null`, so the scan is not an existence
 *      oracle.
 *
 * It also pins the PREMISE: the un-pinned query shape really does return org B's
 * asset for this user. If that ever stops being true, `current_org_ids()`
 * changed and `lib/assets/scan.ts` should be revisited.
 */

type Res<T> = { data: T | null; error: { message: string } | null };
type Row = Record<string, unknown>;
interface Sel extends PromiseLike<Res<Row[]>> {
  eq(column: string, value: unknown): Sel;
  maybeSingle(): PromiseLike<Res<Row>>;
}
interface Ins extends PromiseLike<Res<Row[]>> {
  select(columns?: string): { single(): PromiseLike<Res<Row>> };
}
interface Del extends PromiseLike<Res<null>> {
  eq(column: string, value: unknown): Del;
}
interface Table {
  select(columns?: string): Sel;
  insert(rows: Row | Row[]): Ins;
  delete(): Del;
}
const db = (client: unknown) => client as unknown as { from(t: string): Table };

const TOKEN = `it-qraos-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
let seq = 0;
/**
 * A fixture token that satisfies the resolver's shape gate (base64url, 16–64
 * chars). This MUST be long enough: a token under 16 chars is rejected by
 * `isValidTokenFormat` before any DB work, which would make every isolation
 * assertion below pass for the WRONG reason. `assertRealToken` pins that.
 */
const qrToken = (label: string) =>
  `qr-${label}-${seq++}-${Math.random().toString(36).slice(2)}${Math.random()
    .toString(36)
    .slice(2)}`
    .replace(/[^A-Za-z0-9_-]/g, "-")
    .slice(0, 48);

/** Guard against the false-pass described above. */
function assertRealToken(t: string): string {
  expect(
    isValidTokenFormat(t),
    `fixture token ${JSON.stringify(t)} must pass the shape gate, otherwise ` +
      "the isolation assertions below would pass at the edge gate rather than " +
      "at the org predicate they are meant to prove",
  ).toBe(true);
  return t;
}

/**
 * The EXACT un-pinned two-step lookup that `_scan.ts` shipped before this fix:
 * identity by token + active (no org predicate), then asset by id (no org
 * predicate). Kept verbatim so the premise test measures the real prior shape.
 */
async function resolveUnpinned(
  client: unknown,
  token: string,
): Promise<string | null> {
  const { data: identity } = await db(client)
    .from("asset_qr_identities")
    .select("asset_id")
    .eq("token", token)
    .eq("active", true)
    .maybeSingle();
  const assetId = identity?.asset_id as string | undefined;
  if (!assetId) return null;
  const { data: asset } = await db(client)
    .from("assets")
    .select("id")
    .eq("id", assetId)
    .maybeSingle();
  return (asset?.id as string) ?? null;
}

describeIntegration("qr scan · active-org isolation (multi-org user)", () => {
  let orgA = "";
  let orgB = "";
  let assetA = "";
  let assetB = "";

  let tokenA = "";
  let tokenB = "";
  let tokenRevokedB = "";

  // The multi-org user: OWNER of both A and B — this is what makes the blend
  // possible and what makes RLS (correctly) permit the row.
  let dualUserId = "";
  let dualToken = "";

  // A user who belongs to NEITHER org — the RLS control.
  let outsiderUserId = "";
  let outsiderToken = "";

  async function mintUser(label: string): Promise<{ id: string; token: string }> {
    const email = `${TOKEN}-${label}@example.test`;
    const password = `Pw-${TOKEN}-${Math.random().toString(36).slice(2)}`;
    const created = await serviceClient().auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    expect(created.error, created.error?.message).toBeNull();
    const id = created.data.user?.id ?? "";
    // No auth.users → public.users trigger in this schema, so mirror the row
    // ourselves (memberships.user_id FKs public.users).
    const mirrored = await db(serviceClient())
      .from("users")
      .insert({ id, email, full_name: `QR scan ${label}` })
      .select("id")
      .single();
    expect(mirrored.error, mirrored.error?.message).toBeNull();
    const signedIn = await anonClient().auth.signInWithPassword({ email, password });
    expect(signedIn.error, signedIn.error?.message).toBeNull();
    return { id, token: signedIn.data.session?.access_token ?? "" };
  }

  async function mkOrg(slug: string): Promise<string> {
    const { data, error } = await db(serviceClient())
      .from("organizations")
      .insert({ name: `QR AOS ${slug}`, slug })
      .select("id")
      .single();
    expect(error, error?.message).toBeNull();
    return String(data?.id ?? "");
  }

  async function mkAsset(org: string, name: string): Promise<string> {
    const { data, error } = await db(serviceClient())
      .from("assets")
      .insert({ org_id: org, name })
      .select("id")
      .single();
    expect(error, error?.message).toBeNull();
    return String(data?.id ?? "");
  }

  async function mkIdentity(
    org: string,
    asset: string,
    token: string,
    active: boolean,
  ): Promise<void> {
    const { error } = await db(serviceClient())
      .from("asset_qr_identities")
      .insert({ org_id: org, asset_id: asset, token, active });
    expect(error, error?.message).toBeNull();
  }

  beforeAll(async () => {
    orgA = await mkOrg(`${TOKEN}-a`);
    orgB = await mkOrg(`${TOKEN}-b`);
    if (!orgA || !orgB) throw new Error("failed to create probe orgs");

    assetA = await mkAsset(orgA, "Org A breaker");
    assetB = await mkAsset(orgB, "Org B Hilti TE-70 — CONFIDENTIAL");
    const assetBRevoked = await mkAsset(orgB, "Org B retired grinder");

    tokenA = assertRealToken(qrToken("a"));
    tokenB = assertRealToken(qrToken("b"));
    tokenRevokedB = assertRealToken(qrToken("brev"));
    await mkIdentity(orgA, assetA, tokenA, true);
    await mkIdentity(orgB, assetB, tokenB, true);
    await mkIdentity(orgB, assetBRevoked, tokenRevokedB, false);

    const dual = await mintUser("dual");
    dualUserId = dual.id;
    dualToken = dual.token;
    const svc = db(serviceClient());
    const m1 = await svc
      .from("memberships")
      .insert({ org_id: orgA, user_id: dualUserId, role: "owner" });
    const m2 = await svc
      .from("memberships")
      .insert({ org_id: orgB, user_id: dualUserId, role: "owner" });
    expect(m1.error, m1.error?.message).toBeNull();
    expect(m2.error, m2.error?.message).toBeNull();

    const outsider = await mintUser("outsider");
    outsiderUserId = outsider.id;
    outsiderToken = outsider.token;

    if (!dualToken || !outsiderToken) throw new Error("failed to mint tokens");
  });

  afterAll(async () => {
    const svc = db(serviceClient());
    if (orgA) await svc.from("organizations").delete().eq("id", orgA);
    if (orgB) await svc.from("organizations").delete().eq("id", orgB);
    if (dualUserId) await serviceClient().auth.admin.deleteUser(dualUserId);
    if (outsiderUserId) await serviceClient().auth.admin.deleteUser(outsiderUserId);
  });

  // ---------------------------------------------------------------- premise

  it("documents the defect: the UNPINNED resolver really does return org B's asset", async () => {
    const resolved = await resolveUnpinned(userClient(dualToken), tokenB);
    expect(
      resolved,
      "RLS is deliberately permissive across memberships — if this ever returns " +
        "null, current_org_ids() changed and lib/assets/scan.ts should be revisited",
    ).toBe(assetB);
  });

  // --------------------------------------------------------- outer boundary

  it("a user in NEITHER org resolves nothing (RLS outer boundary, untouched)", async () => {
    const client = userClient(outsiderToken);
    expect(await resolveScannedAssetForOrg(client, tokenB, orgB)).toBeNull();
    expect(await resolveScannedAssetForOrg(client, tokenA, orgA)).toBeNull();
    // …and not even the un-pinned shape leaks to them.
    expect(await resolveUnpinned(client, tokenB)).toBeNull();
  });

  it("an ANONYMOUS scan of a valid token resolves nothing", async () => {
    const anon = anonClient();
    expect(await resolveScannedAssetForOrg(anon, tokenB, orgB)).toBeNull();
    expect(await resolveUnpinned(anon, tokenB)).toBeNull();
  });

  // ----------------------------------------------------------- active-org

  it("org B's token is NOT resolvable while org A is the active org", async () => {
    const scanned = await resolveScannedAssetForOrg(
      userClient(dualToken),
      tokenB,
      orgA,
    );
    expect(
      scanned,
      "a token in a non-active org must be indistinguishable from an unknown token",
    ).toBeNull();
  });

  it("the foreign-org asset's NAME never reaches the caller", async () => {
    const scanned = await resolveScannedAssetForOrg(
      userClient(dualToken),
      tokenB,
      orgA,
    );
    expect(JSON.stringify(scanned)).not.toContain("CONFIDENTIAL");
  });

  // -------------------------------------------------------- no over-scoping

  it("org A's own token still resolves while org A is active (regression)", async () => {
    const scanned = await resolveScannedAssetForOrg(
      userClient(dualToken),
      tokenA,
      orgA,
    );
    expect(scanned?.id, "the ordinary same-org scan must keep working").toBe(assetA);
    expect(scanned?.name).toBe("Org A breaker");
  });

  it("switching active org to B makes B's token resolve and A's not-found", async () => {
    // Proves the predicate tracks the ACTIVE org rather than hiding org B for
    // ever — the org switcher must still work.
    const client = userClient(dualToken);
    const bWhileActiveB = await resolveScannedAssetForOrg(client, tokenB, orgB);
    const aWhileActiveB = await resolveScannedAssetForOrg(client, tokenA, orgB);
    expect(bWhileActiveB?.id).toBe(assetB);
    expect(aWhileActiveB).toBeNull();
  });

  // ------------------------------------------------------ indistinguishable

  it("foreign-org, unknown, revoked and malformed tokens are byte-identical", async () => {
    const client = userClient(dualToken);
    const foreign = await resolveScannedAssetForOrg(client, tokenB, orgA);
    const unknown = await resolveScannedAssetForOrg(
      client,
      assertRealToken(qrToken("never-issued")),
      orgA,
    );
    const revoked = await resolveScannedAssetForOrg(client, tokenRevokedB, orgB);
    const malformed = await resolveScannedAssetForOrg(client, "!!short!!", orgA);

    const shapes = [foreign, unknown, revoked, malformed].map((r) =>
      JSON.stringify(r),
    );
    expect(
      new Set(shapes).size,
      "every failure mode must return the identical null — no existence oracle",
    ).toBe(1);
    expect(shapes[0]).toBe("null");
  });

  it("a revoked token in the caller's OWN org still resolves nothing", async () => {
    expect(
      await resolveScannedAssetForOrg(userClient(dualToken), tokenRevokedB, orgB),
    ).toBeNull();
  });

  it("an empty active org resolves nothing rather than matching everything", async () => {
    expect(
      await resolveScannedAssetForOrg(userClient(dualToken), tokenA, ""),
    ).toBeNull();
  });
});
