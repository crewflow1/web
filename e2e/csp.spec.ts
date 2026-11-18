import { test, expect, type Page, type Response } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cspClassForPath } from "../lib/security/csp";
import { waitForHydrated } from "./_hydration";

/**
 * ENFORCED Content-Security-Policy — browser proof (lib/security/csp.ts).
 *
 * Runs against the real production build (`next start`), so the headers under
 * test are the production code path (middleware + next.config). For every key
 * surface it asserts:
 *   1. exactly one ENFORCING `Content-Security-Policy` header of the right class
 *      (nonce + 'strict-dynamic' for dynamic routes; the static policy for
 *      prerendered pages) and no Report-Only twin;
 *   2. ZERO `securitypolicyviolation` events and zero CSP console errors while
 *      the page loads, hydrates and (where relevant) runs its heaviest client
 *      code (pdf.js worker + WASM codecs in the drawing viewer);
 *   3. on nonce pages, every <script> carries THIS response's nonce.
 * Plus: the prerendered-route guard (every page Next prerendered must be in
 * the static class, or its un-nonced scripts would be blocked), the
 * static → app soft-navigation boundary, and the violation-report sink.
 */

const JOB = "00000000-0000-0000-0000-000000000000"; // seeded by e2e/global-setup.ts
const OWNER = "e2e/.auth/owner.json";

type CspWatch = { violations: () => Promise<string[]> };

/** Capture CSP violations (DOM event + console) for the page's documents. */
async function watchCsp(page: Page): Promise<CspWatch> {
  const consoleHits: string[] = [];
  await page.addInitScript(() => {
    const w = window as unknown as { __cspViolations: string[] };
    w.__cspViolations = [];
    document.addEventListener("securitypolicyviolation", (e) => {
      w.__cspViolations.push(
        `${e.effectiveDirective} blocked=${e.blockedURI} at ${e.sourceFile}:${e.lineNumber} sample=${e.sample}`,
      );
    });
  });
  page.on("console", (m) => {
    if (/content security policy|refused to (load|execute|evaluate|apply|connect|frame|create)/i.test(m.text())) {
      consoleHits.push(`console[${m.type()}]: ${m.text()}`);
    }
  });
  return {
    violations: async () => {
      const inPage = await page
        .evaluate(() => (window as unknown as { __cspViolations?: string[] }).__cspViolations ?? [])
        .catch(() => [] as string[]);
      return [...consoleHits, ...inPage];
    },
  };
}

async function cspHeaders(res: Response | null) {
  const all = res ? await res.headersArray() : [];
  const enforce = all.filter((h) => h.name.toLowerCase() === "content-security-policy");
  const reportOnly = all.filter((h) => h.name.toLowerCase() === "content-security-policy-report-only");
  return { enforce, reportOnly, value: enforce[0]?.value ?? "" };
}

const scriptSrc = (policy: string) =>
  policy.split(";").map((d) => d.trim()).find((d) => d.startsWith("script-src ")) ?? "";

function nonceOf(policy: string): string {
  const m = /'nonce-([A-Za-z0-9+/_-]+={0,2})'/.exec(scriptSrc(policy));
  return m?.[1] ?? "";
}

/** Header-level contract for one document response. */
async function expectPolicy(res: Response | null, cls: "nonce" | "static"): Promise<string> {
  const { enforce, reportOnly, value } = await cspHeaders(res);
  expect(enforce, "exactly one enforcing CSP header").toHaveLength(1);
  expect(reportOnly, "no Report-Only twin").toHaveLength(0);
  expect(value).not.toContain("'unsafe-eval'");
  expect(value).toContain("object-src 'none'");
  expect(value).toContain("frame-ancestors 'none'");
  expect(value).toContain("base-uri 'self'");
  expect(value).toContain("report-uri /api/csp-report");
  if (cls === "nonce") {
    expect(nonceOf(value)).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    expect(scriptSrc(value)).toContain("'strict-dynamic'");
    expect(scriptSrc(value)).not.toContain("'unsafe-inline'");
  } else {
    expect(scriptSrc(value)).not.toContain("'nonce-");
  }
  // The nonce travels on the REQUEST only — never echoed as a response header.
  expect(res?.headers()["x-nonce"]).toBeUndefined();
  return value;
}

/** Every <script> in the document carries the response's nonce. */
async function expectScriptsNonced(page: Page, nonce: string) {
  const nonces = await page.evaluate(() =>
    Array.from(document.querySelectorAll("script")).map((s) => ({
      // CSP hides the nonce attribute; the IDL property keeps the value.
      nonce: (s as HTMLScriptElement).nonce,
      type: s.type,
    })),
  );
  const executable = nonces.filter((s) => s.type !== "application/ld+json");
  expect(executable.length).toBeGreaterThan(0);
  for (const s of executable) expect(s.nonce).toBe(nonce);
}

/**
 * Let the page finish its post-hydration work (lazy chunks, effects) before
 * reading violations: wait for the main thread to go idle (bounded), a real
 * completion signal — not a sleep, and not `networkidle`, which never settles
 * on pages that hold a realtime socket or poll.
 */
async function settle(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const ric = (window as unknown as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => void })
          .requestIdleCallback;
        if (ric) ric(() => resolve(), { timeout: 5_000 });
        else setTimeout(resolve, 0);
      }),
  );
}

async function expectClean(watch: CspWatch, label: string) {
  expect(await watch.violations(), `CSP violations on ${label}`).toEqual([]);
}

test.describe("CSP — prerendered routes are all in the static class (build guard)", () => {
  test("every page Next prerendered is served the nonce-free static policy", () => {
    const manifest = join(process.cwd(), ".next", "prerender-manifest.json");
    test.skip(!existsSync(manifest), "needs the local production build (.next)");
    const routes = JSON.parse(readFileSync(manifest, "utf8")).routes as Record<string, { dataRoute: string | null }>;
    const pages = Object.entries(routes)
      .filter(([, r]) => r.dataRoute) // HTML pages (metadata routes have no RSC data route)
      .map(([path]) => path);
    expect(pages.length).toBeGreaterThan(20);
    const misclassified = pages.filter((p) => cspClassForPath(p) !== "static");
    expect(misclassified, "prerendered pages missing from STATIC_POLICY_PREFIXES").toEqual([]);
    // The unmatched-URL 404 (app/global-not-found.tsx) renders per request so
    // it carries the nonce; it must never be prerendered.
    expect(pages).not.toContain("/_not-found");
  });
});

test.describe("CSP — public surfaces (anonymous)", () => {
  test("marketing home: static policy, hydrates, zero violations", async ({ page }) => {
    const watch = await watchCsp(page);
    const res = await page.goto("/");
    await expectPolicy(res, "static");
    await expect(page).toHaveTitle(/CrewFlow/i);
    await waitForHydrated(page.getByRole("link", { name: "Sign in" }));
    await expectClean(watch, "/");
  });

  const manifestPath = join(process.cwd(), ".next", "prerender-manifest.json");
  const ssgFeature = existsSync(manifestPath)
    ? Object.keys(JSON.parse(readFileSync(manifestPath, "utf8")).routes).find((p) => p.startsWith("/features/"))
    : undefined;
  for (const path of ["/pricing", ssgFeature ?? "/features", "/tools/vat-calculator"]) {
    test(`${path}: static policy, hydrates, zero violations`, async ({ page }) => {
      const watch = await watchCsp(page);
      const res = await page.goto(path);
      await expectPolicy(res, "static");
      // Client JS actually runs under the policy (the calculator is client-rendered).
      await waitForHydrated(page.getByRole("link", { name: "Sign in" }));
      await settle(page);
      await expectClean(watch, path);
    });
  }

  test("login: nonce policy, every script nonced, form hydrates, zero violations", async ({ page }) => {
    const watch = await watchCsp(page);
    const res = await page.goto("/login");
    const policy = await expectPolicy(res, "nonce");
    await expectScriptsNonced(page, nonceOf(policy));
    const submit = page.getByTestId("magic-link-form").getByRole("button", { name: /magic link/i });
    await waitForHydrated(submit);
    await expectClean(watch, "/login");
  });

  test("a fresh nonce per request", async ({ request }) => {
    const a = nonceOf((await request.get("/login")).headers()["content-security-policy"] ?? "");
    const b = nonceOf((await request.get("/login")).headers()["content-security-policy"] ?? "");
    expect(a).not.toBe("");
    expect(a).not.toBe(b);
  });

  test("developer docs: nonce policy, zero violations", async ({ page }) => {
    const watch = await watchCsp(page);
    const docs = await page.goto("/developers");
    await expectPolicy(docs, "nonce");
    await expectClean(watch, "/developers");
  });

  test("customer portal (invalid token) + the PWA offline shell: zero violations", async ({ page }) => {
    const watch = await watchCsp(page);
    const portal = await page.goto("/customer-portal/not-a-real-token-csp");
    await expectPolicy(portal, "nonce");
    await expectClean(watch, "customer-portal");

    // /offline is outside the middleware: it carries the next.config fallback.
    const offline = await page.goto("/offline");
    await expectPolicy(offline, "static");
    await settle(page);
    await expectClean(watch, "/offline");
  });

  test("static → app soft navigation becomes a full document load under the nonce policy", async ({ page }) => {
    const watch = await watchCsp(page);
    await page.goto("/");
    const signIn = page.getByRole("link", { name: "Sign in" }).first();
    await waitForHydrated(signIn);
    const doc = page.waitForResponse((r) => r.request().resourceType() === "document" && new URL(r.url()).pathname === "/login");
    await signIn.click();
    await expectPolicy(await doc, "nonce");
    await expect(page).toHaveURL(/\/login$/);
    // The CURRENT document is /login itself, not the marketing page it came from.
    const docUrl = await page.evaluate(() => (performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming).name);
    expect(new URL(docUrl).pathname).toBe("/login");
    await expectClean(watch, "/ → /login");
  });
});

test.describe("CSP — authenticated app (owner)", () => {
  test.use({ storageState: OWNER });

  for (const path of ["/dashboard", `/jobs/${JOB}`, "/settings", "/settings/billing"]) {
    test(`${path}: nonce policy, every script nonced, zero violations`, async ({ page }) => {
      const watch = await watchCsp(page);
      const res = await page.goto(path);
      expect(new URL(page.url()).pathname, `${path} rendered (not redirected)`).toBe(path);
      const policy = await expectPolicy(res, "nonce");
      await expectScriptsNonced(page, nonceOf(policy));
      await waitForHydrated(page.locator("a[href='/dashboard']"));
      await settle(page);
      await expectClean(watch, path);
    });
  }

  test("an unmatched URL (404) is rendered per request: nonce on every script, hydrates", async ({ page }) => {
    // Signed in: a logged-out visitor to an unknown path is redirected to /login.
    const watch = await watchCsp(page);
    for (const path of ["/this-route-does-not-exist-csp", `/jobs/${JOB}/no-such-tab-csp`]) {
      const missing = await page.goto(path);
      expect(missing?.status(), path).toBe(404);
      const policy = await expectPolicy(missing, "nonce");
      await expectScriptsNonced(page, nonceOf(policy));
      await waitForHydrated(page.getByRole("link", { name: /back to crewflow/i }));
      await expectClean(watch, `404 ${path}`);
    }
  });

  test("drawing viewer: pdf.js worker + WASM codecs render under the enforced policy", async ({ page }) => {
    const watch = await watchCsp(page);
    const res = await page.goto(`/jobs/${JOB}/blueprints`);
    await expectPolicy(res, "nonce");
    const trigger = page.getByRole("button", { name: "View" }).first();
    await waitForHydrated(trigger);
    await trigger.click();
    const dialog = page.getByRole("dialog", { name: /Drawing viewer/ });
    await expect(dialog.locator("canvas[data-rendered-page]")).toBeVisible();
    await settle(page);
    await expectClean(watch, "drawing viewer");
  });

  test("an authenticated soft navigation from marketing into the app lands on a nonce document", async ({ page }) => {
    const watch = await watchCsp(page);
    await page.goto("/");
    const signIn = page.getByRole("link", { name: "Sign in" }).first();
    await waitForHydrated(signIn);
    await signIn.click();
    // Middleware bounces an authed /login to the workspace.
    await expect(page).toHaveURL(/\/dashboard/);
    const docUrl = await page.evaluate(() => (performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming).name);
    expect(cspClassForPath(new URL(docUrl).pathname)).toBe("nonce");
    await settle(page);
    await expectClean(watch, "/ → /dashboard (authed)");
  });
});

test.describe("CSP — violation report sink", () => {
  test("accepts a report (204), rejects other types / methods", async ({ request }) => {
    const ok = await request.post("/api/csp-report", {
      headers: { "content-type": "application/csp-report" },
      data: JSON.stringify({
        "csp-report": {
          "document-uri": "http://localhost:3000/dashboard",
          "effective-directive": "script-src-elem",
          "blocked-uri": "inline",
          disposition: "enforce",
        },
      }),
    });
    expect(ok.status()).toBe(204);
    const wrongType = await request.post("/api/csp-report", {
      headers: { "content-type": "text/plain" },
      data: "x",
    });
    expect(wrongType.status()).toBe(415);
    expect((await request.get("/api/csp-report")).status()).toBe(405);
  });
});
