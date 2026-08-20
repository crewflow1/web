import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { composeFpsReturn, RTI_NO_FILING_NOTICE } from "@/lib/integrations/hmrc/rti-fps";

/**
 * HMRC RTI FPS composer (20261156) — trust-boundary proofs. DARK.
 *
 * The FPS composer folds a finalised payroll run's stored figures into the RTI
 * Full Payment Submission shape and freezes it in hmrc_submissions (kind 'fps',
 * status prepared|held). It mirrors the VAT / CIS300 composers EXACTLY: pure,
 * refuse-while-dark, and NO transmission path — RTI filing stays legally
 * recognition-gated. These proofs pin that posture against the real source.
 *
 * Section 1: the composer REFUSES while dark (two-switch) and NEVER asserts the
 *            final-submission declaration.
 * Section 2: NO live transmission path — rti-fps.ts contains no fetch/network, and
 *            no other file gained one for the FPS.
 * Section 3: the migration widens `kind` ADDITIVELY and preserves append-only
 *            immutability (no new table, no tenant update/delete policy).
 * Section 4: the prepare/hold service is org-pinned, loud, finalised-only; the
 *            action is admin-gated.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

const FPS = "lib/integrations/hmrc/rti-fps.ts";
const MIG = "supabase/migrations/20261156000000_rti_fps.sql";
const SERVICE = "server/services/hmrc-connections.ts";
const ACTION = "app/(app)/payroll/actions.ts";

/** Strip SQL line comments so NEGATIVE assertions test EXECUTABLE statements. */
const sqlOnly = (s: string) =>
  s
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("--");
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join("\n");

/** Strip TS/JS comments, for source contracts about real code. */
const codeOf = (ts: string) =>
  ts.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

const OAUTH_ENV = ["HMRC_CLIENT_ID", "HMRC_CLIENT_SECRET", "NEXT_PUBLIC_FEATURE_HMRC_CONNECT"];

// ---------------------------------------------------------------------------
// 1. THE COMPOSER REFUSES WHILE DARK
// ---------------------------------------------------------------------------

describe("composeFpsReturn refuses while dark (two-switch)", () => {
  const original = { ...process.env };
  beforeEach(() => {
    for (const k of OAUTH_ENV) delete process.env[k];
  });
  afterEach(() => {
    process.env = { ...original };
  });

  it("REFUSES to build an FPS while dark (no credentials + flag)", () => {
    const res = composeFpsReturn({
      payDate: "2026-07-31",
      paymentFrequency: "monthly",
      employees: [
        { employeeId: "u1", grossPay: 3000, payeDeducted: 400, employeeNic: 200, netPay: 2400 },
      ],
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("not_configured");
  });

  it("credentials WITHOUT the feature flag still refuse (two-switch)", () => {
    process.env.HMRC_CLIENT_ID = "id";
    process.env.HMRC_CLIENT_SECRET = "secret";
    const res = composeFpsReturn({
      payDate: "2026-07-31",
      paymentFrequency: "monthly",
      employees: [{ employeeId: "u1", grossPay: 1, payeDeducted: 0, employeeNic: 0, netPay: 1 }],
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("not_configured");
  });

  it("the internal prepare/hold seam builds WITHOUT a connection but never asserts a declaration", () => {
    const res = composeFpsReturn(
      {
        payDate: "2026-07-31",
        paymentFrequency: "monthly",
        employees: [{ employeeId: "u1", grossPay: 3000, payeDeducted: 400, employeeNic: 200, netPay: 2400 }],
      },
      { allowInternalPrepare: true },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.payload.finalSubmission).toBe(false);
  });

  it("the no-filing notice names the recognition gate and denies filing", () => {
    expect(RTI_NO_FILING_NOTICE).toMatch(/recognition/i);
    expect(RTI_NO_FILING_NOTICE).toMatch(/does not file/i);
  });
});

// ---------------------------------------------------------------------------
// 2. NO LIVE TRANSMISSION PATH — the composer is pure, nothing POSTs an FPS
// ---------------------------------------------------------------------------

describe("FPS has no live transmission path", () => {
  it("rti-fps.ts contains NO fetch / network call (pure composer)", () => {
    const code = codeOf(read(FPS));
    expect(code).not.toMatch(/\bfetch\(/);
    expect(code).not.toMatch(/https?:\/\//i);
    // The dark guard precedes any assembly and gates on the shared HMRC switch.
    expect(code).toMatch(/isHmrcConnectable\(\)/);
    expect(code).toMatch(/allowInternalPrepare/);
  });

  it("the composer, prepare/hold service and payroll action contact no HMRC host", () => {
    // The FPS SUBMIT adapter now exists, but it lives in a SEPARATE file
    // (lib/integrations/hmrc/rti-fps-submit.ts, proven structurally dark in
    // __tests__/security/hmrc-submit-adapters.test.ts). The composer, the
    // prepare/hold service and the payroll action stay PURE — none POST to an
    // HMRC endpoint or name the RTI transaction host.
    for (const f of [FPS, SERVICE, ACTION]) {
      const code = codeOf(read(f));
      expect(code, `${f} must contact no HMRC host`).not.toMatch(/service\.gov\.uk|hmrc\.gov\.uk/i);
      expect(code, `${f} must contain no fetch`).not.toMatch(/\bfetch\(/);
    }
  });

  it("the FPS composer never carries a National Insurance number (staff_secrets stays out)", () => {
    const code = codeOf(read(FPS));
    expect(code).not.toMatch(/ni_number|national_insurance|staff_secrets/i);
  });
});

// ---------------------------------------------------------------------------
// 3. THE MIGRATION — additive kind widen, append-only preserved
// ---------------------------------------------------------------------------

describe("the FPS migration is additive and keeps append-only immutability", () => {
  const mig = sqlOnly(read(MIG));

  it("widens the kind CHECK to include 'fps' (keeps vat_return + cis300)", () => {
    expect(mig).toMatch(
      /check \(kind in \('vat_return', 'cis300', 'fps'\)\)/i,
    );
  });

  it("creates NO new table", () => {
    expect(mig).not.toMatch(/create table/i);
  });

  it("adds NO tenant policy (transitions/immutability inherited from 20261099)", () => {
    expect(mig).not.toMatch(/create policy/i);
    expect(mig).not.toMatch(/for update/i);
    expect(mig).not.toMatch(/for delete/i);
  });

  it("defines NO security-definer function (nothing to grant/revoke)", () => {
    expect(mig).not.toMatch(/security definer/i);
    expect(mig).not.toMatch(/\bgrant\b/i);
  });
});

// ---------------------------------------------------------------------------
// 4. THE PREPARE/HOLD SERVICE + ACTION — org-pinned, loud, gated
// ---------------------------------------------------------------------------

describe("prepareFpsReturn is org-pinned, loud, finalised-only; action is gated", () => {
  const svc = codeOf(read(SERVICE));
  const act = codeOf(read(ACTION));

  it("the service pins org_id on the run read and reads loudly", () => {
    // The FPS prepare block pins org_id and fails loud.
    expect(svc).toMatch(/prepareFpsReturn/);
    expect(svc).toMatch(/\.eq\(\s*["']org_id["']\s*,\s*orgId\s*\)/);
    expect(svc).toMatch(/throw readFailure\(/);
  });

  it("the service composes with the internal prepare seam and freezes kind 'fps'", () => {
    expect(svc).toMatch(/composeFpsReturn\(/);
    expect(svc).toMatch(/allowInternalPrepare:\s*true/);
    expect(svc).toMatch(/kind:\s*["']fps["']/);
  });

  it("the service files only a FINALISED run", () => {
    expect(svc).toMatch(/status !== "finalised"/);
  });

  it("the action gates on owner/admin and pins the active org", () => {
    expect(act).toMatch(/prepareFpsRunAction/);
    expect(act).toMatch(/isOwnerOrAdmin\(ctx\.membership\.role\)/);
    expect(act).toMatch(/orgId:\s*ctx\.org\.id/);
  });

  it("the service never selects a token column onto a tenant surface", () => {
    expect(svc).not.toMatch(/access_token/i);
    expect(svc).not.toMatch(/refresh_token/i);
  });
});
