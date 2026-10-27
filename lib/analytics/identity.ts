import "server-only";
import { createHash } from "node:crypto";

/**
 * Analytics identity — de-identify the org before it becomes a PostHog person.
 *
 * The server sink keys each captured event by a `distinctId`. Using the raw
 * `org_id` (a live DB primary key) there makes the organisation's UUID the
 * canonical PostHog *person* id — directly re-identifiable and a conflation of
 * "organisation" with "person". This maps the org to a STABLE, one-way opaque
 * id instead: the same org always yields the same `org_<hash>` (so funnels and
 * retention still join per-org), but the value cannot be reversed to the UUID.
 *
 * A fixed domain-separation prefix is folded in so the digest is specific to
 * this use (not a bare SHA-256 of the UUID that could be matched against a
 * digest computed elsewhere). No secret is required — a 122-bit-random UUID is
 * already non-enumerable — so this stays deterministic across runtimes and
 * needs no shared key.
 */

const DOMAIN = "crewflow:analytics:org:v1:";

/**
 * Map an org id to a stable, non-reversible analytics distinct id
 * (`org_` + 32 hex chars). Returns the fixed non-identifying fallback for an
 * empty/blank input so a missing org can never mint an identity.
 */
export function hashOrgId(orgId: string | null | undefined): string {
  const raw = typeof orgId === "string" ? orgId.trim() : "";
  if (raw.length === 0) return "server";
  const digest = createHash("sha256").update(DOMAIN).update(raw).digest("hex");
  return `org_${digest.slice(0, 32)}`;
}
