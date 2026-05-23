import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Customer OS polish pass — pins error/loading/not-found UX so a
 * future refactor can't silently drop them.
 */

const ROOT = resolve(__dirname, "..", "..");
const has = (p: string) => existsSync(resolve(ROOT, p));
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

describe("customer (app) — error boundary", () => {
  it("app/(app)/error.tsx exists", () => {
    expect(has("app/(app)/error.tsx")).toBe(true);
  });

  it("renders the workspace's own error page (not the root marketing one)", () => {
    const src = read("app/(app)/error.tsx");
    expect(src).toMatch(/"use client"/);
    expect(src).toMatch(/Something went wrong on our side/);
    expect(src).toMatch(/Back to dashboard/);
    expect(src).toMatch(/Raise a ticket/);
    expect(src).toMatch(/href="\/support\/new"/);
  });
});

describe("customer (app) — not-found boundary", () => {
  it("app/(app)/not-found.tsx exists", () => {
    expect(has("app/(app)/not-found.tsx")).toBe(true);
  });

  it("links back to dashboard + support", () => {
    const src = read("app/(app)/not-found.tsx");
    expect(src).toMatch(/href="\/dashboard"/);
    expect(src).toMatch(/href="\/support\/new"/);
  });
});

describe("customer (app) — loading skeletons for new routes", () => {
  it("/support has loading.tsx", () => {
    expect(has("app/(app)/support/loading.tsx")).toBe(true);
  });
  it("/notifications has loading.tsx", () => {
    expect(has("app/(app)/notifications/loading.tsx")).toBe(true);
  });
  it("/settings has loading.tsx", () => {
    expect(has("app/(app)/settings/loading.tsx")).toBe(true);
  });
});

describe("customer (app) — every primary route has loading.tsx", () => {
  // Pin the existing-coverage baseline + every route we just added.
  const expected = [
    "activity",
    "customers",
    "dashboard",
    "finances",
    "imports",
    "invoices",
    "jobs",
    "leads",
    "me",
    "notifications",
    "payments",
    "payroll",
    "quotes",
    "reports",
    "settings",
    "staff",
    "support",
    "tax",
  ];
  for (const route of expected) {
    it(`/${route} has loading.tsx`, () => {
      expect(has(`app/(app)/${route}/loading.tsx`)).toBe(true);
    });
  }
});
