import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Programme D — the commercial read-model must stay on the TENANT client.
 *
 * The unified commercial view assembles a job's costs, purchase orders,
 * finances, profit and margin — data that is safe operator-side ONLY because
 * every read goes through `createClient()` (anon key + user JWT → RLS +
 * impersonation-awareness). The service-role admin client (`createAdminClient`,
 * `lib/supabase/admin.ts`) BYPASSES RLS; `finances` has no `customer_id` and is
 * protected by RLS alone. If a future refactor swapped the loader to the admin
 * client "to simplify a join", the org boundary would silently vanish.
 *
 * This hermetic source-contract test fails closed on that: the route must use
 * the tenant client and must never import the admin client. The pure aggregators
 * must touch no Supabase client at all.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");
const readCode = (p: string) =>
  read(p)
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    })
    .join("\n");

const ROUTE = "app/(app)/jobs/[id]/commercial/page.tsx";
const CASH = "lib/commercial/cash.ts";
const TIMELINE = "lib/commercial/timeline.ts";

describe("Programme D — commercial read-model tenancy contract", () => {
  it("the route reads through the tenant client (createClient)", () => {
    const code = readCode(ROUTE);
    expect(code).toMatch(/from\s+["']@\/lib\/supabase\/server["']/);
    expect(code).toMatch(/createClient\(\)/);
  });

  it("the route NEVER imports or calls the RLS-bypassing admin client", () => {
    const code = readCode(ROUTE);
    expect(code).not.toMatch(/createAdminClient/);
    expect(code).not.toMatch(/supabase\/admin/);
    expect(code).not.toMatch(/service_role/i);
  });

  it("the pure aggregators touch no Supabase client (data is passed in)", () => {
    for (const p of [CASH, TIMELINE]) {
      const code = readCode(p);
      expect(code, `${p} must be pure`).not.toMatch(/@\/lib\/supabase/);
      expect(code, `${p} must not create a client`).not.toMatch(/createClient|createAdminClient/);
    }
  });
});
