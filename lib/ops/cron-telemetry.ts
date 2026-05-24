import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Wrap a cron route's payload with telemetry. Writes one row to
 * `cron_runs` capturing route name, start/end stamps, success, the
 * route's return-value summary, and the failure detail if any.
 *
 * Never throws — telemetry failures are logged but swallowed so a
 * transient ops-table outage can't break the actual cron run.
 *
 * Usage:
 *
 *   export async function GET(request: Request) {
 *     if (!isCronAuthorised(request)) return Response.json({...}, {status: 401});
 *     const result = await withCronTelemetry("alerts-poll", async () => {
 *       const summary = await runAlertsScheduler();
 *       return { ok: true, summary };
 *     });
 *     return Response.json(result.payload, { status: result.status });
 *   }
 *
 * The wrapper guarantees the route ALWAYS returns a JSON-safe value
 * (matches the directive's "returns useful JSON" rule) — on a thrown
 * error the result.payload is `{ ok: false, error }` with status 500.
 */

export type CronTelemetryResult = {
  status: number;
  payload: Record<string, unknown>;
};

export async function withCronTelemetry(
  route: string,
  fn: () => Promise<Record<string, unknown>>,
): Promise<CronTelemetryResult> {
  const startedAt = new Date();
  let ok = false;
  let payload: Record<string, unknown> = {};
  let status = 200;
  let errorMessage: string | null = null;
  let errorDetail: string | null = null;

  try {
    const result = await fn();
    ok = result.ok !== false;
    payload = result;
  } catch (e) {
    ok = false;
    errorMessage = e instanceof Error ? e.message : String(e);
    errorDetail =
      e instanceof Error && e.stack
        ? e.stack.split("\n").slice(0, 8).join("\n")
        : null;
    status = 500;
    payload = { ok: false, error: errorMessage };
    console.error(`[cron/${route}] uncaught error`, {
      message: errorMessage,
      detail: errorDetail,
    });
  }

  const completedAt = new Date();
  const durationMs = completedAt.getTime() - startedAt.getTime();

  // Best-effort write — never let telemetry break the cron run.
  try {
    const admin = createAdminClient();
    await (admin.from("cron_runs" as never) as unknown as {
      insert: (row: unknown) => Promise<{ error: { message: string } | null }>;
    }).insert({
      route,
      started_at: startedAt.toISOString(),
      completed_at: completedAt.toISOString(),
      ok,
      summary: payload as unknown,
      error_message: errorMessage,
      error_detail: errorDetail,
      duration_ms: durationMs,
    });
  } catch (e) {
    console.error("[cron-telemetry] failed to record run", {
      route,
      err: e instanceof Error ? e.message : String(e),
    });
  }

  return { status, payload };
}
