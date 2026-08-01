import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { describeIntegration, serviceClient } from "../_harness";
import { generateApiKey } from "@/lib/api-auth/keygen";

/**
 * Public API v1 jobs read — end-to-end against real Postgres (Train K).
 *
 * AUTHORED, NOT RUN in this train (per the mission's verify constraints). It is
 * the live-DB counterpart to the source pins in
 * __tests__/security/public-api-jobs.test.ts, exercising the route HANDLERS
 * with real api_keys rows so the org-pinning, scope gate, and no-cross-org
 * oracle are proven against the database, not just the source.
 *
 * THE FLAG: the routes are dark behind FEATURE_PUBLIC_API_JOBS. Rather than
 * depend on the process env (lib/env parses once at import), this suite mocks
 * lib/public-api/flag so each test controls the surface explicitly — and one
 * test flips it OFF to prove the dark 404.
 */

const flagState = { enabled: true };
vi.mock("@/lib/public-api/flag", () => ({
  isPublicApiJobsEnabled: () => flagState.enabled,
}));

type Res<T> = { data: T | null; error: { message: string; code?: string } | null };
type Row = Record<string, unknown>;
interface Ins extends PromiseLike<Res<Row[]>> {
  select(columns?: string): { single(): PromiseLike<Res<Row>> };
}
interface Table {
  insert(rows: Row | Row[]): Ins;
}
const db = (client: unknown) => client as unknown as { from(t: string): Table };

const TOKEN = `it-pubapi-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describeIntegration("public API v1 · jobs read · isolation, scope, oracle", () => {
  const svc = () => db(serviceClient());

  let orgA = "";
  let orgB = "";
  let jobA = "";
  let jobB = "";

  /** Plaintext keys we present in the Authorization header. */
  let keyA_read = ""; // org A, scope read:jobs
  let keyA_noscope = ""; // org A, but NO read:jobs scope
  let keyA_revoked = ""; // org A, read:jobs, but revoked

  async function makeOrg(name: string, slug: string): Promise<string> {
    const r = await svc().from("organizations").insert({ name, slug }).select("id").single();
    expect(r.error, r.error?.message).toBeNull();
    return String(r.data?.id ?? "");
  }

  async function makeJob(org: string): Promise<string> {
    const r = await svc()
      .from("jobs")
      .insert({ org_id: org, status: "scheduled", site_postcode: "SW1A 1AA" })
      .select("id")
      .single();
    expect(r.error, r.error?.message).toBeNull();
    return String(r.data?.id ?? "");
  }

  /** Mint a key row directly via service-role (bypasses the admin UI). */
  async function mintKey(
    org: string,
    scopes: string[],
    opts: { revoked?: boolean } = {},
  ): Promise<string> {
    const k = generateApiKey();
    const r = await svc()
      .from("api_keys")
      .insert({
        org_id: org,
        name: `${TOKEN}-${scopes.join("+") || "noscope"}`,
        key_prefix: k.keyPrefix,
        key_hash: k.keyHash,
        scopes,
        revoked_at: opts.revoked ? new Date().toISOString() : null,
      })
      .select("id")
      .single();
    expect(r.error, r.error?.message).toBeNull();
    return k.plaintext;
  }

  const bearer = (plaintext: string) =>
    new Request("https://app.crewflow.uk/api/v1/jobs", {
      headers: { authorization: `Bearer ${plaintext}` },
    });

  beforeAll(async () => {
    orgA = await makeOrg("PubAPI Probe A", `${TOKEN}-a`);
    orgB = await makeOrg("PubAPI Probe B", `${TOKEN}-b`);
    jobA = await makeJob(orgA);
    jobB = await makeJob(orgB);
    keyA_read = await mintKey(orgA, ["read:jobs"]);
    // An empty scope set — a live key that can do nothing. hasScope → false → 403.
    keyA_noscope = await mintKey(orgA, []);
    keyA_revoked = await mintKey(orgA, ["read:jobs"], { revoked: true });
  });

  afterAll(async () => {
    // Org teardown cascades api_keys + jobs (FK on delete cascade).
    for (const id of [orgA, orgB]) {
      if (id) await serviceClient().from("organizations").delete().eq("id", id);
    }
  });

  it("a key for org A lists ONLY org A's jobs (never org B's)", async () => {
    flagState.enabled = true;
    const { GET } = await import("@/app/api/v1/jobs/route");
    const res = await GET(bearer(keyA_read));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ id: string }> };
    const ids = body.data.map((j) => j.id);
    expect(ids).toContain(jobA);
    expect(ids).not.toContain(jobB);
  });

  it("the list DTO carries only the allowlisted fields (no cost/PII/internal)", async () => {
    flagState.enabled = true;
    const { GET } = await import("@/app/api/v1/jobs/route");
    const res = await GET(bearer(keyA_read));
    const body = (await res.json()) as { data: Array<Record<string, unknown>> };
    const row = body.data.find((j) => j.id === jobA)!;
    expect(Object.keys(row).sort()).toEqual(
      ["created_at", "id", "scheduled_date", "site_postcode", "status", "updated_at"].sort(),
    );
    for (const forbidden of ["org_id", "customer_id", "assigned_to", "notes", "ai_summary", "photos"]) {
      expect(row).not.toHaveProperty(forbidden);
    }
  });

  it("a key WITHOUT read:jobs → 403", async () => {
    flagState.enabled = true;
    // keyA_noscope was minted with an empty scope set — authenticated, but the
    // read:jobs capability was never granted.
    const { GET } = await import("@/app/api/v1/jobs/route");
    const res = await GET(bearer(keyA_noscope));
    expect(res.status).toBe(403);
  });

  it("a REVOKED key → 401", async () => {
    flagState.enabled = true;
    const { GET } = await import("@/app/api/v1/jobs/route");
    const res = await GET(bearer(keyA_revoked));
    expect(res.status).toBe(401);
  });

  it("org B's job id via org A's key → 404 (no cross-org oracle)", async () => {
    flagState.enabled = true;
    const { GET } = await import("@/app/api/v1/jobs/[id]/route");
    const res = await GET(
      new Request(`https://app.crewflow.uk/api/v1/jobs/${jobB}`, {
        headers: { authorization: `Bearer ${keyA_read}` },
      }),
      { params: Promise.resolve({ id: jobB }) },
    );
    expect(res.status).toBe(404);
  });

  it("org A's own job id via org A's key → 200 with the DTO", async () => {
    flagState.enabled = true;
    const { GET } = await import("@/app/api/v1/jobs/[id]/route");
    const res = await GET(
      new Request(`https://app.crewflow.uk/api/v1/jobs/${jobA}`, {
        headers: { authorization: `Bearer ${keyA_read}` },
      }),
      { params: Promise.resolve({ id: jobA }) },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { id: string } };
    expect(body.data.id).toBe(jobA);
  });

  it("flag OFF → 404 (dark), even with a perfectly valid key + scope", async () => {
    flagState.enabled = false;
    const { GET } = await import("@/app/api/v1/jobs/route");
    const res = await GET(bearer(keyA_read));
    expect(res.status).toBe(404);
    flagState.enabled = true;
  });
});
