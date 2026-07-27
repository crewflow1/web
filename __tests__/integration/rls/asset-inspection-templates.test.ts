import { afterAll, beforeAll, expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient } from "../_harness";

/**
 * Inspection templates — real-Postgres proof (20260929000000).
 *
 * Proves the M4b-1 invariants against a live database. Triggers + indexes fire
 * for every role, so service_role is a faithful proxy; RLS is proven with anon:
 *   - VERSION IDENTITY: (family_id, version) unique;
 *   - ONE PUBLISHED VERSION per family (partial unique index);
 *   - PUBLISHED SUBSTANCE FROZEN: definition can't change once non-draft
 *     (drafts stay editable);
 *   - PUBLISH INTEGRITY: can't publish an empty definition;
 *   - ATOMIC PUBLISH RPC: supersedes the old published + publishes the draft in
 *     one transaction; refuses a non-draft;
 *   - INSPECTION LINKAGE: template_id / template_version / template_snapshot
 *     are WRITE-ONCE on asset_inspections; cross-org template refs rejected;
 *   - HISTORY PRESERVED: publishing a new version never alters an existing
 *     inspection's frozen snapshot;
 *   - RLS: anon reads nothing.
 */

type Res<T> = { data: T | null; error: { message: string; code?: string } | null };
type Row = Record<string, unknown>;
interface Q extends PromiseLike<Res<Row[]>> {
  eq(k: string, v: unknown): Q;
  maybeSingle(): PromiseLike<Res<Row>>;
  single(): PromiseLike<Res<Row>>;
}
interface Upd extends PromiseLike<Res<Row[]>> {
  eq(k: string, v: unknown): Upd;
}
interface Ins extends PromiseLike<Res<Row[]>> {
  select(c?: string): { single(): PromiseLike<Res<Row>> };
}
interface Del extends PromiseLike<Res<null>> {
  eq(k: string, v: unknown): Del;
}
interface Table {
  select(c?: string): Q;
  insert(r: Row | Row[]): Ins;
  update(r: Row): Upd;
  delete(): Del;
}
interface Client {
  from(t: string): Table;
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<Res<unknown>>;
}
const db = (c: unknown) => c as unknown as Client;

const TAG = `it-tmpl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const DEF = {
  sections: [
    {
      key: "s1",
      title: "Checks",
      items: [
        {
          key: "brakes",
          prompt: "Brakes function",
          response_type: "pass_fail",
          required: true,
          safety_critical: true,
          severity: "minor",
          allow_na: false,
          requires_photo: false,
          requires_photo_on_fail: false,
          requires_comment_on_fail: true,
          requires_signature: false,
        },
      ],
    },
  ],
};

async function mkOrg(slug: string): Promise<string> {
  const { data, error } = await db(serviceClient())
    .from("organizations").insert({ name: `Tmpl ${slug}`, slug: `${TAG}-${slug}` }).select("id").single();
  expect(error, error?.message).toBeNull();
  return String(data?.id ?? "");
}
async function mkAsset(org: string): Promise<string> {
  const { data, error } = await db(serviceClient())
    .from("assets").insert({ org_id: org, name: "templated asset" }).select("id").single();
  expect(error, error?.message).toBeNull();
  return String(data?.id ?? "");
}
async function mkTemplate(org: string, family: string, version: number, status: string, definition: unknown = DEF) {
  return db(serviceClient())
    .from("asset_inspection_templates")
    .insert({ org_id: org, family_id: family, version, name: `T ${version}`, status, definition })
    .select("id")
    .single();
}

describeIntegration("asset_inspection_templates · versioning + immutability + linkage", () => {
  let orgA = "";
  let orgB = "";
  let assetA = "";

  beforeAll(async () => {
    orgA = await mkOrg("a");
    orgB = await mkOrg("b");
    assetA = await mkAsset(orgA);
  });

  afterAll(async () => {
    if (orgA) await db(serviceClient()).from("organizations").delete().eq("id", orgA);
    if (orgB) await db(serviceClient()).from("organizations").delete().eq("id", orgB);
  });

  it("enforces (family_id, version) uniqueness", async () => {
    const fam = crypto.randomUUID();
    const first = await mkTemplate(orgA, fam, 1, "draft");
    expect(first.error, first.error?.message).toBeNull();
    const dup = await mkTemplate(orgA, fam, 1, "draft");
    expect(dup.error?.code).toBe("23505");
  });

  it("enforces ONE PUBLISHED version per family (partial unique index)", async () => {
    const fam = crypto.randomUUID();
    const v1 = await mkTemplate(orgA, fam, 1, "published");
    expect(v1.error, v1.error?.message).toBeNull();
    const v2 = await mkTemplate(orgA, fam, 2, "published");
    expect(v2.error?.code).toBe("23505");
  });

  it("freezes a published definition; drafts stay editable", async () => {
    const fam = crypto.randomUUID();
    const pub = await mkTemplate(orgA, fam, 1, "published");
    const pubId = String(pub.data?.id);
    const frozen = await db(serviceClient())
      .from("asset_inspection_templates")
      .update({ definition: { sections: [] } })
      .eq("id", pubId);
    expect(frozen.error?.message ?? "").toMatch(/frozen once published/i);

    const draft = await mkTemplate(orgA, fam, 2, "draft");
    const draftId = String(draft.data?.id);
    const edited = await db(serviceClient())
      .from("asset_inspection_templates")
      .update({ definition: DEF })
      .eq("id", draftId);
    expect(edited.error, edited.error?.message).toBeNull();
  });

  it("refuses to publish an empty definition (DB backstop)", async () => {
    const fam = crypto.randomUUID();
    const draft = await mkTemplate(orgA, fam, 1, "draft", { sections: [] });
    const draftId = String(draft.data?.id);
    const bad = await db(serviceClient())
      .from("asset_inspection_templates")
      .update({ status: "published" })
      .eq("id", draftId);
    expect(bad.error?.message ?? "").toMatch(/empty definition/i);
  });

  it("publish RPC atomically supersedes the old published version", async () => {
    const fam = crypto.randomUUID();
    const v1 = await mkTemplate(orgA, fam, 1, "published");
    const v1Id = String(v1.data?.id);
    const v2 = await mkTemplate(orgA, fam, 2, "draft");
    const v2Id = String(v2.data?.id);

    const rpc = await db(serviceClient()).rpc("publish_inspection_template", {
      p_template_id: v2Id,
      p_org_id: orgA,
      p_user: null,
    });
    expect(rpc.error, rpc.error?.message).toBeNull();

    const { data: after } = await db(serviceClient())
      .from("asset_inspection_templates")
      .select("id, status")
      .eq("family_id", fam);
    const byId = new Map((after ?? []).map((r) => [r.id, r.status]));
    expect(byId.get(v1Id)).toBe("superseded");
    expect(byId.get(v2Id)).toBe("published");
  });

  it("publish RPC refuses a non-draft", async () => {
    const fam = crypto.randomUUID();
    const pub = await mkTemplate(orgA, fam, 1, "published");
    const rpc = await db(serviceClient()).rpc("publish_inspection_template", {
      p_template_id: String(pub.data?.id),
      p_org_id: orgA,
      p_user: null,
    });
    expect(rpc.error?.message ?? "").toMatch(/only a draft/i);
  });

  it("makes an inspection's template linkage WRITE-ONCE", async () => {
    const fam = crypto.randomUUID();
    const tpl = await mkTemplate(orgA, fam, 1, "published");
    const tplId = String(tpl.data?.id);
    const snap = { template_id: tplId, family_id: fam, version: 1, name: "T 1", check_level: "pre_use_check", sections: DEF.sections };

    const insp = await db(serviceClient()).from("asset_inspections").insert({
      org_id: orgA, asset_id: assetA, title: "Templated", status: "draft",
      template_id: tplId, template_version: 1, template_snapshot: snap,
    }).select("id").single();
    expect(insp.error, insp.error?.message).toBeNull();
    const inspId = String(insp.data?.id);

    const reSnap = await db(serviceClient())
      .from("asset_inspections").update({ template_snapshot: { tampered: true } }).eq("id", inspId);
    expect(reSnap.error?.message ?? "").toMatch(/template_snapshot is immutable/i);

    const reVersion = await db(serviceClient())
      .from("asset_inspections").update({ template_version: 99 }).eq("id", inspId);
    expect(reVersion.error?.message ?? "").toMatch(/template_version is immutable/i);
  });

  it("rejects an inspection referencing another org's template", async () => {
    const famB = crypto.randomUUID();
    const tplB = await mkTemplate(orgB, famB, 1, "published");
    const bad = await db(serviceClient()).from("asset_inspections").insert({
      org_id: orgA, asset_id: assetA, title: "Cross-org", status: "draft",
      template_id: String(tplB.data?.id), template_version: 1,
    }).select("id").single();
    expect(bad.error?.message ?? "").toMatch(/not in org/i);
  });

  it("publishing a NEW version never alters an existing inspection's snapshot", async () => {
    const fam = crypto.randomUUID();
    const v1 = await mkTemplate(orgA, fam, 1, "published");
    const v1Id = String(v1.data?.id);
    const snap = { template_id: v1Id, family_id: fam, version: 1, name: "T 1", check_level: "pre_use_check", sections: DEF.sections };
    const insp = await db(serviceClient()).from("asset_inspections").insert({
      org_id: orgA, asset_id: assetA, title: "Historic", status: "draft",
      template_id: v1Id, template_version: 1, template_snapshot: snap,
    }).select("id").single();
    const inspId = String(insp.data?.id);

    const v2 = await mkTemplate(orgA, fam, 2, "draft", {
      sections: [{ key: "s2", title: "Rewritten", items: DEF.sections[0]!.items }],
    });
    const rpc = await db(serviceClient()).rpc("publish_inspection_template", {
      p_template_id: String(v2.data?.id),
      p_org_id: orgA,
      p_user: null,
    });
    expect(rpc.error, rpc.error?.message).toBeNull();

    const { data: after } = await db(serviceClient())
      .from("asset_inspections").select("template_snapshot, template_version").eq("id", inspId).single();
    expect(after?.template_version).toBe(1);
    expect(after?.template_snapshot).toEqual(snap);
  });

  it("rejects a cross-org supersedes reference (same-org guard)", async () => {
    const famB = crypto.randomUUID();
    const tplB = await mkTemplate(orgB, famB, 1, "draft");
    const bad = await db(serviceClient()).from("asset_inspection_templates").insert({
      org_id: orgA, family_id: crypto.randomUUID(), version: 1, name: "Bad lineage",
      status: "draft", definition: DEF, supersedes_id: String(tplB.data?.id),
    }).select("id").single();
    expect(bad.error?.message ?? "").toMatch(/not in org/i);
  });

  it("denies anon (RLS)", async () => {
    const fam = crypto.randomUUID();
    const tpl = await mkTemplate(orgA, fam, 1, "published");
    const { data, error } = await db(anonClient())
      .from("asset_inspection_templates")
      .select("id")
      .eq("id", String(tpl.data?.id));
    expect(error, error?.message).toBeNull();
    expect(data ?? []).toHaveLength(0);
  });
});
