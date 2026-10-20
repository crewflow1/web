import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { fetchAllRows } from "@/lib/supabase/paginate";
import { readFailure } from "@/lib/supabase/read-failure";
import { getEmailQueueStats } from "@/server/services/notification-email-queue-stats";
import {
  CRON_ROUTES,
  cronFamily,
  type CronFamily,
  type CronRouteName,
} from "@/lib/ops/cron-routes";

/**
 * /admin/ops snapshot — system health pull.
 *
 * One read per concern, no joins. Service-role only; the page that
 * calls it is HQ-gated at the layout level. The snapshot is the
 * single source of truth for the "OPS GREEN / AMBER / RED" widget.
 *
 * Env reporting is presence-only (does the env var exist?). We never
 * echo the value — the directive's "do not expose secrets" rule.
 *
 * Cron coverage is DERIVED from vercel.json via lib/ops/cron-routes —
 * every scheduled cron is monitored here; a hard-coded roster is the
 * drift bug this replaced (8 tracked while vercel.json had 45).
 */

export { CRON_ROUTES };
export type { CronRouteName };

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
  /** Readability grouping for the ops panel (drains/syncs/hq/maintenance). */
  family: CronFamily;
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

/**
 * Off-platform encrypted-backup health, from `ops_backup_runs`.
 * The Mac scheduler is only an execution mechanism; this is the source of truth.
 * green ≤7d since last validated success · amber >7d · red >10d or last run failed
 * or no successful backup on record.
 */
export type BackupHealth = {
  status: "green" | "amber" | "red";
  last_success_at: string | null;
  last_success_age_hours: number | null;
  last_run_status: "running" | "success" | "failed" | null;
  last_run_at: string | null;
  migration_tip: string | null;
  upload_status: string | null;
  summary: string;
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
  /** Off-platform backup DR health. */
  backup: BackupHealth;
  /**
   * Optional deep link to the Sentry project dashboard, from the
   * SENTRY_DASHBOARD_URL env var. A plain URL — not a secret — rendered
   * as a link on /admin/ops when set; null when unset.
   */
  sentry_url: string | null;
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
  {
    name: "CHANNEL_INBOUND_SECRET",
    required: false,
    hint: "Shared bearer token for /api/receptionist/inbound. Required only when external channel adapters (Twilio, WhatsApp Business, Meta) are wired.",
  },
  // Live-activation programme: the vars below were LIVE in prod but invisible
  // to this panel — presence-only rows so ops truth covers what actually runs.
  {
    name: "STRIPE_SECRET_KEY",
    required: false,
    hint: "SaaS billing checkout + /api/webhooks/stripe. Live-mode badge at /api/admin/stripe/verify.",
  },
  {
    name: "STRIPE_WEBHOOK_SECRET",
    required: false,
    hint: "Signature secret for /api/webhooks/stripe. Missing ⇒ webhook 503s (retry-safe).",
  },
  {
    name: "SENTRY_DSN",
    required: false,
    hint: "Server/edge error monitoring. Unset ⇒ Sentry initialises nothing.",
  },
  {
    name: "CREWFLOW_SUPERADMIN_EMAILS",
    required: false,
    hint: "HQ allowlist. Empty ⇒ /admin 404s for everyone (Stripe admin actions become untriggerable).",
  },
  {
    name: "MAINTENANCE_MODE",
    required: false,
    hint: "Global kill switch — \"on\" returns retry-safe 503s platform-wide. Presence here means it is ACTIVE.",
  },
  {
    name: "MAINTENANCE_BYPASS",
    required: false,
    hint: "Operator bypass token for the maintenance 503. Only meaningful while MAINTENANCE_MODE is on.",
  },
  {
    name: "VAPID_PUBLIC_KEY",
    required: false,
    hint: "Web-push channel (pairs with VAPID_PRIVATE_KEY). Unset ⇒ push enqueues nothing.",
  },
  // 2026-10 env-contract census: vars that run (or can run) in prod but were
  // invisible to this panel — presence-only rows so ops truth stays complete.
  {
    name: "KV_REST_API_URL",
    required: false,
    hint: "Vercel KV / Upstash cache endpoint (pairs with KV_REST_API_TOKEN). Unset ⇒ caching no-ops (miss, never an error).",
  },
  {
    name: "KV_REST_API_TOKEN",
    required: false,
    hint: "Vercel KV / Upstash cache token (pairs with KV_REST_API_URL).",
  },
  {
    name: "COMPANIES_HOUSE_API_KEY",
    required: false,
    hint: "HQ research + lead sourcing Companies House probes. Unset ⇒ those probes skip (dark).",
  },
  {
    name: "GITHUB_TOKEN",
    required: false,
    hint: "CTO AI read-only engineering feed (pairs with GITHUB_REPO). Unset ⇒ adapter refuses before fetch.",
  },
  {
    name: "VERCEL_TOKEN",
    required: false,
    hint: "CTO AI deployment telemetry. Unset ⇒ adapter refuses before fetch.",
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
 * Pull cron_runs telemetry for EVERY scheduled route in batched form:
 * one 7-day window query serves the rolling stats, the most-recent-run
 * flags, and the recent-failures list for the whole roster.
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
        order: (k: string, opts: { ascending: boolean }) => {
          order: (k2: string, opts2: { ascending: boolean }) => {
            range: (from: number, to: number) => Promise<{
              data: CronRunRow[] | null;
              error: { message: string } | null;
            }>;
          };
        };
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

  // Pull the last 7 days of runs, F-1 PAGED to the FULL window (fetchAllRows,
  // stable started_at+id ordering). The previous bare read was silently
  // clamped to PostgREST's 1000-row cap — 45 routes over 7 days exceed that
  // easily, so runs_7d, failure counts and last-ok flags were computed over
  // roughly the newest day and were WRONG for most of the roster. LOUD on
  // failure: an ops panel rendering healthy zeros over a broken read is
  // fabricated health.
  const recent7Res = await fetchAllRows<CronRunRow>(
    (from, to) =>
      tbl
        .select("id, route, started_at, completed_at, ok, error_message, duration_ms")
        .gte("started_at", sevenDaysAgo)
        .order("started_at", { ascending: false })
        .order("id", { ascending: true })
        .range(from, to) as unknown as PromiseLike<{
        data: CronRunRow[] | null;
        error: unknown;
      }>,
  );
  if (recent7Res.error) {
    throw readFailure("ops-snapshot: cron_runs 7d window", recent7Res.error);
  }
  const recent7 = recent7Res.data;

  const per_route: CronRouteHealth[] = CRON_ROUTES.map((route) => {
    const runs = recent7.filter((r) => r.route === route);
    const latest = runs[0] ?? null;
    const latestOk = runs.find((r) => r.ok === true) ?? null;
    return {
      route,
      family: cronFamily(route),
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

/**
 * Read off-platform backup health from `ops_backup_runs`. Fails toward amber
 * (never false-green) if the table is unreadable.
 */
async function readBackupHealth(
  admin: ReturnType<typeof createAdminClient>,
): Promise<BackupHealth> {
  const base: BackupHealth = {
    status: "red",
    last_success_at: null,
    last_success_age_hours: null,
    last_run_status: null,
    last_run_at: null,
    migration_tip: null,
    upload_status: null,
    summary: "No off-platform backup on record.",
  };
  try {
    const tbl = admin.from("ops_backup_runs" as never) as unknown as {
      select: (c: string) => {
        eq: (k: string, v: string) => {
          order: (
            k: string,
            o: { ascending: boolean },
          ) => {
            limit: (n: number) => Promise<{
              data: Array<Record<string, unknown>> | null;
              error: { message: string } | null;
            }>;
          };
        };
        order: (
          k: string,
          o: { ascending: boolean },
        ) => {
          limit: (n: number) => Promise<{
            data: Array<Record<string, unknown>> | null;
            error: { message: string } | null;
          }>;
        };
      };
    };
    const [succ, last] = await Promise.all([
      tbl
        .select("finished_at,migration_tip,upload_status")
        .eq("status", "success")
        .order("finished_at", { ascending: false })
        .limit(1),
      tbl
        .select("status,started_at")
        .order("started_at", { ascending: false })
        .limit(1),
    ]);
    if (succ.error || last.error) {
      return {
        ...base,
        status: "amber",
        summary: "Backup status unavailable (ops_backup_runs read error).",
      };
    }
    const lastRun = last.data?.[0];
    const lastSuccess = succ.data?.[0];
    const lastRunStatus =
      (lastRun?.status as BackupHealth["last_run_status"]) ?? null;
    const lastRunAt = (lastRun?.started_at as string | undefined) ?? null;
    const lastSuccessAt =
      (lastSuccess?.finished_at as string | undefined) ?? null;
    const ageH =
      lastSuccessAt != null
        ? (Date.now() - new Date(lastSuccessAt).getTime()) / 3_600_000
        : null;

    let status: BackupHealth["status"];
    let summary: string;
    if (lastRunStatus === "failed") {
      status = "red";
      summary = "Last off-platform backup FAILED — investigate immediately.";
    } else if (ageH == null) {
      status = "red";
      summary = "No successful off-platform backup on record.";
    } else if (ageH <= 7 * 24) {
      status = "green";
      summary = `Last validated backup ${Math.round(ageH)}h ago (upload: ${
        (lastSuccess?.upload_status as string) ?? "n/a"
      }).`;
    } else if (ageH <= 10 * 24) {
      status = "amber";
      summary = `Last validated backup ${Math.round(
        ageH / 24,
      )}d ago (>7d) — a scheduled run may have been missed.`;
    } else {
      status = "red";
      summary = `Last validated backup ${Math.round(
        ageH / 24,
      )}d ago (>10d) — backup is STALE.`;
    }
    return {
      status,
      last_success_at: lastSuccessAt,
      last_success_age_hours: ageH == null ? null : Math.round(ageH),
      last_run_status: lastRunStatus,
      last_run_at: lastRunAt,
      migration_tip: (lastSuccess?.migration_tip as string) ?? null,
      upload_status: (lastSuccess?.upload_status as string) ?? null,
      summary,
    };
  } catch {
    return {
      ...base,
      status: "amber",
      summary: "Backup status unavailable (ops_backup_runs query failed).",
    };
  }
}

export async function buildOpsSnapshot(): Promise<OpsSnapshot> {
  const admin = createAdminClient();
  const env = readEnv();
  const [email, cronHealth, backup] = await Promise.all([
    getEmailQueueStats(),
    readCronHealth(admin),
    readBackupHealth(admin),
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
  } else if (backup.status === "red") {
    status = "red";
    summary = `Off-platform backup: ${backup.summary}`;
  } else if (anyCronFailing || emailBacklog || backup.status === "amber") {
    status = "amber";
    const reasons: string[] = [];
    if (anyCronFailing) {
      // Cap the inline roster — with 45 monitored crons an incident could
      // otherwise turn the one-line summary into a paragraph. The full
      // detail is always in the table below.
      const failing = cronHealth.per_route.filter((c) => c.failures_7d > 0);
      const shown = failing
        .slice(0, 6)
        .map((c) => `${c.route} (${c.failures_7d} fail)`)
        .join(", ");
      const more =
        failing.length > 6 ? ` + ${failing.length - 6} more` : "";
      reasons.push(`cron failures in last 7d: ${shown}${more}`);
    }
    if (emailBacklog) {
      reasons.push(
        `email queue ${email.queued} queued · ${email.permanent_failures} permanent failures`,
      );
    }
    if (backup.status === "amber") {
      reasons.push(`off-platform backup: ${backup.summary}`);
    }
    summary = reasons.join(" · ");
  } else {
    status = "green";
    summary = "All systems nominal.";
  }

  // Sentry deep link — a dashboard URL, never a DSN/secret. Presence-only
  // gating: unset ⇒ null ⇒ the page renders nothing.
  const sentryUrl = process.env.SENTRY_DASHBOARD_URL;

  return {
    status,
    summary,
    env,
    email,
    crons: cronHealth.per_route,
    recent_failures: cronHealth.recent_failures,
    backup,
    sentry_url:
      typeof sentryUrl === "string" && sentryUrl.startsWith("https://")
        ? sentryUrl
        : null,
  };
}
