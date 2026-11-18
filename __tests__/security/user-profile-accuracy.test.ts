import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * DATA ACCURACY — signing in never erases a saved name or phone number.
 *
 * `ensureUserRow` runs on every sign-in. The password and magic-link paths
 * call it with only `{ id, email }`; it used to upsert `full_name: null,
 * phone: null`, so each such sign-in wiped the name and phone the person (or
 * their employer) had saved — staff names then vanished from rotas, payslips
 * and audit entries (UK GDPR Art. 5(1)(d), accuracy).
 *
 * Pinned:
 *   1. BEHAVIOUR — absent / null / empty profile fields are OMITTED from the
 *      upsert (so Postgres leaves the stored value alone); supplied values are
 *      written.
 *   2. SOURCE — the upsert payload is built conditionally; no `?? null`
 *      fallback for full_name / phone comes back.
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

const ID = "00000000-0000-4000-8000-0000000000a1";

beforeEach(() => upsertMock.mockClear());

describe("ensureUserRow preserves saved profile fields", () => {
  it("a password / magic-link sign-in ({id, email} only) writes neither full_name nor phone", async () => {
    await ensureUserRow({ id: ID, email: "pat@example.com" });
    const [row, opts] = upsertMock.mock.calls[0]!;
    expect(row).toEqual({ id: ID, email: "pat@example.com" });
    expect(opts).toEqual({ onConflict: "id" });
  });

  it("explicit null or empty values are omitted, never written as NULL", async () => {
    await ensureUserRow({ id: ID, email: "pat@example.com", fullName: null, phone: "" });
    const row = upsertMock.mock.calls[0]![0];
    expect(row).not.toHaveProperty("full_name");
    expect(row).not.toHaveProperty("phone");
  });

  it("supplied values (OAuth name, invite phone) are written", async () => {
    await ensureUserRow({ id: ID, email: "pat@example.com", fullName: "Pat Example", phone: "+447700900123" });
    expect(upsertMock.mock.calls[0]![0]).toEqual({
      id: ID,
      email: "pat@example.com",
      full_name: "Pat Example",
      phone: "+447700900123",
    });
  });

  it("source: no unconditional NULL fallback for the profile fields", () => {
    const file = readFileSync(join(process.cwd(), "server/services/bootstrap-account.ts"), "utf8");
    const start = file.indexOf("export async function ensureUserRow");
    expect(start).toBeGreaterThanOrEqual(0);
    const next = file.indexOf("export async function", start + 1);
    const body = file.slice(start, next === -1 ? undefined : next);
    expect(body).not.toMatch(/full_name:\s*input\.fullName\s*\?\?\s*null/);
    expect(body).not.toMatch(/phone:\s*input\.phone\s*\?\?\s*null/);
  });
});
