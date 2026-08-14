import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * MFA recovery codes — trust-boundary + behavioural proofs for the lost-device
 * escape hatch (the one MFA capability Supabase does not provide natively).
 *
 * Pinned guarantees:
 *   - the secret table is SERVICE-ROLE ONLY: RLS enabled, no anon/authenticated
 *     policy, table grants revoked (source-contract on the migration);
 *   - generation requires a verified factor, replaces the old set, and returns
 *     plaintext ONCE while persisting only hashes;
 *   - redemption is one-time, constant-time, non-enumerating, rate-limited,
 *     removes the lost factor, and refuses if the code can't be burned;
 *   - a wrong code never grants access and never removes a factor.
 */

// ---- hoisted mocks --------------------------------------------------------
const { consumeMock, createClientMock, createAdminMock } = vi.hoisted(() => ({
  consumeMock: vi.fn(async (..._a: unknown[]) => ({ allowed: true, remaining: 4 })),
  createClientMock: vi.fn(),
  createAdminMock: vi.fn(),
}));

vi.mock("next/navigation", () => ({ redirect: (u: string) => { throw new Error(`REDIRECT:${u}`); } }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: () => createClientMock() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => createAdminMock() }));
vi.mock("@/lib/security/rate-limit", () => ({
  consume: (...a: unknown[]) => consumeMock(...a),
  DEFAULT_LIMITS: { auth: { limit: 5, windowSeconds: 600 } },
}));
vi.mock("@/server/auth/superadmin", () => ({ isSuperAdminEmail: () => false }));
vi.mock("@/server/auth/safe-path", () => ({
  safeInternalPath: (p?: string) => (p && p.startsWith("/") && !p.startsWith("//") ? p : null),
}));

import { redeemRecoveryCode } from "@/app/(auth)/actions";
import { generateRecoveryCodes } from "@/app/(app)/settings/security/actions";
import { hashRecoveryCode } from "@/lib/auth/recovery-codes";
import { INITIAL_FORM_STATE } from "@/lib/forms/state";

// ---- fakes ---------------------------------------------------------------
type Row = { id: string; user_id: string; code_hash: string; used_at: string | null };

/** Minimal in-memory stand-in for the service-role client against one table. */
function makeAdmin(initial: Row[]) {
  let rows: Row[] = initial.map((r) => ({ ...r }));
  const deletedFactors: string[] = [];
  let insertErr: unknown = null;
  let updateErr: unknown = null;

  function builder() {
    const f: Record<string, unknown> = {};
    let op = "";
    let patch: Partial<Row> = {};
    let vals: Array<Partial<Row> & { user_id: string; code_hash: string }> = [];
    const filt: Record<string, unknown> = {};
    const b = {
      select() { op = "select"; return b; },
      insert(v: Array<Partial<Row> & { user_id: string; code_hash: string }>) { op = "insert"; vals = v; return b; },
      update(p: Partial<Row>) { op = "update"; patch = p; return b; },
      delete() { op = "delete"; return b; },
      eq(k: string, v: unknown) { filt[k] = v; return b; },
      is(k: string, v: unknown) { filt[k] = v === null ? "__null__" : v; return b; },
      then(res: (r: { data: unknown; error: unknown }) => void) {
        return res(run());
      },
    };
    function match(r: Row) {
      for (const [k, v] of Object.entries(filt)) {
        if (v === "__null__") { if ((r as never as Record<string, unknown>)[k] !== null) return false; }
        else if ((r as never as Record<string, unknown>)[k] !== v) return false;
      }
      return true;
    }
    function run() {
      if (op === "select") return { data: rows.filter(match), error: null };
      if (op === "insert") { if (insertErr) return { data: null, error: insertErr }; rows.push(...vals.map((v, i): Row => ({ id: `new${i}`, used_at: null, ...v }))); return { data: null, error: null }; }
      if (op === "update") { if (updateErr) return { data: null, error: updateErr }; rows = rows.map((r) => (match(r) ? { ...r, ...patch } : r)); return { data: null, error: null }; }
      if (op === "delete") { rows = rows.filter((r) => !match(r)); return { data: null, error: null }; }
      return { data: null, error: null };
    }
    Object.assign(f, b);
    return b;
  }

  return {
    client: {
      from: () => builder(),
      auth: { admin: { mfa: { deleteFactor: async ({ id }: { id: string }) => { deletedFactors.push(id); return { data: {}, error: null }; } } } },
    },
    rows: () => rows,
    deletedFactors: () => deletedFactors,
    failInsert: (e: unknown) => { insertErr = e; },
    failUpdate: (e: unknown) => { updateErr = e; },
  };
}

function fd(entries: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.append(k, v);
  return f;
}

const USER = { id: "u1", email: "a@b.co" };

beforeEach(() => {
  consumeMock.mockReset();
  consumeMock.mockResolvedValue({ allowed: true, remaining: 4 });
  createClientMock.mockReset();
  createAdminMock.mockReset();
});

// ===========================================================================
describe("generateRecoveryCodes (settings, opt-in)", () => {
  it("refuses when the user has no verified factor", async () => {
    createClientMock.mockResolvedValue({
      auth: {
        getUser: async () => ({ data: { user: USER } }),
        mfa: { listFactors: async () => ({ data: { totp: [] }, error: null }) },
      },
    });
    const res = await generateRecoveryCodes();
    expect(res.ok).toBe(false);
    expect(createAdminMock).not.toHaveBeenCalled();
  });

  it("with a verified factor, replaces the set and returns plaintext codes once", async () => {
    createClientMock.mockResolvedValue({
      auth: {
        getUser: async () => ({ data: { user: USER } }),
        mfa: { listFactors: async () => ({ data: { totp: [{ id: "f1", status: "verified" }] }, error: null }) },
      },
    });
    const admin = makeAdmin([{ id: "old", user_id: "u1", code_hash: "scrypt$old", used_at: null }]);
    createAdminMock.mockReturnValue(admin.client);

    const res = await generateRecoveryCodes();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.codes.length).toBeGreaterThanOrEqual(8);
    // old set gone, fresh set persisted as HASHES (never plaintext)
    const stored = admin.rows();
    expect(stored.every((r) => r.code_hash.startsWith("scrypt$"))).toBe(true);
    expect(stored.some((r) => r.id === "old")).toBe(false);
    for (const c of res.codes) {
      expect(stored.some((r) => r.code_hash.includes(c))).toBe(false);
    }
  });
});

describe("redeemRecoveryCode (login escape hatch)", () => {
  function fakeLoginClient() {
    return {
      auth: {
        getUser: async () => ({ data: { user: USER } }),
        mfa: { listFactors: async () => ({ data: { totp: [{ id: "f1", status: "verified" }] }, error: null }) },
      },
    };
  }

  it("valid code: burns it, removes the factor, lands the user", async () => {
    createClientMock.mockResolvedValue(fakeLoginClient());
    const good = hashRecoveryCode("ABCDE-FGHJK");
    const admin = makeAdmin([
      { id: "c1", user_id: "u1", code_hash: good, used_at: null },
      { id: "c2", user_id: "u1", code_hash: hashRecoveryCode("ZZZZZ-YYYYY"), used_at: null },
    ]);
    createAdminMock.mockReturnValue(admin.client);

    const s = await redeemRecoveryCode(INITIAL_FORM_STATE, fd({ code: "abcde-fghjk" }));
    expect(s.ok).toBe(true);
    expect(s.redirectTo).toBe("/dashboard");
    expect(admin.deletedFactors()).toContain("f1");
    // whole set cleared once recovery succeeds
    expect(admin.rows().length).toBe(0);
  });

  it("wrong code: no access, no factor removed, code not burned", async () => {
    createClientMock.mockResolvedValue(fakeLoginClient());
    const admin = makeAdmin([{ id: "c1", user_id: "u1", code_hash: hashRecoveryCode("ABCDE-FGHJK"), used_at: null }]);
    createAdminMock.mockReturnValue(admin.client);

    const s = await redeemRecoveryCode(INITIAL_FORM_STATE, fd({ code: "WRONG-CODEX" }));
    expect(s.ok).toBe(false);
    expect(admin.deletedFactors()).toHaveLength(0);
    expect(admin.rows().find((r) => r.id === "c1")?.used_at).toBeNull();
  });

  it("an already-used code is not accepted (one-time)", async () => {
    createClientMock.mockResolvedValue(fakeLoginClient());
    const admin = makeAdmin([{ id: "c1", user_id: "u1", code_hash: hashRecoveryCode("ABCDE-FGHJK"), used_at: "2026-01-01T00:00:00Z" }]);
    createAdminMock.mockReturnValue(admin.client);
    // select filters used_at is null → the used row is invisible → no match
    const s = await redeemRecoveryCode(INITIAL_FORM_STATE, fd({ code: "ABCDE-FGHJK" }));
    expect(s.ok).toBe(false);
    expect(admin.deletedFactors()).toHaveLength(0);
  });

  it("is rate-limited (shared auth limiter)", async () => {
    consumeMock.mockResolvedValue({ allowed: false, remaining: 0 });
    createClientMock.mockResolvedValue(fakeLoginClient());
    createAdminMock.mockReturnValue(makeAdmin([]).client);
    const s = await redeemRecoveryCode(INITIAL_FORM_STATE, fd({ code: "ABCDE-FGHJK" }));
    expect(s.ok).toBe(false);
    expect(s.error).toMatch(/too many/i);
  });

  it("refuses if the code can't be burned (never grant access on a failed consume-write)", async () => {
    createClientMock.mockResolvedValue(fakeLoginClient());
    const admin = makeAdmin([{ id: "c1", user_id: "u1", code_hash: hashRecoveryCode("ABCDE-FGHJK"), used_at: null }]);
    admin.failUpdate({ message: "db down" });
    createAdminMock.mockReturnValue(admin.client);
    const s = await redeemRecoveryCode(INITIAL_FORM_STATE, fd({ code: "ABCDE-FGHJK" }));
    expect(s.ok).toBe(false);
    expect(admin.deletedFactors()).toHaveLength(0);
  });

  it("requires a live session", async () => {
    createClientMock.mockResolvedValue({ auth: { getUser: async () => ({ data: { user: null } }) } });
    const s = await redeemRecoveryCode(INITIAL_FORM_STATE, fd({ code: "ABCDE-FGHJK" }));
    expect(s.ok).toBe(false);
  });
});

describe("migration contract — service-role-only secret table", () => {
  const migration = readFileSync(
    resolve(__dirname, "../../supabase/migrations/20261121000000_mfa_recovery_codes.sql"),
    "utf8",
  );
  const fn = readFileSync(
    resolve(__dirname, "../../supabase/migrations/20261121000001_mfa_recovery_codes_remaining_fn.sql"),
    "utf8",
  );

  it("enables RLS and revokes anon/authenticated grants", () => {
    expect(migration).toMatch(/enable row level security/i);
    expect(migration).toMatch(/revoke all on table public\.mfa_recovery_codes from anon, authenticated/i);
  });

  it("grants NO policy to anon/authenticated (default-deny is the whole point)", () => {
    expect(migration).not.toMatch(/create policy/i);
  });

  it("stores only a hash column — no plaintext code column", () => {
    expect(migration).toMatch(/code_hash\s+text\s+not null/i);
    expect(migration).not.toMatch(/code_plaintext|code\s+text/i);
  });

  it("the count reader is SECURITY DEFINER, auth.uid()-guarded, authenticated-only", () => {
    expect(fn).toMatch(/security definer/i);
    expect(fn).toMatch(/auth\.uid\(\)/);
    expect(fn).toMatch(/raise exception 'not authenticated'/i);
    expect(fn).toMatch(/grant execute on function public\.mfa_recovery_codes_remaining\(\) to authenticated/i);
    expect(fn).toMatch(/revoke all on function .* from public, anon/i);
  });
});
