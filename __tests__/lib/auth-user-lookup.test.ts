import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  findAuthUserByEmail,
  AUTH_USER_LOOKUP_MAX_PAGES,
  AUTH_USER_LOOKUP_PER_PAGE,
} from "@/lib/supabase/auth-user-lookup";

/**
 * Pagination proofs for the shared by-email auth lookup.
 *
 * The bug this helper replaces: auth.admin.listUsers() is paginated
 * (50/page by default), so a bare call — or a single perPage:1000 page —
 * only ever saw the first slice of the auth base. Recovery paths keyed on
 * "does this email already have an account?" then failed for real,
 * recoverable accounts (loud-read-failures audit; demo-lifecycle invite
 * recovery reported auth_create_user instead of recovering).
 */

const listUsersMock = vi.fn();
const admin = {
  auth: { admin: { listUsers: listUsersMock } },
} as unknown as Parameters<typeof findAuthUserByEmail>[0];

/** Build one listUsers page result the way auth-js shapes it. */
const page = (users: Array<{ id: string; email?: string }>, nextPage: number | null) => ({
  data: { users, aud: "authenticated", nextPage, lastPage: 0, total: 0 },
  error: null,
});

beforeEach(() => {
  listUsersMock.mockReset();
});

describe("findAuthUserByEmail — pagination", () => {
  it("finds a user on the first page without fetching more", async () => {
    listUsersMock.mockResolvedValueOnce(
      page([{ id: "u-1", email: "someone@x.test" }, { id: "u-2", email: "jane@x.test" }], 2),
    );

    const res = await findAuthUserByEmail(admin, "jane@x.test");

    expect(res).toEqual({ ok: true, user: { id: "u-2", email: "jane@x.test" } });
    expect(listUsersMock).toHaveBeenCalledTimes(1);
    expect(listUsersMock).toHaveBeenCalledWith({
      page: 1,
      perPage: AUTH_USER_LOOKUP_PER_PAGE,
    });
  });

  it("follows the nextPage cursor and finds a user beyond page 1 (the regression)", async () => {
    listUsersMock.mockImplementation(async ({ page: p }: { page: number }) => {
      if (p === 1) return page([{ id: "u-1", email: "a@x.test" }], 2);
      if (p === 2) return page([{ id: "u-2", email: "b@x.test" }], 3);
      return page([{ id: "u-3", email: "JANE@x.test" }], null);
    });

    // Case-insensitive + trimmed on both sides.
    const res = await findAuthUserByEmail(admin, "  Jane@X.Test ");

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.user?.id).toBe("u-3");
    expect(listUsersMock).toHaveBeenCalledTimes(3);
    expect(listUsersMock).toHaveBeenNthCalledWith(2, {
      page: 2,
      perPage: AUTH_USER_LOOKUP_PER_PAGE,
    });
    expect(listUsersMock).toHaveBeenNthCalledWith(3, {
      page: 3,
      perPage: AUTH_USER_LOOKUP_PER_PAGE,
    });
  });

  it("returns ok:true user:null only after exhausting every page", async () => {
    listUsersMock
      .mockResolvedValueOnce(page([{ id: "u-1", email: "a@x.test" }], 2))
      .mockResolvedValueOnce(page([{ id: "u-2", email: "b@x.test" }], null));

    const res = await findAuthUserByEmail(admin, "missing@x.test");

    expect(res).toEqual({ ok: true, user: null });
    expect(listUsersMock).toHaveBeenCalledTimes(2);
  });

  it("treats a page WITHOUT a nextPage field as the last page (mock/legacy shape)", async () => {
    listUsersMock.mockResolvedValueOnce({ data: { users: [] }, error: null });

    const res = await findAuthUserByEmail(admin, "missing@x.test");

    expect(res).toEqual({ ok: true, user: null });
    expect(listUsersMock).toHaveBeenCalledTimes(1);
  });
});

describe("findAuthUserByEmail — loud failure, never a false 'not found'", () => {
  it("surfaces a listUsers error as ok:false with the reason", async () => {
    listUsersMock
      .mockResolvedValueOnce(page([{ id: "u-1", email: "a@x.test" }], 2))
      .mockResolvedValueOnce({ data: { users: [] }, error: { message: "auth API 500" } });

    const res = await findAuthUserByEmail(admin, "jane@x.test");

    expect(res).toEqual({ ok: false, reason: "auth API 500" });
  });

  it("catches a thrown/rejected listUsers call instead of throwing", async () => {
    listUsersMock.mockRejectedValueOnce(new Error("network down"));

    const res = await findAuthUserByEmail(admin, "jane@x.test");

    expect(res).toEqual({ ok: false, reason: "network down" });
  });

  it("aborts a runaway cursor at the page cap with ok:false", async () => {
    listUsersMock.mockImplementation(async ({ page: p }: { page: number }) =>
      page([{ id: `u-${p}`, email: `user${p}@x.test` }], p + 1),
    );

    const res = await findAuthUserByEmail(admin, "missing@x.test");

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/aborted after/);
    expect(listUsersMock).toHaveBeenCalledTimes(AUTH_USER_LOOKUP_MAX_PAGES);
  });
});
