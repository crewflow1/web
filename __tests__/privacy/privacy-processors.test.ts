import { describe, expect, it } from "vitest";
import {
  buildProcessorManifest,
  PROCESSOR_MANUAL_DEADLINE_DAYS,
  type ProcessorFacts,
  type ProcessorName,
} from "@/server/services/privacy-processors";

/**
 * The per-request processor manifest (pure). Integration coverage of the census
 * and the ledger rows: __tests__/integration/privacy/company-deletion.test.ts
 * ("processors: …") and account-deletion.test.ts (CASE A).
 */
const NONE: ProcessorFacts = {
  stripe_customer_ids: [],
  twilio_number_sids: [],
  twilio_calls: 0,
  twilio_sms: 0,
  vapi_number_sids: [],
  vapi_calls: 0,
  whatsapp_route_ids: [],
};
const ORG = "6f1c2a9e-1111-4222-8333-944455556666";
const ctx = { now: new Date("2026-11-16T12:00:00Z"), billingRetentionUntil: "2032-12-31" };
type Entry = ReturnType<typeof buildProcessorManifest>[number];
const NAMES: readonly ProcessorName[] = [
  "anthropic", "posthog", "resend", "sentry", "stripe", "supabase_platform_logs", "twilio", "vapi", "vercel", "whatsapp_meta",
];
/** processor → entry; throws if the manifest is missing one (so no lookup is ever undefined). */
const by = (rows: Entry[]): Record<ProcessorName, Entry> => {
  const out = {} as Record<ProcessorName, Entry>;
  for (const name of NAMES) {
    const r = rows.find((x) => x.processor === name);
    if (!r) throw new Error(`no manifest entry for ${name}`);
    out[name] = r;
  }
  return out;
};

describe("processor manifest", () => {
  it("lists every processor exactly once, for every kind", () => {
    for (const kind of ["org", "user_account", "staff_erasure"] as const) {
      const names = buildProcessorManifest({ kind, orgId: ORG }, NONE, { posthogConfigured: false }, ctx).map((r) => r.processor);
      expect(new Set(names).size).toBe(names.length);
      expect(names.sort()).toEqual(
        ["anthropic", "posthog", "resend", "sentry", "stripe", "supabase_platform_logs", "twilio", "vapi", "vercel", "whatsapp_meta"],
      );
    }
  });

  it("company: the Stripe customer is RETAINED for tax (never deleted), with the billing retention date", () => {
    const m = by(buildProcessorManifest({ kind: "org", orgId: ORG }, { ...NONE, stripe_customer_ids: ["cus_ABC", "cus_ABC", null as unknown as string] }, { posthogConfigured: false }, ctx));
    expect(m.stripe).toEqual({
      processor: "stripe",
      disposition: "retained_legal",
      held_count: 1,
      external_refs: ["cus_ABC"],
      retention_until: "2032-12-31",
      due_by: null,
    });
  });

  it("a person never touches the company's Stripe customer, analytics identity, numbers or routes", () => {
    const facts: ProcessorFacts = {
      ...NONE,
      stripe_customer_ids: ["cus_ABC"],
      vapi_number_sids: ["PNvapi"],
      vapi_calls: 3,
      whatsapp_route_ids: ["123456"],
    };
    for (const kind of ["user_account", "staff_erasure"] as const) {
      const m = by(buildProcessorManifest({ kind, orgId: ORG }, facts, { posthogConfigured: true }, ctx));
      for (const p of ["stripe", "posthog", "vapi", "whatsapp_meta"] as const) expect(m[p].disposition, `${kind}/${p}`).toBe("not_held");
    }
  });

  it("texts sent to a person are a manual Twilio request for that person", () => {
    const m = by(buildProcessorManifest({ kind: "user_account", orgId: null }, { ...NONE, twilio_sms: 2 }, { posthogConfigured: false }, ctx));
    expect(m.twilio).toMatchObject({ disposition: "manual_request", held_count: 2, due_by: "2026-12-16" });
  });

  it("company with provider footprints: open manual requests with a deadline; analytics keyed by the org HASH only", () => {
    const m = by(
      buildProcessorManifest(
        { kind: "org", orgId: ORG },
        { ...NONE, twilio_number_sids: ["PN1"], twilio_calls: 4, whatsapp_route_ids: ["98765"] },
        { posthogConfigured: true },
        ctx,
      ),
    );
    const due = new Date(ctx.now.getTime() + PROCESSOR_MANUAL_DEADLINE_DAYS * 86_400_000).toISOString().slice(0, 10);
    expect(m.twilio).toMatchObject({ disposition: "manual_request", held_count: 5, external_refs: ["PN1"], due_by: due });
    expect(m.whatsapp_meta).toMatchObject({ disposition: "manual_request", held_count: 1, external_refs: ["98765"] });
    expect(m.posthog.disposition).toBe("manual_request");
    expect(m.posthog.external_refs).toHaveLength(1);
    expect(m.posthog.external_refs[0] ?? "").toMatch(/^org_[0-9a-f]{32}$/);
    expect(m.posthog.external_refs[0] ?? "").not.toContain(ORG);
  });

  it("analytics not configured → nothing held; log processors age out; Sentry holds nothing by design", () => {
    const m = by(buildProcessorManifest({ kind: "org", orgId: ORG }, NONE, { posthogConfigured: false }, ctx));
    expect(m.posthog.disposition).toBe("not_held");
    for (const p of ["resend", "anthropic", "supabase_platform_logs", "vercel"] as const) expect(m[p].disposition).toBe("ages_out");
    expect(m.sentry.disposition).toBe("not_held");
    expect(Object.values(m).every((r) => (r.disposition === "manual_request") === (r.due_by !== null))).toBe(true);
  });

  it("never carries a personal value: refs that look like an email, phone or free text are dropped", () => {
    const m = by(
      buildProcessorManifest(
        { kind: "org", orgId: ORG },
        { ...NONE, stripe_customer_ids: ["jane@example.invalid", "+447700900123", "two words", "cus_OK"] },
        { posthogConfigured: false },
        ctx,
      ),
    );
    expect(m.stripe.external_refs).toEqual(["cus_OK"]);
  });
});
