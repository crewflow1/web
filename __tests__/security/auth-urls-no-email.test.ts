import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * PRIVACY (finding G-10 / M-7) — an email address never appears in an auth URL
 * or in the sign-in success log.
 *
 * Before: every magic-link request redirected to `/check-email?email=<address>`,
 * a failed callback bootstrap to `/login?error=…&email=<address>`, provider error
 * messages quoting the address were put in `/login?error=…`, and every
 * successful callback logged `email` to the function logs. URLs reach hosting
 * request logs, browser history and (after analytics consent) analytics page
 * views; function logs are retained by the host.
 *
 * Pinned here by BEHAVIOUR (the real server action and route handler, with the
 * provider mocked) and by a SOURCE guard over the auth surface. The browser
 * half (the address shown on /check-email from sessionStorage, and no '@' in
 * any URL the browser requests) is proven in e2e/auth-recovery-and-signup.spec.ts.
 */

const ADDRESS = "pat.example@example.test";

const { redirectMock, consumeMock, ensureUserRowMock, createClientMock } = vi.hoisted(() => ({
  redirectMock: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
  consumeMock: vi.fn<(...a: unknown[]) => Promise<{ allowed: boolean; remaining: number }>>(
    async () => ({ allowed: true, remaining: 4 }),
  ),
  ensureUserRowMock: vi.fn<(i?: unknown) => Promise<void>>(async () => {}),
  createClientMock: vi.fn(),
}));

vi.mock("next/navigation", () => ({ redirect: (u: string) => redirectMock(u) }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ origin: "https://app.crewflow.uk" }),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: () => createClientMock() }));
vi.mock("@/lib/security/rate-limit", () => ({
  consume: (...a: unknown[]) => consumeMock(...a),
  DEFAULT_LIMITS: { auth: { limit: 5, windowSeconds: 600 } },
}));
vi.mock("@/server/services/bootstrap-account", () => ({
  ensureUserRow: (i: unknown) => ensureUserRowMock(i),
}));
vi.mock("@/server/auth/superadmin", () => ({ isSuperAdminEmail: () => false }));

import { signInWithMagicLink, signInWithGoogle } from "@/app/(auth)/actions";
import { GET as callback } from "@/app/auth/callback/route";

function fd(entries: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.append(k, v);
  return f;
}

/** The URL a server action redirected to (the redirect mock throws REDIRECT:<url>). */
async function redirectedTo(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (e) {
    const m = /^REDIRECT:(.*)$/s.exec((e as Error).message);
    if (m) return m[1]!;
    throw e;
  }
  throw new Error("expected a redirect");
}

function expectNoAddress(url: string) {
  expect(url).not.toContain("@");
  expect(url.toLowerCase()).not.toContain("%40");
  expect(url).not.toMatch(/[?&]email=/);
}

beforeEach(() => {
  redirectMock.mockClear();
  consumeMock.mockClear();
  ensureUserRowMock.mockReset();
  ensureUserRowMock.mockImplementation(async () => {});
  createClientMock.mockReset();
});

describe("magic-link request (server action)", () => {
  it("success redirects to a bare /check-email — the address is not in the URL", async () => {
    createClientMock.mockResolvedValue({ auth: { signInWithOtp: async () => ({ error: null }) } });
    const url = await redirectedTo(() => signInWithMagicLink(fd({ email: ADDRESS })));
    expect(url).toBe("/check-email");
    expectNoAddress(url);
  });

  it("a provider error that quotes the address is replaced before it reaches the URL", async () => {
    createClientMock.mockResolvedValue({
      auth: { signInWithOtp: async () => ({ error: { message: `Email address "${ADDRESS}" is invalid` } }) },
    });
    const url = await redirectedTo(() => signInWithMagicLink(fd({ email: ADDRESS })));
    expect(url.startsWith("/login?error=")).toBe(true);
    expectNoAddress(url);
  });

  it("a provider error becomes a CODE — provider text never travels in the URL", async () => {
    createClientMock.mockResolvedValue({
      auth: { signInWithOtp: async () => ({ error: { message: "Signups not allowed for otp" } }) },
    });
    const url = await redirectedTo(() => signInWithMagicLink(fd({ email: ADDRESS })));
    expect(url).toBe("/login?error=magic_link_send_failed");
  });

  it("an OAuth start error that quotes an address is replaced too", async () => {
    createClientMock.mockResolvedValue({
      auth: { signInWithOAuth: async () => ({ data: null, error: { message: `bad user ${ADDRESS}` } }) },
    });
    const url = await redirectedTo(() => signInWithGoogle());
    expectNoAddress(url);
  });
});

describe("/auth/callback", () => {
  const verifiedUser = {
    auth: {
      verifyOtp: async () => ({
        data: { user: { id: "00000000-0000-4000-8000-0000000000b1", email: ADDRESS, user_metadata: {} } },
        error: null,
      }),
    },
  };
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  const req = () =>
    new Request("https://app.crewflow.uk/auth/callback?token_hash=th_123&type=magiclink") as never;

  it("a failed bootstrap bounces to /login with the error code only", async () => {
    createClientMock.mockResolvedValue(verifiedUser);
    ensureUserRowMock.mockRejectedValue(new Error("db down"));
    const res = await callback(req());
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("/login?error=bootstrap_failed");
    expectNoAddress(location);
    // …and the failure log carries no address either.
    expect(JSON.stringify(errSpy.mock.calls)).not.toContain(ADDRESS);
  });

  it("a successful sign-in logs the user id, never the address", async () => {
    createClientMock.mockResolvedValue(verifiedUser);
    const res = await callback(req());
    expectNoAddress(res.headers.get("location") ?? "");
    const logged = JSON.stringify(logSpy.mock.calls);
    expect(logged).toContain("auth.callback.success");
    expect(logged).toContain("00000000-0000-4000-8000-0000000000b1");
    expect(logged).not.toContain(ADDRESS);
  });
});

describe("source guard — no auth surface builds a URL from an address", () => {
  const root = resolve(__dirname, "../..");
  const files = [
    "app/(auth)/actions.ts",
    "app/(auth)/login/page.tsx",
    "app/(auth)/check-email/page.tsx",
    "app/(auth)/_magic-link.client.tsx",
    "app/auth/callback/route.ts",
  ];
  const code = (rel: string) =>
    readFileSync(resolve(root, rel), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");

  it.each(files)("%s puts no email parameter in a URL", (rel) => {
    const src = code(rel);
    expect(src).not.toMatch(/[?&]email=/);
    expect(src).not.toMatch(/searchParams\.(set|append)\(\s*["']email["']/);
  });

  it("/check-email and /login read no email query parameter", () => {
    expect(code("app/(auth)/check-email/page.tsx")).not.toMatch(/searchParams/);
    expect(code("app/(auth)/login/page.tsx")).not.toMatch(/\bemail\?:/);
  });

  it("the callback success log has no email field", () => {
    const src = code("app/auth/callback/route.ts");
    const at = src.indexOf('"auth.callback.success"');
    expect(at).toBeGreaterThan(0);
    expect(src.slice(at, at + 300)).not.toMatch(/\bemail\s*:/);
  });
});
