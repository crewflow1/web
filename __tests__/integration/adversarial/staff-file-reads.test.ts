/* eslint-disable @typescript-eslint/no-explicit-any -- loose clients, see _fixture.ts */
/**
 * Same-company least privilege for STORED FILES (migration 20261354000000, founder ruling D-17).
 *
 * Before: any member of a company could read every object under the company's folder in seven
 * buckets straight from the Storage API, and every tenant_attachments row org-wide — so a staff
 * member could fetch attachments on invoices, quotes, suppliers, customers, leads and colleagues'
 * staff records. After: a file is readable by an owner/admin, or by a member who can see the
 * database row that references it under that table's own row-level security.
 *
 * Real GoTrue sessions against the local stack; synthetic organisations, cleaned up afterwards.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { as, createWorld, destroyWorld, svc, type World } from "./_fixture";
import { serviceClient } from "../_harness";

const BUCKET = "tenant-attachments";
const pdf = (marker: string) => Buffer.from(`%PDF-1.4\n% ${marker}\n`);

type Planted = { label: string; id: string; path: string };

describe("stored files follow record visibility (staff vs owner vs other company)", () => {
  let w: World | null = null;
  const planted: Record<string, Planted> = {};
  const paths: { bucket: string; path: string }[] = [];

  async function plantAttachment(label: string, targetTable: string, targetId: string, uploadedBy: string | null) {
    const world = w!;
    const path = `${world.A.id}/adv-files/${world.tag}-${label}.pdf`;
    const up = await serviceClient().storage.from(BUCKET).upload(path, pdf(`${world.tag}-${label}`), {
      contentType: "application/pdf",
      upsert: true,
    });
    if (up.error) throw new Error(`upload ${label}: ${up.error.message}`);
    paths.push({ bucket: BUCKET, path });
    const row = await svc()
      .from("tenant_attachments")
      .insert({
        org_id: world.A.id,
        target_table: targetTable,
        target_id: targetId,
        filename: `${label}.pdf`,
        storage_path: path,
        mime_type: "application/pdf",
        size_bytes: 20,
        uploaded_by: uploadedBy,
      })
      .select("id")
      .single();
    if (row.error || !row.data) throw new Error(`attachment row ${label}: ${row.error?.message}`);
    planted[label] = { label, id: (row.data as { id: string }).id, path };
  }

  beforeAll(async () => {
    w = await createWorld("secfiles");
    const A = w.A.id;
    const one = async (q: PromiseLike<{ data: any; error: any }>, what: string) => {
      const r = await q;
      if (r.error || !r.data) throw new Error(`${what}: ${r.error?.message}`);
      return r.data as { id: string };
    };
    const customer = await one(svc().from("customers").insert({ org_id: A, name: `Files customer ${w.tag}` }).select("id").single(), "customer");
    const supplier = await one(svc().from("suppliers").insert({ org_id: A, name: `Files supplier ${w.tag}`, payment_terms_days: 30 }).select("id").single(), "supplier");
    const assigned = await one(svc().from("jobs").insert({ org_id: A, customer_id: customer.id, assigned_to: w.A.staff.id }).select("id").single(), "assigned job");
    await svc().from("job_assignments").insert({ org_id: A, job_id: assigned.id, user_id: w.A.staff.id });
    const unassigned = await one(svc().from("jobs").insert({ org_id: A, customer_id: customer.id }).select("id").single(), "unassigned job");
    const staffMembership = await one(svc().from("memberships").select("id").eq("org_id", A).eq("user_id", w.A.staff.id).single(), "staff membership");
    const adminMembership = await one(svc().from("memberships").select("id").eq("org_id", A).eq("user_id", w.A.admin.id).single(), "admin membership");

    await plantAttachment("assigned-job", "jobs", assigned.id, w.A.owner.id);
    await plantAttachment("unassigned-job", "jobs", unassigned.id, w.A.owner.id);
    await plantAttachment("customer", "customers", customer.id, w.A.owner.id);
    await plantAttachment("supplier", "suppliers", supplier.id, w.A.owner.id);
    // invoice / quote ids need not resolve: these targets are owner/admin-only regardless.
    await plantAttachment("invoice", "invoices", crypto.randomUUID(), w.A.owner.id);
    await plantAttachment("own-staff-record", "memberships", staffMembership.id, w.A.owner.id);
    await plantAttachment("colleague-staff-record", "memberships", adminMembership.id, w.A.owner.id);
    await plantAttachment("staff-uploaded-on-unassigned", "jobs", unassigned.id, w.A.staff.id);
  }, 120_000);

  afterAll(async () => {
    for (const p of paths) await serviceClient().storage.from(p.bucket).remove([p.path]);
    await destroyWorld(w);
  }, 120_000);

  const STAFF_VISIBLE = ["assigned-job", "own-staff-record", "staff-uploaded-on-unassigned"];
  const STAFF_HIDDEN = ["unassigned-job", "customer", "supplier", "invoice", "colleague-staff-record"];

  async function rowVisible(token: string, label: string): Promise<boolean> {
    const r = await as(token).from("tenant_attachments").select("id").eq("id", planted[label]!.id);
    expect(r.error, `row read ${label}`).toBeNull();
    return (r.data ?? []).length === 1;
  }

  async function objectReadable(token: string, label: string): Promise<boolean> {
    const r = await as(token).storage.from(BUCKET).download(planted[label]!.path);
    return r.error === null && r.data !== null;
  }

  it("staff see attachment rows only on records they may see (assigned job, own staff record, own uploads)", async () => {
    const staff = w!.A.staff.token;
    for (const l of STAFF_VISIBLE) expect(await rowVisible(staff, l), `staff should see ${l}`).toBe(true);
    for (const l of STAFF_HIDDEN) expect(await rowVisible(staff, l), `staff must NOT see ${l}`).toBe(false);
  });

  it("staff cannot download files on commercial, customer, unassigned or colleagues' records straight from Storage", async () => {
    const staff = w!.A.staff.token;
    for (const l of STAFF_VISIBLE) expect(await objectReadable(staff, l), `staff should download ${l}`).toBe(true);
    for (const l of STAFF_HIDDEN) expect(await objectReadable(staff, l), `staff must NOT download ${l}`).toBe(false);
  });

  it("staff cannot enumerate the company's attachment folder", async () => {
    const listed = await as(w!.A.staff.token).storage.from(BUCKET).list(`${w!.A.id}/adv-files`);
    const names = (listed.data ?? []).map((o: { name: string }) => o.name);
    for (const l of STAFF_HIDDEN) expect(names.some((n) => n.includes(`-${l}.pdf`)), `listing exposes ${l}`).toBe(false);
  });

  it("owner and admin keep full access (positive control)", async () => {
    for (const token of [w!.A.owner.token, w!.A.admin.token]) {
      for (const l of [...STAFF_VISIBLE, ...STAFF_HIDDEN]) {
        expect(await rowVisible(token, l), `admin row ${l}`).toBe(true);
        expect(await objectReadable(token, l), `admin object ${l}`).toBe(true);
      }
    }
  });

  it("another company's owner sees nothing", async () => {
    for (const l of [...STAFF_VISIBLE, ...STAFF_HIDDEN]) {
      expect(await rowVisible(w!.B.owner.token, l), `org B row ${l}`).toBe(false);
      expect(await objectReadable(w!.B.owner.token, l), `org B object ${l}`).toBe(false);
    }
  });

  it("receipts follow the finance row: staff cannot download a company finance receipt; the owner can", async () => {
    const world = w!;
    const path = `${world.A.id}/adv-files/${world.tag}-receipt.pdf`;
    const up = await serviceClient().storage.from("receipts").upload(path, pdf(`${world.tag}-receipt`), {
      contentType: "application/pdf",
      upsert: true,
    });
    if (up.error) throw new Error(`receipt upload: ${up.error.message}`);
    paths.push({ bucket: "receipts", path });
    const fin = await svc()
      .from("finances")
      .insert({ org_id: world.A.id, amount: 12.5, category: "materials", receipt_url: path })
      .select("id")
      .single();
    if (fin.error) throw new Error(`finance row: ${fin.error.message}`);
    const staffRead = await as(world.A.staff.token).storage.from("receipts").download(path);
    expect(staffRead.data, "staff must NOT download a finance receipt").toBeNull();
    const ownerRead = await as(world.A.owner.token).storage.from("receipts").download(path);
    expect(ownerRead.error, "owner downloads the receipt").toBeNull();
    const otherOrg = await as(world.B.owner.token).storage.from("receipts").download(path);
    expect(otherOrg.data, "org B must NOT download org A's receipt").toBeNull();
  });

  it("no bucket keeps a bare company-folder read: an object with no referencing row is admin-only in every member-readable bucket", async () => {
    const world = w!;
    for (const bucket of ["tenant-attachments", "compliance-docs", "receipts", "signatures", "job-docs", "whatsapp-media", "blueprints"]) {
      // Some buckets restrict MIME types; try PNG then PDF.
      const PNG_1PX = Buffer.from(
        "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4e20000000049454e44ae426082",
        "hex",
      );
      let path = "";
      for (const c of [
        { ext: "png", type: "image/png", bytes: PNG_1PX },
        { ext: "pdf", type: "application/pdf", bytes: pdf(`${world.tag}-${bucket}`) },
      ]) {
        const candidate = `${world.A.id}/adv-files/${world.tag}-orphan.${c.ext}`;
        const up = await serviceClient().storage.from(bucket).upload(candidate, c.bytes, { contentType: c.type, upsert: true });
        if (!up.error) {
          path = candidate;
          break;
        }
      }
      expect(path, `could not plant an object in ${bucket} (test would be vacuous)`).not.toBe("");
      paths.push({ bucket, path });
      const staffRead = await as(world.A.staff.token).storage.from(bucket).download(path);
      expect(staffRead.data, `${bucket}: staff must NOT read an unreferenced company object`).toBeNull();
      const ownerRead = await as(world.A.owner.token).storage.from(bucket).download(path);
      expect(ownerRead.error, `${bucket}: owner reads it (positive control)`).toBeNull();
    }
  });

  it("one row per stored object: a staff member cannot add a second row pointing at a file they may not see (and so cannot read it)", async () => {
    const world = w!;
    const staff = as(world.A.staff.token);
    const assignedJob = await svc().from("tenant_attachments").select("target_id").eq("id", planted["assigned-job"]!.id).single();
    const forged = await staff.from("tenant_attachments").insert({
      org_id: world.A.id,
      target_table: "jobs",
      target_id: (assignedJob.data as { target_id: string }).target_id,
      filename: "forged.pdf",
      storage_path: planted["invoice"]!.path,
      mime_type: "application/pdf",
      size_bytes: 20,
      uploaded_by: world.A.staff.id,
    });
    expect(forged.error, "a duplicate storage_path must be refused").not.toBeNull();
    expect(await objectReadable(world.A.staff.token, "invoice"), "the invoice file stays unreadable").toBe(false);
  });

  it("attachments on assets (column-granted table) evaluate without error and follow asset visibility", async () => {
    const world = w!;
    const asset = await svc().from("assets").insert({ org_id: world.A.id, name: `Files asset ${world.tag}` }).select("id").single();
    if (asset.error || !asset.data) throw new Error(`asset: ${asset.error?.message}`);
    const assetId = (asset.data as { id: string }).id;
    await plantAttachment("asset-photo", "assets", assetId, world.A.owner.id);
    const staff = as(world.A.staff.token);
    const staffSeesAsset = ((await staff.from("assets").select("id").eq("id", assetId)).data ?? []).length === 1;
    // The whole-table read must not error (the visibility probe reads only assets.id).
    const list = await staff.from("tenant_attachments").select("id").eq("org_id", world.A.id);
    expect(list.error, "listing attachments as staff must not error").toBeNull();
    expect(await rowVisible(world.A.staff.token, "asset-photo")).toBe(staffSeesAsset);
    expect(await objectReadable(world.A.staff.token, "asset-photo")).toBe(staffSeesAsset);
  });
});
