// One-off: capture real product screenshots from the local seeded demo org
// (Brightwork Construction) for the marketing site's product frames.
// Run with the dev server on :3200 pointed at local Supabase. Not part of CI.
import { chromium } from "playwright";
import fs from "node:fs";

const BASE = "http://localhost:3200";
const OUT = "public/product-shots";
const EMAIL = "demo@brightwork.example";
const PASSWORD = "DemoPass123!";

// Only screens seeded with realistic data, each clipped to its content (no
// trailing whitespace / onboarding banner). quotes/RAMS aren't seeded, so we
// don't capture them (an empty screen is worse than none).
const SHOTS = [
  { path: "/dashboard", name: "dashboard", wait: 1600, clip: { x: 0, y: 0, width: 1440, height: 620 } },
  { path: "/cash", name: "cash", wait: 1500, clip: { x: 0, y: 0, width: 1440, height: 726 } },
  { path: "/jobs", name: "jobs", wait: 1400, clip: { x: 0, y: 0, width: 1440, height: 640 } },
  { path: "/invoices", name: "invoices", wait: 1400, clip: { x: 0, y: 0, width: 1440, height: 540 } },
  { path: "/customers", name: "customers", wait: 1400, clip: { x: 0, y: 0, width: 1440, height: 600 } },
  { path: "/quotes", name: "quotes", wait: 1400, clip: { x: 0, y: 0, width: 1440, height: 560 } },
  { path: "/health-safety", name: "health-safety", wait: 1500, clip: { x: 0, y: 0, width: 1440, height: 720 } },
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
