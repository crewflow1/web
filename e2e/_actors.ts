import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Browser, Page } from "@playwright/test";

/**
 * Multi-actor E2E helpers (shared). Mint a Playwright storageState using
 * @supabase/ssr's OWN cookie encoder (same approach as global-setup.ts: correct
 * cookie name / base64url / chunking) and run a block as that actor in its own
 * browser context. Extracted so specs that exercise separation-of-duties flows
 * (e.g. a DISTINCT quote approver) don't each re-implement the cookie encoding.
 * LOCAL-only by construction — it signs in against the configured Supabase URL.
 */
export async function mintState(email: string, password: string, statePath: string): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  const prefix = `sb-${new URL(url).hostname.split(".")[0]}-auth-token`;
  const anonClient = createClient(url, anon, { auth: { persistSession: false, autoRefreshToken: false } });
  const signIn = await anonClient.auth.signInWithPassword({ email, password });
  if (signIn.error || !signIn.data.session) {
    throw new Error(`[e2e _actors] sign-in failed for ${email}: ${signIn.error?.message}`);
  }
  const { access_token, refresh_token } = signIn.data.session;
  const jar = new Map<string, { value: string; options?: Record<string, unknown> }>();
  const enc = createServerClient(url, anon, {
    cookies: {
      getAll: () => Array.from(jar.entries()).map(([name, c]) => ({ name, value: c.value })),
      setAll: (cs) => {
        for (const c of cs) jar.set(c.name, { value: c.value, options: c.options });
      },
    },
  });
  await enc.auth.setSession({ access_token, refresh_token });
  for (let i = 0; i < 100 && !Array.from(jar.keys()).some((k) => k.startsWith(prefix)); i++) {
    await new Promise((r) => setTimeout(r, 20));
  }
  const cookies = Array.from(jar.entries())
    .filter(([name]) => name.startsWith(prefix))
    .map(([name, c]) => ({
      name,
      value: c.value,
      domain: "localhost",
      path: "/",
      httpOnly: false,
      secure: false,
      sameSite: "Lax" as const,
      expires: Math.floor(Date.now() / 1000) + 3600,
    }));
  if (cookies.length === 0) throw new Error(`[e2e _actors] auth cookie never minted for ${email}`);
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify({ cookies, origins: [] }, null, 2));
}

/** Run a block as a given actor in its own browser context (multi-actor pattern). */
export async function asActor<T>(
  browser: Browser,
  storageState: string,
  fn: (page: Page) => Promise<T>,
): Promise<T> {
  const ctx = await browser.newContext({ storageState });
  try {
    return await fn(await ctx.newPage());
  } finally {
    await ctx.close();
  }
}
