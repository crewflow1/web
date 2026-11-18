/**
 * Deterministic primitives shared by the seeder and its tests. PURE — importing
 * this module never touches a database (seed.mjs runs on import; this does not).
 * Mirrored by load/k6/lib/ids.js (k6) and by scripts/load/sql/seed.sql
 * (`md5(key)::uuid`); __tests__/load/ids-parity.test.ts holds all three equal.
 */
import { createHash } from "node:crypto";

export const md5hex = (s) => createHash("md5").update(s).digest("hex");

/** uuid = md5(key) formatted 8-4-4-4-12 (Postgres `md5(key)::uuid` renders identically). */
export const ltId = (key) => {
  const h = md5hex(key);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};

/** Deterministic "random" in [0,1): first 28 bits of md5(key). SQL: pg_temp.lt_r(). */
export const ltR = (key) => parseInt(md5hex(key).slice(0, 7), 16) / 0x10000000;
