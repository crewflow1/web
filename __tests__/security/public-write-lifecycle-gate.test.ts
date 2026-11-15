import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { publicWriteAllowed } from "@/lib/auth/org-status";

/**
 * D-17 — public (unauthenticated / token / API-key) WRITE paths respect the company lifecycle.
 *
 * 1. The rule itself (pure).
 * 2. An INVENTORY: every server-action file under the public surfaces, and every other public
 *    write entry point, must go through the lifecycle gate. A new public action that forgets
 *    it fails here. Behaviour is proved against real Postgres in
 *    __tests__/integration/adversarial/public-links-lifecycle.test.ts.
 */
const ROOT = resolve(__dirname, "../..");
const read = (f: string) => readFileSync(resolve(ROOT, f), "utf8");

describe("publicWriteAllowed (D-17 rule)", () => {
  const STATES = ["active", "trial", "pending", "suspended", "rejected", "cancelled", null, undefined, "", "something-new"];
  it("operational: active / trial only", () => {
    for (const s of STATES) expect(publicWriteAllowed(s, "operational"), String(s)).toBe(s === "active" || s === "trial");
  });
  it("payment: also while suspended / cancelled (an existing debt), never pending / rejected / unknown", () => {
    for (const s of STATES) {
      expect(publicWriteAllowed(s, "payment"), String(s)).toBe(["active", "trial", "suspended", "cancelled"].includes(s as string));
    }
  });
  it("consent: always (the data subject's own rights)", () => {
    for (const s of STATES) expect(publicWriteAllowed(s, "consent")).toBe(true);
  });
});

describe("public write entry points go through the lifecycle gate (inventory)", () => {
  const PUBLIC_ACTION_ROOTS = ["app/customer-portal", "app/worker-portal", "app/q", "app/l", "app/payment"];
  const walk = (dir: string, out: string[] = []): string[] => {
    if (!existsSync(resolve(ROOT, dir))) return out;
    for (const e of readdirSync(resolve(ROOT, dir), { withFileTypes: true })) {
      const p = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(p, out);
      else if (/\.(ts|tsx)$/.test(e.name) && /^\s*["']use server["'];?/m.test(read(p))) out.push(p);
    }
    return out;
  };
  const actions = PUBLIC_ACTION_ROOTS.flatMap((d) => walk(d));

  // app/q/[token]/actions.ts only validates + dispatches to acceptQuoteByToken / declineQuoteByToken
  // (app/(app)/quotes/actions.ts), which carry the gate — asserted separately below.
  const DELEGATES = new Set(["app/q/[token]/actions.ts"]);
  const GATE = /\b(gatePortalWrite|orgPublicWriteRefused|assertOrgAcceptsPublicWrite|isHeldStatus|publicWriteAllowed)\b/;

  it("finds the public action files (sanity)", () => {
    expect(actions.length).toBeGreaterThanOrEqual(14);
  });

  it.each(actions)("%s is gated", (f) => {
    if (DELEGATES.has(f)) return;
    const src = read(f);
    expect(GATE.test(src), `${f} is a public server action with no company-lifecycle gate`).toBe(true);
    // a portal action never uses the bare loader: every call is wrapped by the write gate
    const bare = (src.match(/loadCustomerByPortalToken\(/g) ?? []).length;
    const gated = (src.match(/gatePortalWrite\(await loadCustomerByPortalToken\(/g) ?? []).length;
    expect(gated, `${f}: every loadCustomerByPortalToken call must be wrapped by gatePortalWrite`).toBe(bare);
  });

  it("the quote link, the lead form, inbound ingestion, API keys and SCIM carry the gate", () => {
    const quotes = read("app/(app)/quotes/actions.ts");
    for (const fn of ["acceptQuoteByToken", "declineQuoteByToken"]) {
      const body = quotes.slice(quotes.indexOf(`export async function ${fn}(`)).slice(0, 2500);
      expect(body, fn).toMatch(/orgPublicWriteRefused\(quote\.org_id, "operational"\)/);
    }
    expect(read("app/api/public/lead/route.ts")).toMatch(/publicWriteAllowed\(org\.status, "operational"\)/);
    const rec = read("server/services/receptionist.ts");
    const core = rec.slice(rec.indexOf("export async function processInboundEnquiry(")).slice(0, 2500);
    expect(core).toMatch(/assertOrgAcceptsPublicWrite\(input\.org_id, "operational"\)/);
    expect(read("lib/api-auth/resolve.ts")).toMatch(/orgPublicWriteRefused\(data\.org_id, "operational"\)/);
    expect(read("lib/enterprise-sso/scim-auth.ts")).toMatch(/orgPublicWriteRefused\(cfg\.orgId, "operational"\)/);
  });

  it("consent and payment are the ONLY relaxed kinds, and only where they belong", () => {
    const relaxed = actions.filter((f) => /gatePortalWrite\(await loadCustomerByPortalToken\([^)]*\), "(consent|payment)"\)/.test(read(f))).sort();
    expect(relaxed).toEqual([
      "app/customer-portal/_contact-action.ts",
      "app/customer-portal/_pay-action.ts",
      "app/customer-portal/_preferences-action.ts",
      "app/customer-portal/_upload-action.ts",
    ]);
  });
});

describe("scheduled customer senders skip companies that are not active (inventory)", () => {
  it.each([
    "app/api/cron/invoice-reminders/route.ts",
    "app/api/cron/quote-followup/route.ts",
    "server/services/review-requests.ts",
    "server/services/lead-followups.ts",
    "server/services/maintenance-reminders.ts",
    "server/services/automation-schedules.ts",
  ])("%s filters on loadNonActiveOrgIds", (f) => {
    const src = read(f);
    expect(src).toMatch(/loadNonActiveOrgIds\(\)/);
    expect(src, `${f} must actually USE the held set`).toMatch(/heldOrgs\.has\(/);
  });
});
