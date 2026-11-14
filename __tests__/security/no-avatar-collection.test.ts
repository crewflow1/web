import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * DATA MINIMISATION — CrewFlow does not collect profile pictures.
 *
 * `/auth/callback` used to lift `avatar_url` / `picture` out of the OAuth
 * provider's metadata (for a Google sign-in: a URL to the person's profile
 * photo) and `ensureUserRow` copied it into `public.users.avatar_url` on every
 * sign-in. Nothing in the product ever read that column — no screen, export,
 * email or PDF — so it was personal data (an image of a face, by reference)
 * collected for no purpose.
 *
 * These tests pin that the copy cannot silently return:
 *   1. BEHAVIOUR — `ensureUserRow` upserts no `avatar_url` key, even if a
 *      caller passes one.
 *   2. SOURCE — the auth callback no longer reads the provider's picture, and
 *      no application code selects or writes `avatar_url`.
 */

const { upsertMock } = vi.hoisted(() => ({
  upsertMock: vi.fn<(row: Record<string, unknown>, opts?: unknown) => Promise<{ error: null }>>(
    async () => ({ error: null }),
  ),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({
      upsert: (row: Record<string, unknown>, opts?: unknown) => upsertMock(row, opts),
    }),
  }),
}));
vi.mock("@/server/services/sample-data", () => ({ seedSampleData: async () => {} }));

import { ensureUserRow } from "@/server/services/bootstrap-account";

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

beforeEach(() => upsertMock.mockClear());

describe("no profile-picture collection", () => {
  it("ensureUserRow never writes avatar_url, even when handed one", async () => {
    const input = {
      id: "00000000-0000-4000-8000-000000000001",
      email: "person@example.com",
      fullName: "Pat Example",
      phone: null,
      // A stale caller (or a future refactor) passing the old field must not
      // bring the column back.
      avatarUrl: "https://lh3.googleusercontent.com/a/example-photo",
    };
    await ensureUserRow(input as unknown as Parameters<typeof ensureUserRow>[0]);

    expect(upsertMock).toHaveBeenCalledTimes(1);
    const row = upsertMock.mock.calls[0]![0];
    expect(Object.keys(row).sort()).toEqual(["email", "full_name", "id", "phone"]);
    expect(JSON.stringify(row)).not.toContain("googleusercontent");
  });

  it("the auth callback does not read the provider's picture / avatar metadata", () => {
    const src = stripComments(read("app/auth/callback/route.ts"));
    expect(src).not.toMatch(/avatar/i);
    expect(src).not.toMatch(/meta\.picture/);
  });

  it("the bootstrap service has no executable reference to avatar_url", () => {
    expect(stripComments(read("server/services/bootstrap-account.ts"))).not.toMatch(/avatar/i);
  });
});
