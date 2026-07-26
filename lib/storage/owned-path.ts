/**
 * Evidence/attachment storage keys are ALWAYS org-first: `${orgId}/...` (built server-side
 * from ctx.org.id at upload). Before minting a service-role signed URL for a row, the signer
 * MUST confirm the stored path actually lives under that row's own org — otherwise a poisoned
 * `storage_path` (an org-A row pointing at an org-B object) would yield a cross-tenant download
 * URL. This mirrors the DB trigger tg_assert_storage_path_org (migration 20261031) and is the
 * app-layer half of that defence-in-depth (it also covers any row written before the trigger).
 *
 * Pure + exported so the invariant is unit-tested directly.
 */
export function storagePathBelongsToOrg(
  storagePath: string | null | undefined,
  orgId: string | null | undefined,
): boolean {
  if (typeof storagePath !== "string" || typeof orgId !== "string" || orgId.length === 0) return false;
  // Reject traversal-shaped keys defensively: a leading '/', any '..' segment, or a backslash
  // could, on a normalizing backend, resolve outside the org prefix even though segment[0]
  // still equals org_id. Not exploitable on S3-exact-key storage today, but cheap to forbid.
  if (storagePath.startsWith("/") || storagePath.includes("..") || storagePath.includes("\\")) return false;
  return storagePath.split("/")[0] === orgId;
}
