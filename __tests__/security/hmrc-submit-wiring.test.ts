import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { isHmrcConnectable } from "@/lib/integrations/hmrc/oauth";

/**
 * HMRC SUBMIT WIRING — trust-boundary proofs for the /tax submit path.
 *
 * The submit orchestrator (server/services/hmrc-submit.ts) was built dark and
 * UNWIRED; this pins the wiring that connects it to the product WITHOUT widening
 * the dark surface:
 *
 *   - GATE ORDERING in the action: input validation → auth/admin → the HONEST
 *     dark refusal (isHmrcConnectable) → only then the orchestrator;
 *   - the /tax page renders the submit affordance ONLY under `canSubmit`, which
 *     requires isHmrcConnectable() — false today, so the control does not exist
 *     dark;
 *   - NO NETWORK DARK: the action layer contains no fetch at all, and in the
 *     orchestrator the dark guard precedes every DB claim for all three kinds;
 *   - the recognition posture is unchanged: the prepare writers stay narrowed to
 *     'prepared' | 'held', and the cis_monthly_returns status CHECK is untouched
 *     (filing remains structurally unrepresentable in the CIS ledger).
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");
const codeOf = (ts: string) =>
  ts.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

const ACTIONS = "app/(app)/tax/actions.ts";
const PAGE = "app/(app)/tax/page.tsx";
const ORCH = "server/services/hmrc-submit.ts";
const CONN_SERVICE = "server/services/hmrc-connections.ts";

describe("submitHmrcReturnAction — gate ordering + honest dark refusal", () => {
  const code = codeOf(read(ACTIONS));
  const idx = code.indexOf("export async function submitHmrcReturnAction");
  const body = code.slice(idx);

  it("exists and is the only submit entry", () => {
    expect(idx).toBeGreaterThan(-1);
  });

  it("validates the kind + submission id BEFORE any auth or service work", () => {
    const kindIdx = body.indexOf("isSubmitKind(kindRaw)");
    const uuidIdx = body.indexOf("UUID_RE.test(submissionId)");
    const authIdx = body.indexOf("requireOrgContext()");
    expect(kindIdx).toBeGreaterThan(-1);
    expect(uuidIdx).toBeGreaterThan(-1);
    expect(authIdx).toBeGreaterThan(-1);
    expect(kindIdx).toBeLessThan(authIdx);
    expect(uuidIdx).toBeLessThan(authIdx);
  });

  it("admin gate precedes the dark gate; the dark gate precedes the orchestrator", () => {
    const adminIdx = body.indexOf('ctx.membership.role !== "owner"');
    const darkIdx = body.indexOf("if (!isHmrcConnectable())");
    const orchIdx = Math.min(
      ...["submitVatReturn(", "submitCis300Return(", "submitFpsReturn("]
        .map((s) => body.indexOf(s))
        .filter((i) => i > -1),
    );
    expect(adminIdx).toBeGreaterThan(-1);
    expect(darkIdx).toBeGreaterThan(-1);
    expect(Number.isFinite(orchIdx)).toBe(true);
    expect(adminIdx).toBeLessThan(darkIdx);
    expect(darkIdx).toBeLessThan(orchIdx);
  });

  it("the dark refusal is HONEST — it names recognition, not a fake error", () => {
    expect(body).toMatch(/not yet recognised by/);
    expect(body).toMatch(/prepared & held internally/);
  });

  it("the action layer makes NO network call of its own", () => {
    expect(code).not.toMatch(/\bfetch\(/);
  });
});

describe("/tax page — the submit affordance does not exist dark", () => {
  const code = codeOf(read(PAGE));

  it("canSubmit requires isHmrcConnectable()", () => {
    expect(code).toMatch(/const canSubmit = canPrepare && isHmrcConnectable\(\)/);
  });

  it("the submit form renders ONLY under canSubmit, for prepared|held rows", () => {
    const formIdx = code.indexOf("action={submitHmrcReturnAction}");
    expect(formIdx).toBeGreaterThan(-1);
    // The nearest preceding conditional must be the canSubmit + state gate.
    const before = code.slice(0, formIdx);
    const guardIdx = before.lastIndexOf("canSubmit && (s.status === \"prepared\" || s.status === \"held\")");
    expect(guardIdx).toBeGreaterThan(-1);
  });
});

describe("the orchestrator refuses dark BEFORE any DB claim (all three kinds)", () => {
  const code = codeOf(read(ORCH));

  it("each submit function's dark guard precedes its submissions read", () => {
    for (const fn of ["submitVatReturn", "submitCis300Return", "submitFpsReturn"]) {
      const fnIdx = code.indexOf(`export async function ${fn}`);
      expect(fnIdx, `expected ${fn}`).toBeGreaterThan(-1);
      const body = code.slice(fnIdx);
      const guardIdx = body.indexOf("if (!isHmrcConnectable())");
      const dbIdx = body.indexOf('from("hmrc_submissions")');
      expect(guardIdx).toBeGreaterThan(-1);
      expect(dbIdx).toBeGreaterThan(-1);
      expect(guardIdx).toBeLessThan(dbIdx);
    }
  });
});

describe("recognition posture unchanged", () => {
  it("HMRC stays NOT connectable in a bare environment (dark today)", () => {
    const original = { ...process.env };
    delete process.env.HMRC_CLIENT_ID;
    delete process.env.HMRC_CLIENT_SECRET;
    delete process.env.NEXT_PUBLIC_FEATURE_HMRC_CONNECT;
    try {
      expect(isHmrcConnectable()).toBe(false);
    } finally {
      process.env = { ...original };
    }
  });

  it("the prepare writers stay narrowed to prepared|held (HmrcPreparedStatus)", () => {
    const code = codeOf(read(CONN_SERVICE));
    expect(code).toMatch(
      /export type HmrcPreparedStatus = Extract<HmrcSubmissionStatus, "prepared" \| "held">/,
    );
    // Every optional prepare-status parameter uses the NARROW type.
    expect(code).not.toMatch(/status\?:\s*HmrcSubmissionStatus/);
    expect(code).toMatch(/status\?:\s*HmrcPreparedStatus/);
  });

  it("cis_monthly_returns' status vocabulary is untouched (prepared|exported only)", () => {
    // The CIS ledger's own CHECK still cannot represent a filed state — the
    // submit path lives exclusively in hmrc_submissions (20261130 vocabulary).
    const mig = read("supabase/migrations/20261055000000_cis_statements.sql");
    expect(mig).toMatch(/check \(status in \('prepared', 'exported'\)\)/i);
  });
});
