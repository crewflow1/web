/* eslint-disable @typescript-eslint/no-explicit-any -- seed script: the generated
   Database types don't cover every seeded table, so writes go through a loose cast. */
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { assertLocalE2eTarget } from "./_guard";

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
  /**
   * FIRST statement of the E2E tier. Playwright runs globalSetup before it
   * loads a single spec and aborts the whole run if it throws, so refusing here
   * stops every destructive spec in the process — and it happens before this
   * file's own service-role createClient below, not after the first upsert.
   */
  assertLocalE2eTarget("global setup (e2e/global-setup.ts)");

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
    // already exists → find it. perPage must beat the default 50: a local
    // stack accumulates integration-tier auth users across runs, and the seed
    // user silently fell past the first page (fixture-only fix).
    const list = await svc.auth.admin.listUsers({ page: 1, perPage: 1000 });
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

  const prefix = authCookiePrefix(url);

  // Sign a user in and write a Playwright storageState, cookies encoded by
  // @supabase/ssr's own encoder (correct name/base64url/chunking).
  async function mintState(email: string, password: string, statePath: string): Promise<void> {
    const anonClient = createClient(url!, anon!, { auth: { persistSession: false, autoRefreshToken: false } });
    const signIn = await anonClient.auth.signInWithPassword({ email, password });
    if (signIn.error || !signIn.data.session) throw new Error(`[e2e harness] sign-in failed for ${email}: ${signIn.error?.message}`);
    const { access_token, refresh_token } = signIn.data.session;
    const jar = new Map<string, { value: string; options?: Record<string, unknown> }>();
    const enc = createServerClient(url!, anon!, {
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
    if (cookies.length === 0) throw new Error(`[e2e harness] auth cookie never minted for ${email}`);
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(statePath, JSON.stringify({ cookies, origins: [] }, null, 2));
  }

  // --- 4. owner session (used by all authenticated journeys) ---
  await mintState(EMAIL, PASSWORD, STATE_PATH);

  // --- 5. the SIGN-OUT sessions. ONE PER SIGN-OUT SPEC — never shared. ---------
  //
  // A spec that clicks "Sign out" REVOKES the session it is holding. Every state
  // file is minted once here and then loaded fresh from disk by each spec, so the
  // cookie a later spec presents is the SAME token an earlier spec already
  // revoked: it authenticates as nobody, the route redirects to /login, and the
  // spec fails somewhere far from the real cause (a page-not-found assertion
  // rather than "your session was destroyed by an unrelated file").
  //
  // That is not hypothetical — `second.json` was shared by the blueprint
  // logout-purge spec and the offline-diary logout spec, and because Playwright
  // runs the tier with `workers: 1` in file order, blueprint-offline signed the
  // session out ~90s before offline-diary-queue tried to use it.
  //
  // So each sign-out spec gets its OWN member, isolated from the owner (whose
  // session every other authenticated journey shares and which must never be
  // signed out) and from each other. Adding a new sign-out spec means adding a
  // row here, NOT reusing one of these.
  //
  //   second.json → e2e/blueprint-offline.spec.ts   (offline drawing-cache purge)
  //   third.json  → e2e/offline-diary-queue.spec.ts (offline write-queue purge)
  //
  // Both are `staff` in the seeded org, so they can download the drawing and
  // author a diary entry.
  async function seedMember(email: string, fullName: string, stateFile: string): Promise<void> {
    const created = await svc.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
    let id = created.data.user?.id;
    if (!id) { const list = await svc.auth.admin.listUsers({ page: 1, perPage: 1000 }); id = list.data.users.find((u) => u.email === email)?.id; if (id) await svc.auth.admin.updateUserById(id, { password: PASSWORD, email_confirm: true }); }
    if (!id) throw new Error(`[e2e harness] could not seed member ${email}: ${created.error?.message}`);
    await db.from("users").upsert({ id, email, full_name: fullName });
    await db.from("memberships").upsert({ org_id: orgId, user_id: id, role: "staff" }, { onConflict: "org_id,user_id" });
    await mintState(email, PASSWORD, STATE_PATH.replace("owner.json", stateFile));
  }
  await seedMember("e2e-second@crewflow.test", "E2E Second", "second.json");
  await seedMember("e2e-third@crewflow.test", "E2E Third", "third.json");

  // --- 6. an HQ (superadmin) session for the /admin a11y specs. Deliberately NO
  // membership row: requireOrgContext (server/auth/session.ts) redirects any
  // superadmin email off every (app) route, so this account must stay out of
  // app-tier journeys — and conversely the OWNER must never be allowlisted.
  // The address only gains superadmin power when the e2e shell exports
  // CREWFLOW_SUPERADMIN_EMAILS=e2e-hq@crewflow.test (ci.yml does; the admin
  // spec skips itself when the export is absent).
  const hqEmail = "e2e-hq@crewflow.test";
  const hqCreated = await svc.auth.admin.createUser({ email: hqEmail, password: PASSWORD, email_confirm: true });
  let hqId = hqCreated.data.user?.id;
  if (!hqId) { const list = await svc.auth.admin.listUsers({ page: 1, perPage: 1000 }); hqId = list.data.users.find((u) => u.email === hqEmail)?.id; if (hqId) await svc.auth.admin.updateUserById(hqId, { password: PASSWORD, email_confirm: true }); }
  if (!hqId) throw new Error(`[e2e harness] could not seed hq user: ${hqCreated.error?.message}`);
  await db.from("users").upsert({ id: hqId, email: hqEmail, full_name: "E2E HQ" });
  await mintState(hqEmail, PASSWORD, STATE_PATH.replace("owner.json", "hq.json"));

  // eslint-disable-next-line no-console
  console.log(`[e2e harness] seeded org ${orgId} + owner + second + third member + hq → ${dirname(STATE_PATH)}`);
}
