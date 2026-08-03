import { NextResponse } from "next/server";
import { isCronAuthorised } from "@/lib/cron/auth";
import { withCronTelemetry } from "@/lib/ops/cron-telemetry";
import {
  bankingProviderReady,
  type BankingProvider,
} from "@/lib/integrations/banking/adapters";
import { resolveActiveBankingProvider } from "@/lib/integrations/banking/oauth";
import { runBankSync } from "@/server/services/bank-sync";

/**
 * Open-Banking bank-feed sync — the cron seam that pulls each connected org's
 * transactions via the aggregator and writes them into the EXISTING
 * bank_statement_lines reconciliation tables (idempotently).
 *
 *   GET /api/cron/bank-sync
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * FCA LEGAL BOUNDARY. Account Information Services are FCA-regulated. This route
 * can never pull live bank data before AISP authorisation + aggregator
 * credentials + the feature flag exist. The dark no-op below is the technical
 * guarantee; the legal gate sits above it.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * DARK ⇒ 204 NO-OP WITH ZERO DATABASE ACCESS. The readiness gate sits BEFORE
 * `withCronTelemetry` on purpose: telemetry writes a `cron_runs` row, and a dark
 * tick that wrote telemetry would burn a row every hour to record that nothing
 * can happen. While dark (always today) every tick is an empty 204 that touches
 * neither the aggregator nor the database. This is why the route is SAFE to keep
 * scheduled in vercel.json before activation: scheduling is not an activation
 * step, so activation stays "credentials + flag only".
 *
 * When live, one tick = `runBankSync`: for the bound provider, list every
 * `connected` org, decrypt-on-use its token (refresh on expiry/401 + retry once),
 * pull the transaction window, and dedupe-insert the new lines under a fresh
 * bank_statements parent. The engine never throws; per-org outcomes are summarised
 * into the telemetry payload.
 *
 * Auth: Bearer CRON_SECRET (lib/cron/auth). Returns 401 otherwise.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A pass may refresh tokens and page transactions for several orgs; give it room.
export const maxDuration = 60;

export async function GET(request: Request): Promise<NextResponse> {
  if (!isCronAuthorised(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // The dark no-op: BEFORE telemetry, before any client — zero DB access.
  const provider = resolveActiveBankingProvider();
  if (!provider || !bankingProviderReady(provider as BankingProvider)) {
    return new NextResponse(null, { status: 204 });
  }

  const { status, payload } = await withCronTelemetry("bank-sync", async () => {
    const summary = await runBankSync();
    const counts: Record<string, number> = {};
    let inserted = 0;
    for (const r of summary.results) {
      counts[r.outcome] = (counts[r.outcome] ?? 0) + 1;
      inserted += r.inserted;
    }
    return {
      ok: summary.results.every((r) => r.ok || r.outcome === "skipped_dark"),
      ran: summary.ran,
      provider: summary.provider,
      orgs: summary.results.length,
      inserted,
      outcomes: counts,
    };
  });
  return NextResponse.json(payload, { status });
}
