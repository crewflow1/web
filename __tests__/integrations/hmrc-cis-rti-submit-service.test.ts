import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * HMRC CIS300 + RTI FPS — the SUBMIT ORCHESTRATOR state machines
 * (server/services/hmrc-submit.ts submitCis300Return / submitFpsReturn).
 *
 * Hermetic: the service-role client is an in-memory fake, the OAuth/token-crypto/
 * submit-adapter modules are mocked, so NO real Supabase and NO real HMRC network
 * is touched. The fraud-header builder runs FOR REAL (pure). Mirrors
 * __tests__/integrations/hmrc-submit-service.test.ts (the VAT orchestrator) for
 * CIS300 + FPS.
 *
 * Proven here, for BOTH kinds:
 *   - REFUSE when dark / no enc key / not connected (no adapter call).
 *   - HAPPY PATH: prepared → submitting → accepted, HMRC correlation id persisted
 *     into the shared submission-reference column; decrypted tokens + the payload's
 *     employer/contractor handle handed to the adapter.
 *   - IDEMPOTENT double-submit: a non-prepared/held return is refused; the adapter
 *     is never called twice for one period.
 *   - TENANT ISOLATION: a submission id belonging to another org is not found.
 *   - Business rejection → 'rejected'; transient → reverted 'prepared'; terminal →
 *     reverted + connection flipped to 'error'.
 *   - A payload missing the employer/contractor handle is refused before the claim.
 */

type Row = Record<string, unknown>;

const h = vi.hoisted(() => {
  const state: {
    connectable: boolean;
    encKey: boolean;
    submissions: Row[];
    connections: Row[];
    cisImpl: (args: unknown) => Promise<Record<string, unknown>>;
    fpsImpl: (args: unknown) => Promise<Record<string, unknown>>;
    cisCalls: unknown[];
    fpsCalls: unknown[];
  } = {
    connectable: true,
    encKey: true,
    submissions: [],
    connections: [],
    cisImpl: async () => ({ ok: true, receipt: {} }),
    fpsImpl: async () => ({ ok: true, receipt: {} }),
    cisCalls: [],
    fpsCalls: [],
  };

  class Builder {
    private mode: "select" | "update" = "select";
    private updateRow: Row | null = null;
    private returnRows = false;
    private eqs: [string, unknown][] = [];
    private ins: [string, unknown[]][] = [];
    constructor(private rows: Row[]) {}
    select(cols?: string) {
      void cols;
      if (this.mode === "update") this.returnRows = true;
      return this;
    }
    update(row: Row) {
      this.mode = "update";
      this.updateRow = row;
      return this;
    }
    eq(col: string, val: unknown) {
      this.eqs.push([col, val]);
      return this;
    }
    in(col: string, vals: unknown[]) {
      this.ins.push([col, vals]);
      return this;
    }
    private match(): Row[] {
      return this.rows.filter(
        (r) =>
          this.eqs.every(([c, v]) => r[c] === v) &&
          this.ins.every(([c, vs]) => vs.includes(r[c])),
      );
    }
    private exec(): { data: Row[]; error: null } {
      if (this.mode === "update") {
        const matched = this.match();
        for (const r of matched) Object.assign(r, this.updateRow);
        return { data: this.returnRows ? matched.map((r) => ({ id: r.id })) : matched, error: null };
      }
      return { data: this.match(), error: null };
    }
    maybeSingle() {
      const { data, error } = this.exec();
      return Promise.resolve({ data: data[0] ?? null, error });
    }
    then<R1, R2>(
      onF?: ((v: { data: Row[]; error: null }) => R1 | PromiseLike<R1>) | null,
      onR?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
    ) {
      return Promise.resolve(this.exec()).then(onF, onR);
    }
  }

  const adminFake = {
    from(name: string) {
      const rows = name === "hmrc_submissions" ? state.submissions : state.connections;
      return new Builder(rows);
    },
  };

  return { state, adminFake };
});

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => h.adminFake }));
vi.mock("@/lib/integrations/hmrc/oauth", () => ({
  isHmrcConnectable: () => h.state.connectable,
  decryptStoredTokens: (s: { accessToken: string; refreshToken: string | null }) => ({
    accessToken: `dec(${s.accessToken})`,
    refreshToken: s.refreshToken !== null ? `dec(${s.refreshToken})` : null,
  }),
}));
vi.mock("@/lib/integrations/token-crypto", () => ({
  encryptToken: (v: string) => `enc(${v})`,
  isTokenEncryptionConfigured: () => h.state.encKey,
}));
vi.mock("@/lib/integrations/hmrc/vat-submit", () => ({ submitVatReturnToHmrc: async () => ({ ok: true, receipt: {} }) }));
vi.mock("@/lib/integrations/hmrc/cis-submit", () => ({
  submitCis300ReturnToHmrc: async (args: unknown) => {
    h.state.cisCalls.push(args);
    return h.state.cisImpl(args);
  },
}));
vi.mock("@/lib/integrations/hmrc/rti-fps-submit", () => ({
  submitFpsReturnToHmrc: async (args: unknown) => {
    h.state.fpsCalls.push(args);
    return h.state.fpsImpl(args);
  },
}));

const { submitCis300Return, submitFpsReturn } = await import("@/server/services/hmrc-submit");

const ORG = "org-A";

function seedConnected() {
  h.state.connections = [
    {
      id: "conn-1",
      org_id: ORG,
      provider: "hmrc",
      status: "connected",
      hmrc_vrn: "GB123456789",
      access_token: "ct-access",
      refresh_token: "ct-refresh",
      token_expires_at: "2099-01-01T00:00:00Z",
      last_error: null,
    },
  ];
}

function seedCis(status = "prepared", orgId = ORG, id = "cis-1"): Row {
  return {
    id,
    org_id: orgId,
    connection_id: "conn-1",
    kind: "cis300",
    status,
    period_key: "2026-05-05",
    payload: { contractor: { employerPayeReference: "123/AB456", utr: null }, subcontractors: [] },
    submitted_at: null,
    submit_error: null,
  };
}
function seedFps(status = "prepared", orgId = ORG, id = "fps-1"): Row {
  return {
    id,
    org_id: orgId,
    connection_id: "conn-1",
    kind: "fps",
    status,
    period_key: "monthly:2026-07-01..2026-07-31",
    payload: { employer: { employerPayeReference: "123/AB456" }, employees: [] },
    submitted_at: null,
    submit_error: null,
  };
}

beforeEach(() => {
  h.state.connectable = true;
  h.state.encKey = true;
  h.state.cisCalls = [];
  h.state.fpsCalls = [];
  h.state.cisImpl = async () => ({
    ok: true,
    receipt: { processingDate: "2026-05-19T09:00:00.000Z", submissionReference: "CID-cis", chargeRefNumber: "XCIS01" },
  });
  h.state.fpsImpl = async () => ({
    ok: true,
    receipt: { processingDate: "2026-07-31T09:00:00.000Z", submissionReference: "CID-fps" },
  });
  seedConnected();
});

// ---------------------------------------------------------------------------
// CIS300 orchestrator
// ---------------------------------------------------------------------------

describe("submitCis300Return", () => {
  const call = (id = "cis-1") => submitCis300Return({ orgId: ORG, submissionId: id, submittedBy: "user-1" });

  it("REFUSES when dark — no adapter call, submission untouched", async () => {
    h.state.submissions = [seedCis("prepared")];
    h.state.connectable = false;
    const res = await call();
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("not_configured");
    expect(h.state.cisCalls).toHaveLength(0);
    expect(h.state.submissions[0]!.status).toBe("prepared");
  });

  it("REFUSES when the token-encryption key is absent", async () => {
    h.state.submissions = [seedCis("prepared")];
    h.state.encKey = false;
    const res = await call();
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("not_configured");
    expect(h.state.cisCalls).toHaveLength(0);
  });

  it("REFUSES when the org is not connected", async () => {
    h.state.submissions = [seedCis("prepared")];
    h.state.connections[0]!.status = "disconnected";
    const res = await call();
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("not_connected");
    expect(h.state.cisCalls).toHaveLength(0);
  });

  it("advances prepared → accepted, persists the correlation id + charge ref, hands decrypted tokens + contractor ref", async () => {
    h.state.submissions = [seedCis("prepared")];
    const res = await call();
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.status).toBe("accepted");
    const row = h.state.submissions[0]!;
    expect(row.status).toBe("accepted");
    // HMRC's correlation id lands in the shared submission-reference column.
    expect(row.hmrc_form_bundle_number).toBe("CID-cis");
    expect(row.hmrc_charge_ref_number).toBe("XCIS01");
    expect(row.hmrc_processing_date).toBe("2026-05-19T09:00:00.000Z");
    expect(row.submitted_by).toBe("user-1");
    const args = h.state.cisCalls[0] as { contractorRef: string; tokens: { accessToken: string } };
    expect(args.contractorRef).toBe("123/AB456");
    expect(args.tokens.accessToken).toBe("dec(ct-access)");
  });

  it("refuses a payload with no contractor reference BEFORE any claim", async () => {
    const bad = seedCis("prepared");
    bad.payload = { contractor: { employerPayeReference: null, utr: null }, subcontractors: [] };
    h.state.submissions = [bad];
    const res = await call();
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("not_submittable");
    expect(h.state.cisCalls).toHaveLength(0);
    expect(h.state.submissions[0]!.status).toBe("prepared");
  });

  it("is idempotent: a non-prepared/held return is refused, adapter never called twice", async () => {
    for (const status of ["submitting", "submitted", "accepted", "rejected"]) {
      h.state.submissions = [seedCis(status)];
      h.state.cisCalls = [];
      const res = await call();
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.reason).toBe("not_submittable");
      expect(h.state.cisCalls).toHaveLength(0);
    }
  });

  it("TENANT ISOLATION: another org's submission id is not found", async () => {
    h.state.submissions = [seedCis("prepared", "org-OTHER", "cis-1")];
    const res = await call("cis-1");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("not_found");
    expect(h.state.cisCalls).toHaveLength(0);
  });

  it("business rejection → 'rejected'; transient → reverted 'prepared'; terminal → connection 'error'", async () => {
    h.state.submissions = [seedCis("prepared")];
    h.state.cisImpl = async () => ({ ok: false, reason: "error", message: "bad month", rejected: true });
    let res = await call();
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("rejected");
    expect(h.state.submissions[0]!.status).toBe("rejected");

    h.state.submissions = [seedCis("prepared")];
    h.state.cisImpl = async () => ({ ok: false, reason: "error", message: "503" });
    res = await call();
    expect(res.ok).toBe(false);
    expect(h.state.submissions[0]!.status).toBe("prepared");
    expect(h.state.connections[0]!.status).toBe("connected");

    h.state.submissions = [seedCis("prepared")];
    h.state.cisImpl = async () => ({ ok: false, reason: "error", message: "grant dead", terminal: true });
    res = await call();
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.terminal).toBe(true);
    expect(h.state.submissions[0]!.status).toBe("prepared");
    expect(h.state.connections[0]!.status).toBe("error");
  });
});

// ---------------------------------------------------------------------------
// RTI FPS orchestrator
// ---------------------------------------------------------------------------

describe("submitFpsReturn", () => {
  const call = (id = "fps-1") => submitFpsReturn({ orgId: ORG, submissionId: id, submittedBy: "user-1" });

  it("REFUSES when dark — no adapter call", async () => {
    h.state.submissions = [seedFps("prepared")];
    h.state.connectable = false;
    const res = await call();
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("not_configured");
    expect(h.state.fpsCalls).toHaveLength(0);
  });

  it("advances prepared → accepted, persists the correlation id, hands decrypted tokens + employer ref", async () => {
    h.state.submissions = [seedFps("prepared")];
    const res = await call();
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.status).toBe("accepted");
    const row = h.state.submissions[0]!;
    expect(row.status).toBe("accepted");
    expect(row.hmrc_form_bundle_number).toBe("CID-fps");
    expect(row.hmrc_processing_date).toBe("2026-07-31T09:00:00.000Z");
    const args = h.state.fpsCalls[0] as { employerRef: string; tokens: { accessToken: string } };
    expect(args.employerRef).toBe("123/AB456");
    expect(args.tokens.accessToken).toBe("dec(ct-access)");
  });

  it("wrong-kind submission is refused (a VAT/CIS row is not submittable as FPS)", async () => {
    h.state.submissions = [seedCis("prepared", ORG, "fps-1")]; // kind 'cis300' under the FPS id
    const res = await call("fps-1");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("not_submittable");
    expect(h.state.fpsCalls).toHaveLength(0);
  });

  it("refuses a payload with no employer PAYE reference BEFORE any claim", async () => {
    const bad = seedFps("prepared");
    bad.payload = { employer: { employerPayeReference: null }, employees: [] };
    h.state.submissions = [bad];
    const res = await call();
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("not_submittable");
    expect(h.state.fpsCalls).toHaveLength(0);
  });

  it("re-encrypts + persists refreshed tokens returned by the adapter", async () => {
    h.state.submissions = [seedFps("prepared")];
    h.state.fpsImpl = async () => ({
      ok: true,
      receipt: { processingDate: null, submissionReference: "CID-fps-9" },
      refreshed: { accessToken: "new-access", refreshToken: "new-refresh", expiresAt: "2100-01-01T00:00:00Z" },
    });
    await call();
    const conn = h.state.connections[0]!;
    expect(conn.access_token).toBe("enc(new-access)");
    expect(conn.refresh_token).toBe("enc(new-refresh)");
  });

  it("TENANT ISOLATION: another org's FPS id is not found", async () => {
    h.state.submissions = [seedFps("prepared", "org-OTHER", "fps-1")];
    const res = await call("fps-1");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("not_found");
    expect(h.state.fpsCalls).toHaveLength(0);
  });
});
