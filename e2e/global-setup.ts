/* eslint-disable @typescript-eslint/no-explicit-any -- seed script: the generated
   Database types don't cover every seeded table, so writes go through a loose cast. */
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Authenticated-E2E harness (task #25) — CI-SAFE, zero production-reachable code.
 *
 * Runs in Node before the Playwright specs (after the webServer is up). It seeds
 * a deterministic org/user/membership/job/blueprint/version + a real 1-page PDF
 * into the LOCAL Supabase using the SERVICE-ROLE key that the e2e CI job already
 * exports into this same shell (.github/workflows/ci.yml) — exactly as the
 * integration tier already does (__tests__/integration/_harness.ts). It then
 * signs the user in and writes a Playwright `storageState` whose Supabase auth
 * cookie is minted by `@supabase/ssr`'s OWN encoder (correct name, base64url,
 * chunking) so the app middleware accepts it.
 *
 * No app/middleware/auth change, no gated login route, no production account,
 * no committed secret (the state file is gitignored). The seeded rows live only
 * in the ephemeral CI Postgres (fresh `supabase start` volume).
 */

const JOB = "00000000-0000-0000-0000-000000000000"; // the sentinel id the blueprint specs hardcode
const EMAIL = "e2e-owner@crewflow.test";
const PASSWORD = "E2e-Harness-Pw-2f9c1a"; // local-only synthetic credential; never a production account
const STATE_PATH = join(process.cwd(), "e2e", ".auth", "owner.json");

/** A minimal, valid, single-page PDF (so pdf.js actually paints). `text` lets two
 *  revisions carry visibly different content for the compare fixture. */
function minimalPdf(text = "CrewFlow E2E"): Buffer {
  const objs = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n",
  ];
  const stream = `BT /F1 24 Tf 40 200 Td (${text}) Tj ET`;
  objs.push(`4 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj\n`);
  objs.push("5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n");
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const o of objs) { offsets.push(pdf.length); pdf += o; }
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf, "latin1");
}

/** Cookie name @supabase/ssr uses: sb-<first hostname label>-auth-token. Computed, never hardcoded. */
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

  // --- 1. user (idempotent: reuse if already seeded on a persistent local DB) ---
  let userId: string;
  const created = await svc.auth.admin.createUser({ email: EMAIL, password: PASSWORD, email_confirm: true });
  if (created.data.user) {
    userId = created.data.user.id;
  } else {
    // already exists → find it
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

  // --- 3. job (fixed sentinel id the specs use) + blueprint + a rendered version ---
  await db.from("jobs").upsert({ id: JOB, org_id: orgId, status: "in-progress" });
  let bpId = (await db.from("blueprints").select("id").eq("job_id", JOB).eq("drawing_number", "A-201").maybeSingle()).data?.id as string | undefined;
  if (!bpId) {
    bpId = (await db.from("blueprints").insert({ org_id: orgId, job_id: JOB, drawing_number: "A-201", title: "GA Plan", discipline: "architectural" }).select("id").single()).data?.id;
  }
  if (!bpId) throw new Error("[e2e harness] failed to seed blueprint");

  // Seed TWO revisions (Rev A then Rev B) with visibly different content, so the
  // Revision Comparison journey has a real pair. version/current_version are
  // trigger-derived; inserting A then B yields version 1 then 2.
  const existing = (await db.from("blueprint_versions").select("id").eq("blueprint_id", bpId)).data as { id: string }[] | null;
  const have = existing?.length ?? 0;
  const revs: { rev: string; date: string; text: string }[] = [
    { rev: "Rev A", date: "2026-01-01", text: "REV A PLAN" },
    { rev: "Rev B", date: "2026-03-01", text: "REV B CHANGED" },
  ];
  for (let i = have; i < revs.length; i++) {
    const r = revs[i]!;
    const path = `${orgId}/${JOB}/${bpId}/v${i + 1}.pdf`;
    const bytes = minimalPdf(r.text);
    const up = await svc.storage.from("blueprints").upload(path, bytes, { contentType: "application/pdf", upsert: true });
    if (up.error) throw new Error(`[e2e harness] PDF upload failed: ${up.error.message}`);
    const ins = await db.from("blueprint_versions").insert({
      blueprint_id: bpId, org_id: orgId, revision: r.rev, revision_date: r.date,
      storage_bucket: "blueprints", storage_path: path, file_name: `A-201-${r.rev}.pdf`,
      mime_type: "application/pdf", size_bytes: bytes.length,
    }).select("id").single();
    if (ins.error) throw new Error(`[e2e harness] version insert failed: ${ins.error.message}`);
  }

  // --- 4. sign in (same primitive the integration tier runs in CI) ---
  const anonClient = createClient(url, anon, { auth: { persistSession: false, autoRefreshToken: false } });
  const signIn = await anonClient.auth.signInWithPassword({ email: EMAIL, password: PASSWORD });
  if (signIn.error || !signIn.data.session) throw new Error(`[e2e harness] sign-in failed: ${signIn.error?.message}`);
  const { access_token, refresh_token } = signIn.data.session;

  // --- 5. encode cookies via @supabase/ssr's OWN encoder (correct name/base64url/chunking) ---
  const jar = new Map<string, { value: string; options?: Record<string, unknown> }>();
  const enc = createServerClient(url, anon, {
    cookies: {
      getAll: () => Array.from(jar.entries()).map(([name, c]) => ({ name, value: c.value })),
      setAll: (cookies) => { for (const c of cookies) jar.set(c.name, { value: c.value, options: c.options }); },
    },
  });
  await enc.auth.setSession({ access_token, refresh_token });
  // the flush happens on the async SIGNED_IN event — bounded-poll until the auth cookie lands
  const prefix = authCookiePrefix(url);
  for (let i = 0; i < 100 && !Array.from(jar.keys()).some((k) => k.startsWith(prefix)); i++) {
    await new Promise((r) => setTimeout(r, 20));
  }
  const cookies = Array.from(jar.entries())
    .filter(([name]) => name.startsWith(prefix))
    .map(([name, c]) => ({
      name, value: c.value, domain: "localhost", path: "/",
      httpOnly: false, secure: false, sameSite: "Lax" as const,
      expires: Math.floor(Date.now() / 1000) + 3600,
    }));
  if (cookies.length === 0) throw new Error("[e2e harness] auth cookie was never minted — refusing to write an empty storageState");

  mkdirSync(dirname(STATE_PATH), { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify({ cookies, origins: [] }, null, 2));
  // eslint-disable-next-line no-console
  console.log(`[e2e harness] seeded org ${orgId} + wrote ${cookies.length} auth cookie(s) → ${STATE_PATH}`);
}
