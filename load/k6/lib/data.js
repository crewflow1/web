// load/k6/lib/data.js — the seeded dataset as the load generator sees it.
//
// The seeder (scripts/load/seed.mjs) derives every id as
//   uuid = md5('<tag>:<kind>:<orgIdx>:<n>')   (see ./ids.js)
// so the generator needs NO id dump: it loads a small manifest (one row per
// organisation with its row counts + tenant marker) and recomputes any id.
import crypto from "k6/crypto";
import { SharedArray } from "k6/data";
import { ACTIONS_PATH, MANIFEST_PATH } from "./config.js";
import { makeIds } from "./ids.js";

const manifestArr = new SharedArray("manifest", () => [JSON.parse(open(MANIFEST_PATH))]);
export const manifest = manifestArr[0];
export const TAG = manifest.tag;
export const orgs = manifest.orgs;

const actionsArr = new SharedArray("actions", () => {
  try {
    return [JSON.parse(open(ACTIONS_PATH))];
  } catch (e) {
    return [{ buildId: null, actions: {} }];
  }
});
export const actionMap = actionsArr[0];

// The id / email scheme is shared with the seeder (./ids.js, parity-tested).
const ids = makeIds(TAG, (s) => crypto.md5(s, "hex"));
export const ltId = ids.ltId;
export const userId = ids.userId;
export const emailOf = ids.emailOf;
export const hqEmail = ids.hqEmail;

// ── per-persona user pools (prefix sums → O(log n) lookup, no giant arrays) ──
function prefix(field) {
  const out = new Array(orgs.length + 1);
  out[0] = 0;
  for (let i = 0; i < orgs.length; i++) out[i + 1] = out[i] + orgs[i][field];
  return out;
}
const staffPrefix = prefix("staff");
const adminPrefix = prefix("admins");

function locate(pfx, ordinal) {
  const total = pfx[pfx.length - 1];
  const k = ordinal % total;
  let lo = 0;
  let hi = orgs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (pfx[mid + 1] > k) hi = mid;
    else lo = mid + 1;
  }
  return { org: orgs[lo], n: k - pfx[lo] + 1 };
}

export const POOL = {
  owner: orgs.length,
  office: adminPrefix[orgs.length],
  staff: staffPrefix[orgs.length],
  hq: manifest.hq,
  public: Infinity,
};

/** Resolve a persona ordinal to its one seeded identity. */
export function identityFor(persona, ordinal) {
  if (persona === "owner") {
    const org = orgs[ordinal % orgs.length];
    return { org, role: "owner", n: 1, email: emailOf(org.idx, "owner", 1), userId: userId(org.idx, "owner", 1) };
  }
  if (persona === "office") {
    const { org, n } = locate(adminPrefix, ordinal);
    return { org, role: "admin", n, email: emailOf(org.idx, "admin", n), userId: userId(org.idx, "admin", n) };
  }
  if (persona === "staff") {
    const { org, n } = locate(staffPrefix, ordinal);
    return { org, role: "staff", n, email: emailOf(org.idx, "staff", n), userId: userId(org.idx, "staff", n) };
  }
  if (persona === "hq") {
    const n = (ordinal % manifest.hq) + 1;
    return { org: null, role: "hq", n, email: hqEmail(n), userId: userId(0, "hq", n) };
  }
  return { org: orgs[ordinal % orgs.length], role: "public", n: ordinal };
}

/** A different tenant — the target of the cross-tenant canary probes. */
export function foreignOrg(org) {
  if (orgs.length < 2) return null;
  return orgs[org.idx % orgs.length]; // idx is 1-based → the "next" org, wrapping
}
