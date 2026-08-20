// One-off: capture real product screenshots from the local seeded demo org
// (Brightwork Construction) for the marketing site's product frames.
// Run with the dev server on :3200 pointed at local Supabase. Not part of CI.
import { chromium } from "playwright";
import fs from "node:fs";

const BASE = "http://localhost:3200";
const OUT = "public/product-shots";
const EMAIL = "demo@brightwork.example";
const PASSWORD = "DemoPass123!";

const SHOTS = [
  // Dashboard hero: clip to the topbar + "Good morning" attention cards,
  // above the onboarding-progress banner (cleaner, more focused hero frame).
  { path: "/dashboard", name: "dashboard", wait: 1600, clip: { x: 0, y: 0, width: 1440, height: 620 } },
  { path: "/jobs", name: "jobs", wait: 1400 },
  { path: "/invoices", name: "invoices", wait: 1400 },
  { path: "/quotes", name: "quotes", wait: 1400 },
  { path: "/customers", name: "customers", wait: 1400 },
  { path: "/health-safety", name: "health-safety", wait: 1400 },
];

fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 960 },
  deviceScaleFactor: 2,
});
const page = await ctx.newPage();

// --- log in via the password panel -----------------------------------------
await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
await page.getByPlaceholder("you@yourcompany.co.uk").last().fill(EMAIL);
const pw = page.getByPlaceholder("Your password");
await pw.fill(PASSWORD);
await pw.press("Enter");
await page
  .waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 20000 })
  .catch(() => {});
await page.waitForTimeout(1500);
console.log("after login, url:", page.url());

// --- capture ---------------------------------------------------------------
const results = [];
for (const s of SHOTS) {
  try {
    await page.goto(`${BASE}${s.path}`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(s.wait);
    const file = `${OUT}/${s.name}.png`;
    await page.screenshot(s.clip ? { path: file, clip: s.clip } : { path: file });
    const bytes = fs.statSync(file).size;
    results.push(`${s.name}: ${page.url()} (${Math.round(bytes / 1024)}kB)`);
  } catch (e) {
    results.push(`${s.name}: FAILED ${e.message}`);
  }
}
await browser.close();
console.log(results.join("\n"));
