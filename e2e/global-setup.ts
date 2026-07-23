/* eslint-disable @typescript-eslint/no-explicit-any -- seed script: the generated
   Database types don't cover every seeded table, so writes go through a loose cast. */
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Authenticated-E2E harness — CI-SAFE, zero production-reachable code.
 *
 * Runs in Node before the Playwright specs (after the webServer is up). It seeds
 * a deterministic org/user/membership/job into the LOCAL Supabase using the
 * SERVICE-ROLE key the e2e CI job exports into this shell (.github/workflows/ci.yml),
 * exactly as the integration tier already does (__tests__/integration/_harness.ts).
 * It then signs the user in and writes a Playwright `storageState` whose Supabase
 * auth cookie is minted by `@supabase/ssr`'s OWN encoder (correct name, base64url,
 * chunking) so the app middleware accepts it.
 *
 * No app/middleware/auth change, no gated login route, no production account, no
 * committed secret (the state file is gitignored). Seeded rows live only in the
 * ephemeral CI Postgres. NOTE: this is the same harness the blueprint stack (#409)
 * introduces; when that stack and this branch both land, e2e/global-setup.ts merges
 * to the superset (org/user/membership/job [+ blueprint seed]) — a trivial resolution.
 */

const JOB = "00000000-0000-0000-0000-000000000000"; // fixed sentinel id specs can hardcode
const EMAIL = "e2e-owner@crewflow.test";
const PASSWORD = "E2e-Harness-Pw-2f9c1a"; // local-only synthetic credential; never a production account
const STATE_PATH = join(process.cwd(), "e2e", ".auth", "owner.json");

function authCookiePrefix(url: string): string {
  return `sb-${new URL(url).hostname.split(".")[0]}-auth-token`;
}

export default async function globalSetup(): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const service = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !anon || !service) {
    throw new Error("[e2e harness] missing NEXT_PUBLIC_SUPABASE_URL / ANON_KEY / SUPABASE_SERVICE_ROLE_KEY");
  }
  const svc = createClient(url, service, { auth: { persistSession: false, autoRefreshToken: false } });

  // --- 1. user (idempotent) ---
  let userId: string;
  const created = await svc.auth.admin.createUser({ email: EMAIL, password: PASSWORD, email_confirm: true });
  if (created.data.user) {
    userId = created.data.user.id;
  } else {
    const list = await svc.auth.admin.listUsers();
    const found = list.data.users.find((u) => u.email === EMAIL);
    if (!found) throw new Error(`[e2e harness] could not create or find seed user: ${created.error?.message}`);
    userId = found.id;
    await svc.auth.admin.updateUserById(userId, { password: PASSWORD, email_confirm: true });
  }
  const db = svc as unknown as { from: (t: string) => any };
  await db.from("users").upsert({ id: userId, email: EMAIL, full_name: "E2E Owner" });

  // --- 2. org (status MUST be active or requireOrgContext bounces to /access-pending) ---
  const slug = "e2e-harness-org";
  let orgId = (await db.from("organizations").select("id").eq("slug", slug).maybeSingle()).data?.id as string | undefined;
  if (!orgId) {
    orgId = (await db.from("organizations").insert({ name: "E2E Co", slug, status: "active" }).select("id").single()).data?.id;
  } else {
    await db.from("organizations").update({ status: "active" }).eq("id", orgId);
  }
  if (!orgId) throw new Error("[e2e harness] failed to seed org");
  await db.from("memberships").upsert({ org_id: orgId, user_id: userId, role: "owner" }, { onConflict: "org_id,user_id" });

  // --- 3. job (fixed sentinel id) ---
  await db.from("jobs").upsert({ id: JOB, org_id: orgId, status: "in-progress" });

  // --- 4. sign in + write the storageState (cookies via @supabase/ssr's encoder) ---
  const prefix = authCookiePrefix(url);
  const anonClient = createClient(url, anon, { auth: { persistSession: false, autoRefreshToken: false } });
  const signIn = await anonClient.auth.signInWithPassword({ email: EMAIL, password: PASSWORD });
  if (signIn.error || !signIn.data.session) throw new Error(`[e2e harness] sign-in failed: ${signIn.error?.message}`);
  const { access_token, refresh_token } = signIn.data.session;
  const jar = new Map<string, { value: string; options?: Record<string, unknown> }>();
  const enc = createServerClient(url, anon, {
    cookies: {
      getAll: () => Array.from(jar.entries()).map(([name, c]) => ({ name, value: c.value })),
      setAll: (cs) => { for (const c of cs) jar.set(c.name, { value: c.value, options: c.options }); },
    },
  });
  await enc.auth.setSession({ access_token, refresh_token });
  for (let i = 0; i < 100 && !Array.from(jar.keys()).some((k) => k.startsWith(prefix)); i++) await new Promise((r) => setTimeout(r, 20));
  const cookies = Array.from(jar.entries()).filter(([name]) => name.startsWith(prefix)).map(([name, c]) => ({
    name, value: c.value, domain: "localhost", path: "/", httpOnly: false, secure: false, sameSite: "Lax" as const,
    expires: Math.floor(Date.now() / 1000) + 3600,
  }));
  if (cookies.length === 0) throw new Error("[e2e harness] auth cookie never minted");
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify({ cookies, origins: [] }, null, 2));

  console.log(`[e2e harness] seeded org ${orgId} + owner → ${dirname(STATE_PATH)}`);
}
