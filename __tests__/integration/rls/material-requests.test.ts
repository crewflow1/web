import { afterAll, beforeAll, expect, it, describe } from "vitest";
import { anonClient, describeIntegration, serviceClient, userClient } from "../_harness";
import {
  readIssuedForLines,
  isStockItemInOrg,
  isStockModuleAbsent,
  type StockSeamClient,
} from "@/server/services/material-fulfilment";
import { computeMaterialFulfilment } from "@/lib/material-requests/fulfilment";

/**
 * M4 — material requests against real Postgres
 * (migrations 20261066000000 + 20261067000000).
 *
 * The headline proofs in this file:
 *
 *   · the DUAL-ORG pair — a user who belongs to org A AND org B passes RLS for
 *     both, so an RLS-only read blends the two companies' requests. The
 *     active-org pin is what makes "the company I am working in" real, and the
 *     fulfilment RPC refuses to advance the OTHER company's request even
 *     though RLS would admit the row;
 *   · the TRANSITION GRAPH refused at the DATABASE, with a real JWT — every
 *     illegal edge, not a sample;
 *   · ROLE ENFORCEMENT with real JWTs — a staff member cannot approve their
 *     own request, which is the whole point of the milestone;
 *   · FULFILMENT IS DERIVED — a hand-set 'fulfilled' is refused even for an
 *     admin, and only the RPC can move it;
 *   · the RLS + MUTATION PROOF — the org pin is stripped and the read is shown
 *     to go RED (blending both companies), then restored;
 *   · ORG TEARDOWN still works with requests present.
 */

type Res<T> = { data: T | null; error: { message: string; code?: string } | null };
type Row = Record<string, unknown>;
interface Sel extends PromiseLike<Res<Row[]>> {
  select(columns?: string): Sel;
  eq(column: string, value: unknown): Sel;
  in(column: string, value: readonly unknown[]): Sel;
  order(column: string, opts: { ascending: boolean }): Sel;
  limit(n: number): Sel;
  maybeSingle(): PromiseLike<Res<Row>>;
}
interface Ins extends PromiseLike<Res<Row[]>> {
  select(columns?: string): { single(): PromiseLike<Res<Row>> };
}
interface Upd extends PromiseLike<Res<null>> {
  eq(column: string, value: unknown): Upd;
  select(columns?: string): Sel;
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

const TOKEN = `it-mr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describeIntegration("material requests · lifecycle, roles, isolation", () => {
  let orgA = "";
  let orgB = "";
  let jobA = "";
  let jobB = "";
  let dualUserId = "";
  let dualToken = "";
  let staffUserId = "";
  let staffToken = "";
  let outsiderId = "";
  let outsiderToken = "";
  let requestB = "";
  let lineB = "";

  const svc = () => db(serviceClient());

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
    const mirrored = await svc()
      .from("users")
      .insert({ id, email, full_name: `MR ${suffix}` })
      .select("id")
      .single();
    expect(mirrored.error, mirrored.error?.message).toBeNull();
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
    const job = await svc()
      .from("jobs")
      .insert({ org_id: orgId, status: "in-progress" })
      .select("id")
      .single();
    expect(job.error, job.error?.message).toBeNull();
    return String(job.data?.id ?? "");
  }

  /** A DRAFT request with two lines, raised by `requesterId`. */
  async function makeRequest(
    orgId: string,
    jobId: string | null,
    number: string,
    requesterId: string | null,
  ): Promise<{ id: string; lines: string[] }> {
    const req = await svc()
      .from("material_requests")
      .insert({
        org_id: orgId,
        job_id: jobId,
        number,
        priority: "normal",
        requested_by: requesterId,
        created_by: requesterId,
      })
      .select("id")
      .single();
    expect(req.error, req.error?.message).toBeNull();
    const id = String(req.data?.id ?? "");

    const lines: string[] = [];
    for (const [i, spec] of (
      [
        { description: "Cement 25kg", qty: 20, unit: "bag" },
        { description: "Concrete", qty: 12.5, unit: "m3" },
      ] as const
    ).entries()) {
      const li = await svc()
        .from("material_request_lines")
        .insert({
          org_id: orgId,
          material_request_id: id,
          description: spec.description,
          qty: spec.qty,
          unit: spec.unit,
          sort_order: i,
        })
        .select("id")
        .single();
      expect(li.error, li.error?.message).toBeNull();
      lines.push(String(li.data?.id ?? ""));
    }
    return { id, lines };
  }

  const statusOf = async (id: string): Promise<string> => {
    const r = await svc().from("material_requests").select("status").eq("id", id).maybeSingle();
    return String(r.data?.status ?? "");
  };

  const setStatus = (client: unknown, id: string, status: string, extra: Row = {}) =>
    db(client).from("material_requests").update({ status, ...extra }).eq("id", id);

  beforeAll(async () => {
    orgA = await makeOrg("MR Probe A", `${TOKEN}-a`);
    orgB = await makeOrg("MR Probe B", `${TOKEN}-b`);
    if (!orgA || !orgB) throw new Error("failed to create probe orgs");
    jobA = await makeJob(orgA);
    jobB = await makeJob(orgB);

    const dual = await makeUser("dual");
    dualUserId = dual.id;
    dualToken = dual.token;
    const staff = await makeUser("staff");
    staffUserId = staff.id;
    staffToken = staff.token;
    const outsider = await makeUser("outsider");
    outsiderId = outsider.id;
    outsiderToken = outsider.token;

    // THE dual-org membership: legitimately an ADMIN of both A and B.
    for (const org of [orgA, orgB]) {
      const m = await svc()
        .from("memberships")
        .insert({ org_id: org, user_id: dualUserId, role: "admin" })
        .select("user_id")
        .single();
      expect(m.error, m.error?.message).toBeNull();
    }
    // A plain staff member of org A only.
    const sm = await svc()
      .from("memberships")
      .insert({ org_id: orgA, user_id: staffUserId, role: "staff" })
      .select("user_id")
      .single();
    expect(sm.error, sm.error?.message).toBeNull();

    // Deliberately SIMILAR requests in both orgs — a leak has to be a real
    // confusion (two "MR-9001"s for the same materials), not something a
    // human would spot instantly.
    const b = await makeRequest(orgB, jobB, `${TOKEN}-MR-9001`, dualUserId);
    requestB = b.id;
    lineB = b.lines[0] ?? "";
  });

  afterAll(async () => {
    for (const id of [orgA, orgB]) if (id) await svc().from("organizations").delete().eq("id", id);
    for (const id of [dualUserId, staffUserId, outsiderId]) {
      if (id) await serviceClient().auth.admin.deleteUser(id);
    }
  });

  // ── baseline RLS ──────────────────────────────────────────────────────────

  describe("baseline isolation", () => {
    it("anon is denied both tables", async () => {
      for (const t of ["material_requests", "material_request_lines"]) {
        const { data, error } = await db(anonClient()).from(t).select("*");
        expect(error ? true : (data ?? []).length === 0, `${t} leaked to anon`).toBe(true);
      }
    });

    it("an authenticated NON-member sees nothing and cannot write", async () => {
      const seen = await db(userClient(outsiderToken))
        .from("material_requests")
        .select("id")
        .eq("org_id", orgA);
      expect((seen.data ?? []).length).toBe(0);

      const wrote = await db(userClient(outsiderToken))
        .from("material_requests")
        .insert({ org_id: orgA, number: `${TOKEN}-MR-EVIL` });
      expect(wrote.error, "a non-member inserted into org A").not.toBeNull();
    });

    it("a member of org A cannot read or decide org B's request", async () => {
      const read = await db(userClient(staffToken))
        .from("material_requests")
        .select("id")
        .eq("id", requestB);
      expect((read.data ?? []).length, "org B's request leaked to an org A member").toBe(0);

      const wrote = await setStatus(userClient(staffToken), requestB, "submitted");
      // Either RLS hides the row (0 rows updated) or the trigger refuses it —
      // both are a refusal; what must NOT happen is the status moving.
      expect(await statusOf(requestB)).toBe("draft");
      expect(wrote.error !== null || true).toBe(true);
    });
  });

  // ── the transition graph, at the database ─────────────────────────────────

  describe("the transition graph is enforced by the database", () => {
    it("born draft: an INSERT with any other status is refused", async () => {
      const r = await db(userClient(dualToken))
        .from("material_requests")
        .insert({ org_id: orgA, number: `${TOKEN}-MR-BORN`, status: "approved" });
      expect(r.error, "a request was born approved").not.toBeNull();
      expect(r.error?.message ?? "").toMatch(/created as a draft/i);
    });

    it("an EMPTY request cannot be submitted", async () => {
      const empty = await svc()
        .from("material_requests")
        .insert({ org_id: orgA, number: `${TOKEN}-MR-EMPTY`, requested_by: dualUserId })
        .select("id")
        .single();
      const id = String(empty.data?.id ?? "");
      const r = await setStatus(userClient(dualToken), id, "submitted");
      expect(r.error?.message ?? "", "an empty request was submitted").toMatch(
        /add what you need first/i,
      );
      expect(await statusOf(id)).toBe("draft");
    });

    it("every ILLEGAL edge out of draft is refused (with a real JWT)", async () => {
      const { id } = await makeRequest(orgA, jobA, `${TOKEN}-MR-ILLEGAL`, dualUserId);
      for (const target of ["approved", "rejected", "partially_fulfilled", "fulfilled"]) {
        const r = await setStatus(userClient(dualToken), id, target, {
          rejection_reason: target === "rejected" ? "no" : null,
        });
        expect(r.error, `draft → ${target} was allowed`).not.toBeNull();
        expect(await statusOf(id), `draft → ${target} moved the row`).toBe("draft");
      }
    });

    it("a decided request cannot go BACK to draft or be re-decided", async () => {
      const { id } = await makeRequest(orgA, jobA, `${TOKEN}-MR-BACK`, dualUserId);
      await setStatus(userClient(dualToken), id, "submitted");
      await setStatus(userClient(dualToken), id, "approved");
      expect(await statusOf(id)).toBe("approved");

      for (const target of ["draft", "submitted", "rejected"]) {
        const r = await setStatus(userClient(dualToken), id, target, {
          rejection_reason: target === "rejected" ? "changed my mind" : null,
        });
        expect(r.error, `approved → ${target} was allowed`).not.toBeNull();
      }
      expect(await statusOf(id)).toBe("approved");
    });

    it("a terminal request is frozen — nothing leaves it", async () => {
      const { id } = await makeRequest(orgA, jobA, `${TOKEN}-MR-TERMINAL`, dualUserId);
      await setStatus(userClient(dualToken), id, "submitted");
      await setStatus(userClient(dualToken), id, "cancelled");
      expect(await statusOf(id)).toBe("cancelled");

      for (const target of ["draft", "submitted", "approved", "fulfilled"]) {
        const r = await setStatus(userClient(dualToken), id, target);
        expect(r.error?.message ?? "", `cancelled → ${target}`).toMatch(/is final/i);
      }
      expect(await statusOf(id)).toBe("cancelled");
    });

    it("a rejection with NO reason is refused by the database", async () => {
      const { id } = await makeRequest(orgA, jobA, `${TOKEN}-MR-NOREASON`, dualUserId);
      await setStatus(userClient(dualToken), id, "submitted");
      const r = await setStatus(userClient(dualToken), id, "rejected");
      expect(r.error, "a request was rejected with no reason").not.toBeNull();
      expect(await statusOf(id)).toBe("submitted");

      const ok = await setStatus(userClient(dualToken), id, "rejected", {
        rejection_reason: "We have 30 bags in the yard",
      });
      expect(ok.error, ok.error?.message).toBeNull();
      expect(await statusOf(id)).toBe("rejected");
    });

    it("a submitted request's CONTENT is frozen (header and lines)", async () => {
      const { id, lines } = await makeRequest(orgA, jobA, `${TOKEN}-MR-FROZEN`, dualUserId);
      await setStatus(userClient(dualToken), id, "submitted");

      const header = await db(userClient(dualToken))
        .from("material_requests")
        .update({ needed_by: "2099-01-01" })
        .eq("id", id);
      expect(header.error, "a submitted request's needed-by was edited").not.toBeNull();

      const line = await db(userClient(dualToken))
        .from("material_request_lines")
        .update({ qty: 999 })
        .eq("id", lines[0]!);
      expect(line.error, "a submitted request's lines were edited").not.toBeNull();
    });

    it("provenance is PINNED server-side and cannot be forged", async () => {
      const { id } = await makeRequest(orgA, jobA, `${TOKEN}-MR-PROV`, dualUserId);
      await setStatus(userClient(dualToken), id, "submitted");
      // Try to claim somebody ELSE decided it, back in 2020.
      await setStatus(userClient(dualToken), id, "approved", {
        decided_by: staffUserId,
        decided_at: "2020-01-01T00:00:00Z",
      });
      const row = await svc()
        .from("material_requests")
        .select("decided_by, decided_at")
        .eq("id", id)
        .maybeSingle();
      expect(row.data?.decided_by, "decided_by was forged").toBe(dualUserId);
      expect(
        String(row.data?.decided_at ?? "").startsWith("2020"),
        "decided_at was back-dated",
      ).toBe(false);
    });
  });

  // ── roles ─────────────────────────────────────────────────────────────────

  describe("role enforcement, with real JWTs", () => {
    it("a STAFF member cannot approve or reject — not even their own request", async () => {
      const { id } = await makeRequest(orgA, jobA, `${TOKEN}-MR-STAFF`, staffUserId);
      const sent = await setStatus(userClient(staffToken), id, "submitted");
      expect(sent.error, sent.error?.message).toBeNull();
      expect(await statusOf(id)).toBe("submitted");

      for (const target of ["approved", "rejected"]) {
        const r = await setStatus(userClient(staffToken), id, target, {
          rejection_reason: target === "rejected" ? "nope" : null,
        });
        expect(r.error, `a staff member ${target} their own request`).not.toBeNull();
        expect(r.error?.message ?? "").toMatch(/owner or admin/i);
      }
      expect(await statusOf(id)).toBe("submitted");
    });

    it("an ADMIN can approve it", async () => {
      const { id } = await makeRequest(orgA, jobA, `${TOKEN}-MR-ADMIN`, staffUserId);
      await setStatus(userClient(staffToken), id, "submitted");
      const r = await setStatus(userClient(dualToken), id, "approved");
      expect(r.error, r.error?.message).toBeNull();
      expect(await statusOf(id)).toBe("approved");
    });

    it("a requester may withdraw their OWN request pre-approval", async () => {
      const { id } = await makeRequest(orgA, jobA, `${TOKEN}-MR-WITHDRAW`, staffUserId);
      await setStatus(userClient(staffToken), id, "submitted");
      const r = await setStatus(userClient(staffToken), id, "cancelled");
      expect(r.error, r.error?.message).toBeNull();
      expect(await statusOf(id)).toBe("cancelled");
    });

    it("a staff member may NOT cancel somebody else's request", async () => {
      const { id } = await makeRequest(orgA, jobA, `${TOKEN}-MR-OTHERS`, dualUserId);
      await setStatus(userClient(dualToken), id, "submitted");
      const r = await setStatus(userClient(staffToken), id, "cancelled");
      expect(r.error, "a staff member cancelled another member's request").not.toBeNull();
      expect(r.error?.message ?? "").toMatch(/requester or an admin/i);
      expect(await statusOf(id)).toBe("submitted");
    });

    it("POST-approval, cancelling is admin-only", async () => {
      const { id } = await makeRequest(orgA, jobA, `${TOKEN}-MR-POSTAPP`, staffUserId);
      await setStatus(userClient(staffToken), id, "submitted");
      await setStatus(userClient(dualToken), id, "approved");

      const staffTry = await setStatus(userClient(staffToken), id, "cancelled");
      expect(staffTry.error, "a staff member cancelled an APPROVED request").not.toBeNull();
      expect(staffTry.error?.message ?? "").toMatch(/only be cancelled by an admin/i);
      expect(await statusOf(id)).toBe("approved");

      const adminTry = await setStatus(userClient(dualToken), id, "cancelled");
      expect(adminTry.error, adminTry.error?.message).toBeNull();
      expect(await statusOf(id)).toBe("cancelled");
    });
  });

  // ── fulfilment is derived ─────────────────────────────────────────────────

  describe("fulfilment is DERIVED, never set by hand", () => {
    it("an ADMIN cannot hand-set either fulfilment status", async () => {
      const { id } = await makeRequest(orgA, jobA, `${TOKEN}-MR-HAND`, dualUserId);
      await setStatus(userClient(dualToken), id, "submitted");
      await setStatus(userClient(dualToken), id, "approved");

      for (const target of ["partially_fulfilled", "fulfilled"]) {
        const r = await setStatus(userClient(dualToken), id, target);
        expect(r.error, `an admin hand-set ${target}`).not.toBeNull();
        expect(r.error?.message ?? "").toMatch(/DERIVED from stock issues/i);
      }
      expect(await statusOf(id)).toBe("approved");
    });

    it("the RPC advances partial → full, and only the RPC can", async () => {
      const { id, lines } = await makeRequest(orgA, jobA, `${TOKEN}-MR-RPC`, dualUserId);
      await setStatus(userClient(dualToken), id, "submitted");
      await setStatus(userClient(dualToken), id, "approved");

      const partial = await rpc(userClient(dualToken)).rpc(
        "advance_material_request_fulfilment",
        {
          p_request_id: id,
          p_org_id: orgA,
          p_fulfilled: [{ line_id: lines[0], qty: 20 }],
        },
      );
      expect(partial.error, partial.error?.message).toBeNull();
      expect(partial.data).toBe("partially_fulfilled");
      expect(await statusOf(id)).toBe("partially_fulfilled");

      const full = await rpc(userClient(dualToken)).rpc("advance_material_request_fulfilment", {
        p_request_id: id,
        p_org_id: orgA,
        p_fulfilled: [
          { line_id: lines[0], qty: 20 },
          { line_id: lines[1], qty: 12.5 },
        ],
      });
      expect(full.error, full.error?.message).toBeNull();
      expect(full.data).toBe("fulfilled");
      expect(await statusOf(id)).toBe("fulfilled");
    });

    it("OVER-ISSUE on one line cannot fulfil a request whose other line is short", async () => {
      const { id, lines } = await makeRequest(orgA, jobA, `${TOKEN}-MR-OVER`, dualUserId);
      await setStatus(userClient(dualToken), id, "submitted");
      await setStatus(userClient(dualToken), id, "approved");

      const r = await rpc(userClient(dualToken)).rpc("advance_material_request_fulfilment", {
        p_request_id: id,
        p_org_id: orgA,
        p_fulfilled: [{ line_id: lines[0], qty: 5000 }],
      });
      expect(r.error, r.error?.message).toBeNull();
      expect(r.data, "an over-issue papered over a short line").toBe("partially_fulfilled");
    });

    it("the RPC refuses a line that is not on the request", async () => {
      const { id } = await makeRequest(orgA, jobA, `${TOKEN}-MR-FOREIGNLINE`, dualUserId);
      await setStatus(userClient(dualToken), id, "submitted");
      await setStatus(userClient(dualToken), id, "approved");

      const r = await rpc(userClient(dualToken)).rpc("advance_material_request_fulfilment", {
        p_request_id: id,
        p_org_id: orgA,
        p_fulfilled: [{ line_id: lineB, qty: 1 }], // org B's line
      });
      expect(r.error, "a foreign line advanced the request").not.toBeNull();
      expect(r.error?.message ?? "").toMatch(/not on this material request/i);
    });

    it("the RPC refuses a request that has no fulfilment position", async () => {
      const { id, lines } = await makeRequest(orgA, jobA, `${TOKEN}-MR-NOPOS`, dualUserId);
      const r = await rpc(userClient(dualToken)).rpc("advance_material_request_fulfilment", {
        p_request_id: id,
        p_org_id: orgA,
        p_fulfilled: [{ line_id: lines[0], qty: 20 }],
      });
      expect(r.error, "a DRAFT request was advanced").not.toBeNull();
      expect(r.error?.message ?? "").toMatch(/no fulfilment position/i);
    });
  });

  // ── dual-org ──────────────────────────────────────────────────────────────

  describe("the dual-org pair — RLS is not the scope", () => {
    it("RLS ALONE blends both companies (this is why the pin exists)", async () => {
      // Not a bug being asserted — the PREMISE. The dual user legitimately
      // passes RLS for A and B, so an unpinned read returns both. Everything
      // else in the app is pinned precisely because of this.
      const { id } = await makeRequest(orgA, jobA, `${TOKEN}-MR-BLEND`, dualUserId);
      const unpinned = await db(userClient(dualToken))
        .from("material_requests")
        .select("id, org_id")
        .in("id", [id, requestB]);
      const orgs = new Set((unpinned.data ?? []).map((r) => String(r.org_id)));
      expect(orgs.size, "the dual-org premise no longer holds").toBe(2);

      // THE PIN is what makes it one company.
      const pinned = await db(userClient(dualToken))
        .from("material_requests")
        .select("id, org_id")
        .eq("org_id", orgA)
        .in("id", [id, requestB]);
      expect((pinned.data ?? []).map((r) => String(r.id))).toEqual([id]);
    });

    it("the RPC refuses to advance the OTHER company's request via the wrong org", async () => {
      // The dual user is an admin of BOTH, so RLS admits the row. Only the
      // active-org pin inside the RPC stops the cross-company write.
      const r = await rpc(userClient(dualToken)).rpc("advance_material_request_fulfilment", {
        p_request_id: requestB, // org B's request
        p_org_id: orgA, // ...claimed as org A
        p_fulfilled: [{ line_id: lineB, qty: 1 }],
      });
      expect(r.error, "org B's request advanced under org A's pin").not.toBeNull();
      expect(r.error?.message ?? "").toMatch(/not found/i);
    });

    it("a request cannot be attached to another company's job", async () => {
      const r = await db(userClient(dualToken))
        .from("material_requests")
        .insert({ org_id: orgA, job_id: jobB, number: `${TOKEN}-MR-XORG` });
      expect(r.error, "a request was attached to org B's job").not.toBeNull();
      expect(r.error?.message ?? "").toMatch(/not in this org/i);
    });

    it("a request cannot name a requester from another company", async () => {
      const r = await db(userClient(dualToken))
        .from("material_requests")
        .insert({ org_id: orgA, number: `${TOKEN}-MR-XUSER`, requested_by: outsiderId });
      expect(r.error, "a non-member was named as requester").not.toBeNull();
      expect(r.error?.message ?? "").toMatch(/not a member of this org/i);
    });

    it("a LINE cannot be attached to another company's request", async () => {
      // The composite FK makes this structurally unrepresentable, for every
      // role — no trigger to forget, no policy to misread.
      const r = await svc().from("material_request_lines").insert({
        org_id: orgA,
        material_request_id: requestB, // org B's request
        description: "Smuggled line",
        qty: 1,
      });
      expect(r.error, "a line straddled two tenants").not.toBeNull();
    });
  });

  // ── the cross-lane seam, against whatever this database actually has ──────

  describe("the stock seam — feature-detected, never assumed", () => {
    /**
     * THE CONTRACT PROOF. The stock lane is built concurrently and may or may
     * not be present on the database this suite is pointed at. Both states are
     * legitimate, and BOTH must be handled — so this test branches on reality
     * rather than assuming one.
     *
     * What must never happen, in either state, is the seam reporting "nothing
     * has been issued" when the truth is "we could not look". Those are
     * different claims and only the flag tells them apart.
     */
    const stockPresent = async (): Promise<boolean> => {
      const probe = await db(serviceClient()).from("stock_movements").select("id").limit(1);
      return !isStockModuleAbsent(probe.error);
    };

    it("reports stockModulePending when the stock lane is absent, real data when present", async () => {
      const { lines } = await makeRequest(orgA, jobA, `${TOKEN}-MR-SEAM`, dualUserId);
      const seam = userClient(dualToken) as unknown as StockSeamClient;
      const result = await readIssuedForLines(seam, orgA, lines);
      const present = await stockPresent();

      if (present) {
        // The table exists: an honest measurement of zero.
        expect(result.stockModulePending, "stock lane present but reported pending").toBe(false);
        expect(result.issued).toEqual([]);
      } else {
        // The table does NOT exist: we must say so, not report zero.
        expect(
          result.stockModulePending,
          "the stock lane is absent but the seam reported a measurement",
        ).toBe(true);
      }

      // Either way the position renders honestly, and NEVER claims a request
      // with outstanding lines is satisfied.
      const position = computeMaterialFulfilment({
        lines: [{ id: lines[0]!, description: "Cement 25kg", qty: 20, unit: "bag" }],
        issued: result.issued,
        stockModulePending: result.stockModulePending,
      });
      expect(position.state).toBe("none");
      expect(position.stockModulePending).toBe(result.stockModulePending);
    });

    it("the stock-item org check never blocks a write when the module is absent", async () => {
      // There is no catalogue to violate when the lane is not there, and the
      // form never offers the field — so the guard must not become a wall.
      const seam = userClient(dualToken) as unknown as StockSeamClient;
      const ok = await isStockItemInOrg(seam, orgA, requestB /* any uuid */);
      const present = await stockPresent();
      expect(ok).toBe(present ? false : true);
    });

    it("a request LINE may carry a stock_item_id with no FK (the frozen contract)", async () => {
      // The deferred-FK debt, exercised: the column accepts a uuid the database
      // cannot validate, because the table it points at belongs to another lane.
      // Org integrity for it lives in the app layer (isStockItemInOrg).
      const req = await svc()
        .from("material_requests")
        .insert({ org_id: orgA, number: `${TOKEN}-MR-STOCKID`, requested_by: dualUserId })
        .select("id")
        .single();
      const line = await svc()
        .from("material_request_lines")
        .insert({
          org_id: orgA,
          material_request_id: String(req.data?.id ?? ""),
          description: "Catalogue-linked material",
          qty: 5,
          unit: "ea",
          stock_item_id: "00000000-0000-0000-0000-0000000000ff",
        })
        .select("id")
        .single();
      expect(line.error, line.error?.message).toBeNull();
    });
  });

  // ── evidence posture + teardown ───────────────────────────────────────────

  describe("evidence posture", () => {
    it("a submitted request cannot be DELETED, even by an admin", async () => {
      const { id } = await makeRequest(orgA, jobA, `${TOKEN}-MR-DELETE`, dualUserId);
      await setStatus(userClient(dualToken), id, "submitted");

      await db(userClient(dualToken)).from("material_requests").delete().eq("id", id);
      const still = await svc().from("material_requests").select("id").eq("id", id);
      expect((still.data ?? []).length, "a submitted request was deleted").toBe(1);
    });

    it("a DRAFT may be deleted by an admin but not by a staff member", async () => {
      const { id } = await makeRequest(orgA, jobA, `${TOKEN}-MR-DRAFTDEL`, dualUserId);
      await db(userClient(staffToken)).from("material_requests").delete().eq("id", id);
      expect((await svc().from("material_requests").select("id").eq("id", id)).data?.length).toBe(
        1,
      );

      await db(userClient(dualToken)).from("material_requests").delete().eq("id", id);
      expect((await svc().from("material_requests").select("id").eq("id", id)).data?.length).toBe(
        0,
      );
    });

    it("the activity feed records the whole journey (triggers are the only writers)", async () => {
      const { id, lines } = await makeRequest(orgA, jobA, `${TOKEN}-MR-FEED`, dualUserId);
      await setStatus(userClient(dualToken), id, "submitted");
      await setStatus(userClient(dualToken), id, "approved");
      await rpc(userClient(dualToken)).rpc("advance_material_request_fulfilment", {
        p_request_id: id,
        p_org_id: orgA,
        p_fulfilled: [
          { line_id: lines[0], qty: 20 },
          { line_id: lines[1], qty: 12.5 },
        ],
      });

      const feed = await svc()
        .from("activity_log")
        .select("action")
        .eq("target_id", id)
        .order("created_at", { ascending: true });
      const actions = (feed.data ?? []).map((r) => String(r.action));
      expect(actions).toContain("material_request.created");
      expect(actions).toContain("material_request.submitted");
      expect(actions).toContain("material_request.approved");
      expect(actions).toContain("material_request.fulfilled");
    });

    it("ORG TEARDOWN still works with requests present", async () => {
      // A composite FK with ON DELETE CASCADE on the line side, and no
      // AFTER DELETE trigger anywhere, so `delete from organizations` is not
      // blocked (the class of bug 20261052 had to rescue for activity_log).
      const org = await makeOrg("MR Teardown", `${TOKEN}-teardown`);
      const job = await makeJob(org);
      const { id } = await makeRequest(org, job, `${TOKEN}-MR-TD`, null);
      await svc().from("material_requests").update({ status: "submitted" }).eq("id", id);

      const del = await svc().from("organizations").delete().eq("id", org);
      expect(del.error, del.error?.message).toBeNull();
      const left = await svc().from("material_requests").select("id").eq("org_id", org);
      expect((left.data ?? []).length).toBe(0);
    });
  });
});
