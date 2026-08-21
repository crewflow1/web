// One-off: capture the /leads screen for the JobJourney "Catch the enquiry"
// stage. Same login + clip as capture-shots.mjs; resized to 1600px afterwards.
import { chromium } from "playwright";
const BASE = "http://localhost:3200";
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
await page.getByPlaceholder("you@yourcompany.co.uk").last().fill("demo@brightwork.example");
const pw = page.getByPlaceholder("Your password");
await pw.fill("DemoPass123!");
await pw.press("Enter");
await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 20000 }).catch(() => {});
await page.goto(`${BASE}/leads`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(1600);
await page.screenshot({ path: "public/product-shots/journey/leads.png", clip: { x: 0, y: 0, width: 1440, height: 600 } });
console.log("leads captured:", page.url());
await browser.close();
