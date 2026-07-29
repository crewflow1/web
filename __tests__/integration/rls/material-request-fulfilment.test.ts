import { afterAll, beforeAll, expect, it, describe } from "vitest";
import { anonClient, describeIntegration, serviceClient, userClient } from "../_harness";
import {
  readIssuedForLines,
  reconcileRequestFulfilment,
  reconcileFulfilmentForMovement,
  issueStockToRequestLine,
  type StockSeamClient,
} from "@/server/services/material-fulfilment";
import { computeMaterialFulfilment } from "@/lib/material-requests/fulfilment";

/**
 * THE JOINED JOURNEY — material requests fulfilled from operational stock,
 * against real Postgres (migrations 20261063–69).
 *
 * This is the seam the two lanes deferred to release time. Each lane shipped a
 * frozen half:
 *   · the STOCK lane writes an issue movement carrying an opaque
 *     material_request_line_id (record_stock_issue), and reverses it with a
 *     `correction` that does NOT copy that id;
 *   · the M4 lane derives fulfilment from those movements and advances the
 *     request through ONE guarded RPC (advance_material_request_fulfilment),
 *     but deliberately did not write the derivation in SQL — it could not see
 *     the stock schema.
 *
 * The join is server/services/material-fulfilment.ts: readIssuedForLines is the
 * corrections-EXCLUDING derivation, and issueStockToRequestLine /
 * reconcileFulfilmentForMovement drive the advance. The proofs here:
 *
 *   1. FULL JOURNEY — partial → fulfilled, provenance and activity feed intact.
 *   2. THE CORRECTED ISSUE (the reason this lane exists) — a reversed issue is
 *      EXCLUDED from the derivation, so the line returns to outstanding and the
 *      request comes off 'fulfilled' rather than lying that a stripped site is
 *      stocked. A naive sum over movement_type='issue' would over-report.
 *   3. OVER-ISSUE — 15 against a request for 10 reads fulfilled, outstanding 0,
 *      never 150% and never −5; the movement stays truthful at 15.
 *   4. CROSS-ORG — a crafted org-B issue carrying org-A's line id is WRITABLE
 *      (the linkage column has no FK, by contract) but never counts for org A,
 *      because the seam pins the active org.
 *
 * Dual-org throughout: the admin belongs to A AND B, so RLS admits both — the
 * active-org pin is what makes "the company I am working in" real.
 */

type Res<T> = { data: T | null; error: { message: string; code?: string } | null };
type Row = Record<string, unknown>;
interface Sel extends PromiseLike<Res<Row[]>> {
  select(columns?: string): Sel;
  eq(column: string, value: unknown): Sel;
  in(column: string, value: readonly unknown[]): Sel;
  order(column: string, opts: { ascending: boolean }): Sel;
  maybeSingle(): PromiseLike<Res<Row>>;
}
interface Ins extends PromiseLike<Res<Row[]>> {
  select(columns?: string): { single(): PromiseLike<Res<Row>> };
}
interface Upd extends PromiseLike<Res<null>> {
  eq(column: string, value: unknown): Upd;
}
interface Table {
  select(columns?: string): Sel;
  insert(rows: Row | Row[]): Ins;
  update(patch: Row): Upd;
  delete(): Upd;
}
const db = (client: unknown) => client as unknown as { from(t: string): Table };
const rpc = (client: unknown) =>
  client as unknown as {
    rpc(fn: string, args: Record<string, unknown>): PromiseLike<Res<unknown>>;
  };

const TOKEN = `it-mrf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describeIntegration("material request fulfilment · the joined stock journey", () => {
  let orgA = "";
  let orgB = "";
  let jobA = "";
  let dualUserId = "";
  let dualToken = "";
  let itemB = "";
  let siteB = "";

  const svc = () => db(serviceClient());
  const seam = () => userClient(dualToken) as unknown as StockSeamClient;

  async function makeUser(suffix: string): Promise<{ id: string; token: string }> {
    const email = `${TOKEN}-${suffix}@example.test`;
    const password = `Pw-${TOKEN}-${suffix}-${Math.random().toString(36).slice(2)}`;
    const created = await serviceClient().auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    expect(created.error, created.error?.message).toBeNull();
    const id = created.data.user?.id ?? "";
    await svc().from("users").insert({ id, email, full_name: `MRF ${suffix}` }).select("id").single();
    const signedIn = await anonClient().auth.signInWithPassword({ email, password });
    expect(signedIn.error, signedIn.error?.message).toBeNull();
    const token = signedIn.data.session?.access_token ?? "";
    if (!id || !token) throw new Error(`failed to mint user ${suffix}`);
    return { id, token };
  }

  async function makeOrg(name: string, slug: string): Promise<string> {
    const org = await svc().from("organizations").insert({ name, slug }).select("id").single();
    expect(org.error, org.error?.message).toBeNull();
    return String(org.data?.id ?? "");
  }

  async function makeJob(orgId: string): Promise<string> {
    const job = await svc().from("jobs").insert({ org_id: orgId, status: "in-progress" }).select("id").single();
    expect(job.error, job.error?.message).toBeNull();
    return String(job.data?.id ?? "");
  }

  async function makeItem(orgId: string, name: string): Promise<string> {
    const r = await svc().from("stock_items").insert({ org_id: orgId, name, unit: "ea" }).select("id").single();
    expect(r.error, r.error?.message).toBeNull();
    return String(r.data?.id ?? "");
  }

  async function makeSite(orgId: string, name: string): Promise<string> {
    const r = await svc().from("sites").insert({ org_id: orgId, name, kind: "depot" }).select("id").single();
    expect(r.error, r.error?.message).toBeNull();
    return String(r.data?.id ?? "");
  }

  /** Seed a positive balance via an admin-bypassing service-role adjustment. */
  async function seedStock(orgId: string, itemId: string, siteId: string, qty: number): Promise<void> {
    const r = await rpc(serviceClient()).rpc("record_stock_adjustment", {
      p_org_id: orgId,
      p_item_id: itemId,
      p_site_id: siteId,
      p_delta: qty,
      p_reason: "seed for fulfilment test",
    });
    expect(r.error, r.error?.message).toBeNull();
  }

  type LineSpec = { desc: string; qty: number; stockItemId?: string | null };

  /** A DRAFT→submitted→approved request with the given lines, raised by the dual admin. */
  async function makeApprovedRequest(
    orgId: string,
    jobId: string | null,
    number: string,
    specs: LineSpec[],
  ): Promise<{ id: string; lines: string[] }> {
    const req = await svc()
      .from("material_requests")
      .insert({
        org_id: orgId,
        job_id: jobId,
        number,
        priority: "normal",
        requested_by: dualUserId,
        created_by: dualUserId,
      })
      .select("id")
      .single();
    expect(req.error, req.error?.message).toBeNull();
    const id = String(req.data?.id ?? "");

    const lines: string[] = [];
    for (const [i, spec] of specs.entries()) {
      const li = await svc()
        .from("material_request_lines")
        .insert({
          org_id: orgId,
          material_request_id: id,
          description: spec.desc,
          qty: spec.qty,
          unit: "ea",
          stock_item_id: spec.stockItemId ?? null,
          sort_order: i,
        })
        .select("id")
        .single();
      expect(li.error, li.error?.message).toBeNull();
      lines.push(String(li.data?.id ?? ""));
    }

    // submit then approve through the real transition trigger, as the dual admin.
    const client = userClient(dualToken);
    const sub = await db(client).from("material_requests").update({ status: "submitted" }).eq("id", id).eq("org_id", orgId);
    expect(sub.error, sub.error?.message).toBeNull();
    const app = await db(client).from("material_requests").update({ status: "approved" }).eq("id", id).eq("org_id", orgId);
    expect(app.error, app.error?.message).toBeNull();
    return { id, lines };
  }

  const statusOf = async (id: string): Promise<string> => {
    const r = await svc().from("material_requests").select("status").eq("id", id).maybeSingle();
    return String(r.data?.status ?? "");
  };

  /** The derived fulfilment position for a request, read exactly as a surface would. */
  async function derive(orgId: string, specs: Array<{ id: string; desc: string; qty: number }>) {
    const { issued, stockModulePending } = await readIssuedForLines(
      seam(),
      orgId,
      specs.map((s) => s.id),
    );
    expect(stockModulePending, "stock lane must be present for these tests").toBe(false);
    return computeMaterialFulfilment({
      lines: specs.map((s) => ({ id: s.id, description: s.desc, qty: s.qty })),
      issued,
      stockModulePending,
    });
  }

  function mustIssue(r: Awaited<ReturnType<typeof issueStockToRequestLine>>): {
    movementId: string;
    status: string | null;
  } {
    if (!r.ok) throw new Error(`issue failed: ${r.message ?? r.code ?? "unknown"}`);
    return { movementId: r.movementId, status: r.status };
  }

  beforeAll(async () => {
    orgA = await makeOrg("MRF Probe A", `${TOKEN}-a`);
    orgB = await makeOrg("MRF Probe B", `${TOKEN}-b`);
    jobA = await makeJob(orgA);
    const dual = await makeUser("dual");
    dualUserId = dual.id;
    dualToken = dual.token;
    for (const org of [orgA, orgB]) {
      const m = await svc().from("memberships").insert({ org_id: org, user_id: dualUserId, role: "admin" }).select("user_id").single();
      expect(m.error, m.error?.message).toBeNull();
    }
    itemB = await makeItem(orgB, "B cement");
    siteB = await makeSite(orgB, "B depot");
  });

  afterAll(async () => {
    for (const id of [orgA, orgB]) if (id) await svc().from("organizations").delete().eq("id", id);
    if (dualUserId) await serviceClient().auth.admin.deleteUser(dualUserId);
  });

  // ── 1. The full journey ─────────────────────────────────────────────────────

  it("FULL JOURNEY: 2 lines → partial (12 of 20) → fulfilled, provenance + feed intact", async () => {
    const itemA = await makeItem(orgA, "Cement 25kg");
    const siteA = await makeSite(orgA, "Yard A");
    await seedStock(orgA, itemA, siteA, 100);

    const { id, lines } = await makeApprovedRequest(orgA, jobA, `${TOKEN}-FULL`, [
      { desc: "Cement 25kg", qty: 20, stockItemId: itemA },
      { desc: "Ballast bulk bag", qty: 12.5, stockItemId: itemA },
    ]);
    const specs = [
      { id: lines[0]!, desc: "Cement 25kg", qty: 20 },
      { id: lines[1]!, desc: "Ballast bulk bag", qty: 12.5 },
    ];

    // issue 12 of 20 to line 1 → partially_fulfilled, line 1 outstanding 8
    const p1 = mustIssue(
      await issueStockToRequestLine(seam(), orgA, id, {
        itemId: itemA,
        siteId: siteA,
        qty: 12,
        requestLineId: lines[0]!,
        jobId: jobA,
      }),
    );
    expect(p1.status).toBe("partially_fulfilled");
    expect(await statusOf(id)).toBe("partially_fulfilled");
    let pos = await derive(orgA, specs);
    expect(pos.lines[0]!.outstanding).toBe(8);
    expect(pos.lines[0]!.fulfilled).toBe(12);
    expect(pos.state).toBe("partial");

    // issue the remaining 8 → line 1 complete but line 2 still outstanding → stays partial
    const p2 = mustIssue(
      await issueStockToRequestLine(seam(), orgA, id, {
        itemId: itemA,
        siteId: siteA,
        qty: 8,
        requestLineId: lines[0]!,
        jobId: jobA,
      }),
    );
    expect(p2.status).toBe("partially_fulfilled");
    pos = await derive(orgA, specs);
    expect(pos.lines[0]!.complete).toBe(true);
    expect(pos.lines[1]!.outstanding).toBe(12.5);

    // fulfil line 2 → every line met → fulfilled
    const p3 = mustIssue(
      await issueStockToRequestLine(seam(), orgA, id, {
        itemId: itemA,
        siteId: siteA,
        qty: 12.5,
        requestLineId: lines[1]!,
        jobId: jobA,
      }),
    );
    expect(p3.status).toBe("fulfilled");
    expect(await statusOf(id)).toBe("fulfilled");

    // PROVENANCE: three issue movements, each carrying its line id and the job.
    const mv = await svc()
      .from("stock_movements")
      .select("material_request_line_id, job_id, qty, movement_type")
      .eq("org_id", orgA)
      .in("material_request_line_id", lines);
    const issues = (mv.data ?? []).filter((m) => m.movement_type === "issue");
    expect(issues.length).toBe(3);
    expect(issues.every((m) => m.job_id === jobA), "every issue carries the job").toBe(true);

    // ACTIVITY FEED — triggers are the only writers; the whole journey is there.
    const feed = await svc().from("activity_log").select("action").eq("target_id", id);
    const actions = (feed.data ?? []).map((r) => String(r.action));
    expect(actions).toContain("material_request.submitted");
    expect(actions).toContain("material_request.approved");
    expect(actions).toContain("material_request.partially_fulfilled");
    expect(actions).toContain("material_request.fulfilled");
  });

  // ── 2. THE CORRECTED ISSUE — the reason this lane exists ─────────────────────

  it("CORRECTED ISSUE: a reversed issue returns the line to outstanding and off 'fulfilled'", async () => {
    const itemA = await makeItem(orgA, "Corr cement");
    const siteA = await makeSite(orgA, "Corr yard");
    await seedStock(orgA, itemA, siteA, 20);

    // 2 lines so fulfilling ONE leaves the REQUEST partially_fulfilled (not the
    // terminal 'fulfilled') — the state from which a reversal is legible.
    const { id, lines } = await makeApprovedRequest(orgA, null, `${TOKEN}-CORR`, [
      { desc: "Cement 25kg", qty: 20, stockItemId: itemA },
      { desc: "Sharp sand", qty: 5, stockItemId: null }, // never issued
    ]);
    const specs = [
      { id: lines[0]!, desc: "Cement 25kg", qty: 20 },
      { id: lines[1]!, desc: "Sharp sand", qty: 5 },
    ];

    // issue 20 to line 1 → line 1 reads fulfilled, request partially_fulfilled
    const issue = mustIssue(
      await issueStockToRequestLine(seam(), orgA, id, {
        itemId: itemA,
        siteId: siteA,
        qty: 20,
        requestLineId: lines[0]!,
      }),
    );
    expect(issue.status).toBe("partially_fulfilled");
    let pos = await derive(orgA, specs);
    expect(pos.lines[0]!.complete, "line 1 reads fulfilled before the reversal").toBe(true);
    expect(pos.lines[0]!.outstanding).toBe(0);

    // CONFIRM the hazard is real: record_stock_correction does NOT copy the line
    // id onto the correction row — so a NAIVE sum over movement_type='issue'
    // would still count the reversed issue.
    const corr = await rpc(userClient(dualToken)).rpc("record_stock_correction", {
      p_org_id: orgA,
      p_movement_id: issue.movementId,
      p_reason: "picked the wrong bin",
    });
    expect(corr.error, corr.error?.message).toBeNull();
    const corrRow = await svc()
      .from("stock_movements")
      .select("material_request_line_id, movement_type, corrects_movement_id")
      .eq("id", String(corr.data))
      .maybeSingle();
    expect(corrRow.data?.movement_type).toBe("correction");
    expect(
      corrRow.data?.material_request_line_id,
      "the correction row must NOT carry the line id — that is the whole hazard",
    ).toBeNull();
    expect(corrRow.data?.corrects_movement_id).toBe(issue.movementId);

    // Drive the reconcile the correction path uses.
    const reconciled = await reconcileFulfilmentForMovement(seam(), orgA, issue.movementId);

    // THE DERIVATION EXCLUDES THE CORRECTED ISSUE → line 1 back to outstanding 20.
    const { issued } = await readIssuedForLines(seam(), orgA, lines);
    expect(issued, "the only issue was reversed, so nothing counts").toEqual([]);
    pos = await derive(orgA, specs);
    expect(pos.lines[0]!.outstanding, "line 1 returns to outstanding 20").toBe(20);
    expect(pos.state).toBe("none");

    // THE STATUS: NOT 'fulfilled'. It stays partially_fulfilled (the M4 contract
    // walks a request forward only and treats 'fulfilled' as terminal, so a
    // part-fulfilled request that loses its issues stays part-fulfilled rather
    // than reverting to approved — the DERIVED position above is the live truth).
    const status = await statusOf(id);
    expect(status, "a reversed issue must not leave the request reading fulfilled").not.toBe("fulfilled");
    expect(status).toBe("partially_fulfilled");
    expect(reconciled).toBe("partially_fulfilled");
  });

  it("CORRECTED ISSUE (derivation, single line): full → none, purely from the exclusion", async () => {
    // Isolates the derivation from the terminal-status caveat: a single-line
    // request reaches 'fulfilled', but the DERIVED position — what every surface
    // renders — correctly returns to 'none'/outstanding once the issue is
    // reversed. A naive sum would still say 'full' here.
    const itemA = await makeItem(orgA, "Single cement");
    const siteA = await makeSite(orgA, "Single yard");
    await seedStock(orgA, itemA, siteA, 20);
    const { id, lines } = await makeApprovedRequest(orgA, null, `${TOKEN}-CORR1`, [
      { desc: "Cement", qty: 20, stockItemId: itemA },
    ]);
    const specs = [{ id: lines[0]!, desc: "Cement", qty: 20 }];

    const issue = mustIssue(
      await issueStockToRequestLine(seam(), orgA, id, {
        itemId: itemA,
        siteId: siteA,
        qty: 20,
        requestLineId: lines[0]!,
      }),
    );
    expect(issue.status).toBe("fulfilled");
    expect((await derive(orgA, specs)).state).toBe("full");

    await rpc(userClient(dualToken)).rpc("record_stock_correction", {
      p_org_id: orgA,
      p_movement_id: issue.movementId,
      p_reason: "never left the yard",
    });

    const pos = await derive(orgA, specs);
    expect(pos.state, "the corrected issue is excluded — the derivation says 'none'").toBe("none");
    expect(pos.lines[0]!.outstanding).toBe(20);
  });

  // ── 3. Over-issue ────────────────────────────────────────────────────────────

  it("OVER-ISSUE: 15 against a request for 10 reads fulfilled, outstanding 0, never 150% or −5", async () => {
    const itemA = await makeItem(orgA, "Screws box");
    const siteA = await makeSite(orgA, "Over yard");
    await seedStock(orgA, itemA, siteA, 15);
    const { id, lines } = await makeApprovedRequest(orgA, null, `${TOKEN}-OVER`, [
      { desc: "Screws", qty: 10, stockItemId: itemA },
    ]);

    const issue = mustIssue(
      await issueStockToRequestLine(seam(), orgA, id, {
        itemId: itemA,
        siteId: siteA,
        qty: 15,
        requestLineId: lines[0]!,
      }),
    );
    expect(issue.status).toBe("fulfilled");
    expect(await statusOf(id)).toBe("fulfilled");

    const pos = await derive(orgA, [{ id: lines[0]!, desc: "Screws", qty: 10 }]);
    expect(pos.lines[0]!.fulfilled, "clamped to requested, never 15/150%").toBe(10);
    expect(pos.lines[0]!.outstanding, "never negative outstanding").toBe(0);
    expect(pos.lines[0]!.over).toBe(true);
    expect(pos.lines[0]!.overBy).toBe(5);
    expect(pos.state).toBe("full");

    // the MOVEMENT is truthful — 15 really went out, the surplus is real stock.
    const mv = await svc().from("stock_movements").select("qty").eq("id", issue.movementId).maybeSingle();
    expect(Number(mv.data?.qty)).toBe(15);
  });

  // ── 4. Cross-org ─────────────────────────────────────────────────────────────

  it("CROSS-ORG: a crafted org-B issue carrying org-A's line id never counts for org A", async () => {
    const itemA = await makeItem(orgA, "XOrg cement");
    const { id, lines } = await makeApprovedRequest(orgA, null, `${TOKEN}-XORG`, [
      { desc: "Cement", qty: 10, stockItemId: itemA },
    ]);
    const lineA = lines[0]!;

    // The linkage column has NO foreign key (the frozen contract), so org B CAN
    // physically write org A's line id onto its own movement — this is craftable,
    // and we prove the WRITE succeeds so the defence being tested is real.
    await seedStock(orgB, itemB, siteB, 10);
    const bIssue = await rpc(userClient(dualToken)).rpc("record_stock_issue", {
      p_org_id: orgB,
      p_item_id: itemB,
      p_site_id: siteB,
      p_qty: 10,
      p_job_id: null,
      p_material_request_line_id: lineA, // org A's line, smuggled onto an org-B movement
      p_notes: "crafted cross-org",
    });
    expect(bIssue.error, bIssue.error?.message).toBeNull();
    const crafted = await svc()
      .from("stock_movements")
      .select("org_id, material_request_line_id")
      .eq("id", String(bIssue.data))
      .maybeSingle();
    expect(String(crafted.data?.org_id), "the crafted row really is in org B").toBe(orgB);
    expect(String(crafted.data?.material_request_line_id), "and really carries org A's line id").toBe(lineA);

    // ...yet the seam pins the ACTIVE org, so org A's derivation never sees it.
    const { issued } = await readIssuedForLines(seam(), orgA, [lineA]);
    expect(issued, "an org-B movement must not count toward org A's fulfilment").toEqual([]);

    // and a reconcile cannot be tricked into advancing org A's request by it.
    await reconcileRequestFulfilment(seam(), orgA, id);
    expect(await statusOf(id), "org A's request is untouched by the cross-org movement").toBe("approved");
  });

  // ── 5. Baseline: the derivation reports honestly ─────────────────────────────

  it("an approved request with no issues derives as 'none', never a false measurement", async () => {
    const itemA = await makeItem(orgA, "Idle cement");
    const { id, lines } = await makeApprovedRequest(orgA, null, `${TOKEN}-IDLE`, [
      { desc: "Cement", qty: 10, stockItemId: itemA },
    ]);
    const pos = await derive(orgA, [{ id: lines[0]!, desc: "Cement", qty: 10 }]);
    expect(pos.state).toBe("none");
    expect(pos.stockModulePending).toBe(false);
    // reconcile is a no-op; the request stays approved.
    await reconcileRequestFulfilment(seam(), orgA, id);
    expect(await statusOf(id)).toBe("approved");
  });
});
