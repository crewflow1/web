import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * P4 Job Documents — UI source-contract suite (PR-B).
 *
 * CI has no browser, so — exactly like ui-phases.test.ts — we pin the wiring
 * between the Job Detail page, the server panel, the server actions and the
 * client controls with cheap file + substring/regex checks. These lock the
 * pieces that are easy to break silently:
 *
 *   • the page derives `canViewPrivate` (owner/admin) and passes it down;
 *   • the panel gates the PRIVATE-area FETCH on `canViewPrivate` (the hard
 *     security requirement — staff must never receive private document data);
 *   • the actions stay thin adapters over the service (audit keeps flowing);
 *   • the client NEVER statically imports the `server-only` service's runtime
 *     values — only `import type` — so it can't be pulled into the bundle.
 */

const root = resolve(__dirname, "../..");
const exists = (rel: string) => existsSync(resolve(root, rel));
const read = (rel: string) => readFileSync(resolve(root, rel), "utf-8");

const PAGE = "app/(app)/jobs/[id]/page.tsx";
const PANEL = "app/(app)/jobs/[id]/_job-documents.tsx";
const CLIENT = "app/(app)/jobs/[id]/_job-documents-client.tsx";
const ACTIONS = "app/(app)/jobs/[id]/job-documents-actions.ts";

// =====================================================================
// Files exist
// =====================================================================

describe("Job Documents UI — files", () => {
  it("ships panel, client controls and server actions", () => {
    expect(exists(PANEL)).toBe(true);
    expect(exists(CLIENT)).toBe(true);
    expect(exists(ACTIONS)).toBe(true);
  });
});

// =====================================================================
// Job Detail page — role gate + mount
// =====================================================================

describe("Job Detail page wiring", () => {
  it("captures ctx from requireOrgContext and derives owner/admin access", () => {
    const src = read(PAGE);
    expect(src).toMatch(/const\s+\{\s*ctx\s*\}\s*=\s*await\s+requireOrgContext\(\)/);
    expect(src).toMatch(/ctx\.membership\.role === "owner"/);
    expect(src).toMatch(/ctx\.membership\.role === "admin"/);
    expect(src).toMatch(/const\s+canViewPrivate\s*=/);
  });

  it("imports and mounts the panel, passing canViewPrivate down", () => {
    const src = read(PAGE);
    expect(src).toMatch(
      /import\s+\{\s*JobDocumentsPanel\s*\}\s+from\s+["']\.\/_job-documents["']/,
    );
    expect(src).toMatch(/<JobDocumentsPanel/);
    expect(src).toMatch(/canViewPrivate=\{canViewPrivate\}/);
  });
});

// =====================================================================
// Server panel — security gate on the FETCH
// =====================================================================

describe("Server panel — private-area fetch gate", () => {
  it("consumes the service list functions", () => {
    const src = read(PANEL);
    expect(src).toMatch(/from\s+["']@\/server\/services\/job-documents["']/);
    expect(src).toMatch(/\blistJobDocuments\b/);
    expect(src).toMatch(/\blistJobDocumentVersions\b/);
  });

  it("always loads the staff area", () => {
    const src = read(PANEL);
    expect(src).toMatch(/loadArea\(\s*jobId\s*,\s*"staff"\s*\)/);
  });

  it("only loads the private area when canViewPrivate, else null", () => {
    const src = read(PANEL);
    // The gate must be on the fetch, not the render: a ternary that skips
    // loadArea(.., "private") entirely for staff.
    expect(src).toMatch(
      /canViewPrivate\s*\?\s*await\s+loadArea\([^)]*"private"\s*\)\s*:\s*null/,
    );
  });

  it("offers staff a write-only drop box (dropbox NewDocumentForm)", () => {
    const src = read(PANEL);
    expect(src).toMatch(/dropbox/);
  });
});

// =====================================================================
// Server actions — thin adapters over the service (audit keeps flowing)
// =====================================================================

describe("Server actions wiring", () => {
  it('is a "use server" module', () => {
    expect(read(ACTIONS)).toMatch(/^"use server";/);
  });

  it("delegates every mutation/read to the service layer", () => {
    const src = read(ACTIONS);
    for (const fn of [
      "createJobDocument",
      "addJobDocumentVersion",
      "completeJobDocument",
      "deleteJobDocument",
      "getJobDocumentDownloadUrl",
    ]) {
      expect(src).toContain(fn);
    }
  });

  it("revalidates the job detail path after writes", () => {
    expect(read(ACTIONS)).toMatch(/revalidatePath\(`\/jobs\/\$\{jobId\}`\)/);
  });
});

// =====================================================================
// Client controls — bundle safety + mobile capture
// =====================================================================

describe("Client controls", () => {
  it('is a "use client" module with camera capture', () => {
    const src = read(CLIENT);
    expect(src).toMatch(/^"use client";/);
    expect(src).toMatch(/capture="environment"/);
  });

  it("invokes the server actions, not the service directly", () => {
    const src = read(CLIENT);
    for (const fn of [
      "uploadJobDocument",
      "uploadJobDocumentVersion",
      "completeJobDocumentAction",
      "deleteJobDocumentAction",
      "getJobDocumentDownloadUrlAction",
    ]) {
      expect(src).toContain(fn);
    }
  });

  it("imports the server-only service ONLY as a type (never its values)", () => {
    const src = read(CLIENT);
    const valueImport =
      /import\s+\{[^}]*\}\s+from\s+["']@\/server\/services\/job-documents["']/;
    const typeImport =
      /import\s+type\s+\{[^}]*\}\s+from\s+["']@\/server\/services\/job-documents["']/;
    expect(typeImport.test(src)).toBe(true);
    expect(valueImport.test(src)).toBe(false);
  });
});
