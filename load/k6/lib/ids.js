// load/k6/lib/ids.js — the deterministic id / identity scheme, shared with the seeder.
//
// PURE (the md5 implementation is injected): k6 passes k6/crypto's md5, the
// unit tests pass Node's, and __tests__/load/ids-parity.test.ts proves the
// result is byte-identical to scripts/load/_ids.mjs (seed.mjs) and to the SQL
// seeder's `md5('<key>')::uuid`. That parity is what lets the load generator
// recompute any seeded id without an id dump.
//
//   uuid  = md5('<tag>:<kind>:<orgIdx>:<n>') formatted 8-4-4-4-12
//   email = lt-<tag>-o<orgIdx>-<role><n>@loadtest.crewflow.invalid   (RFC 2606: undeliverable)
//   HQ    = lt-<tag>-hq<n>@loadtest.crewflow.invalid

export const SYNTHETIC_EMAIL_DOMAIN = "loadtest.crewflow.invalid";

export function uuidFromHex(h) {
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/** @param tag dataset tag  @param md5hex (string) => 32-char lowercase hex */
export function makeIds(tag, md5hex) {
  const ltId = (kind, orgIdx, n) => uuidFromHex(md5hex(`${tag}:${kind}:${orgIdx}:${n}`));
  return {
    ltId,
    userId: (orgIdx, role, n) => ltId("user", orgIdx, `${role}:${n}`),
    emailOf: (orgIdx, role, n) => `lt-${tag}-o${orgIdx}-${role}${n}@${SYNTHETIC_EMAIL_DOMAIN}`,
    hqEmail: (n) => `lt-${tag}-hq${n}@${SYNTHETIC_EMAIL_DOMAIN}`,
  };
}

/** Every identity the harness signs in as must be synthetic. */
export function isSyntheticEmail(email) {
  return /^lt-[a-z0-9]{2,12}-[a-z0-9-]+@loadtest\.crewflow\.invalid$/.test(String(email || ""));
}
