import { get as getOffline } from "./offline-store";

/**
 * Byte source for the blueprint viewer (Programme E). Online-first with an
 * offline fallback: the render surface calls this instead of a bare fetch. With
 * nothing cached and preferOffline falsy (the default), it is byte-identical to
 * today's `fetch(src, {credentials:"same-origin"}) → arrayBuffer()`, so the
 * online path is unchanged. When the same-origin serve-route fetch genuinely
 * fails (offline / 5xx) and an authorized copy for THIS user+org+version is
 * cached, it returns those bytes instead. The hardened pdf.js config downstream
 * is untouched — only where `buf` comes from changes.
 */

export type ByteSource = "online" | "offline";
export type LoadedBytes = { bytes: ArrayBuffer; source: ByteSource };

/** Pure decision helper (unit-testable): given signals, which source wins. */
export function decideByteSource(opts: { preferOffline: boolean; fetchOk: boolean; cacheHit: boolean }): ByteSource | "error" {
  if (opts.preferOffline && opts.cacheHit) return "offline";
  if (opts.fetchOk) return "online";
  if (opts.cacheHit) return "offline";
  return "error";
}

export async function loadBlueprintBytes(opts: {
  jobId: string;
  versionId: string;
  identity?: { userId: string; orgId: string } | null; // required to read the offline cache
  preferOffline?: boolean;
  signal?: AbortSignal;
}): Promise<LoadedBytes> {
  const src = `/jobs/${opts.jobId}/blueprints/f/${opts.versionId}`;
  const id = opts.identity ?? null;

  const readCache = async (): Promise<ArrayBuffer | null> => {
    if (!id) return null;
    const rec = await getOffline(id.userId, id.orgId, opts.versionId); // verifies partition + integrity
    return rec ? rec.blob.arrayBuffer() : null;
  };

  // Deliberately offline (navigator.onLine === false + a copy exists): skip the doomed fetch.
  if (opts.preferOffline) {
    const cached = await readCache();
    if (cached) return { bytes: cached, source: "offline" };
    // preferOffline but nothing cached → still try the network (onLine can lie).
  }

  try {
    const res = await fetch(src, { credentials: "same-origin", signal: opts.signal });
    if (!res.ok) throw new Error(`fetch ${res.status}`);
    return { bytes: await res.arrayBuffer(), source: "online" };
  } catch (err) {
    if ((err as { name?: string })?.name === "AbortError") throw err; // our own cancellation
    const cached = await readCache();
    if (cached) return { bytes: cached, source: "offline" };
    throw err; // nothing cached → the surface's existing error state
  }
}
