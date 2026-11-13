import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { safeActionPath } from "@/lib/notifications/action-url";
import { buildDigestEmail } from "@/lib/notifications/preferences";

/**
 * INJ-01 (defence in depth) — a stored notification `action_url` is DATA, and
 * every surface that turns it into a link accepts ONLY a same-origin relative
 * path. The DB half (the column-restricted UPDATE grant that stops a tenant user
 * rewriting the column at all) is proven against real Postgres in
 * __tests__/integration/rls/notifications-column-immutability.test.ts; this file
 * pins the render half so a poisoned value that reaches a row by ANY route can
 * never become an off-origin link, a script URL, or injected email markup.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

const POISONED = [
  "https://evil.example/login",
  "http://evil.example/",
  "//evil.example/login",
  "/\\evil.example/login",
  "\\\\evil.example",
  "@evil.example/login", //     https://crewflow.uk@evil.example/login
  ".evil.example/login", //     https://crewflow.uk.evil.example/login
  ":8443@evil.example/",
  "javascript:alert(1)",
  "JaVaScRiPt:alert(1)",
  "java\tscript:alert(1)",
  " javascript:alert(1)",
  "data:text/html,<script>alert(1)</script>",
  "vbscript:msgbox(1)",
  "/jobs/1\r\nSet-Cookie: x=1",
  "/jobs/1 onclick=alert(1)",
  "jobs/1",
  "",
  "   ",
];

describe("safeActionPath — the one same-origin guard", () => {
  it("accepts ordinary in-app relative paths unchanged (incl. query + fragment)", () => {
    for (const ok of [
      "/dashboard",
      "/jobs/3f2b6c1e-0000-4000-8000-000000000000#checklist",
      "/admin/support?priority=urgent&q=Acme%20Builders",
      "/materials/requests/abc",
    ]) {
      expect(safeActionPath(ok)).toBe(ok);
    }
  });

  it("trims surrounding whitespace on an otherwise valid path", () => {
    expect(safeActionPath("  /leads/1  ")).toBe("/leads/1");
  });

  it("rejects every off-origin / script / smuggling form", () => {
    for (const bad of POISONED) {
      expect(safeActionPath(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it("rejects non-strings", () => {
    expect(safeActionPath(null)).toBeNull();
    expect(safeActionPath(undefined)).toBeNull();
    expect(safeActionPath(42 as unknown as string)).toBeNull();
  });
});

describe("digest email — a poisoned action_url never becomes a link", () => {
  const base = {
    id: "n1",
    category: "other",
    priority: "normal",
    created_at: "2026-11-13T09:00:00Z",
  };

  it("emits no href and no URL line for any poisoned value", () => {
    for (const bad of POISONED) {
      const email = buildDigestEmail({
        cadence: "daily",
        notifications: [{ ...base, title: "Hello", body: null, action_url: bad }],
      });
      expect(email).not.toBeNull();
      // The only hrefs left are our own fixed footer links.
      const hrefs = [...email!.body_html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
      for (const h of hrefs) {
        expect(h === "https://crewflow.uk/notifications" || h === "https://crewflow.uk/settings", h).toBe(true);
      }
      expect(email!.body_html).not.toContain("evil.example");
      expect(email!.body_text).not.toContain("evil.example");
      expect(email!.body_text.toLowerCase()).not.toContain("javascript:");
    }
  });

  it("still links a legitimate relative path to our origin", () => {
    const email = buildDigestEmail({
      cadence: "daily",
      notifications: [{ ...base, title: "Job updated", body: null, action_url: "/jobs/abc" }],
    });
    expect(email!.body_html).toContain('href="https://crewflow.uk/jobs/abc"');
    expect(email!.body_text).toContain("https://crewflow.uk/jobs/abc");
  });

  it("escapes quotes so a title/body/path can never break out of an attribute", () => {
    const email = buildDigestEmail({
      cadence: "daily",
      notifications: [
        {
          ...base,
          title: `"><img src=x onerror=alert(1)>`,
          body: `' onmouseover='alert(1)`,
          action_url: `/jobs/abc"onmouseover="alert(1)`,
        },
      ],
    });
    const html = email!.body_html;
    expect(html).not.toContain("<img");
    expect(html).not.toContain(`"onmouseover="`);
    expect(html).not.toContain(`' onmouseover='`);
    expect(html).toContain("&quot;");
  });
});

describe("render sites route action_url through the guard (no raw href)", () => {
  const SITES = [
    "app/(app)/_components/notifications.tsx",
    "app/(app)/notifications/page.tsx",
    "app/admin/notifications/page.tsx",
  ];

  it("no component passes the raw column to href", () => {
    for (const p of SITES) {
      const src = read(p);
      expect(src, p).toContain("safeActionPath");
      expect(src, p).not.toMatch(/href=\{\s*n\.action_url\s*\}/);
    }
  });

  it("the email builders never concatenate the raw column onto our origin", () => {
    const email = read("lib/notifications/email.ts");
    expect(email).toContain("safeActionPath(n.action_url)");
    expect(email).not.toMatch(/crewflow\.uk"\s*\+\s*n\.action_url/);
    const prefs = read("lib/notifications/preferences.ts");
    expect(prefs).not.toMatch(/\$\{BASE_URL\}\$\{(escapeHtml\()?n\.action_url/);
  });
});
