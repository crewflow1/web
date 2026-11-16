import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { fetchAllRows } from "@/lib/supabase/paginate";
import { publicWriteAllowed, type PublicWriteKind } from "@/lib/auth/org-status";

/**
 * Company-lifecycle gate for PUBLIC write paths (D-17). Every unauthenticated / token / API-key
 * entry point that writes with the service role calls this before it writes — the database's
 * read-only policies and write-guard trigger only see client JWTs, so they cannot stop these.
 * Rule + rationale: lib/auth/org-status.ts → publicWriteAllowed.
 *
 * FAILS CLOSED: an org that cannot be read (error, missing) is treated as not accepting.
 */
export async function orgPublicWriteRefused(orgId: string | null | undefined, kind: PublicWriteKind): Promise<boolean> {
  if (kind === "consent") return false;
  if (!orgId) return true;
  const { data, error } = await createAdminClient()
    .from("organizations")
    .select("status")
    .eq("id", orgId)
    .maybeSingle();
  if (error || !data) {
    if (error) console.error("[org-lifecycle] status read failed — refusing the public write", error.message);
    return true;
  }
  return !publicWriteAllowed((data as { status: string | null }).status, kind);
}

/** Thrown by ingestion paths that have no "refused" return shape. Nothing has been written. */
export class OrgNotAcceptingError extends Error {
  constructor(readonly orgId: string) {
    super("organisation is not active — public write refused");
    this.name = "OrgNotAcceptingError";
  }
}

export async function assertOrgAcceptsPublicWrite(orgId: string, kind: PublicWriteKind = "operational"): Promise<void> {
  if (await orgPublicWriteRefused(orgId, kind)) throw new OrgNotAcceptingError(orgId);
}

/**
 * Portal WRITE gate: wraps the result of the single portal authority
 * (loadCustomerByPortalToken) and returns null — exactly like an invalid token — when the
 * company's status does not admit this kind of public write. Usage:
 *   const loaded = await gatePortalWrite(await loadCustomerByPortalToken(token), "operational");
 */
export async function gatePortalWrite<T extends { customer: { org_id: string } }>(
  loaded: T | null,
  kind: PublicWriteKind,
): Promise<T | null> {
  if (!loaded) return null;
  return (await orgPublicWriteRefused(loaded.customer.org_id, kind)) ? null : loaded;
}

/**
 * For the scheduled senders (D-17): the ids of every company that is NOT active / trial. A
 * suspended or cancelled company must not keep chasing its customers with automated reminders
 * (invoice chasers, quote follow-ups, review requests, service / warranty reminders, lead
 * follow-ups) or firing its automation schedules. THROWS on a read failure — a sender that
 * cannot tell which companies are held must send nothing this tick (the cron records the
 * failure and retries), never guess.
 */
export async function loadNonActiveOrgIds(): Promise<Set<string>> {
  const admin = createAdminClient();
  // COMPLETE read (F-1): paged on the primary key — a truncated list would let a held company through.
  const { data, error } = await fetchAllRows<{ id: string }>((from, to) =>
    admin
      .from("organizations")
      .select("id")
      .not("status", "in", "(active,trial)")
      .order("id", { ascending: true })
      .range(from, to),
  );
  if (error) throw new Error(`org-lifecycle: could not load non-active companies: ${(error as { message?: string }).message ?? String(error)}`);
  return new Set(((data ?? []) as Array<{ id: string }>).map((o) => o.id));
}

/**
 * Cached view of loadNonActiveOrgIds for the notification chokepoint (called on almost every user
 * action — it must not add a query each time). 60-second TTL per server instance. FAILS OPEN:
 * notifications are not a security boundary, so if the status read fails we deliver as before
 * rather than risk dropping a billing notice.
 */
let _heldCache: { at: number; ids: Set<string> } | null = null;
export async function nonActiveOrgIdsForNotifications(): Promise<Set<string>> {
  const now = Date.now();
  if (_heldCache && now - _heldCache.at < 60_000) return _heldCache.ids;
  try {
    _heldCache = { at: now, ids: await loadNonActiveOrgIds() };
    return _heldCache.ids;
  } catch (e) {
    console.error("[org-lifecycle] held-company lookup failed — notifications delivered unfiltered", e instanceof Error ? e.message : String(e));
    return new Set();
  }
}

/** Drop the cached list (tests; and callers that have just changed a company's status). */
export function clearNonActiveOrgCache(): void {
  _heldCache = null;
}
