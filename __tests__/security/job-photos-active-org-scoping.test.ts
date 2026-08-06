import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { requireOrgContext } from "@/server/auth/session";
import { createClient } from "@/lib/supabase/server";
import type { NextRequest } from "next/server";

/**
 * Active-org scoping — GET /api/jobs/[id]/photos (the #456 read-side class, c35c straggler).
 *
 * THE DEFECT: CrewFlow users can belong to more than one organisation, and the
 * app tracks an "active org" (`active_org_id` cookie → `requireOrgContext()`).
 * The RLS helpers `current_org_ids()` / `is_org_admin()` are deliberately
 * permissive — they admit EVERY org the viewer belongs to — so a by-id job read
 * with NO `org_id` predicate is multi-org for any dual-org member. This GET
 * loaded the job by `.eq("id", id)` alone and then minted short-lived SIGNED
 * URLs for its photos: a dual-org member could read a job — and download its
 * photos — from their OTHER org via this route. The POST handler in the same
 * file already stamps the active org; the GET was the straggler.
 *
 * THE FIX (two controls, both pinned here):
 *   1. The job lookup is constrained to `ctx.org.id`, so an other-org job is
 *      indistinguishable from a missing one (404) — mirrors the POST handler
 *      and jobs/[id]/page.tsx (loadJobForOrg).
 *   2. Defence-in-depth before signing: each stored path must live under this
 *      org's prefix (storagePathBelongsToOrg), so a poisoned `photos` entry
 *      pointing at another org's object is never handed a signed URL — mirrors
 *      the signer guard in server/services/job-documents.ts + blueprints.ts.
 *
 * Companion to __tests__/integration/rls/active-org-scoping.test.ts, which
 * proves the same invariant against real Postgres via loadJobForOrg. Here the
 * route wiring is isolated with both seams mocked so the test is hermetic.
 */

vi.mock("@/server/auth/session", () => ({ requireOrgContext: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

// Late import so the module mocks are bound before the route module resolves.
async function loadRoute() {
  return import("@/app/api/jobs/[id]/photos/route");
}

type JobRow = { id: string; org_id: string; photos: string[] };

/** Records every signing request so a test can assert exactly which paths were signed. */
type SignCall = { bucket: string; paths: string[]; ttl: number };

/**
 * A fake Supabase client backed by an in-memory `jobs` table. `.eq()` collects
 * predicates; `.maybeSingle()` returns a row ONLY when EVERY collected predicate
 * matches. So if the route ever drops the `org_id` predicate, a foreign-org job
 * matches by id alone and the scoping assertions turn red — the fake enforces
 * the invariant, it does not assume it.
 */
function makeSupabase(jobs: JobRow[]) {
  const signCalls: SignCall[] = [];
  const client = {
    from(table: string) {
      const filters: Record<string, unknown> = {};
      const builder = {
        select: () => builder,
        eq: (col: string, val: unknown) => {
          filters[col] = val;
          return builder;
        },
        maybeSingle: async () => {
          if (table !== "jobs") return { data: null, error: null };
          const match = jobs.find((j) =>
            Object.entries(filters).every(
              ([k, v]) => (j as unknown as Record<string, unknown>)[k] === v,
            ),
          );
          return {
            data: match ? { id: match.id, photos: match.photos } : null,
            error: null,
          };
        },
      };
      return builder;
    },
    storage: {
      from(bucket: string) {
        return {
          createSignedUrls: async (paths: string[], ttl: number) => {
            signCalls.push({ bucket, paths, ttl });
            return {
              data: paths.map((p) => ({
                path: p,
                signedUrl: `https://signed.example/${p}`,
                error: null,
              })),
              error: null,
            };
          },
        };
      },
    },
    __signCalls: signCalls,
  };
  return client;
}

function sessionContext(orgId: string): Awaited<ReturnType<typeof requireOrgContext>> {
  return {
    user: { id: "user-1" },
    ctx: {
      membership: { org_id: orgId, role: "owner" },
      org: { id: orgId, name: "Org", slug: "org", status: "active" },
    },
  } as unknown as Awaited<ReturnType<typeof requireOrgContext>>;
}

/** The handler only awaits `params`, so a promise-bearing stand-in is sufficient. */
function ctxArg(id: string) {
  return { params: Promise.resolve({ id }) };
}
const NO_REQUEST = {} as unknown as NextRequest;

const ORG_A = "00000000-0000-0000-0000-00000000000a";
const ORG_B = "00000000-0000-0000-0000-00000000000b";

describe("GET /api/jobs/[id]/photos — active-org scoping", () => {
  beforeEach(() => {
    vi.mocked(requireOrgContext).mockReset();
    vi.mocked(createClient).mockReset();
  });
  afterEach(() => vi.restoreAllMocks());

  it("a dual-org member gets 404 for a job in their OTHER org (the defect)", async () => {
    // Active org A; the job lives in org B. RLS would admit it (the viewer owns
    // both), so ONLY the app-layer org pin keeps it not-found.
    vi.mocked(requireOrgContext).mockResolvedValue(sessionContext(ORG_A));
    const supa = makeSupabase([
      { id: "job-B", org_id: ORG_B, photos: [`${ORG_B}/job-B/secret.jpg`] },
    ]);
    vi.mocked(createClient).mockResolvedValue(supa as never);

    const { GET } = await loadRoute();
    const res = await GET(NO_REQUEST, ctxArg("job-B"));

    expect(res.status).toBe(404);
    // The other org's photos must NEVER be signed.
    expect(supa.__signCalls, "no signed URL may be minted for a foreign job").toHaveLength(0);
  });

  it("returns the job's own photos when it belongs to the ACTIVE org (no over-scoping)", async () => {
    vi.mocked(requireOrgContext).mockResolvedValue(sessionContext(ORG_A));
    const supa = makeSupabase([
      { id: "job-A", org_id: ORG_A, photos: [`${ORG_A}/job-A/p1.jpg`, `${ORG_A}/job-A/p2.jpg`] },
    ]);
    vi.mocked(createClient).mockResolvedValue(supa as never);

    const { GET } = await loadRoute();
    const res = await GET(NO_REQUEST, ctxArg("job-A"));

    expect(res.status).toBe(200);
    const body = (await res.json()) as { photos: Array<{ path: string; url: string }> };
    expect(body.photos.map((p) => p.path)).toEqual([
      `${ORG_A}/job-A/p1.jpg`,
      `${ORG_A}/job-A/p2.jpg`,
    ]);
    expect(supa.__signCalls).toHaveLength(1);
    expect(supa.__signCalls[0]!.bucket).toBe("job-photos");
  });

  it("drops a poisoned photo path pointing at ANOTHER org before signing (defence-in-depth)", async () => {
    // The job itself is in the active org, but its `photos` array has been
    // poisoned with a key under org B's prefix. That path must never be signed.
    vi.mocked(requireOrgContext).mockResolvedValue(sessionContext(ORG_A));
    const own = `${ORG_A}/job-A/mine.jpg`;
    const foreign = `${ORG_B}/job-B/leak.jpg`;
    const supa = makeSupabase([{ id: "job-A", org_id: ORG_A, photos: [own, foreign] }]);
    vi.mocked(createClient).mockResolvedValue(supa as never);

    const { GET } = await loadRoute();
    const res = await GET(NO_REQUEST, ctxArg("job-A"));

    expect(res.status).toBe(200);
    const body = (await res.json()) as { photos: Array<{ path: string }> };
    expect(body.photos.map((p) => p.path)).toEqual([own]);
    // The foreign key never reached the signer.
    expect(supa.__signCalls).toHaveLength(1);
    expect(supa.__signCalls[0]!.paths).toEqual([own]);
    expect(JSON.stringify(supa.__signCalls)).not.toContain(foreign);
  });

  it("returns an empty gallery (no signing) when the active-org job has no photos", async () => {
    vi.mocked(requireOrgContext).mockResolvedValue(sessionContext(ORG_A));
    const supa = makeSupabase([{ id: "job-A", org_id: ORG_A, photos: [] }]);
    vi.mocked(createClient).mockResolvedValue(supa as never);

    const { GET } = await loadRoute();
    const res = await GET(NO_REQUEST, ctxArg("job-A"));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ photos: [] });
    expect(supa.__signCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Source pins — register this straggler in the documented read-side convention
// (mirrors __tests__/security/active-org-read-stragglers.test.ts). These fail
// against the pre-fix source even if the behavioural fake above were relaxed.
// ---------------------------------------------------------------------------

describe("GET /api/jobs/[id]/photos — source invariants", () => {
  const SRC = () =>
    readFileSync(
      resolve(__dirname, "..", "..", "app/api/jobs/[id]/photos/route.ts"),
      "utf8",
    );
  const GET = () => {
    const s = SRC();
    const start = s.indexOf("export async function GET");
    const next = s.indexOf("\nexport async function", start + 1);
    return s.slice(start, next === -1 ? undefined : next);
  };

  it("the GET handler captures ctx and pins the job read to the active org", () => {
    const F = GET();
    expect(F, "GET must destructure ctx from requireOrgContext").toMatch(
      /const \{[^}]*\bctx\b[^}]*\} = await requireOrgContext\(\)/,
    );
    expect(F, "the job lookup lost its active-org predicate").toMatch(
      /\.eq\(\s*["']id["'],\s*id\s*\)\s*\.eq\(\s*["']org_id["'],\s*ctx\.org\.id\s*\)/,
    );
  });

  it("the GET handler guards each path with storagePathBelongsToOrg before signing", () => {
    expect(SRC()).toMatch(
      /import \{ storagePathBelongsToOrg \} from "@\/lib\/storage\/owned-path"/,
    );
    expect(GET()).toMatch(/storagePathBelongsToOrg\(\s*p,\s*ctx\.org\.id\s*\)/);
  });
});
