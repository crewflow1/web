import { serviceClient } from "../_harness";

/**
 * The CrewFlow-wide AI ceiling (20261358000000; £100/month, founder decision) sums EVERY
 * organisation's monthly spend. The per-organisation budget suites fill probe orgs to their
 * own £100 default ceiling — which alone exhausts the platform budget, so the platform gate
 * (correctly) refuses the next org and those suites could no longer observe per-org
 * semantics. They therefore lift the platform ceiling for the duration of their own file and
 * restore the exact previous value afterwards. Integration files run serially
 * (`fileParallelism: false`), so no other file observes the lifted value. The platform gate
 * itself is proven separately, at £100, in platform-ceiling.test.ts.
 *
 * Schema without 20261358000000 (no table): a no-op.
 */
type Budget = {
  from(t: string): {
    select(c: string): { eq(k: string, v: unknown): { maybeSingle(): PromiseLike<{ data: { ceiling_pence?: number } | null; error: unknown }> } };
    update(row: Record<string, unknown>): { eq(k: string, v: unknown): PromiseLike<{ error: { message: string } | null }> };
  };
};

export async function liftPlatformCeilingForThisFile(): Promise<() => Promise<void>> {
  const svc = serviceClient() as unknown as Budget;
  const cur = await svc.from("ai_platform_budget").select("ceiling_pence").eq("id", true).maybeSingle();
  if (cur.error || !cur.data || typeof cur.data.ceiling_pence !== "number") return async () => {};
  const previous = cur.data.ceiling_pence;
  const up = await svc.from("ai_platform_budget").update({ ceiling_pence: 1_000_000 }).eq("id", true);
  if (up.error) throw new Error(`could not lift the platform ceiling for this file: ${up.error.message}`);
  return async () => {
    const back = await svc.from("ai_platform_budget").update({ ceiling_pence: previous }).eq("id", true);
    if (back.error) throw new Error(`could not restore the platform ceiling: ${back.error.message}`);
  };
}
