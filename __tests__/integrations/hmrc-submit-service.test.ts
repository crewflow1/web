import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * HMRC MTD VAT — the SUBMIT ORCHESTRATOR state machine (server/services/hmrc-submit.ts).
 *
 * Hermetic: the service-role client is an in-memory fake, the OAuth/token-crypto/
 * submit-adapter modules are mocked, so NO real Supabase and NO real HMRC network
 * is touched. The fraud-header builder runs FOR REAL (pure). The dark invariant is
 * exercised directly (connectable=false ⇒ refuse before any claim or submit); the
 * live-path cases FORCE connectable=true via the mock purely to drive the state
 * machine.
 *
 * Proven here:
 *   - REFUSE when dark (no submit-adapter call, submission untouched).
 *   - REFUSE when the token-encryption key is absent.
 *   - REFUSE when the org is not connected.
 *   - HAPPY PATH: prepared → submitting → accepted, receipt persisted, decrypted
 *     tokens handed to the adapter, refreshed tokens re-encrypted + persisted.
 *   - IDEMPOTENT double-submit: a non-prepared/held return is refused (not_submittable);
 *     re-submitting an already-accepted period never calls the adapter twice.
 *   - HMRC business rejection → status='rejected', error persisted.
 *   - TRANSIENT failure → reverted to 'prepared' (retriable), connection stays live.
 *   - TERMINAL (dead grant) → reverted to 'prepared' AND connection flipped to 'error'.
 */

type Row = Record<string, unknown>;

const h = vi.hoisted(() => {
  const state: {
    connectable: boolean;
    encKey: boolean;
    submissions: Row[];
    connections: Row[];
    submitImpl: (args: unknown) => Promise<Record<string, unknown>>;
    submitCalls: unknown[];
  } = {
    connectable: true,
    encKey: true,
    submissions: [],
    connections: [],
    submitImpl: async () => ({ ok: true, receipt: {} }),
    submitCalls: [],
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
vi.mock("@/lib/integrations/hmrc/vat-submit", () => ({
  submitVatReturnToHmrc: async (args: unknown) => {
    h.state.submitCalls.push(args);
    return h.state.submitImpl(args);
  },
}));

const { submitVatReturn } = await import("@/server/services/hmrc-submit");

const ORG = "org-A";
const SUB = "sub-1";

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
function seedSubmission(status = "prepared") {
  h.state.submissions = [
    {
      id: SUB,
      org_id: ORG,
      connection_id: "conn-1",
      kind: "vat_return",
      status,
      period_key: "2026-01-01",
      payload: { periodKey: "18A1", netVatDue: 60 },
      submitted_at: null,
      submit_error: null,
    },
  ];
}

beforeEach(() => {
  h.state.connectable = true;
  h.state.encKey = true;
  h.state.submitCalls = [];
  h.state.submitImpl = async () => ({
    ok: true,
    receipt: {
      processingDate: "2026-01-31T09:00:00.000Z",
      formBundleNumber: "FB-1",
      chargeRefNumber: "CR-1",
      paymentIndicator: "BANK",
    },
  });
  seedConnected();
  seedSubmission("prepared");
});

const call = () => submitVatReturn({ orgId: ORG, submissionId: SUB, submittedBy: "user-1" });

describe("submitVatReturn — dark + precondition refusals", () => {
  it("REFUSES when HMRC is not connectable — no adapter call, submission untouched", async () => {
    h.state.connectable = false;
    const res = await call();
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("not_configured");
    expect(h.state.submitCalls).toHaveLength(0);
    expect(h.state.submissions[0]!.status).toBe("prepared");
  });

  it("REFUSES when the token-encryption key is absent", async () => {
    h.state.encKey = false;
    const res = await call();
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("not_configured");
    expect(h.state.submitCalls).toHaveLength(0);
  });

  it("REFUSES when the org is not connected", async () => {
    h.state.connections[0]!.status = "disconnected";
    const res = await call();
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("not_connected");
    expect(h.state.submitCalls).toHaveLength(0);
    expect(h.state.submissions[0]!.status).toBe("prepared");
  });

  it("REFUSES a missing submission", async () => {
    h.state.submissions = [];
    const res = await call();
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("not_found");
  });
});

describe("submitVatReturn — happy path", () => {
  it("advances prepared → submitting → accepted, persists the receipt", async () => {
    const res = await call();
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.status).toBe("accepted");
      expect(res.receipt.formBundleNumber).toBe("FB-1");
    }
    const row = h.state.submissions[0]!;
    expect(row.status).toBe("accepted");
    expect(row.hmrc_form_bundle_number).toBe("FB-1");
    expect(row.hmrc_charge_ref_number).toBe("CR-1");
    expect(row.hmrc_processing_date).toBe("2026-01-31T09:00:00.000Z");
    expect(row.submitted_by).toBe("user-1");
  });

  it("hands the adapter DECRYPTED tokens + the org VRN + the frozen payload", async () => {
    await call();
    expect(h.state.submitCalls).toHaveLength(1);
    const args = h.state.submitCalls[0] as {
      vrn: string;
      tokens: { accessToken: string; refreshToken: string | null };
      payload: { periodKey: string };
      fraudHeaders: Record<string, string>;
    };
    expect(args.vrn).toBe("GB123456789");
    expect(args.tokens.accessToken).toBe("dec(ct-access)");
    expect(args.tokens.refreshToken).toBe("dec(ct-refresh)");
    expect(args.payload.periodKey).toBe("18A1");
    // Real fraud-header builder ran.
    expect(args.fraudHeaders["Gov-Client-Connection-Method"]).toBe("WEB_APP_VIA_SERVER");
  });

  it("re-encrypts + persists refreshed tokens returned by the adapter", async () => {
    h.state.submitImpl = async () => ({
      ok: true,
      receipt: { processingDate: null, formBundleNumber: "FB-9", chargeRefNumber: null, paymentIndicator: null },
      refreshed: { accessToken: "new-access", refreshToken: "new-refresh", expiresAt: "2100-01-01T00:00:00Z" },
    });
    await call();
    const conn = h.state.connections[0]!;
    expect(conn.access_token).toBe("enc(new-access)");
    expect(conn.refresh_token).toBe("enc(new-refresh)");
    expect(conn.token_expires_at).toBe("2100-01-01T00:00:00Z");
  });
});

describe("submitVatReturn — idempotent double-submit rejection", () => {
  it("refuses a return already in a terminal/in-flight state (not_submittable)", async () => {
    for (const status of ["submitting", "submitted", "accepted", "rejected"]) {
      seedSubmission(status);
      h.state.submitCalls = [];
      const res = await call();
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.reason).toBe("not_submittable");
      expect(h.state.submitCalls).toHaveLength(0);
    }
  });

  it("submitting the same period twice calls the adapter exactly once", async () => {
    const first = await call();
    expect(first.ok).toBe(true);
    // The row is now 'accepted'. A second submit is refused before any adapter call.
    const second = await call();
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe("not_submittable");
    expect(h.state.submitCalls).toHaveLength(1);
  });
});

describe("submitVatReturn — failure classification", () => {
  it("HMRC business rejection → status='rejected', error persisted", async () => {
    h.state.submitImpl = async () => ({ ok: false, reason: "error", message: "bad period key", rejected: true });
    const res = await call();
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("rejected");
    const row = h.state.submissions[0]!;
    expect(row.status).toBe("rejected");
    expect(row.submit_error).toBe("bad period key");
  });

  it("TRANSIENT failure → reverted to 'prepared' (retriable), connection stays connected", async () => {
    h.state.submitImpl = async () => ({ ok: false, reason: "error", message: "503 upstream" });
    const res = await call();
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe("error");
      expect(res.terminal).toBe(false);
    }
    expect(h.state.submissions[0]!.status).toBe("prepared");
    expect(h.state.submissions[0]!.submit_error).toBe("503 upstream");
    expect(h.state.connections[0]!.status).toBe("connected");
  });

  it("TERMINAL (dead grant) → reverted to 'prepared' AND connection flipped to 'error'", async () => {
    h.state.submitImpl = async () => ({ ok: false, reason: "error", message: "grant dead", terminal: true });
    const res = await call();
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.terminal).toBe(true);
    expect(h.state.submissions[0]!.status).toBe("prepared");
    expect(h.state.connections[0]!.status).toBe("error");
    expect(h.state.connections[0]!.last_error).toBe("grant dead");
  });
});
