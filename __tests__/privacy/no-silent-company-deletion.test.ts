import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isPurgeable, RETENTION_PURGEABLE_TABLES } from "@/lib/retention/policy";
import { drainDueDeletionRequests, type DeletionAdminClient } from "@/server/services/privacy-deletion";

/**
 * CASE C — cancelling a subscription never deletes data (founder policy
 * 2026-11-16). A company leaves CrewFlow's database only through an explicit,
 * owner-made company-deletion request run by the deletion engine. This file
 * pins every OTHER way a company could disappear:
 *   1. no application code deletes an `organizations` row except two rollbacks
 *      of a company created moments earlier in the same request;
 *   2. no migration (database function, trigger or scheduled job) does, except
 *      the sanctioned teardown primitive;
 *   3. only the deletion UI actions and the retention cron's drain reach the
 *      deletion engine — no billing, Stripe-webhook or cancellation code does;
 *   4. the retention purge can never name a company or its core records;
 *   5. the drain runs ONLY what the ledger holds — elapsed time alone (a company
 *      cancelled for years) triggers nothing.
 * The behavioural half (a real cancelled company, the drain switched on) is
 * __tests__/integration/privacy/cancellation-never-deletes.test.ts.
 */

const ROOT = path.resolve(__dirname, "../..");

function walk(dir: string, exts: RegExp, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, exts, out);
    else if (exts.test(name)) out.push(full);
  }
  return out;
}

const rel = (f: string) => path.relative(ROOT, f).split(path.sep).join("/");
const appSources = ["app", "server", "lib", "components"].flatMap((d) => walk(path.join(ROOT, d), /\.(ts|tsx)$/));

describe("CASE C — no path other than an explicit deletion request removes a company", () => {
  it("application code deletes an organisation row only to roll back one it has just created", () => {
    const hits = appSources
      .filter((f) => /\.from\(\s*["'`]organizations["'`]\s*\)\s*\.delete\(/.test(readFileSync(f, "utf8")))
      .map(rel)
      .sort();
    // bootstrap-account: signup failed after creating the org. demo-lifecycle:
    // demo provisioning failed after creating the org. Both delete only the id
    // they inserted in the same call.
    expect(hits).toEqual(["server/services/bootstrap-account.ts", "server/services/demo-lifecycle.ts"]);
  });

  it("no migration deletes an organisation except the sanctioned teardown primitive", () => {
    const migrations = walk(path.join(ROOT, "supabase/migrations"), /\.sql$/);
    expect(migrations.length).toBeGreaterThan(400);
    const hits = migrations
      .filter((f) => {
        const sql = readFileSync(f, "utf8").replace(/--[^\n]*/g, "");
        return /delete\s+from\s+(public\.)?"?organizations"?\b/i.test(sql);
      })
      .map((f) => path.basename(f));
    expect(hits).toEqual(["20261360000000_privacy_org_teardown.sql"]);
  });

  it("only the deletion actions and the retention cron's drain reach the deletion engine", () => {
    const importers = appSources
      .filter((f) => /from\s+["']@\/server\/services\/privacy-deletion["']/.test(readFileSync(f, "utf8")))
      .map(rel)
      .sort();
    expect(importers).toEqual([
      "app/(app)/settings/account/actions.ts",
      "app/(app)/settings/account/page.tsx",
      "app/(app)/staff/[id]/page.tsx",
      "app/(app)/staff/erasure-actions.ts",
      "app/api/cron/retention-purge/route.ts",
    ]);
    // The cron uses the drain only — it never creates a request.
    const cron = readFileSync(path.join(ROOT, "app/api/cron/retention-purge/route.ts"), "utf8");
    expect(cron).not.toMatch(/request(Org|Account)Deletion|requestStaffErasure|privacy_request_create/);
    // Nothing outside the engine calls the destructive primitives directly.
    const direct = appSources
      .filter((f) => /rpc\(\s*["'](privacy_org_teardown|privacy_org_lockout|privacy_request_create|gdpr_erase_org)["']/.test(readFileSync(f, "utf8")))
      .map(rel)
      .sort();
    expect(direct).toEqual(["server/services/gdpr-erase.ts", "server/services/privacy-deletion.ts"]);
  });

  it("the retention purge can never name a company or its core records", () => {
    for (const t of ["organizations", "memberships", "org_subscriptions", "billing_invoices", "subscription_cancellations", "invoices", "jobs", "customers"]) {
      expect(isPurgeable(t), t).toBe(false);
      expect(RETENTION_PURGEABLE_TABLES).not.toContain(t);
    }
  });

  it("the drain runs only what the ledger holds: with no request, nothing runs — however long a company has been cancelled", async () => {
    const reads: string[] = [];
    const rpcs: string[] = [];
    const chain = {
      eq: () => chain,
      in: () => chain,
      lte: () => chain,
      lt: () => chain,
      order: () => chain,
      limit: () => chain,
      range: () => chain,
      maybeSingle: () => Promise.resolve({ data: null, error: null }),
      then: (ok: (v: { data: unknown[]; error: null }) => unknown) => Promise.resolve({ data: [], error: null }).then(ok),
    };
    const fake = {
      from: (table: string) => {
        reads.push(table);
        return { select: () => chain };
      },
      rpc: (fn: string) => {
        rpcs.push(fn);
        return Promise.resolve({ data: null, error: null });
      },
      storage: { from: () => ({ list: async () => ({ data: [], error: null }), remove: async () => ({ data: null, error: null }) }) },
      auth: { admin: { deleteUser: async () => ({ error: null }) } },
    } as unknown as DeletionAdminClient;
    const prev = process.env.FEATURE_ACCOUNT_DELETION;
    process.env.FEATURE_ACCOUNT_DELETION = "true";
    try {
      const out = await drainDueDeletionRequests({ limit: 50 }, { admin: fake, now: () => new Date("2099-01-01T00:00:00Z") });
      expect(out).toEqual({ enabled: true, considered: 0, results: [] });
    } finally {
      if (prev === undefined) delete process.env.FEATURE_ACCOUNT_DELETION;
      else process.env.FEATURE_ACCOUNT_DELETION = prev;
    }
    expect(reads).toEqual(["privacy_deletion_requests"]);
    expect(rpcs).toEqual([]);
  });
});
