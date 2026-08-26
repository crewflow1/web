import { defineConfig, devices } from "@playwright/test";
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";
export default defineConfig({
  testDir: "/Users/moetalibi/Code/web-audit/e2e",
  testMatch: /cross-browser-critical\.spec\.ts/,
  use: { baseURL },
  projects: [
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
  ],
  webServer: {
    command: "npm run start",
    url: baseURL,
    reuseExistingServer: true,
    timeout: 120_000,
    cwd: "/Users/moetalibi/Code/web-audit",
  },
});
