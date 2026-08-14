import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ATTACHMENT_TARGET_TABLES } from "@/server/services/tenant-attachments";

/**
 * Blueprint Pins completion wave (P2) — source-contract security proofs.
 *
 * These lock the DB-enforced tenant/link invariants and the services' trust
 * boundaries at the SOURCE for the three new capabilities (task pins, threaded
 * comments, direct pin photos), so a future edit that quietly weakens them
 * fails CI. Behavioural proofs (real Postgres RLS) live in
 * __tests__/integration/rls/blueprint-pins.test.ts.
 */

const root = join(__dirname, "..", "..");
const mig1 = readFileSync(join(root, "supabase/migrations/20261122000000_blueprint_pin_tasks_and_comments.sql"), "utf8");
const mig2 = readFileSync(join(root, "supabase/migrations/20261122000001_blueprint_pin_attachments.sql"), "utf8");
const commentsSvc = readFileSync(join(root, "server/services/blueprint-pin-comments.ts"), "utf8");
const photosSvc = readFileSync(join(root, "server/services/blueprint-pin-photos.ts"), "utf8");
const pinsSvc = readFileSync(join(root, "server/services/blueprint-pins.ts"), "utf8");

describe("task-pin migration — additive kind + payload integrity", () => {
  it("widens the kind domain to include 'task' without dropping snag/note", () => {
    expect(mig1).toMatch(/check\s*\(kind in \('snag',\s*'note',\s*'task'\)\)/i);
  });

  it("adds task-only lifecycle columns, all nullable so existing rows survive", () => {
    expect(mig1).toMatch(/add column if not exists task_status text/i);
    expect(mig1).toMatch(/add column if not exists assigned_to uuid references public\.users\(id\) on delete set null/i);
    expect(mig1).toMatch(/add column if not exists due_date\s+date/i);
    expect(mig1).toMatch(/task_status is null or task_status in \('open',\s*'in_progress',\s*'done'\)/i);
  });

  it("rebuilds the kind<->payload CHECK so task pins carry a status and no snag/note-only fields", () => {
    expect(mig1).toMatch(/drop constraint if exists blueprint_pins_kind_payload/i);
    // task branch: no snag link, OWNS a status.
    expect(mig1).toMatch(/kind = 'task' and snag_id is null and task_status is not null/i);
    // snag/note branches must forbid task fields so a snag/note pin can't smuggle a status/assignee.
    expect(mig1).toMatch(/kind = 'snag'[\s\S]*?task_status is null and assigned_to is null and due_date is null/i);
    expect(mig1).toMatch(/kind = 'note'[\s\S]*?task_status is null and assigned_to is null and due_date is null/i);
  });
});

describe("pin-comments migration — tenant + thread integrity", () => {
  it("gives blueprint_pins an (id, org_id) candidate key for the comments FK", () => {
    expect(mig1).toMatch(/blueprint_pins[\s\S]*?add constraint blueprint_pins_id_org_key unique \(id, org_id\)/i);
  });

  it("links a comment to its pin with a COMPOSITE (pin_id, org_id) FK — the cross-tenant guard", () => {
    expect(mig1).toMatch(/foreign key\s*\(pin_id,\s*org_id\)\s*references\s+public\.blueprint_pins\s*\(id,\s*org_id\)\s*on delete cascade/i);
  });

  it("threads replies with a COMPOSITE self-FK on (parent_comment_id, org_id)", () => {
    expect(mig1).toMatch(/unique\s*\(id,\s*org_id\)/i);
    expect(mig1).toMatch(/foreign key\s*\(parent_comment_id,\s*org_id\)\s*references\s+public\.blueprint_pin_comments\s*\(id,\s*org_id\)\s*on delete cascade/i);
  });

  it("derives org_id from the parent pin + enforces same-pin replies in a SECURITY DEFINER trigger", () => {
    expect(mig1).toMatch(/tg_blueprint_pin_comment_before_write/i);
    expect(mig1).toMatch(/security definer/i);
    expect(mig1).toMatch(/set search_path = public/i);
    expect(mig1).toMatch(/new\.org_id\s*:=\s*v_org/i);
    expect(mig1).toMatch(/same pin/i);
    expect(mig1).toMatch(/before insert or update on public\.blueprint_pin_comments/i);
  });

  it("RLS: members read; author posts (author_id = auth.uid()); author-or-admin deletes", () => {
    expect(mig1).toMatch(/enable row level security/i);
    expect(mig1).toMatch(/for select using \(org_id in \(select public\.current_org_ids\(\)\)\)/i);
    expect(mig1).toMatch(/for insert with check \([\s\S]*?author_id = auth\.uid\(\)/i);
    expect(mig1).toMatch(/for delete using \([\s\S]*?author_id = auth\.uid\(\) or public\.is_org_admin\(org_id\)/i);
  });
});

describe("pin-photo migration — reuses the universal attachment pipeline", () => {
  it("widens the tenant_attachments target CHECK to include blueprint_pins (introspect-drop-readd)", () => {
    expect(mig2).toMatch(/drop constraint %I/i); // introspected drop
    expect(mig2).toMatch(/tenant_attachments_target_table_check[\s\S]*?'blueprint_pins'/i);
    // must preserve prior targets — spot-check the first and a late one.
    expect(mig2).toMatch(/'customers'/);
    expect(mig2).toMatch(/'non_conformance_reports'/);
  });

  it("the TS target list includes blueprint_pins (drift test pins it equal to the CHECK)", () => {
    expect(ATTACHMENT_TARGET_TABLES).toContain("blueprint_pins");
  });
});

describe("pin-comments service — trust boundaries", () => {
  it("writes through the tenant client (RLS), never the service-role admin client", () => {
    expect(commentsSvc).toMatch(/from "@\/lib\/supabase\/server"/);
    expect(commentsSvc).not.toMatch(/createAdminClient|service-role|createServiceClient/);
  });

  it("pins reads to the ACTIVE org (verifies the pin is in ctx.org.id before reading its thread)", () => {
    expect(commentsSvc).toMatch(/pinInActiveOrg/);
    expect(commentsSvc).toMatch(/\.eq\("org_id",\s*ctx\.org\.id\)/);
  });

  it("pages the thread with fetchAllRows (F-1) on a stable, unique order", () => {
    expect(commentsSvc).toMatch(/fetchAllRows/);
    expect(commentsSvc).toMatch(/\.order\("created_at",\s*\{ ascending: true \}\)[\s\S]*?\.order\("id",\s*\{ ascending: true \}\)/);
  });

  it("count-gates the delete so an RLS refusal is a deterministic failure, not a silent no-op", () => {
    expect(commentsSvc).toMatch(/delete\(\{ count: "exact" \}\)/);
    expect(commentsSvc).toMatch(/if \(!count\)/);
  });

  it("audits via recordAdminActivity", () => {
    expect(commentsSvc).toMatch(/recordAdminActivity/);
    expect(commentsSvc).toMatch(/blueprint_pin_comment\.created/);
    expect(commentsSvc).toMatch(/blueprint_pin_comment\.deleted/);
  });
});

describe("pin-photos service — trust boundaries", () => {
  it("accepts IMAGES ONLY (a pin marks a thing you photograph, not a document)", () => {
    expect(photosSvc).toMatch(/PIN_PHOTO_MIME/);
    expect(photosSvc).not.toMatch(/application\/pdf/);
    expect(photosSvc).toMatch(/image\/jpeg/);
  });

  it("verifies the pin is in the ACTIVE org before hanging bytes off it", () => {
    expect(photosSvc).toMatch(/pinInActiveOrg/);
    expect(photosSvc).toMatch(/\.eq\("org_id",\s*ctx\.org\.id\)/);
  });

  it("never signs a path that isn't under the row's own org (anti-poisoning)", () => {
    expect(photosSvc).toMatch(/storagePathBelongsToOrg/);
  });

  it("delegates upload/delete to the hardened tenant-attachments service (no bespoke storage writes)", () => {
    expect(photosSvc).toMatch(/uploadTenantAttachment/);
    expect(photosSvc).toMatch(/deleteTenantAttachment/);
    expect(photosSvc).not.toMatch(/\.storage\s*\.\s*from\([^)]*\)\s*\.\s*upload/);
  });
});

describe("blueprint-pins service — task-pin writes stay tenant-scoped", () => {
  it("createTaskPin/updateTaskPin go through the tenant client, not admin", () => {
    expect(pinsSvc).toMatch(/export async function createTaskPin/);
    expect(pinsSvc).toMatch(/export async function updateTaskPin/);
    expect(pinsSvc).not.toMatch(/createAdminClient|service-role/);
  });

  it("updateTaskPin is ACTIVE-org + kind='task' pinned and count-gated", () => {
    const fn = pinsSvc.slice(pinsSvc.indexOf("export async function updateTaskPin"), pinsSvc.indexOf("export async function movePin"));
    expect(fn).toMatch(/\.eq\("org_id",\s*ctx\.org\.id\)/);
    expect(fn).toMatch(/\.eq\("kind",\s*"task"\)/);
    expect(fn).toMatch(/if \(!count\)/);
  });
});
