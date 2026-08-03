import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
  resolveAccountHandle,
  refreshAccessToken,
  exchangeCodeForTokens,
} from "@/lib/integrations/calendar/oauth";

/**
 * Calendar OAuth — LIVE-path unit tests (hermetic; Google/Microsoft HTTP mocked).
 *
 * Proves the activation-critical pieces that make connect COMPLETE and tokens
 * RENEW: account-handle resolution (userinfo / /me), token refresh
 * (grant_type=refresh_token), and that the code exchange folds the handle in so a
 * connected row can persist (no `no_account` dead-end). Every function REFUSES
 * before any network call while the provider is dark.
 */

const CREDS = {
  FEATURE_CALENDAR_CONNECT: "1",
  GOOGLE_CALENDAR_CLIENT_ID: "gid",
  GOOGLE_CALENDAR_CLIENT_SECRET: "gsecret",
  MS_GRAPH_CLIENT_ID: "mid",
  MS_GRAPH_CLIENT_SECRET: "msecret",
} as const;

function enableProviders() {
  for (const [k, v] of Object.entries(CREDS)) process.env[k] = v;
}
function disableProviders() {
  for (const k of Object.keys(CREDS)) delete process.env[k];
}

function jsonRes(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

const original = { ...process.env };
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  process.env = { ...original };
});

describe("resolveAccountHandle", () => {
  beforeEach(enableProviders);

  it("resolves the Google account email from userinfo", async () => {
    fetchMock.mockResolvedValueOnce(jsonRes(200, { email: "boss@acme.co", sub: "123" }));
    const res = await resolveAccountHandle({ provider: "google", accessToken: "AT" });
    expect(res).toEqual({ ok: true, handle: "boss@acme.co" });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://www.googleapis.com/oauth2/v3/userinfo");
    expect((init as RequestInit).headers).toMatchObject({ authorization: "Bearer AT" });
  });

  it("resolves the Microsoft account from Graph /me (userPrincipalName)", async () => {
    fetchMock.mockResolvedValueOnce(jsonRes(200, { userPrincipalName: "boss@acme.onmicrosoft.com" }));
    const res = await resolveAccountHandle({ provider: "microsoft", accessToken: "AT" });
    expect(res).toEqual({ ok: true, handle: "boss@acme.onmicrosoft.com" });
    expect(fetchMock.mock.calls[0]![0]).toBe("https://graph.microsoft.com/v1.0/me");
  });

  it("REFUSES with NO network call while dark", async () => {
    disableProviders();
    const res = await resolveAccountHandle({ provider: "google", accessToken: "AT" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("not_configured");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("refreshAccessToken", () => {
  beforeEach(enableProviders);

  it("posts grant_type=refresh_token and returns the renewed access token", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonRes(200, { access_token: "new-AT", refresh_token: "new-RT", expires_in: 3600 }),
    );
    const res = await refreshAccessToken({ provider: "google", refreshToken: "old-RT" });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.tokens.accessToken).toBe("new-AT");
      expect(res.tokens.refreshToken).toBe("new-RT");
      expect(res.tokens.expiresAt).not.toBeNull();
    }
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://oauth2.googleapis.com/token");
    const body = String((init as RequestInit).body);
    expect(body).toContain("grant_type=refresh_token");
    expect(body).toContain("refresh_token=old-RT");
    expect(body).toContain("client_id=gid");
  });

  it("keeps the old refresh token (null) when the provider omits a rotated one", async () => {
    fetchMock.mockResolvedValueOnce(jsonRes(200, { access_token: "new-AT", expires_in: 3600 }));
    const res = await refreshAccessToken({ provider: "microsoft", refreshToken: "old-RT" });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.tokens.refreshToken).toBeNull();
  });

  it("REFUSES with NO network call while dark", async () => {
    disableProviders();
    const res = await refreshAccessToken({ provider: "google", refreshToken: "old-RT" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("not_configured");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("exchangeCodeForTokens folds in the account handle", () => {
  beforeEach(enableProviders);

  it("resolves and stores externalAccountId after the token exchange", async () => {
    // 1) token endpoint, 2) userinfo follow-up.
    fetchMock
      .mockResolvedValueOnce(
        jsonRes(200, { access_token: "AT", refresh_token: "RT", expires_in: 3600 }),
      )
      .mockResolvedValueOnce(jsonRes(200, { email: "boss@acme.co" }));

    const res = await exchangeCodeForTokens({
      provider: "google",
      code: "code",
      codeVerifier: "verifier",
      redirectUri: "https://app.example/cb",
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.tokens.accessToken).toBe("AT");
      expect(res.tokens.externalAccountId).toBe("boss@acme.co");
    }
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("REFUSES with NO network call while dark", async () => {
    disableProviders();
    const res = await exchangeCodeForTokens({
      provider: "google",
      code: "code",
      codeVerifier: "verifier",
      redirectUri: "https://app.example/cb",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("not_configured");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
