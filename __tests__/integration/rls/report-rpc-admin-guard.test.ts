import { beforeAll, expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient, userClient } from "../_harness";

/**
 * R5 Phase 4 (slice 3) — report RPCs are owner/admin-only (migration 20261253).
 *
 * These six SECURITY DEFINER report RPCs bypass RLS and are EXECUTE-granted to
 * `authenticated`, so the app's client-side /reports page gate does not stop a
 * staff JWT POSTing /rest/v1/rpc. They must refuse a non-admin (42501) while
 * still answering owners/admins. (The /reports pages already deny staff; this
 * closes the direct-RPC indirect leak that re-opens R5 Phase 3/4 base-table
 * narrowing + leaks per-worker hours regardless.)
 */

type Res = { data: unknown; error: { message: string; code?: string } | null };
type Rpc = (fn: string, args: Record<string, unknown>) => PromiseLike<Res>;
const rpc = (client: unknown) => client as unknown as { rpc: Rpc };
const svc = () => serviceClient() as unknown as { from(t: string): { insert(r: Record<string, unknown>): { select(c?: string): { single(): PromiseLike<{ data: { id: string } | null; error: { message: string } | null }> } } } };
const TOKEN = `r5rpt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

let orgA = "";
const tok: Record<string, string> = {};
const uid: Record<string, string> = {};

const insId = async (table: string, row: Record<string, unknown>): Promise<string> =>
  String((await svc().from(table).insert(row).select("id").single()).data?.id ?? "");

async function mkUser(s: string): Promise<{ id: string; token: string }> {
  const email = `${TOKEN}-${s}@example.test`;
  const password = `Pw-${TOKEN}-${s}-${Math.random().toString(36).slice(2)}`;
  const created = await serviceClient().auth.admin.createUser({ email, password, email_confirm: true });
  const id = created.data.user?.id ?? "";
  await svc().from("users").insert({ id, email, full_name: `RPT ${s}` }).select("id").single();
  const token = (await anonClient().auth.signInWithPassword({ email, password })).data.session?.access_token ?? "";
  if (!id || !token) throw new Error(`mint ${s}`);
  return { id, token };
}

// name → args keyed on the org (param name differs per function).
const CALLS: { fn: string; args: (org: string) => Record<string, unknown> }[] = [
  { fn: "report_profit_labour_hours", args: (o) => ({ p_org: o }) },
  { fn: "report_profit_stock_cogs", args: (o) => ({ p_org: o }) },
  { fn: "report_aged_receivables", args: (o) => ({ p_org_id: o, p_as_at: "2026-02-01" }) },
  { fn: "reports_revenue_per_month", args: (o) => ({ p_org_id: o, p_months: 3 }) },
  { fn: "reports_top_customers_by_revenue", args: (o) => ({ p_org_id: o, p_limit: 5 }) },
  { fn: "reports_jobs_per_week", args: (o) => ({ p_org_id: o, p_weeks: 4 }) },
];

describeIntegration("rls · report RPCs admin-only (20261253 · R5 Phase 4)", () => {
  beforeAll(async () => {
    orgA = await insId("organizations", { name: `RPT ${TOKEN}`, slug: `${TOKEN}-a` });
    for (const who of ["admin", "staff"]) {
      const u = await mkUser(who);
      uid[who] = u.id; tok[who] = u.token;
    }
    await svc().from("memberships").insert({ org_id: orgA, user_id: uid.admin, role: "owner" }).select("user_id").single();
    await svc().from("memberships").insert({ org_id: orgA, user_id: uid.staff, role: "staff" }).select("user_id").single();
  });

  for (const { fn, args } of CALLS) {
    it(`${fn}: staff denied (42501), owner allowed, anon denied`, async () => {
      const staff = await rpc(userClient(tok.staff ?? "")).rpc(fn, args(orgA));
      expect(staff.error, `${fn}: staff must be denied`).not.toBeNull();
      expect(String(staff.error?.code ?? staff.error?.message ?? "")).toMatch(/42501|Forbidden|owner\/admin/i);

      const owner = await rpc(userClient(tok.admin ?? "")).rpc(fn, args(orgA));
      expect(owner.error, `${fn}: owner must be allowed (${owner.error?.message})`).toBeNull();

      const anon = await rpc(anonClient()).rpc(fn, args(orgA));
      expect(anon.error, `${fn}: anon must be denied`).not.toBeNull();
    });
  }
});
