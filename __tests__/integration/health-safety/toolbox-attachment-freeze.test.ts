import { afterAll, beforeAll, expect, it } from "vitest";
import { describeIntegration, serviceClient } from "../_harness";

/**
 * Toolbox Talk attachment-evidence freeze (M5, 20261028). Proves the signed-sheet /
 * photo evidence attached to a DELIVERED talk is append-only for EVERY role: once the
 * talk leaves draft, its tenant_attachments rows cannot be deleted or repointed
 * (no silent Photo-A → Photo-B swap), but NEW files can still be added. A draft's
 * attachments stay fully mutable, and a non-toolbox target is untouched by the guard.
 */

type Res<T> = { data: T | null; error: { message: string; code?: string } | null };
type Row = Record<string, unknown>;
interface Sel extends PromiseLike<Res<Row[]>> { eq(c: string, v: unknown): Sel }
interface Upd extends PromiseLike<Res<null>> { eq(c: string, v: unknown): Upd }
interface Del extends PromiseLike<Res<null>> { eq(c: string, v: unknown): Del }
interface Ins extends PromiseLike<Res<Row[]>> { select(c?: string): { single(): PromiseLike<Res<Row>> } }
interface Table { select(c?: string): Sel; insert(r: Row | Row[]): Ins; update(v: Row): Upd; delete(): Del }
const db = (client: unknown) => client as unknown as { from(t: string): Table };
const T = `it-ttatt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describeIntegration("Toolbox Talk attachment freeze · DB invariants (20261028)", () => {
  let orgA = "", jobA = "", talk = "";
  const svc = () => db(serviceClient());

  const attach = (targetTable: string, targetId: string, name: string) =>
    svc().from("tenant_attachments").insert({
      org_id: orgA, target_table: targetTable, target_id: targetId,
      filename: name, storage_path: `${orgA}/${targetTable}/${targetId}/${name}`,
    }).select("id").single();

  beforeAll(async () => {
    orgA = String((await svc().from("organizations").insert({ name: "TT-Att", slug: `${T}-a` }).select("id").single()).data?.id);
    jobA = String((await svc().from("jobs").insert({ org_id: orgA, status: "new" }).select("id").single()).data?.id);
    talk = String((await svc().from("toolbox_talks").insert({ org_id: orgA, topic: "WAH", key_points: "edge protection" }).select("id").single()).data?.id);
  });
  afterAll(async () => {
    if (orgA) await svc().from("organizations").delete().eq("id", orgA);
  });

  it("a DRAFT talk's attachments are freely deletable", async () => {
    const a = await attach("toolbox_talks", talk, "draft-sheet.jpg");
    const id = String(a.data?.id);
    const del = await svc().from("tenant_attachments").delete().eq("id", id);
    expect(del.error, "a draft's evidence is mutable").toBeNull();
  });

  it("once DELIVERED, an attachment cannot be deleted, and cannot be repointed (append-only)", async () => {
    // attach the signed sheet, then deliver the talk
    const a = await attach("toolbox_talks", talk, "signed-sheet-A.jpg");
    const attId = String(a.data?.id);
    await svc().from("toolbox_talks").update({ status: "issued", reference: `TBT-${T}`, issued_at: new Date().toISOString() }).eq("id", talk);

    // DELETE Photo A → blocked
    const del = await svc().from("tenant_attachments").delete().eq("id", attId);
    expect(del.error?.message ?? "", "deleting delivered evidence must be blocked").toMatch(/frozen/i);

    // REPOINT storage_path (swap the bytes) → blocked
    const upd = await svc().from("tenant_attachments").update({ storage_path: `${orgA}/toolbox_talks/${talk}/signed-sheet-B.jpg` }).eq("id", attId);
    expect(upd.error?.message ?? "", "repointing delivered evidence must be blocked").toMatch(/frozen/i);

    // ADD a new file → allowed (append-only evidence)
    const b = await attach("toolbox_talks", talk, "extra-photo.jpg");
    expect(b.error, "adding evidence to a delivered talk is allowed").toBeNull();
  });

  it("the freeze governs ONLY toolbox talks — a job's attachments stay deletable", async () => {
    const a = await attach("jobs", jobA, "job-photo.jpg");
    const id = String(a.data?.id);
    const del = await svc().from("tenant_attachments").delete().eq("id", id);
    expect(del.error, "a non-toolbox target is not frozen").toBeNull();
  });
});
