import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ATTACHMENT_TARGET_TABLES } from "@/server/services/tenant-attachments";

/**
 * Train J — QR/asset events on the timeline + attachments on maintenance &
 * custody. These are the trust-boundary pins for that slice:
 *
 *   1. Every attachment target the new UI mounts is already in the allowed
 *      CHECK/app list (widening the CHECK would be a migration — out of scope).
 *   2. The two new timeline reads on the asset page are ACTIVE-org pinned and
 *      loud (`current_org_ids()` is permissive, so RLS alone is not scoping).
 *   3. The QR scan resolver is still a pure READ — no scan-event write — so the
 *      timeline cannot be surfacing fabricated scan rows.
 *   4. The attachment mounts pass only (targetTable, targetId) — no client
 *      storage path — reusing the one vetted pipeline.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (rel: string) => readFileSync(resolve(ROOT, rel), "utf8");

const CUSTODY = "app/(app)/assets/[id]/_custody.tsx";
const MAINTENANCE = "app/(app)/assets/[id]/_maintenance.tsx";
const PAGE = "app/(app)/assets/[id]/page.tsx";
const SCAN = "lib/assets/scan.ts";

describe("asset timeline + attachments invariants", () => {
  it("custody attaches to asset_assignments — a target already in the allowed list", () => {
    const src = read(CUSTODY);
    expect(src).toMatch(/targetTable="asset_assignments"/);
    expect(ATTACHMENT_TARGET_TABLES).toContain("asset_assignments");
  });

  it("maintenance attaches to asset_maintenance_cases — a target already in the allowed list", () => {
    const src = read(MAINTENANCE);
    expect(src).toMatch(/targetTable="asset_maintenance_cases"/);
    expect(ATTACHMENT_TARGET_TABLES).toContain("asset_maintenance_cases");
  });

  it("new attachment mounts pass only targetTable + targetId (no client storage path)", () => {
    for (const rel of [CUSTODY, MAINTENANCE]) {
      const src = read(rel);
      // The mount must not hand the panel a storage_path / path prop — the
      // service derives the org-bound path itself.
      expect(src).not.toMatch(/storage_?[Pp]ath=/);
    }
  });

  it("the two new timeline reads on the asset page are ACTIVE-org pinned", () => {
    const src = read(PAGE);
    // Custody-history read.
    expect(src).toMatch(/asset_assignments[\s\S]*?\.eq\("asset_id", id\)[\s\S]*?\.eq\("org_id", ctx\.org\.id\)/);
    // QR-history read.
    expect(src).toMatch(/asset_qr_identities[\s\S]*?\.eq\("asset_id", id\)[\s\S]*?\.eq\("org_id", ctx\.org\.id\)/);
  });

  it("the timeline reads are loud (a read failure throws readFailure, never a silent empty)", () => {
    const src = read(PAGE);
    expect(src).toMatch(/qrHistoryError\)\s*throw readFailure/);
    expect(src).toMatch(/historyError\)\s*throw readFailure/);
  });

  it("the QR scan resolver remains a pure read — it never writes a scan event", () => {
    const src = read(SCAN);
    // No mutation verbs on the resolver path — scans are not logged, so the
    // timeline cannot be sourcing fabricated scan rows.
    expect(src).not.toMatch(/\.insert\(/);
    expect(src).not.toMatch(/\.update\(/);
    expect(src).not.toMatch(/\.upsert\(/);
  });
});
