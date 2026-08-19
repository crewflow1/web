/**
 * Per-domain data retention — the policy registry, the EXCLUSION tripwire, and
 * the shared input contract.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS IS (and what lives ELSEWHERE)
 * ─────────────────────────────────────────────────────────────────────────────
 * CrewFlow lets an organisation age-out its own HIGH-VOLUME OPERATIONAL LOGS —
 * notification feeds, delivery queues, telematics readings, request logs — on a
 * configurable window, so those relations don't grow without bound. This module
 * is the SINGLE SOURCE OF TRUTH for WHICH tables that is allowed to touch and
 * the window bounds; the SQL primitive (migration 20261184000000) and the purge
 * service (server/services/retention-purge.ts) both consume it.
 *
 * NOTE: `lib/retention/signals.ts` is an UNRELATED churn-signals module. This
 * file is data-retention policy; the two share only the directory name.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * SECURITY MODEL — POSITIVE ALLOWLIST (default-DENY).
 * ═════════════════════════════════════════════════════════════════════════════
 * A retention policy can ONLY ever target a table named in `RETENTION_PURGEABLE`.
 * Everything else in the schema is un-purgeable by construction — a table is
 * NEVER purgeable unless a reviewer consciously adds it here. That default-deny
 * posture is what makes statutory/financial/audit data safe: those tables are
 * not on the list, so no policy can be created against them, the DB CHECK
 * rejects them, and the SQL primitive refuses them.
 *
 * `RETENTION_EXCLUDED` is the second, redundant layer: an EXPLICIT, hard-coded
 * census of the domains that must NEVER become purgeable — the tripwire the
 * exclusion guard test asserts against. If a future edit ever tried to move an
 * excluded table onto the allowlist, `RETENTION_EXCLUDED ∩ RETENTION_PURGEABLE`
 * would become non-empty and __tests__/security/retention-policy-exclusions
 * would fail the build. The set is cross-checked against the GDPR statutory
 * classification (lib/gdpr) so a NEW statutory table forces a matching exclusion.
 *
 * ── THE HARD RULE (legal / financial) ────────────────────────────────────────
 * Statutorily-required data is NEVER deleted by this system:
 *   • financial records — invoices, invoice_payments, payments, finances,
 *     quotes/versions, purchase orders, goods-received, retention releases,
 *     bank statements, supplier payments;
 *   • payroll / pension / CIS / VAT / HMRC submissions (Companies Act s386 +
 *     HMRC's 6-year duty);
 *   • audit / accountability trails — activity_log, hq_events, the GDPR
 *     export/erasure logs, and this system's own purge log.
 * These live in `RETENTION_EXCLUDED` and can never appear in the allowlist.
 */

/** Disposition applied by an age-based purge run. Dry-run previews, purge deletes. */
export const RETENTION_PURGE_MODES = ["dry_run", "purge"] as const;
export type RetentionPurgeMode = (typeof RETENTION_PURGE_MODES)[number];

/**
 * Window bounds (days). A window shorter than the minimum is refused so a
 * fat-fingered "1" can't wipe a live feed; the maximum (10 years) is a sanity
 * ceiling far beyond any operational-log need. Enforced in the Zod schema, the
 * DB CHECK, and the SQL primitive alike.
 */
export const MIN_RETENTION_DAYS = 30;
export const MAX_RETENTION_DAYS = 3650;

/** A purgeable table's registry entry. */
export type PurgeableTable = {
  /** The timestamp column whose age the window is measured against. */
  timestampColumn: string;
  /** Short human label for the settings UI. */
  label: string;
  /** One-line description of what the rows are (and why ageing them is safe). */
  description: string;
};

/**
 * THE ALLOWLIST — the ONLY tables a retention policy may target.
 *
 * Every entry is a HIGH-VOLUME, TRANSIENT OPERATIONAL relation: a feed, a
 * delivery queue, a telemetry stream, or an integration mirror. NONE is a
 * financial, payroll, tax, or audit record (those are in `RETENTION_EXCLUDED`).
 * Every entry carries a NOT-NULL `org_id` (so a purge is cleanly tenant-scoped)
 * and the named `timestampColumn` (verified to exist by the SQL primitive).
 *
 * Adding a table here is a deliberate, reviewed act: the exclusion guard test
 * re-checks that no forbidden table ever lands on this list, and the drift guard
 * checks this set stays byte-identical to the DB CHECK and the SQL primitive's
 * internal allowlist.
 */
export const RETENTION_PURGEABLE: Readonly<Record<string, PurgeableTable>> =
  Object.freeze({
    notifications: {
      timestampColumn: "created_at",
      label: "In-app notifications",
      description:
        "The in-app notification feed. Ageing old items keeps the bell fast; the events they reflect live on in their own records.",
    },
    webhook_deliveries: {
      timestampColumn: "created_at",
      label: "Webhook deliveries",
      description:
        "Outbound webhook delivery attempts (status, response, retries). A transient delivery log, not business data.",
    },
    push_deliveries: {
      timestampColumn: "created_at",
      label: "Push send records",
      description:
        "Web Push send/queue records. The notifications they dispatch survive in the notifications table.",
    },
    notification_email_queue: {
      timestampColumn: "created_at",
      label: "Notification email queue",
      description:
        "Outbound notification-email queue rows (queued/sent/failed). A transient dispatch queue.",
    },
    automation_runs: {
      timestampColumn: "created_at",
      label: "Automation run history",
      description:
        "Per-run execution history for automations. Runtime telemetry — the rules and their effects are stored separately.",
    },
    maintenance_reminder_log: {
      timestampColumn: "created_at",
      label: "Maintenance reminder log",
      description:
        "Dispatch log for asset/warranty maintenance reminders. A transient send log.",
    },
    api_request_log: {
      timestampColumn: "created_at",
      label: "API request log",
      description:
        "Public API access log (key, method, route, status, timestamp). Operational request metadata, no business data.",
    },
    health_score_events: {
      timestampColumn: "created_at",
      label: "Health score history",
      description:
        "Health-score recompute events. Platform ops telemetry; the current score is derived and kept live.",
    },
    telematics_readings: {
      timestampColumn: "created_at",
      label: "Telematics readings",
      description:
        "High-frequency vehicle telematics readings (location/odometer/etc). The highest-volume stream; ageing keeps storage bounded.",
    },
    calendar_pulled_events: {
      timestampColumn: "created_at",
      label: "Mirrored calendar events",
      description:
        "A read-only mirror of external provider calendar events. The provider remains the source of truth.",
    },
  });

/** The purgeable table names, sorted. Frozen so no surface can mutate the set. */
export const RETENTION_PURGEABLE_TABLES: readonly string[] = Object.freeze(
  Object.keys(RETENTION_PURGEABLE).slice().sort(),
);

/**
 * THE EXCLUSION CENSUS — tables that must NEVER become purgeable (table → why).
 *
 * This is the explicit, hard-coded tripwire. It is INTENTIONALLY REDUNDANT with
 * the default-deny allowlist: the allowlist already makes every table here
 * un-purgeable, and this census plus its guard test make that fact loud and
 * regression-proof. Grouped by the legal/financial/audit domains the directive
 * names. Kept a strict SUPERSET of the GDPR statutory-retention set
 * (lib/gdpr `erasure_anonymise`) — the exclusion guard asserts that superset
 * relationship, so a new statutory table cannot be added to GDPR without also
 * being excluded here.
 */
export const RETENTION_EXCLUDED: Readonly<Record<string, string>> = Object.freeze({
  // ── Financial records (Companies Act 2006 s386 / HMRC 6-year duty) ──────────
  invoices: "statutory financial record (VAT/HMRC 6y)",
  invoice_line_items: "part of the statutory invoice record",
  invoice_payments: "statutory payment record (HMRC 6y)",
  invoice_payment_intents: "statutory payment record",
  payments: "statutory payment record (HMRC 6y)",
  finances: "financial record (Companies Act s386 / HMRC 6y)",
  quotes: "financial/commercial record — priced offer + variations",
  quote_versions: "financial/commercial record — quote version history",
  quote_line_items: "part of the priced quote record",
  purchase_orders: "statutory financial record (HMRC 6y)",
  purchase_order_line_items: "part of the statutory PO record",
  goods_received_notes: "financial/inventory record supporting the ledger",
  goods_received_lines: "part of the GRN record",
  retention_releases: "financial retention (money held back) record",
  job_billing_plans: "financial billing record",
  job_billing_stages: "financial billing record",
  bank_statements: "financial record (Companies Act s386 / HMRC 6y)",
  bank_statement_lines: "financial record (Companies Act s386 / HMRC 6y)",
  supplier_payments: "statutory financial record (HMRC 6y / CIS)",
  supplier_payment_allocations: "part of the statutory supplier-payment record",
  suppliers: "counterparty on retained financial records",
  // ── Payroll / pension (HMRC PAYE / Pensions Act / WTR) ──────────────────────
  payroll_runs: "statutory payroll record (HMRC/PAYE — keep 6y)",
  payroll_lines: "statutory payroll record (HMRC/PAYE)",
  payroll_tax_profiles: "statutory payroll config (PAYE)",
  pension_enrolments: "statutory auto-enrolment record (Pensions Act)",
  holiday_entitlements: "statutory employment record (WTR)",
  // ── CIS (HMRC Construction Industry Scheme) ─────────────────────────────────
  cis_subcontractors: "statutory CIS record (HMRC)",
  cis_contractor_profiles: "statutory CIS record (HMRC)",
  cis_statements: "statutory CIS deduction statement (HMRC)",
  cis_statement_payments: "part of the statutory CIS statement",
  cis_payment_snapshots: "statutory CIS payment snapshot (HMRC)",
  cis_monthly_returns: "statutory CIS300 monthly return (HMRC)",
  cis_monthly_return_lines: "part of the statutory CIS300 return",
  cis_bill_details: "CIS labour/materials split feeding the statutory deduction",
  // ── VAT / HMRC submissions ──────────────────────────────────────────────────
  hmrc_submissions: "statutory tax filing record (HMRC)",
  // ── AI ledgers carrying embedded tenant PII (GDPR-statutory: anonymise) ─────
  ai_invocations:
    "AI cost/governance ledger that may embed tenant prompt/response PII (GDPR anonymise class)",
  ai_reply_audits:
    "AI reply audit that may embed message-content PII (GDPR anonymise class)",
  // ── Audit / accountability trails ───────────────────────────────────────────
  activity_log:
    "audit/accountability trail (Art. 5(2)); its own age-retention lives in migration 20260710000000",
  hq_events: "HQ event spine — append-only platform audit/event stream",
  gdpr_export_log: "GDPR export accountability trail (Art. 5(2))",
  gdpr_erasure_log: "GDPR erasure accountability trail (Art. 5(2))",
  retention_purge_log:
    "this system's OWN append-only audit of every purge — must never be purged by it",
});

/** The excluded table names, sorted. */
export const RETENTION_EXCLUDED_TABLES: readonly string[] = Object.freeze(
  Object.keys(RETENTION_EXCLUDED).slice().sort(),
);

/** True when `table` may be targeted by a retention policy. */
export function isPurgeable(table: string): boolean {
  return Object.prototype.hasOwnProperty.call(RETENTION_PURGEABLE, table);
}

/** True when `table` is on the hard exclusion census. */
export function isExcluded(table: string): boolean {
  return Object.prototype.hasOwnProperty.call(RETENTION_EXCLUDED, table);
}

/** The timestamp column a purge measures age against, or null for a non-purgeable table. */
export function purgeableTimestampColumn(table: string): string | null {
  return isPurgeable(table) ? RETENTION_PURGEABLE[table]!.timestampColumn : null;
}

/**
 * Runtime belt-and-braces: throw if the two layers ever disagree (a purgeable
 * table that is also excluded). This can only fire on a coding error — the guard
 * test catches it at build time — but calling it before any destructive run
 * makes the invariant fail-closed in production too.
 */
export function assertRetentionSetsDisjoint(): void {
  const overlap = RETENTION_PURGEABLE_TABLES.filter((t) => isExcluded(t));
  if (overlap.length > 0) {
    throw new Error(
      `retention policy misconfiguration: excluded tables are on the purgeable allowlist: ${overlap.join(", ")}`,
    );
  }
}

/** A validated retention-policy input (from the settings form). */
export type RetentionPolicyInput = {
  targetTable: string;
  retentionDays: number;
  enabled: boolean;
};

/**
 * Validate a raw policy input WITHOUT a Zod dependency at the call site (kept
 * dependency-free so the hermetic security tier can import this module without
 * pulling server-only code). Returns the parsed input or an error message.
 */
export function parseRetentionPolicyInput(raw: {
  targetTable: unknown;
  retentionDays: unknown;
  enabled: unknown;
}): { ok: true; value: RetentionPolicyInput } | { ok: false; error: string } {
  const targetTable = typeof raw.targetTable === "string" ? raw.targetTable : "";
  if (!isPurgeable(targetTable)) {
    return { ok: false, error: "That table can't have a retention policy." };
  }
  // Defence in depth: an excluded table must never validate even if it somehow
  // reached the allowlist. assertRetentionSetsDisjoint guarantees this can't
  // happen, but we re-check per-input rather than trust the set.
  if (isExcluded(targetTable)) {
    return { ok: false, error: "That table is protected and can't be purged." };
  }
  const retentionDays =
    typeof raw.retentionDays === "number"
      ? raw.retentionDays
      : Number.parseInt(String(raw.retentionDays ?? ""), 10);
  if (
    !Number.isInteger(retentionDays) ||
    retentionDays < MIN_RETENTION_DAYS ||
    retentionDays > MAX_RETENTION_DAYS
  ) {
    return {
      ok: false,
      error: `Retention window must be between ${MIN_RETENTION_DAYS} and ${MAX_RETENTION_DAYS} days.`,
    };
  }
  const enabled = raw.enabled === true || raw.enabled === "on" || raw.enabled === "true";
  return { ok: true, value: { targetTable, retentionDays, enabled } };
}
