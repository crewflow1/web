import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * External-worker sign-off — immutable, append-only evidence with provenance.
 *
 * A worker acknowledgement is a legal safety record: it must answer who, WHICH
 * ISSUED VERSION, when and from where, and once written it can never be edited
 * or deleted. These pin those invariants on the migration source (the real
 * trigger/RLS behaviour is proven against Postgres in the integration tier).
 */

const root = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const MIG = read("supabase/migrations/20261185000000_worker_signoff.sql");
const ACTION = read("app/worker-portal/[token]/actions.ts");

describe("append-only + immutable", () => {
  it("a no-update trigger blocks edits even for the service role", () => {
    expect(MIG).toMatch(/function public\.tg_worker_ack_no_update/);
    expect(MIG).toMatch(/worker acknowledgements are append-only and cannot be modified/);
    expect(MIG).toMatch(/before update on public\.worker_acknowledgements/);
  });

  it("there is NO update or delete RLS policy on the evidence table", () => {
    const ackPolicies = MIG.match(/policy \w+ on public\.worker_acknowledgements\s+for (\w+)/g) ?? [];
    // Only a SELECT policy exists — no insert/update/delete for authenticated.
    expect(ackPolicies.join(" ")).toMatch(/for select/);
    expect(ackPolicies.join(" ")).not.toMatch(/for update/);
    expect(ackPolicies.join(" ")).not.toMatch(/for delete/);
    expect(ackPolicies.join(" ")).not.toMatch(/for insert/);
  });

  it("evidence is written ONLY on the service-role path (no authenticated INSERT)", () => {
    // No `for insert` policy → an authenticated member cannot forge a worker
    // signature; the token-gated portal writes it on the admin client.
    expect(MIG).not.toMatch(/policy \w+ on public\.worker_acknowledgements\s+for insert/);
  });

  it("timestamps are pinned server-side in the trigger (no client backdating)", () => {
    const fn = MIG.slice(MIG.indexOf("function public.tg_worker_ack_validate"));
    expect(fn).toMatch(/new\.acknowledged_at := now\(\)/);
    expect(fn).toMatch(/new\.created_at := now\(\)/);
  });

  it("RLS is enabled on both new tables", () => {
    expect(MIG).toMatch(/alter table public\.worker_signoff_tokens enable row level security/);
    expect(MIG).toMatch(/alter table public\.worker_acknowledgements enable row level security/);
  });
});

describe("provenance is captured + version-anchored", () => {
  it("the evidence row carries name, statement, ip_hash, user_agent + version anchor", () => {
    expect(MIG).toMatch(/signed_name\s+text not null/);
    expect(MIG).toMatch(/statement\s+text not null/);
    expect(MIG).toMatch(/subject_version text not null/);
    expect(MIG).toMatch(/ip_hash\s+text/);
    expect(MIG).toMatch(/user_agent\s+text/);
  });

  it("the version anchor must match the subject's live issued reference", () => {
    const fn = MIG.slice(MIG.indexOf("function public.tg_worker_ack_validate"));
    expect(fn).toMatch(/if new\.subject_version is distinct from s_ref then/);
    expect(fn).toMatch(/version mismatch/);
  });

  it("only a LIVE/issued document is signable (draft/superseded refused)", () => {
    const fn = MIG.slice(MIG.indexOf("function public.tg_worker_ack_validate"));
    expect(fn).toMatch(/cannot acknowledge a % risk assessment/);
    expect(fn).toMatch(/cannot acknowledge a % toolbox talk/);
    expect(fn).toMatch(/cannot acknowledge a % permit/);
    expect(fn).toMatch(/cannot acknowledge a permit outside its validity window/);
  });

  it("one acknowledgement per token per issued version (idempotent re-sign)", () => {
    expect(MIG).toMatch(/constraint worker_ack_unique unique \(token_id, subject_type, subject_id, subject_version\)/);
    // The action treats the 23505 as idempotent success, not an error.
    expect(ACTION).toMatch(/code === "23505"/);
  });

  it("the ip_hash provenance uses the salted one-way hasher (never the raw IP)", () => {
    expect(ACTION).toMatch(/hashIp\(getIpFromHeaders\(h\)\)/);
    expect(ACTION).not.toMatch(/ip_hash: ip\b/);
  });
});

describe("signature image is org-first (no cross-tenant object)", () => {
  it("a DB CHECK forces the stored path under the row's own org", () => {
    expect(MIG).toMatch(/worker_ack_image_path_org_first check/);
    expect(MIG).toMatch(/split_part\(signature_image_path, '\/', 1\) = org_id::text/);
  });
  it("the action stores under the worker_signoff scope with a server-built key", () => {
    expect(ACTION).toMatch(/scope: "worker_signoff"/);
    expect(ACTION).toMatch(/storeSignatureImage\(/);
  });
});
