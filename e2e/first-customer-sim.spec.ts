/* eslint-disable @typescript-eslint/no-explicit-any -- service-role seed/verify
   cast: the generated Database types don't cover every seeded table, so the
   service-role reads/writes in this spec go through a loose cast, exactly as
   e2e/global-setup.ts and e2e/portal-customer.spec.ts already do. */
import { test, expect, type Page, type Browser } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { assertLocalE2eTarget } from "./_guard";

/**
 * FIRST-CUSTOMER SIMULATION (multi-actor, real browser) — a realistic rehearsal
 * of a construction firm's first weeks on CrewFlow, end to end, proving PERSISTED
 * state (not transient banners) at every step. It extends e2e/core-journey.spec.ts
 * (owner-only lead→payment) into the full multi-ACTOR journey a real crew runs:
 * an owner, a restricted admin, two field staff (a primary and a crew member), a
 * token-only customer on the portal, and an HQ (super-admin) onboarding touchpoint.
 *
 * It reuses the harness exactly:
 *   - the seeded "E2E Co" org + owner/staff/hq storageStates from global-setup;
 *   - the SAME helpers — gotoReady / submitAndLand / settle, and the guarded
 *     service-role client (assertLocalE2eTarget → LOCAL-only);
 *   - event-based waits (waitForURL + expect.poll against the DB) and deterministic,
 *     TAG-namespaced fixtures. The ONLY time-based wait is the post-navigation
 *     React-hydration settle inherited from core-journey (controlled inputs /
 *     client router navigation are silently lost before hydration).
 *
 * It seeds its OWN extra members in beforeAll via the service-role client (as
 * portal-customer.spec.ts does) and mints a storageState for the admin with the
 * SAME @supabase/ssr cookie encoder global-setup uses — so NOTHING in
 * global-setup.ts has to change. The primary-staff actor reuses the existing
 * dedicated staff.json session (never signed out).
 *
 * COVERAGE (each a serial test, state threaded through `S`):
 *   1.  owner creates TWO customers (/customers/new) — DB-verified rows + portal tokens
 *   2.  owner creates TWO jobs (/jobs/new): Job A → primary staff, Job B → crew staff
 *       — DB-verified jobs.assigned_to (the single first-class assignee per job)
 *   3.  owner assigns the CREW member to Job A via the checklist run-list
 *       (job_checklists.assigned_to) — primary + crew both working one job
 *   4.  the PRIMARY STAFF records progress on their ASSIGNED Job A (staff.json)
 *       — DB-verified job_progress_observations.recorded_by = the staff user
 *   5.  [R5 — GATED] the primary staff is DENIED recording progress on the
 *       NON-ASSIGNED Job B. R5 (assigned-only write on job_progress_observations)
 *       is apply-HELD and may not be live in the test DB, so this test SKIPS unless
 *       E2E_R5_APPLIED=1. Until R5 is applied, a staff member can record progress
 *       on ANY org job they can open (requireOrgContext only; see progress-actions.ts)
 *       — a documented product gap, asserted here only once the guard is live.
 *   6.  owner builds a quote for customer A with correct VAT math — DB draft total
 *   7.  request approval → self-approve → accept ⇒ auto Job + draft Invoice (DB)
 *   8.  owner records a payment ⇒ invoice derives paid + payment row (DB)
 *   9.  the customer views their own PORTAL by token (no login) — valid, not expired
 *   10. a RESTRICTED ADMIN reaches a management surface (/quotes, which staff is
 *       bounced from) yet is DENIED CrewFlow HQ (/admin → 404) — admin ≠ owner ≠ HQ
 *   11. [HQ — GATED] an HQ super-admin sees the onboarded "E2E Co" org at
 *       /admin/organizations. SKIPS unless CREWFLOW_SUPERADMIN_EMAILS includes the
 *       HQ email in the shell that runs Playwright (same gate the admin a11y specs use).
 *
 * MUST run against a PRODUCTION build (`npm run start`) like the rest of the tier:
 * under `next dev`, Pattern-A post-action router navigation is dropped.
 */

const svc = createClient(
  assertLocalE2eTarget("first-customer-sim.spec.ts"),
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);
const db = svc as unknown as { from: (t: string) => any };

type Row = Record<string, unknown>;
async function one(table: string, col: string, val: string): Promise<Row | null> {
  const { data } = await svc.from(table).select("*").eq(col, val).maybeSingle();
  return (data as Row | null) ?? null;
}
async function many(table: string, col: string, val: string): Promise<Row[]> {
  const { data } = await svc.from(table).select("*").eq(col, val);
  return (data as Row[] | null) ?? [];
}

const SLUG = "e2e-harness-org";
const PASSWORD = "E2e-Harness-Pw-2f9c1a"; // local-only synthetic credential; never a production account
const PRIMARY_EMAIL = "e2e-staff@crewflow.test"; // the existing dedicated staff (staff.json)
const CREW_EMAIL = "e2e-sim-crew@crewflow.test"; // seeded here; crew member, no browser session needed
const ADMIN_EMAIL = "e2e-sim-admin@crewflow.test"; // seeded here; restricted (non-owner) admin
const HQ_EMAIL = "e2e-hq@crewflow.test";

const STAFF_STATE = "e2e/.auth/staff.json";
const HQ_STATE = "e2e/.auth/hq.json";
const ADMIN_STATE = "e2e/.auth/sim-admin.json"; // minted in beforeAll

/** R5 — assigned-only write guard on job_progress_observations — is apply-held. */
const R5_APPLIED = process.env.E2E_R5_APPLIED === "1";
/** HQ (super-admin) surfaces only resolve when the shell allowlists the HQ email. */
const HQ_ALLOWLISTED = (process.env.CREWFLOW_SUPERADMIN_EMAILS ?? "")
  .toLowerCase()
  .includes(HQ_EMAIL);

const TAG = `FCS${Date.now().toString(36)}`;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;
const idOf = (url: string) => url.match(UUID)?.[0] ?? "";

// Shared across the serial chain.
const S = {
  orgId: "",
  primaryStaffId: "",
  crewStaffId: "",
  adminId: "",
  customerAId: "",
  customerBId: "",
  portalTokenA: "",
  jobAId: "",
  jobBId: "",
  quoteId: "",
  acceptedJobId: "",
  invoiceId: "",
};

async function settle(page: Page) {
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(800); // post-navigation React hydration (see core-journey)
}
async function gotoReady(page: Page, url: string) {
  await page.goto(url);
  await settle(page);
}
async function submitAndLand(page: Page, label: string, urlRe: RegExp) {
  await page.getByRole("button", { name: label }).click();
  try {
    await page.waitForURL(urlRe, { timeout: 30_000 });
  } catch {
    const alerts = (await page.locator('[role="alert"]').allTextContents())
      .map((s) => s.trim())
      .filter(Boolean)
      .join(" | ");
    throw new Error(`"${label}" did not navigate to ${urlRe} (alerts: ${alerts || "none"})`);
  }
}

/** Resolve a seeded user's id from the users table (populated by global-setup/seedMember). */
async function userIdByEmail(email: string): Promise<string> {
  const row = (await db.from("users").select("id").eq("email", email).maybeSingle()).data as
    | { id: string }
    | null;
  if (!row?.id) throw new Error(`[first-customer-sim] seeded user not found: ${email}`);
  return row.id;
}

/** Create (idempotently) an auth user + membership in the harness org. Returns the user id. */
async function seedMember(email: string, fullName: string, role: string): Promise<string> {
  const created = await svc.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  let id = created.data.user?.id;
  if (!id) {
    const list = await svc.auth.admin.listUsers({ page: 1, perPage: 1000 });
    id = list.data.users.find((u) => u.email === email)?.id;
    if (id) await svc.auth.admin.updateUserById(id, { password: PASSWORD, email_confirm: true });
  }
  if (!id) throw new Error(`[first-customer-sim] could not seed member ${email}: ${created.error?.message}`);
  await db.from("users").upsert({ id, email, full_name: fullName });
  await db
    .from("memberships")
    .upsert({ org_id: S.orgId, user_id: id, role }, { onConflict: "org_id,user_id" });
  return id;
}

/** Mint a Playwright storageState using @supabase/ssr's OWN cookie encoder (same
 *  approach as global-setup.ts: correct cookie name/base64url/chunking). */
async function mintState(email: string, password: string, statePath: string): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  const prefix = `sb-${new URL(url).hostname.split(".")[0]}-auth-token`;
  const anonClient = createClient(url, anon, { auth: { persistSession: false, autoRefreshToken: false } });
  const signIn = await anonClient.auth.signInWithPassword({ email, password });
  if (signIn.error || !signIn.data.session) {
    throw new Error(`[first-customer-sim] sign-in failed for ${email}: ${signIn.error?.message}`);
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
  if (cookies.length === 0) throw new Error(`[first-customer-sim] auth cookie never minted for ${email}`);
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify({ cookies, origins: [] }, null, 2));
}

/** Run a block as a given actor in its own browser context (multi-actor pattern). */
async function asActor<T>(browser: Browser, storageState: string, fn: (page: Page) => Promise<T>): Promise<T> {
  const ctx = await browser.newContext({ storageState });
  try {
    return await fn(await ctx.newPage());
  } finally {
    await ctx.close();
  }
}

test.describe.configure({ mode: "serial" });

test.describe("first-customer simulation — owner, admin, staff, customer, HQ", () => {
  test.use({ storageState: "e2e/.auth/owner.json" });

  test.beforeAll(async () => {
    const org = (await db.from("organizations").select("id").eq("slug", SLUG).maybeSingle()).data as
      | { id: string }
      | null;
    if (!org?.id) throw new Error("seeded org not found — did globalSetup run?");
    S.orgId = org.id;

    S.primaryStaffId = await userIdByEmail(PRIMARY_EMAIL); // the staff.json session's user
    S.crewStaffId = await seedMember(CREW_EMAIL, "E2E Sim Crew", "staff");
    S.adminId = await seedMember(ADMIN_EMAIL, "E2E Sim Admin", "admin");
    await mintState(ADMIN_EMAIL, PASSWORD, ADMIN_STATE);
  });

  // 1 ──────────────────────────────────────────────────────────────────────────
  test("1. owner creates two customers", async ({ page }) => {
    test.setTimeout(90_000);
    for (const key of ["A", "B"] as const) {
      await gotoReady(page, "/customers/new");
      await page.locator('input[name="name"]').fill(`${TAG} Customer ${key}`);
      await page.locator('input[name="email"]').fill(`${TAG.toLowerCase()}-${key.toLowerCase()}@cust.test`);
      await submitAndLand(page, "Save customer", new RegExp(`/customers/${UUID.source}`));
      const id = idOf(page.url());
      expect(id, `customer ${key} must land on its detail page`).not.toBe("");
      if (key === "A") S.customerAId = id;
      else S.customerBId = id;
    }
    // Persisted: both customer rows exist for this org, each with a portal token.
    await expect.poll(() => one("customers", "id", S.customerAId)).not.toBeNull();
    await expect.poll(() => one("customers", "id", S.customerBId)).not.toBeNull();
    const cA = await one("customers", "id", S.customerAId);
    S.portalTokenA = String(cA?.portal_token ?? "");
    expect(S.portalTokenA, "a new customer must get a portal token").not.toBe("");
  });

  // 2 ──────────────────────────────────────────────────────────────────────────
  test("2. owner creates two jobs, each assigned to a different staff member", async ({ page }) => {
    test.setTimeout(90_000);
    const specs = [
      { customerId: () => S.customerAId, assignee: () => S.primaryStaffId, set: (id: string) => (S.jobAId = id) },
      { customerId: () => S.customerBId, assignee: () => S.crewStaffId, set: (id: string) => (S.jobBId = id) },
    ];
    for (const spec of specs) {
      await gotoReady(page, "/jobs/new");
      await page.locator('select[name="customer_id"]').selectOption(spec.customerId());
      await page.locator('select[name="assigned_to"]').selectOption(spec.assignee());
      await submitAndLand(page, "Create job", new RegExp(`/jobs/${UUID.source}`));
      const id = idOf(page.url());
      expect(id).not.toBe("");
      spec.set(id);
    }
    expect(S.jobAId).not.toBe(S.jobBId);
    // Persisted: each job carries the intended first-class assignee.
    await expect.poll(async () => (await one("jobs", "id", S.jobAId))?.assigned_to).toBe(S.primaryStaffId);
    await expect.poll(async () => (await one("jobs", "id", S.jobBId))?.assigned_to).toBe(S.crewStaffId);
  });

  // 3 ──────────────────────────────────────────────────────────────────────────
  test("3. owner assigns the crew member to Job A via the checklist run-list", async ({ page }) => {
    test.setTimeout(90_000);
    await gotoReady(page, `/jobs/${S.jobAId}`);
    // Add a run-list step, then wait for the row to PERSIST before expecting its UI.
    await page.getByPlaceholder(/add a checklist step/i).fill(`${TAG} fit kitchen`);
    await page.getByRole("button", { name: /^Add$/ }).click();
    await expect
      .poll(async () => (await many("job_checklists", "job_id", S.jobAId)).length)
      .toBeGreaterThan(0);

    // Reload so the new item's assignee <select> is present, then assign the crew member.
    await gotoReady(page, `/jobs/${S.jobAId}`);
    const assignee = page.locator('select[id^="assignee-"]').first();
    await expect(assignee).toBeVisible();
    await assignee.selectOption(S.crewStaffId);

    // Persisted: the crew member now owns a checklist line on Job A (primary + crew on one job).
    await expect
      .poll(async () =>
        (await many("job_checklists", "job_id", S.jobAId)).some((r) => r.assigned_to === S.crewStaffId),
      )
      .toBe(true);
  });

  // 4 ──────────────────────────────────────────────────────────────────────────
  test("4. the primary staff records progress on their ASSIGNED job", async ({ browser }) => {
    test.setTimeout(90_000);
    await asActor(browser, STAFF_STATE, async (page) => {
      await gotoReady(page, `/jobs/${S.jobAId}`);
      await page.locator('input[name="percent"]').fill("40");
      await page.getByRole("button", { name: /^Record$/ }).click();
      // Persisted: an observation authored by the staff user, on their own job.
      await expect
        .poll(async () => {
          const obs = await many("job_progress_observations", "job_id", S.jobAId);
          const mine = obs.find((o) => o.recorded_by === S.primaryStaffId);
          return mine ? Number(mine.percent) : -1;
        })
        .toBe(40);
    });
  });

  // 5 ── R5 (GATED) ─────────────────────────────────────────────────────────────
  test("5. [R5] the primary staff is DENIED progress on a NON-assigned job", async ({ browser }) => {
    test.skip(
      !R5_APPLIED,
      "R5 (assigned-only write on job_progress_observations) is apply-held; set E2E_R5_APPLIED=1 once the migration is live in the test DB. Without it, staff can currently record progress on any org job (documented gap).",
    );
    test.setTimeout(90_000);
    await asActor(browser, STAFF_STATE, async (page) => {
      await gotoReady(page, `/jobs/${S.jobBId}`); // assigned to CREW, not to this staff user
      // Attempt a reading. Under R5 the action must refuse (no row authored by this
      // staff user on a job they are not assigned to).
      const percent = page.locator('input[name="percent"]');
      if (await percent.count()) {
        await percent.fill("55");
        const record = page.getByRole("button", { name: /^Record$/ });
        if (await record.count()) await record.click();
      }
      // Give any (wrongly-)accepted write time to land, then assert it did NOT.
      await page.waitForTimeout(1500);
      const wrote = (await many("job_progress_observations", "job_id", S.jobBId)).some(
        (o) => o.recorded_by === S.primaryStaffId,
      );
      expect(wrote, "a non-assigned staff member must not create a progress reading under R5").toBe(false);
    });
  });

  // 6 ──────────────────────────────────────────────────────────────────────────
  test("6. owner builds a quote for customer A with correct VAT math", async ({ page }) => {
    test.setTimeout(60_000);
    await gotoReady(page, "/quotes/new");
    await page.locator('select[name="customer_id"]').selectOption(S.customerAId);
    const desc = page.getByPlaceholder(/supply only/i).first();
    await desc.fill("Supply & fit (first-customer sim)");
    await expect(desc).toHaveValue("Supply & fit (first-customer sim)");
    await page.getByLabel(/quantity/i).first().fill("2");
    await page.getByLabel(/unit price/i).first().fill("100");
    // Live totals: subtotal £200, VAT £40, total £240 (VAT defaults to 20%).
    await expect(page.getByText(/£240\.00/)).toBeVisible();
    await submitAndLand(page, "Save quote", new RegExp(`/quotes/${UUID.source}`));
    S.quoteId = idOf(page.url());
    expect(S.quoteId).not.toBe("");
    await expect
      .poll(async () => {
        const q = await one("quotes", "id", S.quoteId);
        return q && { status: q.status, total: Number(q.total) };
      })
      .toEqual({ status: "draft", total: 240 });
  });

  // 7 ──────────────────────────────────────────────────────────────────────────
  test("7. approve → accept ⇒ auto Job + draft Invoice", async ({ page }) => {
    test.setTimeout(90_000);
    await gotoReady(page, `/quotes/${S.quoteId}`);
    await page.getByRole("button", { name: /request approval/i }).click();
    await page.waitForURL(/saved=approval_requested/);
    await settle(page);
    await page.getByRole("button", { name: /^approve$/i }).click();
    await page.waitForURL(/saved=approved/);
    await settle(page);
    await page.getByRole("button", { name: /accept on customer'?s behalf/i }).click();
    await page.waitForURL(/saved=accepted/);

    await expect
      .poll(async () => {
        const q = await one("quotes", "id", S.quoteId);
        return q && { status: q.status, hasJob: !!q.job_id };
      })
      .toEqual({ status: "accepted", hasJob: true });
    S.acceptedJobId = String((await one("quotes", "id", S.quoteId))?.job_id ?? "");
    expect(S.acceptedJobId).not.toBe("");

    await expect
      .poll(async () => {
        const invs = await many("invoices", "job_id", S.acceptedJobId);
        return invs.length === 1 ? Number(invs[0]!.total) : -1;
      })
      .toBe(240);
    S.invoiceId = String((await many("invoices", "job_id", S.acceptedJobId))[0]!.id);
  });

  // 8 ──────────────────────────────────────────────────────────────────────────
  test("8. owner records a payment ⇒ invoice derives paid", async ({ page }) => {
    test.setTimeout(60_000);
    await gotoReady(page, `/invoices/${S.invoiceId}`);
    await page.locator('input[name="amount"]').first().waitFor();
    await page.getByRole("button", { name: /record payment/i }).click();

    await expect
      .poll(async () => {
        const pays = await many("invoice_payments", "invoice_id", S.invoiceId);
        return pays.reduce((n, p) => n + Number(p.amount ?? 0), 0);
      })
      .toBe(240);
    await expect.poll(async () => (await one("invoices", "id", S.invoiceId))?.status).toBe("paid");
  });

  // 9 ──────────────────────────────────────────────────────────────────────────
  test("9. the customer views their own portal by token (no login)", async ({ browser }) => {
    test.setTimeout(60_000);
    // The token IS the credential — a fresh, cookie-less context (no storageState).
    const ctx = await browser.newContext();
    try {
      const page = await ctx.newPage();
      await gotoReady(page, `/customer-portal/${S.portalTokenA}/invoices`);
      await expect(page.getByText(/expired or invalid/i)).toHaveCount(0);
      // A real portal surface renders (the schedule heading), not the invalid-link page.
      await expect(page.getByRole("heading", { name: /payment schedule|invoices/i }).first()).toBeVisible();
    } finally {
      await ctx.close();
    }
  });

  // 10 ─────────────────────────────────────────────────────────────────────────
  test("10. a restricted admin reaches management yet is denied HQ", async ({ browser }) => {
    test.setTimeout(60_000);
    await asActor(browser, ADMIN_STATE, async (page) => {
      // Positive control: admin is management — /quotes (which staff is bounced
      // from, see role-access-boundary.spec.ts) stays open to the admin.
      await page.goto("/quotes");
      await expect(page).toHaveURL(/\/quotes(\?|\/|$)/);
      await expect(page).not.toHaveURL(/\/me(\?|\/|$)/);
      // Ceiling: an admin is NOT a super-admin — CrewFlow HQ 404s (no announce).
      const res = await page.goto("/admin");
      expect(res?.status()).toBe(404);
    });
  });

  // 11 ── HQ (GATED) ────────────────────────────────────────────────────────────
  test("11. [HQ] an HQ super-admin sees the onboarded org", async ({ browser }) => {
    test.skip(
      !HQ_ALLOWLISTED,
      `CREWFLOW_SUPERADMIN_EMAILS must include ${HQ_EMAIL} in the shell that runs Playwright (and the webServer it spawns) for the HQ surface to resolve.`,
    );
    test.setTimeout(60_000);
    await asActor(browser, HQ_STATE, async (page) => {
      await gotoReady(page, "/admin/organizations");
      // The onboarded harness org ("E2E Co") is visible to HQ — the onboarding touchpoint.
      await expect(page.getByText(/E2E Co/).first()).toBeVisible();
    });
  });
});
