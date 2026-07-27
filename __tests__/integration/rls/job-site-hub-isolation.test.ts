import { afterAll, beforeAll, expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient, userClient } from "../_harness";
import {
  gatherJobDiary,
  gatherJobSiteSources,
  gatherJobSnags,
  type SiteHubClient,
} from "@/server/services/job-site-hub";
import { composeSiteTimeline } from "@/lib/site-ops/timeline";

/**
 * Job Site Hub — tenant + job scoping against REAL Postgres.
 *
 * The hub composes eight tables into one job view, so the thing that must be
 * proved is not "RLS exists" (each vertical already proves that) but that the
 * hub's OWN reads cannot widen it. Two failure modes are targeted:
 *
 *   1. ORG BLEND. `current_org_ids()` returns EVERY org the viewer belongs to,
 *      so a bare RLS read serves BOTH orgs' rows to a dual-org member. The
 *      probe user here is a member of org A AND org B precisely so an
 *      unpinned read would fail this suite.
 *   2. JOB BLEED. A second job inside the SAME org must not appear in the
 *      first job's hub.
 *
 * Plus a paging proof: the fixture is read back with a forced page size of 2 so
 * the reads genuinely cross page boundaries, catching the drop/duplicate bug
 * that a non-unique sort order causes.
 *
 * Residue-independent: every fixture is namespaced by a per-run TOKEN and every
 * assertion is made against ids created by THIS run, so a dirty database (or a
 * concurrent suite) cannot make it pass or fail spuriously.
 */

type Res<T> = { data: T | null; error: { message: string } | null };
type Row = Record<string, unknown>;
interface Sel extends PromiseLike<Res<Row[]>> {
  eq(c: string, v: unknown): Sel;
}
interface Ins extends PromiseLike<Res<Row[]>> {
  select(c?: string): { single(): PromiseLike<Res<Row>> };
}
interface Del {
  eq(c: string, v: unknown): PromiseLike<Res<null>>;
}
interface Table {
  select(c?: string): Sel;
  insert(r: Row | Row[]): Ins;
  delete(): Del;
}
const db = (client: unknown) => client as unknown as { from(t: string): Table };

const TOKEN = `it-hub-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const PAGE = 2; // force real page boundaries on a tiny fixture

async function insId(svc: ReturnType<typeof db>, table: string, row: Row): Promise<string> {
  const res = await svc.from(table).insert(row).select("id").single();
  expect(res.error, `${table}: ${res.error?.message}`).toBeNull();
  const id = String(res.data?.id ?? "");
  if (!id) throw new Error(`failed to insert into ${table}`);
  return id;
}

async function mkUser(suffix: string, orgIds: string[]): Promise<{ id: string; token: string }> {
  const email = `${TOKEN}-${suffix}@example.test`;
  const password = `Pw-${TOKEN}-${Math.random().toString(36).slice(2)}`;
  const created = await serviceClient().auth.admin.createUser({ email, password, email_confirm: true });
  expect(created.error, created.error?.message).toBeNull();
  const id = created.data.user?.id ?? "";
  await db(serviceClient()).from("users").insert({ id, email, full_name: email });
  for (const orgId of orgIds) {
    const m = await db(serviceClient()).from("memberships").insert({ org_id: orgId, user_id: id, role: "owner" });
    expect(m.error, m.error?.message).toBeNull();
  }
  const token =
    (await anonClient().auth.signInWithPassword({ email, password })).data.session?.access_token ?? "";
  if (!id || !token) throw new Error(`failed to make user ${suffix}`);
  return { id, token };
}

/** Every row id the hub surfaced, flattened — the set we assert isolation over. */
function allIds(sources: Awaited<ReturnType<typeof gatherJobSiteSources>>): string[] {
  return [
    ...sources.diary.map((r) => r.id),
    ...sources.snags.map((r) => r.id),
    ...sources.toolbox.map((r) => r.id),
    ...sources.rams.map((r) => r.id),
    ...sources.permits.map((r) => r.id),
    ...sources.inspections.map((r) => r.id),
    ...sources.documents.map((r) => r.id),
    ...sources.attachments.map((r) => r.id),
    ...[...sources.assetNames.keys()],
  ];
}

describeIntegration("job site hub · org + job scoping (RLS)", () => {
  const svc = db(serviceClient());

  let orgA = "";
  let orgB = "";
  let jobA = "";
  let jobA2 = "";
  let jobB = "";

  // Everything seeded for org A / job A — the exact set the hub must return.
  const expectedA = {
    diary: [] as string[],
    snags: [] as string[],
    toolbox: [] as string[],
    rams: [] as string[],
    permits: [] as string[],
    inspections: [] as string[],
    documents: [] as string[],
    attachments: [] as string[],
  };
  // Ids seeded elsewhere (org B, or job A2) — none may ever appear in job A's hub.
  const forbidden: string[] = [];

  /** Member of BOTH orgs — the multi-org blend probe. */
  let dual = { id: "", token: "" };
  /** Member of org B only — must see nothing of job A. */
  let outsider = { id: "", token: "" };

  beforeAll(async () => {
    orgA = await insId(svc, "organizations", { name: "Hub A", slug: `${TOKEN}-a` });
    orgB = await insId(svc, "organizations", { name: "Hub B", slug: `${TOKEN}-b` });
    jobA = await insId(svc, "jobs", { org_id: orgA, status: "in-progress" });
    jobA2 = await insId(svc, "jobs", { org_id: orgA, status: "in-progress" });
    jobB = await insId(svc, "jobs", { org_id: orgB, status: "in-progress" });

    // ── org A / job A: >PAGE rows for the paged entities ────────────────────
    for (const day of ["2026-07-16", "2026-07-17", "2026-07-18", "2026-07-19", "2026-07-20"]) {
      expectedA.diary.push(
        await insId(svc, "site_diary_entries", {
          org_id: orgA,
          job_id: jobA,
          entry_date: day,
          work_summary: `${TOKEN} work ${day}`,
          delays: day === "2026-07-18" ? "Concrete late" : null,
        }),
      );
    }
    expectedA.snags.push(
      await insId(svc, "snags", { org_id: orgA, job_id: jobA, title: `${TOKEN} open high`, priority: "high" }),
      await insId(svc, "snags", { org_id: orgA, job_id: jobA, title: `${TOKEN} open low`, priority: "low" }),
      await insId(svc, "snags", {
        org_id: orgA,
        job_id: jobA,
        title: `${TOKEN} verified`,
        status: "verified",
        resolved_at: "2026-07-19T10:00:00Z",
      }),
    );
    expectedA.toolbox.push(
      await insId(svc, "toolbox_talks", {
        org_id: orgA,
        job_id: jobA,
        topic: `${TOKEN} working at height`,
        talk_date: "2026-07-18",
        attendee_count: 7,
      }),
    );
    expectedA.rams.push(
      await insId(svc, "risk_assessments", {
        org_id: orgA,
        job_id: jobA,
        title: `${TOKEN} roof works`,
        activity: "Tiling",
      }),
    );
    expectedA.permits.push(
      await insId(svc, "permits_to_work", {
        org_id: orgA,
        job_id: jobA,
        permit_type: "hot_works",
        title: `${TOKEN} hot works`,
        scope: "Welding, plot 4",
      }),
    );
    expectedA.documents.push(
      await insId(svc, "job_documents", { org_id: orgA, job_id: jobA, visibility: "staff", title: `${TOKEN} EICR` }),
    );

    const assetA = await insId(svc, "assets", { org_id: orgA, name: `${TOKEN} telehandler` });
    await insId(svc, "asset_assignments", {
      org_id: orgA,
      job_id: jobA,
      asset_id: assetA,
      assignment_type: "allocated_to_job",
    });
    expectedA.inspections.push(
      await insId(svc, "asset_inspections", {
        org_id: orgA,
        asset_id: assetA,
        title: `${TOKEN} pre-use`,
        kind: "pre_use",
        inspected_at: "2026-07-17T07:00:00Z",
      }),
    );
    expectedA.attachments.push(
      await insId(svc, "tenant_attachments", {
        org_id: orgA,
        target_table: "jobs",
        target_id: jobA,
        filename: `${TOKEN}-site.jpg`,
        mime_type: "image/jpeg",
        storage_path: `${orgA}/jobs/${jobA}/${TOKEN}-site.jpg`,
      }),
      await insId(svc, "tenant_attachments", {
        org_id: orgA,
        target_table: "site_diary_entries",
        target_id: expectedA.diary[0]!,
        filename: `${TOKEN}-note.pdf`,
        mime_type: "application/pdf",
        storage_path: `${orgA}/site_diary_entries/${expectedA.diary[0]}/${TOKEN}-note.pdf`,
      }),
    );

    // ── org A / job A2 — same org, different job. Must never leak into job A ──
    forbidden.push(
      await insId(svc, "site_diary_entries", { org_id: orgA, job_id: jobA2, entry_date: "2026-07-18" }),
      await insId(svc, "snags", { org_id: orgA, job_id: jobA2, title: `${TOKEN} other job snag` }),
      await insId(svc, "job_documents", { org_id: orgA, job_id: jobA2, visibility: "staff", title: `${TOKEN} other doc` }),
    );

    // ── org B / job B — the blend probe's other tenancy ──────────────────────
    forbidden.push(
      await insId(svc, "site_diary_entries", { org_id: orgB, job_id: jobB, entry_date: "2026-07-18" }),
      await insId(svc, "snags", { org_id: orgB, job_id: jobB, title: `${TOKEN} org B snag`, priority: "high" }),
      await insId(svc, "toolbox_talks", { org_id: orgB, job_id: jobB, topic: `${TOKEN} org B talk` }),
      await insId(svc, "risk_assessments", { org_id: orgB, job_id: jobB, title: `${TOKEN} org B RA`, activity: "x" }),
      await insId(svc, "permits_to_work", {
        org_id: orgB,
        job_id: jobB,
        permit_type: "general",
        title: `${TOKEN} org B permit`,
        scope: "x",
      }),
      await insId(svc, "job_documents", { org_id: orgB, job_id: jobB, visibility: "staff", title: `${TOKEN} org B doc` }),
      await insId(svc, "tenant_attachments", {
        org_id: orgB,
        target_table: "jobs",
        target_id: jobB,
        filename: `${TOKEN}-orgB.jpg`,
        mime_type: "image/jpeg",
        storage_path: `${orgB}/jobs/${jobB}/${TOKEN}-orgB.jpg`,
      }),
    );

    dual = await mkUser("dual", [orgA, orgB]);
    outsider = await mkUser("outsider", [orgB]);
  });

  afterAll(async () => {
    for (const orgId of [orgA, orgB]) {
      if (orgId) await svc.from("organizations").delete().eq("id", orgId);
    }
    for (const u of [dual, outsider]) {
      if (u.id) await serviceClient().auth.admin.deleteUser(u.id);
    }
  });

  it("returns exactly the requesting org's job rows for a DUAL-ORG member", async () => {
    const client = userClient(dual.token) as unknown as SiteHubClient;
    const sources = await gatherJobSiteSources(client, orgA, jobA, PAGE);

    expect([...sources.diary.map((r) => r.id)].sort()).toEqual([...expectedA.diary].sort());
    expect([...sources.snags.map((r) => r.id)].sort()).toEqual([...expectedA.snags].sort());
    expect(sources.toolbox.map((r) => r.id)).toEqual(expectedA.toolbox);
    expect(sources.rams.map((r) => r.id)).toEqual(expectedA.rams);
    expect(sources.permits.map((r) => r.id)).toEqual(expectedA.permits);
    expect(sources.documents.map((r) => r.id)).toEqual(expectedA.documents);
    expect(sources.inspections.map((r) => r.id)).toEqual(expectedA.inspections);
    expect([...sources.attachments.map((r) => r.id)].sort()).toEqual([...expectedA.attachments].sort());
  });

  it("leaks NOTHING from the member's other org, nor from another job in the same org", async () => {
    const client = userClient(dual.token) as unknown as SiteHubClient;
    const sources = await gatherJobSiteSources(client, orgA, jobA, PAGE);
    const seen = new Set(allIds(sources));
    for (const id of forbidden) expect(seen.has(id), `leaked ${id}`).toBe(false);
  });

  it("serves org B's own job correctly to the same dual-org member (no cross-contamination either way)", async () => {
    const client = userClient(dual.token) as unknown as SiteHubClient;
    const sources = await gatherJobSiteSources(client, orgB, jobB, PAGE);
    const seen = new Set(allIds(sources));
    // Org B's fixtures are present…
    expect(sources.snags).toHaveLength(1);
    expect(sources.diary).toHaveLength(1);
    // …and none of org A's job-A rows are.
    for (const id of Object.values(expectedA).flat()) expect(seen.has(id), `leaked ${id}`).toBe(false);
  });

  /**
   * THE org-pin proof. A dual-org member's RLS permits org A's rows, so if the
   * hub asked only `.eq("job_id", …)` this call — "render job A's panels while
   * the active org is B" — would happily serve org A's site data inside org B's
   * context. The explicit `.eq("org_id", …)` is the only thing that stops it.
   * Delete that pin and this test goes red.
   */
  it("returns NOTHING when the active org does not own the job (dual-org member)", async () => {
    const client = userClient(dual.token) as unknown as SiteHubClient;
    const sources = await gatherJobSiteSources(client, orgB, jobA, PAGE);
    expect(allIds(sources)).toEqual([]);
    expect(await gatherJobDiary(client, orgB, jobA, PAGE)).toEqual([]);
    expect(await gatherJobSnags(client, orgB, jobA, PAGE)).toEqual([]);
  });

  it("shows a member of the OTHER org nothing at all for this job", async () => {
    const client = userClient(outsider.token) as unknown as SiteHubClient;
    const sources = await gatherJobSiteSources(client, orgA, jobA, PAGE);
    expect(allIds(sources)).toEqual([]);
    expect(await gatherJobDiary(client, orgA, jobA, PAGE)).toEqual([]);
    expect(await gatherJobSnags(client, orgA, jobA, PAGE)).toEqual([]);
  });

  it("denies an unauthenticated (anon) caller", async () => {
    const client = anonClient() as unknown as SiteHubClient;
    expect(allIds(await gatherJobSiteSources(client, orgA, jobA, PAGE))).toEqual([]);
  });

  it("pages a job-scoped read without dropping or duplicating rows", async () => {
    const client = userClient(dual.token) as unknown as SiteHubClient;
    // 5 diary entries read 2 at a time → 3 pages, two real boundaries.
    const diary = await gatherJobDiary(client, orgA, jobA, PAGE);
    const ids = diary.map((r) => r.id);
    expect(ids).toHaveLength(expectedA.diary.length);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual([...expectedA.diary].sort());
    // Ordered by the unique primary key, so paging is stable and repeatable.
    expect(ids).toEqual([...ids].sort());
    expect((await gatherJobDiary(client, orgA, jobA, PAGE)).map((r) => r.id)).toEqual(ids);
  });

  it("composes a timeline containing only this job's rows", async () => {
    const client = userClient(dual.token) as unknown as SiteHubClient;
    const sources = await gatherJobSiteSources(client, orgA, jobA, PAGE);
    const events = composeSiteTimeline({ now: new Date("2026-07-21T00:00:00Z"), jobId: jobA, ...sources });

    expect(events.length).toBeGreaterThan(0);
    const allowed = new Set(Object.values(expectedA).flat());
    for (const e of events) expect(allowed.has(e.sourceId), `unexpected source ${e.sourceId}`).toBe(true);
    // Newest first, and every kind that was seeded is represented.
    expect(events.map((e) => e.at)).toEqual([...events.map((e) => e.at)].sort().reverse());
    expect(new Set(events.map((e) => e.kind))).toContain("snag_resolved");
    expect(new Set(events.map((e) => e.kind))).toContain("photo");
    expect(new Set(events.map((e) => e.kind))).toContain("inspection");
  });

  it("gatherJobSnags is org- and job-pinned for the dual-org member", async () => {
    const client = userClient(dual.token) as unknown as SiteHubClient;
    const rows = await gatherJobSnags(client, orgA, jobA, PAGE);
    expect([...rows.map((r) => r.id)].sort()).toEqual([...expectedA.snags].sort());
  });
});
