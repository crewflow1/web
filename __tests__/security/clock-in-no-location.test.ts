import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * DATA MINIMISATION — clock-in records no location.
 *
 * `time_entries` carries legacy `gps_lat` / `gps_lng` columns. No screen ever
 * captured a position (and the app's Permissions-Policy denies geolocation),
 * but the clock-in server action used to copy those two fields straight out of
 * the submitted FormData — so a hand-crafted post could store a worker's
 * precise coordinates with no notice, no purpose and no retention rule.
 *
 * Precise location of a worker is high-risk personal data. These tests pin
 * that it cannot come back by accident:
 *   1. BEHAVIOUR — a FormData that DOES carry coordinates produces an insert
 *      with no location keys at all.
 *   2. SOURCE — neither the action nor the /me page names the columns, and no
 *      client code under app/ or components/ posts such a field.
 *   3. PLATFORM — the baseline Permissions-Policy still denies geolocation.
 */

const { insertMock, redirectMock } = vi.hoisted(() => ({
  insertMock: vi.fn(async (_row: Record<string, unknown>) => ({ error: null })),
  redirectMock: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
}));

vi.mock("next/navigation", () => ({ redirect: (u: string) => redirectMock(u) }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/server/auth/session", () => ({
  requireOrgContext: async () => ({
    ctx: { org: { id: "org-1" }, membership: { role: "staff" } },
    user: { id: "user-1" },
  }),
}));

/** A chainable read stub that resolves to `result` when awaited or finished. */
function readChain(result: { data: unknown; error: null }) {
  const chain: Record<string, unknown> = {};
  for (const m of ["select", "eq", "is", "order", "limit"]) {
    chain[m] = () => chain;
  }
  chain.maybeSingle = async () => result;
  chain.then = (resolve: (v: unknown) => unknown) => resolve(result);
  return chain;
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: (table: string) => {
      if (table === "time_entries") {
        return {
          ...readChain({ data: null, error: null }), // "no open entry"
          insert: (row: Record<string, unknown>) => insertMock(row),
        };
      }
      // leave_requests: no approved leave.
      return readChain({ data: [], error: null });
    },
  }),
}));

import { clockIn } from "@/app/(app)/me/actions";

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

beforeEach(() => {
  insertMock.mockClear();
  redirectMock.mockClear();
});

describe("clock-in stores no location", () => {
  it("ignores gps_lat / gps_lng (and look-alikes) supplied in the form post", async () => {
    const fd = new FormData();
    fd.append("job_id", "");
    fd.append("note", "on site");
    fd.append("gps_lat", "54.5973");
    fd.append("gps_lng", "-5.9301");
    fd.append("latitude", "54.5973");
    fd.append("longitude", "-5.9301");

    await expect(clockIn(fd)).rejects.toThrow("REDIRECT:/me?saved=clocked_in");

    expect(insertMock).toHaveBeenCalledTimes(1);
    const row = insertMock.mock.calls[0]![0];
    expect(row).toEqual({
      org_id: "org-1",
      user_id: "user-1",
      job_id: null,
      note: "on site",
    });
    for (const key of Object.keys(row)) {
      expect(key).not.toMatch(/gps|lat|lng|lon|location|geo/i);
    }
  });

  it("the action and the /me page never name the location columns in code", () => {
    // Comments may explain the absence; executable code must not use the names.
    const stripComments = (src: string) =>
      src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    for (const rel of ["app/(app)/me/actions.ts", "app/(app)/me/page.tsx"]) {
      expect(stripComments(read(rel)), rel).not.toMatch(/gps_lat|gps_lng/);
    }
  });

  it("the baseline Permissions-Policy still denies geolocation to every origin", () => {
    expect(read("lib/security/headers.ts")).toMatch(/geolocation=\(\)/);
  });
});
