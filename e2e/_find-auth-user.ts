/* eslint-disable @typescript-eslint/no-explicit-any -- service-role admin client */
/**
 * Find a local Auth user by email, paging through `auth.admin.listUsers`.
 *
 * A single `listUsers({ perPage: 1000 })` page silently misses users once the
 * persistent local stack holds more than 1,000 Auth users (the shared stack
 * accumulates them across integration and e2e runs) — the global setup then
 * failed with "could not create or find seed user". Fixture-only helper.
 */
export async function findAuthUserByEmail(svc: any, email: string): Promise<any | null> {
  const target = email.toLowerCase();
  for (let page = 1; page <= 50; page++) {
    const { data, error } = await svc.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw new Error(`[e2e harness] listUsers failed: ${error.message}`);
    const users: any[] = data?.users ?? [];
    const hit = users.find((u) => (u.email ?? "").toLowerCase() === target);
    if (hit) return hit;
    if (users.length < 1000) return null;
  }
  return null;
}
