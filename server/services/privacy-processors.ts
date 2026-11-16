import "server-only";

import { hashOrgId } from "@/lib/analytics/identity";

/**
 * PROCESSOR DELETION REQUESTS — what third parties hold for a deletion target,
 * and what is done about each.
 *
 * A deletion in CrewFlow's own database does not reach copies held by its
 * sub-processors. For every deletion request the engine records a manifest —
 * one row per processor in `privacy_processor_requests` (migration
 * 20261359000000 §8) — built here from two inputs:
 *   • FACTS read from the database while the target's rows still exist
 *     (`privacy_processor_census`: Stripe customer ids, telephony number SIDs,
 *     call / SMS counts, WhatsApp routes) — opaque handles and counts only;
 *   • the deployment's CONFIGURATION (is analytics configured?).
 *
 * No provider API is called from here. Where a provider offers no deletion
 * path CrewFlow may use today (or the integration is deliberately dark), the
 * row is an OPEN `manual_request` with a deadline, worked by an operator from
 * docs/programme/deletion/PROCESSOR-DELETION-RUNBOOK.md. Decisions per
 * processor and their reasons: DELETION-DESIGN.md §6 and
 * LEGAL-RETENTION-DECISIONS.md.
 */

/** An open manual processor request must be actioned within this many days. */
export const PROCESSOR_MANUAL_DEADLINE_DAYS = 30;

export type ProcessorName =
  | "stripe"
  | "posthog"
  | "twilio"
  | "vapi"
  | "whatsapp_meta"
  | "resend"
  | "sentry"
  | "anthropic"
  | "supabase_platform_logs"
  | "vercel";

export type ProcessorDisposition =
  | "api_done"
  | "retained_legal"
  | "manual_request"
  | "ages_out"
  | "not_held";

export type ProcessorEntry = {
  processor: ProcessorName;
  disposition: ProcessorDisposition;
  held_count: number;
  external_refs: string[];
  retention_until: string | null;
  due_by: string | null;
};

/** What `privacy_processor_census` returns. */
export type ProcessorFacts = {
  stripe_customer_ids: string[];
  twilio_number_sids: string[];
  twilio_calls: number;
  twilio_sms: number;
  vapi_number_sids: string[];
  vapi_calls: number;
  whatsapp_route_ids: string[];
};

export type ProcessorEnv = { posthogConfigured: boolean };

export function processorEnvFromProcess(): ProcessorEnv {
  const set = (v: string | undefined) => typeof v === "string" && v.trim().length > 0;
  return {
    posthogConfigured: set(process.env.POSTHOG_SERVER_KEY) || set(process.env.NEXT_PUBLIC_POSTHOG_KEY),
  };
}

/** Same alphabet the table's CHECK enforces: no '@', '+' or spaces → never an email or phone. */
const OPAQUE_REF = /^[A-Za-z0-9_.-]{1,80}$/;

function refs(ids: readonly unknown[] | null | undefined): string[] {
  const out = new Set<string>();
  for (const id of ids ?? []) if (typeof id === "string" && OPAQUE_REF.test(id)) out.add(id);
  return [...out].sort().slice(0, 50);
}

function count(n: unknown): number {
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

function addDays(now: Date, days: number): string {
  return new Date(now.getTime() + days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * The manifest for one deletion request. Pure: same facts + env → same rows.
 *
 * `scope.kind === "org"` covers everything the company had; the two per-person
 * kinds cover only what is keyed to that person (a person's deletion never
 * touches the company's Stripe customer, numbers or analytics).
 */
export function buildProcessorManifest(
  scope: { kind: "org" | "user_account" | "staff_erasure"; orgId: string | null },
  facts: ProcessorFacts,
  env: ProcessorEnv,
  ctx: { now: Date; billingRetentionUntil: string },
): ProcessorEntry[] {
  const due = addDays(ctx.now, PROCESSOR_MANUAL_DEADLINE_DAYS);
  const entry = (
    processor: ProcessorName,
    disposition: ProcessorDisposition,
    extra: Partial<Pick<ProcessorEntry, "held_count" | "external_refs" | "retention_until">> = {},
  ): ProcessorEntry => ({
    processor,
    disposition,
    held_count: extra.held_count ?? 0,
    external_refs: extra.external_refs ?? [],
    retention_until: extra.retention_until ?? null,
    due_by: disposition === "manual_request" ? due : null,
  });
  const isOrg = scope.kind === "org";
  const out: ProcessorEntry[] = [];

  // Stripe — the customer object and its invoices are CrewFlow's OWN accounting
  // record of the company: retained (not deleted) for the tax period; the
  // subscription is cancelled by the engine's `stripe_cancel` step. A person has
  // no Stripe object of their own.
  const customers = refs(facts.stripe_customer_ids);
  out.push(
    isOrg && customers.length > 0
      ? entry("stripe", "retained_legal", {
          held_count: customers.length,
          external_refs: customers,
          retention_until: ctx.billingRetentionUntil,
        })
      : entry("stripe", "not_held"),
  );

  // PostHog — the server sink keys events by a one-way hash of the org id and the
  // browser SDK never identifies a person (person_profiles: identified_only, no
  // identify call). So: an org's hashed person, if analytics is configured; never
  // a person.
  out.push(
    isOrg && env.posthogConfigured && scope.orgId
      ? entry("posthog", "manual_request", { held_count: 1, external_refs: [hashOrgId(scope.orgId)] })
      : entry("posthog", "not_held"),
  );

  // Telephony (dark integrations — never called from here). Numbers, call logs /
  // recordings and message logs live at the provider; deleting them needs the
  // provider console or an API step that does not exist until activation.
  const twNums = refs(facts.twilio_number_sids);
  const twHeld = twNums.length + count(facts.twilio_calls) + count(facts.twilio_sms);
  out.push(
    twHeld > 0
      ? entry("twilio", "manual_request", { held_count: twHeld, external_refs: twNums })
      : entry("twilio", "not_held"),
  );
  const vapiNums = refs(facts.vapi_number_sids);
  const vapiHeld = vapiNums.length + count(facts.vapi_calls);
  out.push(
    isOrg && vapiHeld > 0
      ? entry("vapi", "manual_request", { held_count: vapiHeld, external_refs: vapiNums })
      : entry("vapi", "not_held"),
  );
  const routes = refs(facts.whatsapp_route_ids);
  out.push(
    isOrg && routes.length > 0
      ? entry("whatsapp_meta", "manual_request", { held_count: routes.length, external_refs: routes })
      : entry("whatsapp_meta", "not_held"),
  );

  // Providers that keep their own logs for a plan-defined period and offer no
  // per-record deletion: nothing to call; disclosed in the privacy notice.
  out.push(entry("resend", "ages_out"));
  out.push(entry("anthropic", "ages_out"));
  out.push(entry("supabase_platform_logs", "ages_out"));
  out.push(entry("vercel", "ages_out"));

  // Sentry — sendDefaultPii:false, scrubEvent on every event, no setUser,
  // replays off: no user context is ever sent.
  out.push(entry("sentry", "not_held"));

  return out;
}
