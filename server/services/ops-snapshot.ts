import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { getEmailQueueStats } from "@/server/services/notification-email-queue-stats";

/**
 * /admin/ops snapshot — system health pull.
 *
 * One read per concern, no joins. Service-role only; the page that
 * calls it is HQ-gated at the layout level. The snapshot is the
 * single source of truth for the "OPS GREEN / AMBER / RED" widget.
 *
 * Env reporting is presence-only (does the env var exist?). We never
 * echo the value — the directive's "do not expose secrets" rule.
 */

export const CRON_ROUTES = [
  "alerts-poll",
  "notifications-drain",
  "health-recompute",
  "invoice-reminders",
  "quote-followup",
] as const;
export type CronRouteName = (typeof CRON_ROUTES)[number];

export type EnvVarStatus = {
  name: string;
  /** Whether process.env[name] is a non-empty string. */
  present: boolean;
  /** "required" gates the system GREEN/AMBER status; "optional" doesn't. */
  required: boolean;
  /** Human-readable note shown when missing. */
  hint: string;
};

export type CronRouteHealth = {
  route: CronRouteName;
  /** Most recent run timestamp, regardless of ok/fail. */
  last_run_at: string | null;
  /** Most recent SUCCESSFUL run timestamp. */
  last_ok_at: string | null;
  /** Most recent run's status. */
  last_ok: boolean | null;
  /** Most recent failure reason, if last_ok === false. */
  last_error: string | null;
  /** Most recent run's duration in ms. */
  last_duration_ms: number | null;
  /** Total runs in the last 7 days. */
  runs_7d: number;
  /** Failures in the last 7 days. */
  failures_7d: number;
};

export type RecentCronFailure = {
  id: string;
  route: string;
  started_at: string;
  error_message: string | null;
  duration_ms: number | null;
};

export type OpsSnapshot = {
  /** Overall traffic-light status. */
  status: "green" | "amber" | "red";
  /** One-line summary the page renders above the tiles. */
  summary: string;
  env: ReadonlyArray<EnvVarStatus>;
  email: Awaited<ReturnType<typeof getEmailQueueStats>>;
  crons: ReadonlyArray<CronRouteHealth>;
  recent_failures: ReadonlyArray<RecentCronFailure>;
};

/**
 * The env vars CrewFlow actually depends on. The flag `required`
 * means "we'll mark ops AMBER if missing". Service-role + Supabase
 * keys are required server-side but checking them here would just
 * tell us the app couldn't have started — they're inherently
 * "present" if this code runs. We list them explicitly anyway so
 * the dashboard's auditability is complete.
 */
const TRACKED_ENV: ReadonlyArray<Omit<EnvVarStatus, "present">> = [
  {
    name: "NEXT_PUBLIC_APP_URL",
    required: true,
    hint: "Base URL for callbacks + public links.",
  },
  {
    name: "NEXT_PUBLIC_SUPABASE_URL",
    required: true,
    hint: "Supabase project URL.",
  },
  {
    name: "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    required: true,
    hint: "Supabase anon key.",
  },
  {
    name: "SUPABASE_SERVICE_ROLE_KEY",
    required: true,
    hint: "Service-role key. Required for cron + HQ.",
  },
  {
    name: "CRON_SECRET",
    required: true,
    hint: "Bearer token Vercel cron uses to authenticate.",
  },
  {
    name: "RESEND_API_KEY",
    required: false,
    hint: "Resend API key. Without this, emails are skipped (not failed).",
  },
  {
    name: "CREWFLOW_INTERNAL_ORG_ID",
    required: false,
    hint: "Internal org uuid. Without this, demo bookings still save + email, but the in-app HQ bell is silent.",
  },
  {
    name: "ANTHROPIC_API_KEY",
    required: false,
    hint: "Required for Migration OS OCR on PDFs/images. Deterministic flows still work without it.",
  },
];

function readEnv(): ReadonlyArray<EnvVarStatus> {
  return TRACKED_ENV.map((e) => {
    const value = process.env[e.name];
    return {
      name: e.name,
      required: e.required,
      hint: e.hint,
      present: typeof value === "string" && value.length > 0,
    };
  });
}

type CronRunRow = {
  id: string;
  route: string;
  started_at: string;
  completed_at: string | null;
  ok: boolean | null;
  error_message: string | null;
  duration_ms: number | null;
};

/**
 * Pull cron_runs telemetry for all 5 routes in batched form. One
 * query for the recent-rolling stats, one for the most-recent row
 * per route, one for the recent-failures list.
 */
async function readCronHealth(
  admin: ReturnType<typeof createAdminClient>,
): Promise<{
  per_route: ReadonlyArray<CronRouteHealth>;
  recent_failures: ReadonlyArray<RecentCronFailure>;
}> {
  type CronTable = {
    select: (cols: string) => {
      gte: (k: string, v: string) => {
        order: (k: string, opts: { ascending: boolean }) => Promise<{
          data: CronRunRow[] | null;
          error: { message: string } | null;
        }>;
      };
      in: (k: string, v: ReadonlyArray<string>) => {
        order: (k: string, opts: { ascending: boolean }) => {
          limit: (n: number) => Promise<{
            data: CronRunRow[] | null;
            error: { message: string } | null;
          }>;
        };
      };
      eq: (k: string, v: unknown) => {
        order: (k: string, opts: { ascending: boolean }) => {
          limit: (n: number) => Promise<{
            data: CronRunRow[] | null;
            error: { message: string } | null;
          }>;
        };
      };
    };
  };

  const tbl = admin.from("cron_runs" as never) as unknown as CronTable;

  const sevenDaysAgo = new Date(
    Date.now() - 7 * 86_400_000,
  ).toISOString();

  // Pull the last 7 days of runs — cheap and gives us rolling stats.
  const recent7Res = await tbl
    .select("id, route, started_at, completed_at, ok, error_message, duration_ms")
    .gte("started_at", sevenDaysAgo)
    .order("started_at", { ascending: false });
  const recent7 = recent7Res.data ?? [];

  const per_route: CronRouteHealth[] = CRON_ROUTES.map((route) => {
    const runs = recent7.filter((r) => r.route === route);
    const latest = runs[0] ?? null;
    const latestOk = runs.find((r) => r.ok === true) ?? null;
    return {
      route,
      last_run_at: latest?.started_at ?? null,
      last_ok_at: latestOk?.started_at ?? null,
      last_ok: latest?.ok ?? null,
      last_error: latest?.ok === false ? latest.error_message : null,
      last_duration_ms: latest?.duration_ms ?? null,
      runs_7d: runs.length,
      failures_7d: runs.filter((r) => r.ok === false).length,
    };
  });

  // Recent failures list — top 10 across all routes.
  const failures: RecentCronFailure[] = recent7
    .filter((r) => r.ok === false)
    .slice(0, 10)
    .map((r) => ({
      id: r.id,
      route: r.route,
      started_at: r.started_at,
      error_message: r.error_message,
      duration_ms: r.duration_ms,
    }));

  return { per_route, recent_failures: failures };
}

export async function buildOpsSnapshot(): Promise<OpsSnapshot> {
  const admin = createAdminClient();
  const env = readEnv();
  const [email, cronHealth] = await Promise.all([
    getEmailQueueStats(),
    readCronHealth(admin),
  ]);

  // Compute traffic-light status.
  const missingRequired = env.filter((e) => e.required && !e.present);
  const anyCronFailing = cronHealth.per_route.some(
    (c) => c.failures_7d > 0 && (c.runs_7d ?? 0) > 0,
  );
  const emailBacklog = email.queued > 50 || email.permanent_failures > 0;

  let status: OpsSnapshot["status"];
  let summary: string;
  if (missingRequired.length > 0) {
    status = "red";
    summary = `Missing required env vars: ${missingRequired
      .map((e) => e.name)
      .join(", ")}.`;
  } else if (anyCronFailing || emailBacklog) {
    status = "amber";
    const reasons: string[] = [];
    if (anyCronFailing) {
      const list = cronHealth.per_route
        .filter((c) => c.failures_7d > 0)
        .map((c) => `${c.route} (${c.failures_7d} fail)`)
        .join(", ");
      reasons.push(`cron failures in last 7d: ${list}`);
    }
    if (emailBacklog) {
      reasons.push(
        `email queue ${email.queued} queued · ${email.permanent_failures} permanent failures`,
      );
    }
    summary = reasons.join(" · ");
  } else {
    status = "green";
    summary = "All systems nominal.";
  }

  return {
    status,
    summary,
    env,
    email,
    crons: cronHealth.per_route,
    recent_failures: cronHealth.recent_failures,
  };
}
