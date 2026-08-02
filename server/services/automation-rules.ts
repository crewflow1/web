import "server-only";
import { readFailure } from "@/lib/supabase/read-failure";
import { AUTOMATION_RULES } from "@/lib/automation/rules";
import type { AutomationRule } from "@/lib/automation/events";

/**
 * Automation OS — per-org rule enable-state (table automation_rules, 20261096).
 *
 * The static catalogue in lib/automation/rules.ts is the DEFAULT/seed; a row in
 * automation_rules OVERRIDES a single rule's enabled-state for a single org. No
 * override row → the catalogue default stands, so the engine's behaviour for an
 * org that has never touched a toggle is byte-for-byte what it was before this
 * table existed.
 *
 * SCOPING — the money-table doctrine, applied to automation config:
 *   1. RLS is the OUTER boundary (member-read / admin-write, DB-enforced).
 *   2. `org_id` is PINNED on every read AND write here. `current_org_ids()`
 *      returns EVERY org the caller belongs to, so RLS alone BLENDS orgs for a
 *      dual-org member. An override toggled with the wrong org pin would flip a
 *      rule for the wrong company — so the pin is load-bearing, exactly as it is
 *      for job_budgets / expense_budgets.
 *
 * TWO READ FLAVOURS:
 *   · loud (loadRuleOverrides / listAutomationRulesForOrg) — for the UI. Binds
 *     `error` and throws readFailure so an empty result can never be confused
 *     with a failed query.
 *   · best-effort (loadRuleOverridesBestEffort) — for the DISPATCHER, which must
 *     never throw (a domain action must not be derailed by an automation read).
 *     On error it logs and returns an EMPTY map, so the engine falls back to the
 *     catalogue defaults — the safe, unchanged behaviour.
 *
 * automation_rules is not in the generated Supabase types yet, so it goes
 * through the established loose-client cast (the job-budget / expense-budget
 * idiom). The cast is TypeScript-only; the runtime client is unchanged.
 */

type Row = Record<string, unknown>;
type Builder = PromiseLike<{ data: Row[] | null; error: unknown }> & {
  select: (c: string) => Builder;
  eq: (k: string, v: unknown) => Builder;
  order: (k: string, o: { ascending: boolean }) => Builder;
  limit: (n: number) => Builder;
};
export type AutomationRuleClient = { from: (t: string) => Builder };

/** The set of catalogue rule ids — the only keys a write is allowed to target. */
const KNOWN_RULE_KEYS: ReadonlySet<string> = new Set(
  AUTOMATION_RULES.map((r) => r.id),
);

/** True when `key` names a rule the code catalogue actually defines. */
export function isKnownRuleKey(key: string): boolean {
  return KNOWN_RULE_KEYS.has(key);
}

/**
 * The catalogue merged with an org's overrides — what the UI renders and what a
 * toggle acts on.
 */
export type AutomationRuleView = {
  rule: AutomationRule;
  /** Effective enabled-state for THIS org (override if present, else default). */
  enabled: boolean;
  /** The catalogue default, so the UI can show "overridden" honestly. */
  defaultEnabled: boolean;
  /** True when a per-org override row exists for this rule. */
  overridden: boolean;
};

const COLS = "rule_key, enabled";

/**
 * Load an org's rule overrides as `rule_key → enabled`. LOUD: throws on error.
 * Org-pinned.
 */
export async function loadRuleOverrides(
  client: AutomationRuleClient,
  orgId: string,
): Promise<Map<string, boolean>> {
  const res = await client
    .from("automation_rules")
    .select(COLS)
    .eq("org_id", orgId)
    .limit(500);
  if (res.error) throw readFailure("automation rules: overrides", res.error);
  return toMap(res.data ?? []);
}

/**
 * Load an org's rule overrides for the DISPATCHER. Best-effort: never throws —
 * on error it logs and returns an empty map, so the engine falls back to the
 * catalogue defaults (unchanged behaviour). Org-pinned.
 */
export async function loadRuleOverridesBestEffort(
  client: AutomationRuleClient,
  orgId: string,
): Promise<Map<string, boolean>> {
  try {
    const res = await client
      .from("automation_rules")
      .select(COLS)
      .eq("org_id", orgId)
      .limit(500);
    if (res.error) {
      console.error("[automation] rule-override read failed", {
        org_id: orgId,
        error: (res.error as { message?: string }).message ?? String(res.error),
      });
      return new Map();
    }
    return toMap(res.data ?? []);
  } catch (e) {
    console.error("[automation] rule-override read threw", {
      org_id: orgId,
      error: e instanceof Error ? e.message : String(e),
    });
    return new Map();
  }
}

function toMap(rows: Row[]): Map<string, boolean> {
  const out = new Map<string, boolean>();
  for (const r of rows) {
    const key = r.rule_key as string | undefined;
    if (key && KNOWN_RULE_KEYS.has(key)) {
      out.set(key, Boolean(r.enabled));
    }
    // An override for an unknown key (a rule since removed from the catalogue)
    // is silently ignored — merged only against rules the code still defines.
  }
  return out;
}

/**
 * The effective enabled-state for one rule under an org's overrides: the
 * override if the org set one, otherwise the catalogue default.
 */
export function effectiveEnabled(
  rule: AutomationRule,
  overrides: Map<string, boolean>,
): boolean {
  return overrides.has(rule.id) ? overrides.get(rule.id)! : rule.enabled;
}

/**
 * The full catalogue, merged with an org's overrides — for Settings → Automations.
 * LOUD read, org-pinned.
 */
export async function listAutomationRulesForOrg(
  client: AutomationRuleClient,
  orgId: string,
): Promise<AutomationRuleView[]> {
  const overrides = await loadRuleOverrides(client, orgId);
  return AUTOMATION_RULES.map((rule) => ({
    rule,
    enabled: effectiveEnabled(rule, overrides),
    defaultEnabled: rule.enabled,
    overridden: overrides.has(rule.id),
  }));
}

/**
 * Upsert an org's override for one rule. Org-pinned on BOTH the payload and the
 * conflict target. `rule_key` is validated against the code catalogue first, so
 * a write can never persist an override for a rule that does not exist.
 *
 * This is called from an ALREADY admin-gated server action; the automation_rules
 * admin-write RLS policies are the real DB boundary (the caller's client carries
 * the user's JWT). Returns nothing; throws on a database error so the action can
 * surface it.
 */
export async function setAutomationRuleEnabled(
  client: AutomationRuleClient,
  orgId: string,
  ruleKey: string,
  enabled: boolean,
  userId: string | null,
): Promise<void> {
  if (!isKnownRuleKey(ruleKey)) {
    throw new Error(`unknown automation rule_key: ${ruleKey}`);
  }
  const upsert = (
    client.from("automation_rules") as unknown as {
      upsert: (
        row: unknown,
        opts: { onConflict: string },
      ) => PromiseLike<{ error: { message: string } | null }>;
    }
  ).upsert(
    {
      org_id: orgId,
      rule_key: ruleKey,
      enabled,
      updated_by: userId,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "org_id,rule_key" },
  );
  const { error } = await upsert;
  if (error) throw new Error(`automation rule toggle failed: ${error.message}`);
}
