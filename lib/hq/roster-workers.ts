/**
 * CrewFlow HQ — Roster worker derivations (MP Wave — HQ roster completion).
 *
 * The dark roster (20261128000000) registered ~15 employee identities at the default-deny
 * FLOOR with NO runner, so their Boardroom cards read "insufficient". MP Wave R3 gave
 * three of them (analytics / monitoring / notification) a real deterministic runner via
 * `lib/hq/roster-runners.ts`. This module does the SAME for the remaining twelve
 * identity-only roles — one pure, DETERMINISTIC derivation each, over a genuine existing
 * data source, folded into the SAME explainable envelope (`RunnerEnvelope`) an AI
 * employee completes a Task-Engine task with:
 *
 *   design-ai · documentation-ai · onboarding-ai · hr-ai · legal-compliance-ai ·
 *   security-ai · devops-ai · database-ai · api-ai · orchestrator-ai · workflow-ai ·
 *   memory-manager-ai
 *
 * The service layer (server/services/hq-*-runner.ts) reads the data with the admin client
 * and defers to these functions; the unit tests exercise them directly.
 *
 * Server/client-safe — NO Supabase / server-only imports, exactly like
 * `lib/hq/roster-runners.ts`. `now` is INJECTED everywhere so every derivation is
 * deterministic and testable.
 *
 * Two first principles run through all twelve (unchanged from R3):
 *   1. HONEST "insufficient" — when the data cannot support a claim we say so, and never
 *      conjure a green result from absent data. No fabricated metrics.
 *   2. NO irreversible action — these workers COMPUTE and REPORT. Every output is a
 *      read-derived, sourced, explainable envelope; nothing here sends, commits, decides,
 *      or mutates. `approvalRequired` is TRUE on every result — humans keep final
 *      approval; generative (model) enrichment stays dark.
 */

import type { RunnerEnvelope } from "@/lib/hq/roster-runners";

/** Uniform posture band the worker envelopes carry (matches the roster-runner severity). */
export type WorkerSeverity = "ok" | "warning" | "critical";

/** The common tail every worker result adds on top of {@link RunnerEnvelope}. */
interface WorkerEnvelope extends RunnerEnvelope {
  /** Worst-signal band; "ok" over real data is a genuine all-clear, not "insufficient". */
  severity: WorkerSeverity;
  /** Every worker output needs a human before it means anything (deny-floor discipline). */
  approvalRequired: true;
}

/** Build the honest-insufficient envelope shared by every worker (thin/absent data). */
function insufficient(
  kind: string,
  reason: string,
  sources: string[],
  now: Date,
  extra: Record<string, unknown>,
): WorkerEnvelope {
  return {
    kind,
    summary: `Insufficient data — ${reason}`,
    reasoning: `${reason} This is an honest empty read, not a green result manufactured from absent data.`,
    confidence: 0,
    insufficient: true,
    generatedAt: now.toISOString(),
    sources,
    severity: "ok",
    approvalRequired: true,
    ...extra,
  } as WorkerEnvelope;
}

/** Build a fully-determined worker envelope over present data. */
function determined(
  kind: string,
  summary: string,
  reasoning: string,
  severity: WorkerSeverity,
  sources: string[],
  now: Date,
  extra: Record<string, unknown>,
): WorkerEnvelope {
  return {
    kind,
    summary,
    reasoning,
    confidence: 1,
    insufficient: false,
    generatedAt: now.toISOString(),
    sources,
    severity,
    approvalRequired: true,
    ...extra,
  } as WorkerEnvelope;
}

const s = (n: number) => (n === 1 ? "" : "s");

// =====================================================================
// 1. Security AI — authority-posture findings over the Capability Registry.
//    Source: hq_capability_grants (every grant that sits ABOVE the deny floor is a
//    posture finding) + hq_apply_audit (recorded autonomous-apply activity). Reports the
//    guard posture; it changes no grant and revokes nothing.
// =====================================================================

export interface SecurityGrantRow {
  scope_level: string;
  scope_key: string | null;
  can_execute: boolean;
  requires_approval: boolean;
}
export interface SecurityApplyRow {
  stage: string;
}
export interface SecurityPostureResult extends WorkerEnvelope {
  kind: "security_posture";
  signals: {
    totalGrants: number;
    executeEnabled: number;
    approvalWaived: number;
    applyActivity: number;
    findings: Array<{ scope: string; issue: string }>;
  };
}

export function summariseSecurityPosture(
  grants: ReadonlyArray<SecurityGrantRow>,
  applyAudit: ReadonlyArray<SecurityApplyRow>,
  now: Date,
): SecurityPostureResult {
  const sources = ["hq_capability_grants", "hq_apply_audit"];
  const kind = "security_posture";
  if (grants.length === 0) {
    return insufficient(kind, "no capability grants to audit yet.", sources, now, {
      signals: { totalGrants: 0, executeEnabled: 0, approvalWaived: 0, applyActivity: 0, findings: [] },
    }) as SecurityPostureResult;
  }

  const findings: Array<{ scope: string; issue: string }> = [];
  let executeEnabled = 0;
  let approvalWaived = 0;
  for (const g of grants) {
    const scope = `${g.scope_level}:${g.scope_key ?? "*"}`;
    if (g.can_execute === true) {
      executeEnabled += 1;
      findings.push({ scope, issue: "can_execute is TRUE — grant sits above the deny floor" });
    }
    if (g.requires_approval === false) {
      approvalWaived += 1;
      findings.push({ scope, issue: "requires_approval is FALSE — human approval is waived" });
    }
  }
  const applyActivity = applyAudit.length;

  const severity: WorkerSeverity =
    executeEnabled > 0 ? "critical" : approvalWaived > 0 || applyActivity > 0 ? "warning" : "ok";
  const summary =
    severity === "ok"
      ? `Deny-floor holds across all ${grants.length} grant${s(grants.length)} — no execute-enabled or approval-waived grant.`
      : `${severity === "critical" ? "Critical" : "Warning"}: ${executeEnabled} execute-enabled, ${approvalWaived} approval-waived grant${s(approvalWaived)}; ${applyActivity} apply-audit record${s(applyActivity)}.`;
  const reasoning =
    `Deterministic posture audit of ${grants.length} capability grant${s(grants.length)}: a grant is flagged only when a real column leaves the default-deny floor (can_execute=true or requires_approval=false). ${applyActivity} apply-audit record${s(applyActivity)} observed. No grant is changed — this reports the posture for a human.`;

  return determined(kind, summary, reasoning, severity, sources, now, {
    signals: { totalGrants: grants.length, executeEnabled, approvalWaived, applyActivity, findings },
  }) as SecurityPostureResult;
}

// =====================================================================
// 2. DevOps AI — deploy / pipeline health over cron + schedule telemetry.
//    Source: cron_runs (scheduled-job reliability) + hq_ai_schedule_runs (AI schedule
//    outcomes). Reports the operational read; it triggers no deploy.
// =====================================================================

export interface DevopsCronRow {
  route: string;
  ok: boolean | null;
}
export interface DevopsScheduleRow {
  outcome: string | null;
}
export interface DevopsHealthResult extends WorkerEnvelope {
  kind: "devops_health";
  signals: {
    cronRuns: number;
    failedCronRuns: number;
    failedRoutes: string[];
    scheduleRuns: number;
    failedScheduleRuns: number;
  };
}

const SCHEDULE_FAIL_OUTCOMES = new Set(["failed", "error", "errored"]);

export function summariseDeployHealth(
  cronRuns: ReadonlyArray<DevopsCronRow>,
  scheduleRuns: ReadonlyArray<DevopsScheduleRow>,
  now: Date,
): DevopsHealthResult {
  const sources = ["cron_runs", "hq_ai_schedule_runs"];
  const kind = "devops_health";
  if (cronRuns.length === 0 && scheduleRuns.length === 0) {
    return insufficient(kind, "no cron or schedule runs to assess yet.", sources, now, {
      signals: { cronRuns: 0, failedCronRuns: 0, failedRoutes: [], scheduleRuns: 0, failedScheduleRuns: 0 },
    }) as DevopsHealthResult;
  }

  const failedRoutes: string[] = [];
  let failedCronRuns = 0;
  for (const c of cronRuns) {
    if (c.ok === false) {
      failedCronRuns += 1;
      if (!failedRoutes.includes(c.route)) failedRoutes.push(c.route);
    }
  }
  const failedScheduleRuns = scheduleRuns.filter(
    (r) => r.outcome != null && SCHEDULE_FAIL_OUTCOMES.has(r.outcome.toLowerCase()),
  ).length;

  const severity: WorkerSeverity =
    failedScheduleRuns > 0 ? "critical" : failedCronRuns > 0 ? "warning" : "ok";
  const summary =
    severity === "ok"
      ? `Pipeline healthy across ${cronRuns.length} cron run${s(cronRuns.length)} and ${scheduleRuns.length} schedule run${s(scheduleRuns.length)}.`
      : `${severity === "critical" ? "Critical" : "Warning"}: ${failedCronRuns} failed cron run${s(failedCronRuns)}${failedRoutes.length ? ` (${failedRoutes.join(", ")})` : ""}; ${failedScheduleRuns} failed schedule run${s(failedScheduleRuns)}.`;
  const reasoning =
    `Deterministic read of ${cronRuns.length} recent cron run${s(cronRuns.length)} (cron_runs.ok) and ${scheduleRuns.length} AI-schedule run${s(scheduleRuns.length)} (hq_ai_schedule_runs.outcome). Failures are counted straight from the recorded columns; nothing is deployed or retried here — this is the operational read for a human.`;

  return determined(kind, summary, reasoning, severity, sources, now, {
    signals: {
      cronRuns: cronRuns.length,
      failedCronRuns,
      failedRoutes,
      scheduleRuns: scheduleRuns.length,
      failedScheduleRuns,
    },
  }) as DevopsHealthResult;
}

// =====================================================================
// 3. Database AI — event-bus / consumer integrity over the retry ledger.
//    Source: hq_consumer_retries (failed-event backlog) + hq_event_consumers (registered
//    consumers). Reports integrity risk; it runs no migration and mutates no data.
// =====================================================================

export interface DbRetryRow {
  consumer: string;
  attempts: number;
}
export interface DbConsumerRow {
  consumer: string;
}
export interface DatabaseIntegrityResult extends WorkerEnvelope {
  kind: "database_integrity";
  signals: {
    consumers: number;
    retryingEvents: number;
    highAttemptEvents: number;
    affectedConsumers: string[];
  };
}

/** A consumer that has retried this many times without success is stuck, not flaky. */
const HIGH_ATTEMPT_THRESHOLD = 5;

export function summariseDataIntegrity(
  retries: ReadonlyArray<DbRetryRow>,
  consumers: ReadonlyArray<DbConsumerRow>,
  now: Date,
): DatabaseIntegrityResult {
  const sources = ["hq_consumer_retries", "hq_event_consumers"];
  const kind = "database_integrity";
  if (retries.length === 0 && consumers.length === 0) {
    return insufficient(kind, "no consumers or retry backlog to assess yet.", sources, now, {
      signals: { consumers: 0, retryingEvents: 0, highAttemptEvents: 0, affectedConsumers: [] },
    }) as DatabaseIntegrityResult;
  }

  const affectedConsumers: string[] = [];
  let highAttemptEvents = 0;
  for (const r of retries) {
    if (!affectedConsumers.includes(r.consumer)) affectedConsumers.push(r.consumer);
    if (r.attempts >= HIGH_ATTEMPT_THRESHOLD) highAttemptEvents += 1;
  }

  const severity: WorkerSeverity =
    highAttemptEvents > 0 ? "critical" : retries.length > 0 ? "warning" : "ok";
  const summary =
    severity === "ok"
      ? `No event-bus backlog across ${consumers.length} registered consumer${s(consumers.length)}.`
      : `${severity === "critical" ? "Critical" : "Warning"}: ${retries.length} retrying event${s(retries.length)} across ${affectedConsumers.length} consumer${s(affectedConsumers.length)}; ${highAttemptEvents} past ${HIGH_ATTEMPT_THRESHOLD} attempts.`;
  const reasoning =
    `Deterministic read of ${retries.length} row${s(retries.length)} in the consumer retry ledger against ${consumers.length} registered consumer${s(consumers.length)}. An event past ${HIGH_ATTEMPT_THRESHOLD} attempts is treated as stuck (integrity risk), not transient. No data is repaired here — this reports the picture for a human.`;

  return determined(kind, summary, reasoning, severity, sources, now, {
    signals: {
      consumers: consumers.length,
      retryingEvents: retries.length,
      highAttemptEvents,
      affectedConsumers,
    },
  }) as DatabaseIntegrityResult;
}

// =====================================================================
// 4. API AI — capability-contract integrity over the token catalogue.
//    Source: hq_capability_grants (every token granted) vs hq_capabilities (the catalogue
//    that DEFINES each token). A granted token absent from the catalogue is a broken
//    contract (the grant's validate trigger would reject it). Reports drift; ships nothing.
// =====================================================================

export interface ApiContractResult extends WorkerEnvelope {
  kind: "api_contract_health";
  signals: {
    grantedTokens: number;
    catalogueTokens: number;
    unknownTokens: string[];
  };
}

export function summariseApiContract(
  grantedTokens: ReadonlyArray<string>,
  catalogueTokens: ReadonlyArray<string>,
  now: Date,
): ApiContractResult {
  const sources = ["hq_capability_grants", "hq_capabilities"];
  const kind = "api_contract_health";
  const granted = [...new Set(grantedTokens.filter((t) => typeof t === "string" && t.length > 0))];
  const catalogue = new Set(catalogueTokens);
  if (granted.length === 0 && catalogue.size === 0) {
    return insufficient(kind, "no tokens or catalogue to reconcile yet.", sources, now, {
      signals: { grantedTokens: 0, catalogueTokens: 0, unknownTokens: [] },
    }) as ApiContractResult;
  }

  const unknownTokens = granted.filter((t) => !catalogue.has(t)).sort();
  const severity: WorkerSeverity = unknownTokens.length > 0 ? "critical" : "ok";
  const summary =
    severity === "ok"
      ? `All ${granted.length} granted token${s(granted.length)} resolve in the ${catalogue.size}-token catalogue — contract intact.`
      : `Critical: ${unknownTokens.length} granted token${s(unknownTokens.length)} absent from the catalogue (${unknownTokens.join(", ")}).`;
  const reasoning =
    `Deterministic reconciliation of ${granted.length} distinct granted token${s(granted.length)} against the ${catalogue.size}-entry capability catalogue. A granted token with no catalogue definition is a broken contract the grant validator would reject. No endpoint or grant is changed — this reports the drift.`;

  return determined(kind, summary, reasoning, severity, sources, now, {
    signals: { grantedTokens: granted.length, catalogueTokens: catalogue.size, unknownTokens },
  }) as ApiContractResult;
}

// =====================================================================
// 5. Documentation AI — doc-drift over the roster + catalogue descriptions.
//    Source: ai_employees (an identity with no role/description is undocumented) +
//    hq_capabilities (a token with no description is undocumented). Reports drift; edits
//    no doc.
// =====================================================================

export interface DocEmployeeRow {
  slug: string;
  role: string | null;
  description: string | null;
}
export interface DocCatalogueRow {
  token: string;
  description: string | null;
}
export interface DocDriftResult extends WorkerEnvelope {
  kind: "documentation_drift";
  signals: {
    employees: number;
    undocumentedEmployees: string[];
    catalogueTokens: number;
    undocumentedTokens: string[];
  };
}

const blank = (v: string | null | undefined) => v == null || v.trim().length === 0;

export function summariseDocDrift(
  employees: ReadonlyArray<DocEmployeeRow>,
  catalogue: ReadonlyArray<DocCatalogueRow>,
  now: Date,
): DocDriftResult {
  const sources = ["ai_employees", "hq_capabilities"];
  const kind = "documentation_drift";
  if (employees.length === 0 && catalogue.length === 0) {
    return insufficient(kind, "no employees or catalogue tokens to check yet.", sources, now, {
      signals: { employees: 0, undocumentedEmployees: [], catalogueTokens: 0, undocumentedTokens: [] },
    }) as DocDriftResult;
  }

  const undocumentedEmployees = employees
    .filter((e) => blank(e.role) || blank(e.description))
    .map((e) => e.slug)
    .sort();
  const undocumentedTokens = catalogue
    .filter((c) => blank(c.description))
    .map((c) => c.token)
    .sort();

  const drift = undocumentedEmployees.length + undocumentedTokens.length;
  const severity: WorkerSeverity = drift > 0 ? "warning" : "ok";
  const summary =
    severity === "ok"
      ? `Docs complete: all ${employees.length} employee${s(employees.length)} and ${catalogue.length} catalogue token${s(catalogue.length)} carry a description.`
      : `Warning: ${undocumentedEmployees.length} employee${s(undocumentedEmployees.length)} and ${undocumentedTokens.length} token${s(undocumentedTokens.length)} lack a description.`;
  const reasoning =
    `Deterministic drift scan: an employee with a blank role or description, or a catalogue token with a blank description, is flagged. Read straight from the text columns — no prose is generated or rewritten here.`;

  return determined(kind, summary, reasoning, severity, sources, now, {
    signals: {
      employees: employees.length,
      undocumentedEmployees,
      catalogueTokens: catalogue.length,
      undocumentedTokens,
    },
  }) as DocDriftResult;
}

// =====================================================================
// 5b. Documentation AI — RELEASE NOTES + ROSTER-DOC COVERAGE (L9a / P10).
//
//     composeReleaseNotes: the deterministic "release notes draft" — a
//     structured composition over three REAL ledgers in a window: the admin
//     activity log (what operators did), the HQ event spine (what the platform
//     and its AI employees did), and HQ decisions (what was decided). It
//     composes and counts; it invents no line. The GENERATIVE half (reader-
//     facing prose) is the governed dark seam `hq.doc_draft`, attached by the
//     runner and null until a model tier is bound.
//
//     summariseRosterDocCoverage: the doc-drift extension — cross-checks the
//     ai_employees roster against the Bible workforce file list
//     (docs/bible/workforce/employees/*.md, read by the runner at runtime with
//     the same node:fs surface launch-readiness.ts already uses). The file list
//     is INJECTED (null when the runtime cannot read the directory — e.g. a
//     serverless bundle without docs/), so the FS leg degrades to an honest
//     "unavailable in this runtime" rather than a fabricated all-covered.
// =====================================================================

export interface ReleaseActivityRow {
  action: string;
  target_table: string;
  created_at: string;
}
export interface ReleaseEventRow {
  verb: string;
  object_type: string;
  severity: string | null;
  ts: string;
}
export interface ReleaseDecisionRow {
  title: string;
  status: string | null;
  created_at: string;
}

export interface ReleaseNotesSection {
  key: string;
  heading: string;
  /** Deterministic entry lines, each composed from a real grouped count. */
  entries: string[];
}

export interface ReleaseNotesResult extends WorkerEnvelope {
  kind: "release_notes_draft";
  windowDays: number;
  signals: {
    activityRows: number;
    eventRows: number;
    decisionRows: number;
    criticalEvents: number;
  };
  sections: ReleaseNotesSection[];
  /**
   * The governed generative leg (`hq.doc_draft`). ALWAYS null from this pure
   * compute; the runner may replace it once a model tier is bound.
   */
  generativeProse: string | null;
  generativeNote: string;
}

const DOC_GENERATIVE_DARK_NOTE =
  "Reader-facing prose is a governed dark seam (hq.doc_draft): no model tier is bound, so no prose is generated and this field is null. The deterministic composition above is complete without it.";

/** Group rows by a key and emit "N x label" lines, largest group first. */
function groupedLines<T>(rows: ReadonlyArray<T>, keyOf: (r: T) => string): string[] {
  const counts = new Map<string, number>();
  for (const r of rows) {
    const k = keyOf(r);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([k, n]) => `${n}\u00d7 ${k}`);
}

export function composeReleaseNotes(
  activity: ReadonlyArray<ReleaseActivityRow>,
  events: ReadonlyArray<ReleaseEventRow>,
  decisions: ReadonlyArray<ReleaseDecisionRow>,
  windowDays: number,
  now: Date,
): ReleaseNotesResult {
  const sources = ["admin_activity_log", "hq_events", "hq_decisions"];
  const kind = "release_notes_draft";
  if (activity.length === 0 && events.length === 0 && decisions.length === 0) {
    return {
      ...insufficient(
        kind,
        `no admin activity, HQ events or decisions in the last ${windowDays} days to compose from.`,
        sources,
        now,
        {
          windowDays,
          signals: { activityRows: 0, eventRows: 0, decisionRows: 0, criticalEvents: 0 },
          sections: [],
        },
      ),
      generativeProse: null,
      generativeNote: DOC_GENERATIVE_DARK_NOTE,
    } as ReleaseNotesResult;
  }

  const sections: ReleaseNotesSection[] = [];
  if (activity.length > 0) {
    sections.push({
      key: "operator_actions",
      heading: `Operator actions (${activity.length})`,
      entries: groupedLines(activity, (r) => `${r.action} on ${r.target_table}`),
    });
  }
  if (events.length > 0) {
    sections.push({
      key: "platform_events",
      heading: `Platform & AI-employee events (${events.length})`,
      entries: groupedLines(events, (r) => `${r.verb} ${r.object_type}`),
    });
  }
  if (decisions.length > 0) {
    sections.push({
      key: "decisions",
      heading: `Decisions raised (${decisions.length})`,
      entries: decisions
        .map((d) => `${d.title} [${d.status ?? "unknown"}]`)
        .sort((a, b) => a.localeCompare(b)),
    });
  }

  const criticalEvents = events.filter((e) => e.severity === "critical").length;
  const severity: WorkerSeverity = criticalEvents > 0 ? "warning" : "ok";
  const summary = `Release-notes draft over the last ${windowDays} days: ${activity.length} operator action${s(activity.length)}, ${events.length} platform event${s(events.length)} (${criticalEvents} critical), ${decisions.length} decision${s(decisions.length)} — composed into ${sections.length} section${s(sections.length)} for human review.`;
  const reasoning =
    `Deterministic composition over three real ledgers in a ${windowDays}-day window: admin_activity_log rows grouped by action+table, hq_events grouped by verb+object, and hq_decisions listed verbatim by title and status. Every line is a grouped count or a stored title — no release claim is invented, and nothing is published: a human reviews the draft. Reader-facing prose is the governed dark seam hq.doc_draft (see generativeNote).`;

  return {
    ...determined(kind, summary, reasoning, severity, sources, now, {
      windowDays,
      signals: {
        activityRows: activity.length,
        eventRows: events.length,
        decisionRows: decisions.length,
        criticalEvents,
      },
      sections,
    }),
    generativeProse: null,
    generativeNote: DOC_GENERATIVE_DARK_NOTE,
  } as ReleaseNotesResult;
}

export interface RosterDocCoverageResult extends WorkerEnvelope {
  kind: "roster_doc_coverage";
  signals: {
    employees: number;
    docFiles: number | null;
    /** Roster slugs with NO Bible workforce file. */
    undocumentedSlugs: string[];
    /** Bible workforce files naming NO current roster slug (stale docs). */
    orphanedDocs: string[];
    fsAvailable: boolean;
  };
}

/**
 * Cross-check the ai_employees roster against the Bible workforce file list.
 * A workforce file `NN-<slug>.md` covers roster slug `<slug>`. `docFiles` is
 * null when the runtime could not read the directory — that is an HONEST
 * "unavailable in this runtime", never treated as full coverage.
 */
export function summariseRosterDocCoverage(
  employees: ReadonlyArray<{ slug: string }>,
  docFiles: ReadonlyArray<string> | null,
  now: Date,
): RosterDocCoverageResult {
  const sources = ["ai_employees", "docs/bible/workforce/employees/*"];
  const kind = "roster_doc_coverage";
  if (docFiles == null) {
    return insufficient(
      kind,
      "the Bible workforce directory could not be read in this runtime, so doc coverage cannot be asserted.",
      sources,
      now,
      {
        signals: {
          employees: employees.length,
          docFiles: null,
          undocumentedSlugs: [],
          orphanedDocs: [],
          fsAvailable: false,
        },
      },
    ) as RosterDocCoverageResult;
  }
  if (employees.length === 0 && docFiles.length === 0) {
    return insufficient(kind, "no employees and no workforce docs to reconcile yet.", sources, now, {
      signals: {
        employees: 0,
        docFiles: 0,
        undocumentedSlugs: [],
        orphanedDocs: [],
        fsAvailable: true,
      },
    }) as RosterDocCoverageResult;
  }

  // `NN-<slug>.md` -> `<slug>`; tolerate files without the numeric prefix.
  const docSlugs = new Map<string, string>(); // slug -> filename
  for (const f of docFiles) {
    const m = f.match(/^(?:\d+-)?(.+)\.md$/);
    if (m) docSlugs.set(m[1]!, f);
  }
  const rosterSlugs = new Set(employees.map((e) => e.slug));
  const undocumentedSlugs = [...rosterSlugs].filter((slug) => !docSlugs.has(slug)).sort();
  const orphanedDocs = [...docSlugs.entries()]
    .filter(([slug]) => !rosterSlugs.has(slug))
    .map(([, file]) => file)
    .sort();

  const drift = undocumentedSlugs.length + orphanedDocs.length;
  const severity: WorkerSeverity = drift > 0 ? "warning" : "ok";
  const summary =
    severity === "ok"
      ? `Workforce docs in step: all ${employees.length} roster identit${employees.length === 1 ? "y" : "ies"} have a Bible file and no file is orphaned (${docFiles.length} docs).`
      : `Warning: ${undocumentedSlugs.length} roster identit${undocumentedSlugs.length === 1 ? "y" : "ies"} lack a Bible workforce file${undocumentedSlugs.length ? ` (${undocumentedSlugs.join(", ")})` : ""}; ${orphanedDocs.length} doc file${s(orphanedDocs.length)} name no current identity.`;
  const reasoning =
    `Deterministic reconciliation of ${rosterSlugs.size} roster slug${s(rosterSlugs.size)} against ${docFiles.length} Bible workforce file${s(docFiles.length)} (filename convention NN-<slug>.md). A roster identity with no file is undocumented; a file naming no identity is stale. No doc is edited — this reports the drift for a human.`;

  return determined(kind, summary, reasoning, severity, sources, now, {
    signals: {
      employees: employees.length,
      docFiles: docFiles.length,
      undocumentedSlugs,
      orphanedDocs,
      fsAvailable: true,
    },
  }) as RosterDocCoverageResult;
}

// =====================================================================
// 6. Onboarding AI — activation nudges over the org estate.
//    Source: organizations (onboarding_state / onboarding_percent / status). Reports which
//    live orgs have stalled activation; it touches no customer account.
// =====================================================================

export interface OnboardingOrgRow {
  status: string | null;
  onboarding_state: string | null;
  onboarding_percent: number | null;
}
export interface OnboardingResult extends WorkerEnvelope {
  kind: "onboarding_nudges";
  signals: {
    activeOrgs: number;
    fullyOnboarded: number;
    inProgress: number;
    notStarted: number;
  };
}

/** Statuses that take an org OUT of the activation funnel (no nudge applies). */
const INACTIVE_ORG_STATUSES = new Set(["cancelled", "suspended", "rejected"]);

export function summariseOnboarding(
  orgs: ReadonlyArray<OnboardingOrgRow>,
  now: Date,
): OnboardingResult {
  const sources = ["organizations"];
  const kind = "onboarding_nudges";
  const active = orgs.filter((o) => !(o.status != null && INACTIVE_ORG_STATUSES.has(o.status)));
  if (active.length === 0) {
    return insufficient(kind, "no active organizations in the activation funnel yet.", sources, now, {
      signals: { activeOrgs: 0, fullyOnboarded: 0, inProgress: 0, notStarted: 0 },
    }) as OnboardingResult;
  }

  let fullyOnboarded = 0;
  let inProgress = 0;
  let notStarted = 0;
  for (const o of active) {
    const pct = o.onboarding_percent ?? 0;
    const complete = pct >= 100 || o.onboarding_state === "complete";
    if (complete) fullyOnboarded += 1;
    else if (pct > 0 || (o.onboarding_state != null && o.onboarding_state !== "not_started")) inProgress += 1;
    else notStarted += 1;
  }

  const stalled = inProgress + notStarted;
  const severity: WorkerSeverity = stalled > 0 ? "warning" : "ok";
  const summary =
    severity === "ok"
      ? `All ${active.length} active org${s(active.length)} fully onboarded.`
      : `Warning: ${stalled} of ${active.length} active org${s(active.length)} have not completed activation (${inProgress} in progress, ${notStarted} not started).`;
  const reasoning =
    `Deterministic funnel read over ${active.length} active organization${s(active.length)} (cancelled/suspended/rejected excluded). Completion is onboarding_percent≥100 or onboarding_state='complete'; everything else is a nudge candidate. No customer account is modified — this drafts the picture for a human.`;

  return determined(kind, summary, reasoning, severity, sources, now, {
    signals: { activeOrgs: active.length, fullyOnboarded, inProgress, notStarted },
  }) as OnboardingResult;
}

// =====================================================================
// 7. HR AI — workforce coherence over the roster + registry.
//    Source: ai_employees (the workforce) + hq_capability_grants (every seeded employee
//    must carry a grant). An employee with no grant is a backfill gap. Reports; holds no
//    authority over any record.
// =====================================================================

export interface HrEmployeeRow {
  slug: string;
  department: string | null;
  status: string | null;
}
export interface WorkforceResult extends WorkerEnvelope {
  kind: "workforce_review";
  signals: {
    employees: number;
    ungranted: string[];
    byDepartment: Array<{ department: string; count: number }>;
    byStatus: Array<{ status: string; count: number }>;
  };
}

export function summariseWorkforce(
  employees: ReadonlyArray<HrEmployeeRow>,
  grantedSlugs: ReadonlyArray<string>,
  now: Date,
): WorkforceResult {
  const sources = ["ai_employees", "hq_capability_grants"];
  const kind = "workforce_review";
  if (employees.length === 0) {
    return insufficient(kind, "no employees in the roster yet.", sources, now, {
      signals: { employees: 0, ungranted: [], byDepartment: [], byStatus: [] },
    }) as WorkforceResult;
  }

  const granted = new Set(grantedSlugs);
  const ungranted = employees.filter((e) => !granted.has(e.slug)).map((e) => e.slug).sort();

  const deptCounts = new Map<string, number>();
  const statusCounts = new Map<string, number>();
  for (const e of employees) {
    const d = e.department ?? "unknown";
    const st = e.status ?? "unknown";
    deptCounts.set(d, (deptCounts.get(d) ?? 0) + 1);
    statusCounts.set(st, (statusCounts.get(st) ?? 0) + 1);
  }
  const byDepartment = [...deptCounts.entries()]
    .map(([department, count]) => ({ department, count }))
    .sort((a, b) => b.count - a.count || a.department.localeCompare(b.department));
  const byStatus = [...statusCounts.entries()]
    .map(([status, count]) => ({ status, count }))
    .sort((a, b) => b.count - a.count || a.status.localeCompare(b.status));

  const severity: WorkerSeverity = ungranted.length > 0 ? "critical" : "ok";
  const summary =
    severity === "ok"
      ? `Workforce coherent: all ${employees.length} employee${s(employees.length)} carry a capability grant, across ${byDepartment.length} department${s(byDepartment.length)}.`
      : `Critical: ${ungranted.length} employee${s(ungranted.length)} have NO capability grant (backfill gap): ${ungranted.join(", ")}.`;
  const reasoning =
    `Deterministic coherence read over ${employees.length} roster row${s(employees.length)}: an employee whose slug has no grant in the registry is a backfill gap (it would resolve to the deny floor). Department and status distributions are exact counts. No person record is touched.`;

  return determined(kind, summary, reasoning, severity, sources, now, {
    signals: { employees: employees.length, ungranted, byDepartment, byStatus },
  }) as WorkforceResult;
}

// =====================================================================
// 8. Legal & Compliance AI — approval / sign-off obligations.
//    Source: hq_approvals (pending / expired approvals awaiting sign-off) + hq_decisions
//    (open decisions past their delay). Reports obligations; it signs nothing.
// =====================================================================

export interface ComplianceApprovalRow {
  state: string | null;
  expires_at: string | null;
}
export interface ComplianceDecisionRow {
  status: string | null;
  delay_until: string | null;
}
export interface ComplianceResult extends WorkerEnvelope {
  kind: "compliance_review";
  signals: {
    pendingApprovals: number;
    expiredApprovals: number;
    openDecisions: number;
    overdueDecisions: number;
  };
}

const PENDING_APPROVAL_STATES = new Set(["pending", "requested", "escalated"]);
const OPEN_DECISION_STATUSES = new Set(["open", "pending", "proposed", "debating", "delayed"]);

export function summariseCompliance(
  approvals: ReadonlyArray<ComplianceApprovalRow>,
  decisions: ReadonlyArray<ComplianceDecisionRow>,
  now: Date,
): ComplianceResult {
  const sources = ["hq_approvals", "hq_decisions"];
  const kind = "compliance_review";
  if (approvals.length === 0 && decisions.length === 0) {
    return insufficient(kind, "no approvals or decisions to review yet.", sources, now, {
      signals: { pendingApprovals: 0, expiredApprovals: 0, openDecisions: 0, overdueDecisions: 0 },
    }) as ComplianceResult;
  }

  const nowMs = now.getTime();
  let pendingApprovals = 0;
  let expiredApprovals = 0;
  for (const a of approvals) {
    const pending = a.state != null && PENDING_APPROVAL_STATES.has(a.state);
    if (pending) {
      pendingApprovals += 1;
      if (a.expires_at) {
        const exp = Date.parse(a.expires_at);
        if (!Number.isNaN(exp) && exp < nowMs) expiredApprovals += 1;
      }
    }
  }

  let openDecisions = 0;
  let overdueDecisions = 0;
  for (const d of decisions) {
    const open = d.status != null && OPEN_DECISION_STATUSES.has(d.status);
    if (open) {
      openDecisions += 1;
      if (d.delay_until) {
        const until = Date.parse(d.delay_until);
        if (!Number.isNaN(until) && until < nowMs) overdueDecisions += 1;
      }
    }
  }

  const severity: WorkerSeverity =
    expiredApprovals > 0 || overdueDecisions > 0
      ? "critical"
      : pendingApprovals > 0 || openDecisions > 0
        ? "warning"
        : "ok";
  const summary =
    severity === "ok"
      ? `No open compliance obligations across ${approvals.length} approval${s(approvals.length)} and ${decisions.length} decision${s(decisions.length)}.`
      : `${severity === "critical" ? "Critical" : "Warning"}: ${pendingApprovals} pending approval${s(pendingApprovals)} (${expiredApprovals} expired), ${openDecisions} open decision${s(openDecisions)} (${overdueDecisions} overdue).`;
  const reasoning =
    `Deterministic obligation read: an approval in a pending/requested/escalated state is outstanding, and one past its expires_at is expired; a decision in an open status past its delay_until is overdue. Read straight from the state columns — this signs, accepts, and commits nothing.`;

  return determined(kind, summary, reasoning, severity, sources, now, {
    signals: { pendingApprovals, expiredApprovals, openDecisions, overdueDecisions },
  }) as ComplianceResult;
}

// =====================================================================
// 9. Design AI — brand-token consistency over the roster.
//    Source: ai_employees (icon + accent brand tokens). Reports which identities are
//    missing a brand token and the palette spread; it alters no shipped design.
// =====================================================================

export interface DesignEmployeeRow {
  slug: string;
  icon: string | null;
  accent: string | null;
}
export interface DesignConsistencyResult extends WorkerEnvelope {
  kind: "design_consistency";
  signals: {
    employees: number;
    missingIcon: string[];
    missingAccent: string[];
    distinctAccents: number;
    distinctIcons: number;
  };
}

export function summariseDesignConsistency(
  employees: ReadonlyArray<DesignEmployeeRow>,
  now: Date,
): DesignConsistencyResult {
  const sources = ["ai_employees"];
  const kind = "design_consistency";
  if (employees.length === 0) {
    return insufficient(kind, "no employees to assess for brand consistency yet.", sources, now, {
      signals: { employees: 0, missingIcon: [], missingAccent: [], distinctAccents: 0, distinctIcons: 0 },
    }) as DesignConsistencyResult;
  }

  const missingIcon = employees.filter((e) => blank(e.icon)).map((e) => e.slug).sort();
  const missingAccent = employees.filter((e) => blank(e.accent)).map((e) => e.slug).sort();
  const distinctAccents = new Set(employees.map((e) => e.accent).filter((v) => !blank(v))).size;
  const distinctIcons = new Set(employees.map((e) => e.icon).filter((v) => !blank(v))).size;

  const gaps = missingIcon.length + missingAccent.length;
  const severity: WorkerSeverity = gaps > 0 ? "warning" : "ok";
  const summary =
    severity === "ok"
      ? `Brand consistent: all ${employees.length} employee${s(employees.length)} carry an icon and accent (${distinctAccents} accent${s(distinctAccents)}, ${distinctIcons} icon${s(distinctIcons)} in use).`
      : `Warning: ${missingIcon.length} employee${s(missingIcon.length)} missing an icon, ${missingAccent.length} missing an accent.`;
  const reasoning =
    `Deterministic brand-token audit over ${employees.length} roster row${s(employees.length)}: an employee with a blank icon or accent breaks the Boardroom's visual language. Palette spread is the distinct-value count of each token. No design asset is changed — this critiques for a human.`;

  return determined(kind, summary, reasoning, severity, sources, now, {
    signals: {
      employees: employees.length,
      missingIcon,
      missingAccent,
      distinctAccents,
      distinctIcons,
    },
  }) as DesignConsistencyResult;
}

// =====================================================================
// 9b. Design AI — the DESIGN REVIEW (L9a / P8): a deeper deterministic audit of
//     the HQ-configurable design surface, beyond the missing-token scan above.
//
//     HONEST SCOPE, stated precisely: this reviews the design data the platform
//     ACTUALLY STORES AND CAN REACH AT RUNTIME — the roster's brand tokens
//     (ai_employees.icon / accent / department): token-format coherence (mixed
//     hex/named accent vocabularies fracture the Boardroom palette), accent
//     collisions inside a department (two identities rendered identically), and
//     icon collisions estate-wide. It does NOT walk the component tree:
//     FILE-SYSTEM-LEVEL audits (DataTable/EmptyState/PageHeader adoption, token
//     usage in TSX) are CI-territory — the design-system tests own them, because
//     a serverless runtime has no reliable source tree to walk and a runtime FS
//     scan would be a fabricated audit the moment the bundle omits the sources.
//     The GENERATIVE half (a prose UI critique) is the governed dark seam
//     `hq.design_review` — attached by the runner, null until a tier is bound.
// =====================================================================

export interface DesignReviewEmployeeRow {
  slug: string;
  icon: string | null;
  accent: string | null;
  department: string | null;
}

export interface DesignReviewResult extends WorkerEnvelope {
  kind: "design_review";
  signals: {
    employees: number;
    /** Accent token format families in use (e.g. "hex", "named") — >1 is drift. */
    accentFormats: string[];
    mixedAccentFormats: boolean;
    /** Departments where two employees share one accent (identical rendering). */
    departmentAccentCollisions: Array<{ department: string; accent: string; slugs: string[] }>;
    /** Icons carried by more than one employee estate-wide. */
    iconCollisions: Array<{ icon: string; slugs: string[] }>;
    findings: Array<{ scope: string; issue: string }>;
  };
  /**
   * The governed generative critique (`hq.design_review`). ALWAYS null from
   * this pure compute; the runner may replace it once a model tier is bound.
   */
  generativeCritique: string | null;
  generativeNote: string;
}

const DESIGN_GENERATIVE_DARK_NOTE =
  "UI critique prose is a governed dark seam (hq.design_review): no model tier is bound, so no critique is generated and this field is null. The deterministic findings above are complete without it.";

/** Classify an accent token's format family (hex vs named/utility token). */
function accentFormatOf(accent: string): string {
  const a = accent.trim();
  if (/^#[0-9a-fA-F]{3,8}$/.test(a)) return "hex";
  if (/^[a-z][a-z0-9-]*$/i.test(a)) return "named";
  return "other";
}

export function summariseDesignReview(
  employees: ReadonlyArray<DesignReviewEmployeeRow>,
  now: Date,
): DesignReviewResult {
  const sources = ["ai_employees"];
  const kind = "design_review";
  if (employees.length === 0) {
    return {
      ...insufficient(kind, "no employees to design-review yet.", sources, now, {
        signals: {
          employees: 0,
          accentFormats: [],
          mixedAccentFormats: false,
          departmentAccentCollisions: [],
          iconCollisions: [],
          findings: [],
        },
      }),
      generativeCritique: null,
      generativeNote: DESIGN_GENERATIVE_DARK_NOTE,
    } as DesignReviewResult;
  }

  const findings: Array<{ scope: string; issue: string }> = [];

  // 1. Accent token-format coherence.
  const formatSet = new Set<string>();
  for (const e of employees) {
    if (!blank(e.accent)) formatSet.add(accentFormatOf(e.accent!));
  }
  const accentFormats = [...formatSet].sort();
  const mixedAccentFormats = accentFormats.length > 1;
  if (mixedAccentFormats) {
    findings.push({
      scope: "roster:accent",
      issue: `Accent tokens mix ${accentFormats.length} format families (${accentFormats.join(", ")}) — one vocabulary keeps the Boardroom palette coherent.`,
    });
  }

  // 2. Accent collisions inside a department (two identities rendered identically).
  const byDeptAccent = new Map<string, string[]>();
  for (const e of employees) {
    if (blank(e.accent)) continue;
    const key = `${e.department ?? "unknown"}\u0000${e.accent!.trim().toLowerCase()}`;
    const list = byDeptAccent.get(key) ?? [];
    list.push(e.slug);
    byDeptAccent.set(key, list);
  }
  const departmentAccentCollisions = [...byDeptAccent.entries()]
    .filter(([, slugs]) => slugs.length > 1)
    .map(([key, slugs]) => {
      const [department, accent] = key.split("\u0000");
      return { department: department!, accent: accent!, slugs: [...slugs].sort() };
    })
    .sort((a, b) => a.department.localeCompare(b.department) || a.accent.localeCompare(b.accent));
  for (const c of departmentAccentCollisions) {
    findings.push({
      scope: `department:${c.department}`,
      issue: `${c.slugs.length} identities share accent '${c.accent}' (${c.slugs.join(", ")}) — indistinguishable cards within one department.`,
    });
  }

  // 3. Icon collisions estate-wide.
  const byIcon = new Map<string, string[]>();
  for (const e of employees) {
    if (blank(e.icon)) continue;
    const key = e.icon!.trim();
    const list = byIcon.get(key) ?? [];
    list.push(e.slug);
    byIcon.set(key, list);
  }
  const iconCollisions = [...byIcon.entries()]
    .filter(([, slugs]) => slugs.length > 1)
    .map(([icon, slugs]) => ({ icon, slugs: [...slugs].sort() }))
    .sort((a, b) => a.icon.localeCompare(b.icon));
  for (const c of iconCollisions) {
    findings.push({
      scope: "roster:icon",
      issue: `Icon '${c.icon}' is carried by ${c.slugs.length} identities (${c.slugs.join(", ")}).`,
    });
  }

  const severity: WorkerSeverity = findings.length > 0 ? "warning" : "ok";
  const summary =
    severity === "ok"
      ? `Design review clean across ${employees.length} identit${employees.length === 1 ? "y" : "ies"}: one accent vocabulary, no accent collision within a department, no icon reuse.`
      : `Warning: ${findings.length} design finding${s(findings.length)} — ${mixedAccentFormats ? "mixed accent formats; " : ""}${departmentAccentCollisions.length} department accent collision${s(departmentAccentCollisions.length)}, ${iconCollisions.length} icon collision${s(iconCollisions.length)}.`;
  const reasoning =
    `Deterministic design review over ${employees.length} roster row${s(employees.length)} — the design data the platform actually stores: accent token-format coherence, per-department accent collisions, estate-wide icon reuse. Component-adoption audits live in CI design-system tests, where the source tree is real; nothing is guessed here, and no design asset is changed — this critiques for a human.`;

  return {
    ...determined(kind, summary, reasoning, severity, sources, now, {
      signals: {
        employees: employees.length,
        accentFormats,
        mixedAccentFormats,
        departmentAccentCollisions,
        iconCollisions,
        findings,
      },
    }),
    generativeCritique: null,
    generativeNote: DESIGN_GENERATIVE_DARK_NOTE,
  } as DesignReviewResult;
}

// =====================================================================
// 10. Orchestrator AI — task-routing picture over the shared queue.
//    Source: hq_ai_tasks (status / task_type / assigned_employee_id). Reports the backlog,
//    unassigned work and per-employee load; it enqueues nothing and reassigns nothing.
// =====================================================================

export interface OrchestratorTaskRow {
  status: string;
  task_type: string;
  assigned_employee_id: string | null;
}
export interface OrchestrationResult extends WorkerEnvelope {
  kind: "orchestration_routing";
  signals: {
    total: number;
    open: number;
    unassignedOpen: number;
    byType: Array<{ type: string; count: number }>;
  };
}

const OPEN_TASK_STATUSES = new Set(["pending", "running", "blocked"]);

export function summariseOrchestration(
  tasks: ReadonlyArray<OrchestratorTaskRow>,
  now: Date,
): OrchestrationResult {
  const sources = ["hq_ai_tasks"];
  const kind = "orchestration_routing";
  if (tasks.length === 0) {
    return insufficient(kind, "no tasks in the queue to route yet.", sources, now, {
      signals: { total: 0, open: 0, unassignedOpen: 0, byType: [] },
    }) as OrchestrationResult;
  }

  const openTasks = tasks.filter((t) => OPEN_TASK_STATUSES.has(t.status));
  const unassignedOpen = openTasks.filter((t) => t.assigned_employee_id == null).length;

  const typeCounts = new Map<string, number>();
  for (const t of openTasks) {
    typeCounts.set(t.task_type, (typeCounts.get(t.task_type) ?? 0) + 1);
  }
  const byType = [...typeCounts.entries()]
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));

  const severity: WorkerSeverity =
    unassignedOpen > 0 ? "warning" : "ok";
  const summary =
    severity === "ok"
      ? openTasks.length === 0
        ? `Queue clear — no open work across ${tasks.length} task${s(tasks.length)}.`
        : `${openTasks.length} open task${s(openTasks.length)} across ${byType.length} type${s(byType.length)}, all assigned.`
      : `Warning: ${unassignedOpen} of ${openTasks.length} open task${s(openTasks.length)} are unassigned.`;
  const reasoning =
    `Deterministic routing read over ${tasks.length} recent task row${s(tasks.length)}: open = pending/running/blocked. Unassigned open tasks (assigned_employee_id is null) are the routing candidates, and the type spread shows where load sits. This proposes nothing autonomously — it reports for a human.`;

  return determined(kind, summary, reasoning, severity, sources, now, {
    signals: {
      total: tasks.length,
      open: openTasks.length,
      unassignedOpen,
      byType,
    },
  }) as OrchestrationResult;
}

// =====================================================================
// 11. Workflow AI — saga sequencing health over the workflow substrate.
//    Source: hq_workflow_sagas (active sagas) + hq_saga_steps (step status). Reports failed
//    and pending steps in active sagas; it launches no workflow and runs no step.
// =====================================================================

export interface WorkflowSagaRow {
  id: string;
  status: string | null;
}
export interface WorkflowStepRow {
  saga_id: string;
  status: string | null;
}
export interface WorkflowResult extends WorkerEnvelope {
  kind: "workflow_sequencing";
  signals: {
    activeSagas: number;
    stepsInActive: number;
    failedSteps: number;
    pendingSteps: number;
  };
}

const ACTIVE_SAGA_STATUSES = new Set(["active", "running", "in_progress", "open"]);
const FAILED_STEP_STATUSES = new Set(["failed", "error", "errored"]);
const PENDING_STEP_STATUSES = new Set(["pending", "blocked", "waiting", "ready"]);

export function summariseWorkflow(
  sagas: ReadonlyArray<WorkflowSagaRow>,
  steps: ReadonlyArray<WorkflowStepRow>,
  now: Date,
): WorkflowResult {
  const sources = ["hq_workflow_sagas", "hq_saga_steps"];
  const kind = "workflow_sequencing";
  if (sagas.length === 0) {
    return insufficient(kind, "no workflow sagas to sequence yet.", sources, now, {
      signals: { activeSagas: 0, stepsInActive: 0, failedSteps: 0, pendingSteps: 0 },
    }) as WorkflowResult;
  }

  const activeSagaIds = new Set(
    sagas.filter((sg) => sg.status != null && ACTIVE_SAGA_STATUSES.has(sg.status)).map((sg) => sg.id),
  );
  const activeSteps = steps.filter((st) => activeSagaIds.has(st.saga_id));
  const failedSteps = activeSteps.filter((st) => st.status != null && FAILED_STEP_STATUSES.has(st.status)).length;
  const pendingSteps = activeSteps.filter((st) => st.status != null && PENDING_STEP_STATUSES.has(st.status)).length;

  const severity: WorkerSeverity =
    failedSteps > 0 ? "critical" : pendingSteps > 0 ? "warning" : "ok";
  const summary =
    severity === "ok"
      ? `${activeSagaIds.size} active saga${s(activeSagaIds.size)} sequencing cleanly (${activeSteps.length} step${s(activeSteps.length)}).`
      : `${severity === "critical" ? "Critical" : "Warning"}: ${failedSteps} failed and ${pendingSteps} pending step${s(pendingSteps)} across ${activeSagaIds.size} active saga${s(activeSagaIds.size)}.`;
  const reasoning =
    `Deterministic sequencing read: an active saga is active/running/in_progress/open; its steps are counted by status straight from hq_saga_steps. A failed step blocks its saga; pending steps are the outstanding sequence. No step is dispatched here — the saga-drain cron owns dispatch, this reports.`;

  return determined(kind, summary, reasoning, severity, sources, now, {
    signals: {
      activeSagas: activeSagaIds.size,
      stepsInActive: activeSteps.length,
      failedSteps,
      pendingSteps,
    },
  }) as WorkflowResult;
}

// =====================================================================
// 12. Memory Manager AI — shared-memory curation candidates.
//    Source: hq_memories (status / expires_at / last_accessed_at / consolidated_into /
//    pinned) + hq_memory_versions (version sprawl). Reports what is stale, expired or
//    superseded; it forgets nothing and rewrites no memory.
// =====================================================================

export interface MemoryRow {
  status: string | null;
  expires_at: string | null;
  last_accessed_at: string | null;
  consolidated_into: string | null;
  pinned: boolean | null;
}
export interface MemoryVersionRow {
  memory_id: string;
}
export interface MemoryCurationResult extends WorkerEnvelope {
  kind: "memory_curation";
  signals: {
    memories: number;
    expired: number;
    superseded: number;
    stale: number;
    versions: number;
  };
}

/** A memory untouched for this long is a staleness candidate (not auto-forgotten). */
const STALE_MS = 90 * 24 * 60 * 60 * 1000;

export function summariseMemoryCuration(
  memories: ReadonlyArray<MemoryRow>,
  versions: ReadonlyArray<MemoryVersionRow>,
  now: Date,
): MemoryCurationResult {
  const sources = ["hq_memories", "hq_memory_versions"];
  const kind = "memory_curation";
  if (memories.length === 0) {
    return insufficient(kind, "no memories to curate yet.", sources, now, {
      signals: { memories: 0, expired: 0, superseded: 0, stale: 0, versions: 0 },
    }) as MemoryCurationResult;
  }

  const nowMs = now.getTime();
  let expired = 0;
  let superseded = 0;
  let stale = 0;
  for (const m of memories) {
    if (m.pinned === true) continue; // pinned memory is never a curation candidate
    if (m.expires_at) {
      const exp = Date.parse(m.expires_at);
      if (!Number.isNaN(exp) && exp < nowMs) expired += 1;
    }
    if (m.consolidated_into != null) superseded += 1;
    if (m.last_accessed_at) {
      const la = Date.parse(m.last_accessed_at);
      if (!Number.isNaN(la) && nowMs - la >= STALE_MS) stale += 1;
    }
  }

  const candidates = expired + superseded + stale;
  const severity: WorkerSeverity = candidates > 0 ? "warning" : "ok";
  const summary =
    severity === "ok"
      ? `Memory healthy across ${memories.length} memor${memories.length === 1 ? "y" : "ies"} — no curation candidate.`
      : `Warning: ${expired} expired, ${superseded} superseded, ${stale} stale (90d+) of ${memories.length} memor${memories.length === 1 ? "y" : "ies"}.`;
  const reasoning =
    `Deterministic curation scan (pinned memory excluded): expired = past expires_at; superseded = consolidated_into is set; stale = last_accessed_at over 90 days ago. ${versions.length} version row${s(versions.length)} observed. Nothing is forgotten or rewritten — this drafts curation candidates for a human.`;

  return determined(kind, summary, reasoning, severity, sources, now, {
    signals: {
      memories: memories.length,
      expired,
      superseded,
      stale,
      versions: versions.length,
    },
  }) as MemoryCurationResult;
}
