import "server-only";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { CRON_ROUTES } from "@/lib/ops/cron-routes";
import { buildOpsSnapshot } from "@/server/services/ops-snapshot";
import { readAutomationHealth } from "@/server/services/automation-dispatcher";
import {
  isEmbeddingActivated,
  isInferenceTierActivated,
  isTierActivated,
} from "@/lib/ai/governor/readiness";
import { TIER_MODEL } from "@/lib/ai/governor/registry";
import { hqBudgetOrgId } from "@/lib/ai/governor/attribution";
import {
  isTranscriptionActivated,
  isTranscriptionModelBound,
} from "@/lib/ai/transcription";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Phase 8 — launch readiness aggregator.
 *
 * Reads the ops snapshot (env + cron + email + telemetry) plus a
 * file-existence check for the migrations / docs the prior phases
 * left behind. Returns a flat list of {phase, status, summary}
 * rows the /admin/launch-checklist page renders.
 *
 * Service-role only. HQ-only page.
 */

export type ChecklistRowStatus = "green" | "amber" | "red";

export type ChecklistRow = {
  id: string;
  label: string;
  status: ChecklistRowStatus;
  summary: string;
  detail?: string;
};

export type LaunchReadiness = {
  overall: ChecklistRowStatus;
  rows: ReadonlyArray<ChecklistRow>;
};

function fileExists(rel: string): boolean {
  return existsSync(resolve(process.cwd(), rel));
}

/**
 * HQ AI attribution — EXISTENCE, not presence (2026-09-10 incident): the env
 * var was set but named an organisation that no longer existed (erased in DR
 * testing), so every HQ-billed AI call fail-closed refused with zero ledger
 * footprint while every presence check stayed green. Presence checks cannot
 * catch a stale id; only the database can.
 */
async function checkHqAttribution(): Promise<ChecklistRow> {
  const orgId = hqBudgetOrgId();
  if (!orgId) {
    return {
      id: "hq-ai-attribution",
      label: "HQ AI attribution",
      status: "amber",
      summary:
        "CREWFLOW_INTERNAL_ORG_ID unset — all HQ-billed AI (research, narratives, drafts, saga decomposition, memory) refuses fail-closed.",
    };
  }
  try {
    const admin = createAdminClient();
    const { data, error } = await admin
      .from("organizations")
      .select("id")
      .eq("id", orgId)
      .maybeSingle();
    if (error) throw error;
    return data
      ? {
          id: "hq-ai-attribution",
          label: "HQ AI attribution",
          status: "green",
          summary: "CREWFLOW_INTERNAL_ORG_ID names an existing organisation — HQ AI spend is attributable.",
        }
      : {
          id: "hq-ai-attribution",
          label: "HQ AI attribution",
          status: "red",
          summary:
            "CREWFLOW_INTERNAL_ORG_ID is set but names NO existing organisation — every HQ-billed AI call is refused fail-closed with no ledger row. Point it at a real org (or recreate the internal org) and redeploy.",
        };
  } catch (e) {
    console.error("[launch-readiness] hq-ai-attribution lookup failed", e);
    return {
      id: "hq-ai-attribution",
      label: "HQ AI attribution",
      status: "amber",
      summary: "Could not verify the internal budget organisation (lookup failed — see server log).",
    };
  }
}

/**
 * Embedding estate — an honest state row so semantic recall's darkness is
 * VISIBLE, not discovered. The estate has two independent switches (the
 * TIER_MODEL.embedding binding+credential, and the DB worker flag) plus a
 * queue whose depth says whether a backfill is pending or stalled. Green only
 * when tier + flag agree ON; amber for every deliberate-dark combination
 * (each named honestly); never red — dark-by-design is not a failure.
 */
async function checkEmbeddingEstate(): Promise<ChecklistRow> {
  const activated = isEmbeddingActivated();
  try {
    const admin = createAdminClient();
    const [{ data: settingsRow, error: sErr }, pendingRes] = await Promise.all([
      admin.from("hq_settings").select("data").eq("id", "singleton").maybeSingle(),
      admin
        .from("hq_memories")
        .select("id", { count: "exact", head: true })
        .is("embedded_at", null)
        .neq("embedding_status", "failed"),
    ]);
    if (sErr) throw sErr;
    if (pendingRes.error) throw pendingRes.error;
    const blob = ((settingsRow as { data?: unknown } | null)?.data ?? {}) as Record<
      string,
      unknown
    >;
    const flag =
      ((blob.memory_embedding as Record<string, unknown> | undefined)?.worker_enabled ??
        false) === true;
    const pending = pendingRes.count ?? 0;
    if (activated && flag) {
      return {
        id: "embedding-estate",
        label: "Embedding estate",
        status: "green",
        summary: `Embedding tier activated and worker enabled — ${pending} row(s) queued.`,
      };
    }
    const parts = [
      activated
        ? "tier activated (binding + credential)"
        : TIER_MODEL.embedding
          ? "tier bound, awaiting its vendor credential (OPENAI_API_KEY)"
          : "tier dark by design (no binding)",
      flag ? "worker flag ON" : "worker flag off",
      `${pending} row(s) queued`,
    ];
    return {
      id: "embedding-estate",
      label: "Embedding estate",
      status: "amber",
      summary: `Semantic recall is dark — ${parts.join("; ")}. Recall serves lexical/structural signals only.`,
    };
  } catch (e) {
    console.error("[launch-readiness] embedding-estate lookup failed", e);
    return {
      id: "embedding-estate",
      label: "Embedding estate",
      status: "amber",
      summary: "Could not verify the embedding estate (lookup failed — see server log).",
    };
  }
}

/**
 * Transcription estate — the STT twin of the embedding-estate row. The tier is
 * ARMED (2026-09-13: TRANSCRIPTION_MODEL + TIER_MODEL.transcription bound to
 * openai/gpt-4o-mini-transcribe), so the honest state is TIER ACTIVATION ×
 * CHANNEL: even fully activated, the only reachable production surface is the
 * super-admin self-test on /admin/ai-costs, because the WhatsApp channel
 * (NEXT_PUBLIC_FEATURE_WHATSAPP + Meta creds) is dark. Green only when tier
 * AND channel are live; amber for every deliberate-dark combination, each
 * named; never red — dark-by-design is not a failure. Includes the last
 * self-test outcome when one is cheaply readable from the audit log.
 */
async function checkTranscriptionEstate(): Promise<ChecklistRow> {
  const tierActivated = isTierActivated("transcription") && isTranscriptionActivated();
  const bound = TIER_MODEL.transcription !== null && isTranscriptionModelBound();
  const channelOn = process.env.NEXT_PUBLIC_FEATURE_WHATSAPP === "true";

  // Last self-test outcome — one indexed read, best-effort. The error is BOUND
  // and thrown into the catch (never discarded — the loud-read shape ledger's
  // rule): a failed lookup logs and omits the fragment, it does not render a
  // false "no self-test yet".
  let selftest = "";
  try {
    const admin = createAdminClient();
    const { data, error } = await admin
      .from("admin_activity_log")
      .select("metadata, created_at")
      .eq("action", "transcription.selftest")
      .order("created_at", { ascending: false })
      .limit(1);
    if (error) throw error;
    const row = (data?.[0] ?? null) as unknown as {
      metadata?: { status?: unknown } | null;
      created_at?: string;
    } | null;
    if (row?.metadata && typeof row.metadata.status === "string") {
      selftest = `; last self-test: ${row.metadata.status}${
        row.created_at ? ` (${row.created_at.slice(0, 10)})` : ""
      }`;
    }
  } catch (e) {
    console.error("[launch-readiness] transcription selftest lookup failed", e);
  }

  if (tierActivated && channelOn) {
    return {
      id: "transcription-estate",
      label: "Transcription estate",
      status: "green",
      summary: `STT tier activated and WhatsApp channel on — voice notes transcribe under the governor${selftest}.`,
    };
  }
  const parts = [
    tierActivated
      ? "provider armed (binding + credential)"
      : bound
        ? "tier bound, awaiting its credential (OPENAI_API_KEY, or the TRANSCRIPTION_API_KEY override)"
        : "tier dark by design (no binding)",
    channelOn
      ? "WhatsApp channel flag on"
      : "application path blocked by WhatsApp/Meta (channel dark — self-test on /admin/ai-costs is the only reachable surface)",
  ];
  return {
    id: "transcription-estate",
    label: "Transcription estate",
    status: "amber",
    summary: `Voice-note transcription — ${parts.join("; ")}${selftest}.`,
  };
}

export async function buildLaunchReadiness(): Promise<LaunchReadiness> {
  const [ops, autoHealth, hqAttribution, embeddingEstate, transcriptionEstate] =
    await Promise.all([
      buildOpsSnapshot(),
      readAutomationHealth(),
      checkHqAttribution(),
      checkEmbeddingEstate(),
      checkTranscriptionEstate(),
    ]);

  // Aggregate cron health.
  const cronFailures7d = ops.crons.reduce((acc, c) => acc + c.failures_7d, 0);

  // Aggregate automation health.
  const autoRuns = autoHealth.reduce((acc, h) => acc + h.runs_7d, 0);
  const autoFails = autoHealth.reduce((acc, h) => acc + h.failures_7d, 0);

  const missingRequired = ops.env.filter((e) => e.required && !e.present);
  const missingOptional = ops.env.filter((e) => !e.required && !e.present);

  const rows: ChecklistRow[] = [
    {
      id: "env-required",
      label: "Required env vars",
      status: missingRequired.length === 0 ? "green" : "red",
      summary:
        missingRequired.length === 0
          ? `All ${ops.env.filter((e) => e.required).length} required vars set.`
          : `${missingRequired.length} missing: ${missingRequired.map((e) => e.name).join(", ")}`,
    },
    {
      id: "env-optional",
      label: "Optional env vars",
      status: missingOptional.length === 0 ? "green" : "amber",
      summary:
        missingOptional.length === 0
          ? "All optional vars present."
          : `${missingOptional.length} optional missing: ${missingOptional.map((e) => e.name).join(", ")}`,
      detail:
        "Optional vars unlock features — email, HQ bell on demos, AI prose, OCR. They do not block launch.",
    },
    {
      id: "email-queue",
      label: "Email queue",
      status:
        ops.email.permanent_failures > 0
          ? "red"
          : ops.email.failed_24h > 0
            ? "amber"
            : "green",
      summary: `${ops.email.queued} queued · ${ops.email.sent_24h} sent (24h) · ${ops.email.failed_24h} failed (24h) · ${ops.email.permanent_failures} permanent failures`,
    },
    {
      id: "cron-health",
      label: "Cron health",
      status:
        cronFailures7d === 0
          ? ops.crons.some((c) => c.last_ok_at)
            ? "green"
            : "amber"
          : "amber",
      summary:
        cronFailures7d === 0
          ? `${CRON_ROUTES.length} cron routes wired; ${ops.crons.filter((c) => c.last_ok_at).length} have a recent success`
          : `${cronFailures7d} cron failures in last 7d`,
    },
    {
      id: "automation",
      label: "Automation OS",
      status: autoFails === 0 ? "green" : "amber",
      summary: `${autoHealth.length} built-in rules, ${autoRuns} runs in last 7d${autoFails ? `, ${autoFails} failures` : ""}`,
    },
    {
      id: "ai-config",
      label: "AI layer",
      // BINDING-AWARE, never key-presence — a bare credential arms nothing
      // (lib/ai/governor/readiness.ts). Green only when the generative tiers
      // are genuinely activated (binding + credential); a stray key on a
      // dark build must not show a false green.
      status: isInferenceTierActivated() ? "green" : "amber",
      summary: isInferenceTierActivated()
        ? "Generative tiers activated (binding + credential) — governed LLM prose + OCR live."
        : "No activated generative tier — deterministic fallback only. Phase 5 surface still works.",
    },
    hqAttribution,
    embeddingEstate,
    transcriptionEstate,
    {
      id: "security-doc",
      label: "Security contract",
      status: fileExists("docs/SECURITY.md") ? "green" : "red",
      summary: fileExists("docs/SECURITY.md")
        ? "docs/SECURITY.md present"
        : "docs/SECURITY.md MISSING",
    },
    {
      id: "rate-limit",
      label: "Rate limiting",
      status: fileExists("lib/security/rate-limit.ts") ? "green" : "red",
      summary: fileExists("lib/security/rate-limit.ts")
        ? "In-memory limiter on /api/demo + /api/ai/question"
        : "Rate limiter MISSING",
    },
    {
      id: "lifecycle-script",
      label: "End-to-end lifecycle test",
      status: fileExists("scripts/e2e-lifecycle.sql") ? "green" : "amber",
      summary: fileExists("scripts/e2e-lifecycle.sql")
        ? "scripts/e2e-lifecycle.sql ready — run against a LOCAL stack: `psql \"$DB_URL\" -f scripts/e2e-lifecycle.sql` (never `--linked`, that is production)"
        : "Lifecycle script MISSING",
    },
    {
      id: "ops-page",
      label: "HQ ops dashboard",
      status: fileExists("app/admin/ops/page.tsx") ? "green" : "red",
      summary: fileExists("app/admin/ops/page.tsx")
        ? "/admin/ops live"
        : "/admin/ops MISSING",
    },
    {
      id: "automations-page",
      label: "HQ automations dashboard",
      status: fileExists("app/admin/automations/page.tsx") ? "green" : "red",
      summary: fileExists("app/admin/automations/page.tsx")
        ? "/admin/automations live"
        : "/admin/automations MISSING",
    },
    {
      id: "portal-jobs",
      label: "Customer portal jobs",
      status: fileExists("app/customer-portal/[token]/jobs/page.tsx")
        ? "green"
        : "red",
      summary: fileExists("app/customer-portal/[token]/jobs/page.tsx")
        ? "/customer-portal/[token]/jobs live"
        : "Portal jobs MISSING",
    },
    {
      id: "portal-messages",
      label: "Customer portal messages",
      status: fileExists("app/customer-portal/[token]/messages/page.tsx")
        ? "green"
        : "red",
      summary: fileExists("app/customer-portal/[token]/messages/page.tsx")
        ? "/customer-portal/[token]/messages live"
        : "Portal messages MISSING",
    },
    {
      id: "onboarding-setup",
      label: "Onboarding setup flow",
      status: fileExists("app/(app)/onboarding/setup/page.tsx")
        ? "green"
        : "red",
      summary: fileExists("app/(app)/onboarding/setup/page.tsx")
        ? "/onboarding/setup + /complete live"
        : "Onboarding setup MISSING",
    },
    {
      id: "ai-question",
      label: "AI question box",
      status: fileExists("app/api/ai/question/route.ts") ? "green" : "red",
      summary: fileExists("app/api/ai/question/route.ts")
        ? "/api/ai/question wired with safety + rate limit"
        : "AI question route MISSING",
    },
  ];

  const anyRed = rows.some((r) => r.status === "red");
  const anyAmber = rows.some((r) => r.status === "amber");
  const overall: ChecklistRowStatus = anyRed
    ? "red"
    : anyAmber
      ? "amber"
      : "green";

  return { overall, rows };
}
