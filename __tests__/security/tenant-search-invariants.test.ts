import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  SOURCE_MAPPERS,
  FORBIDDEN_COLUMN_PATTERNS,
  validateAllMappers,
} from "@/lib/search/semantic/mappers";

/**
 * Tenant Semantic Search — security invariants, derived from source.
 *
 * These assert the NON-NEGOTIABLE posture at the file level, so a later edit that
 * weakens the boundary trips here rather than in production:
 *   - the corpus table is RLS zero-policy (service-role only);
 *   - the queue primitives are service-role only (never authenticated/anon);
 *   - the retrieval RPC enforces tenant + staff + visibility IN-BODY, is pinned
 *     security-definer + search_path='', is granted ONLY to authenticated (anon
 *     revoked), and NEVER projects the embedding column;
 *   - the mappers never embed a money/secret column.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

const DOCS_MIG = read("supabase/migrations/20261280000000_tenant_search_documents.sql");
const QUEUE_MIG = read("supabase/migrations/20261281000000_tenant_search_queue.sql");
const RETR_MIG = read("supabase/migrations/20261282000000_tenant_search_retrieval.sql");
const ROUTE = read("app/api/search/route.ts");

describe("corpus table is RLS zero-policy (service-role only)", () => {
  it("enables RLS on tenant_search_documents", () => {
    expect(DOCS_MIG).toMatch(/alter table public\.tenant_search_documents enable row level security/);
  });
  it("defines NO policy on tenant_search_documents (zero-policy)", () => {
    expect(DOCS_MIG).not.toMatch(/create policy[^;]*on public\.tenant_search_documents/i);
    expect(QUEUE_MIG).not.toMatch(/create policy[^;]*on public\.tenant_search_documents/i);
    expect(RETR_MIG).not.toMatch(/create policy[^;]*on public\.tenant_search_documents/i);
  });
});

describe("queue primitives are service-role only", () => {
  it("every queue function revokes from public/anon/authenticated and grants only service_role", () => {
    // No queue function is ever granted to authenticated.
    expect(QUEUE_MIG).not.toMatch(/grant execute on function[\s\S]*?to authenticated/i);
    // Each function grant targets service_role (match the full statement so a
    // comment mentioning "service_role" is not counted).
    const grants = QUEUE_MIG.match(/grant execute on function/gi) ?? [];
    const serviceGrants = QUEUE_MIG.match(/grant execute on function[\s\S]*?to service_role/gi) ?? [];
    expect(grants.length).toBeGreaterThanOrEqual(6);
    expect(serviceGrants.length).toBe(grants.length);
    // Each has a matching revoke from the JWT roles.
    const revokes = QUEUE_MIG.match(/revoke all on function[\s\S]*?from public, anon, authenticated/gi) ?? [];
    expect(revokes.length).toBe(grants.length);
  });
});

describe("retrieval RPC enforces the boundary in-body", () => {
  it("is security definer with a pinned empty search_path", () => {
    expect(RETR_MIG).toMatch(/security definer/);
    expect(RETR_MIG).toMatch(/set search_path = ''/);
  });

  it("gates on current_org_ids() membership and FAILS CLOSED", () => {
    expect(RETR_MIG).toMatch(/current_org_ids\(\)/);
    expect(RETR_MIG).toMatch(/p_org_id = any \(select public\.current_org_ids\(\)\)/);
    // A non-member returns '[]' before any candidate is considered.
    expect(RETR_MIG).toMatch(/if not coalesce\(v_is_member, false\) then\s*return '\[\]'::jsonb/);
  });

  it("enforces the staff assignment + visibility allowlist (positive, fail-closed)", () => {
    expect(RETR_MIG).toMatch(/my_assigned_job_ids\(\)/);
    expect(RETR_MIG).toMatch(/is_org_admin\(p_org_id\)/);
    // The staff visibility allowlist is POSITIVE — anything else is denied.
    const allowlistHits = RETR_MIG.match(/visibility in \('member', 'staff'\)/g) ?? [];
    // Present in BOTH the semantic and lexical candidate channels.
    expect(allowlistHits.length).toBeGreaterThanOrEqual(2);
  });

  it("applies the SAME permission predicate to both candidate channels", () => {
    const jobGate = RETR_MIG.match(/d\.job_id in \(select public\.my_assigned_job_ids\(\)\)/g) ?? [];
    expect(jobGate.length).toBeGreaterThanOrEqual(2);
  });

  it("is granted to authenticated but revoked from public/anon", () => {
    expect(RETR_MIG).toMatch(/revoke all on function public\.tenant_search_semantic[\s\S]*?from public, anon, authenticated/i);
    expect(RETR_MIG).toMatch(/grant execute on function public\.tenant_search_semantic[\s\S]*?to authenticated/i);
  });

  it("NEVER projects the embedding column in its returned jsonb", () => {
    // The only references to the embedding column are the <=> distance operator
    // and the version/dimension filter — never a jsonb key named 'embedding'.
    expect(RETR_MIG).not.toMatch(/'embedding'\s*,/);
    expect(RETR_MIG).not.toMatch(/'embedding',\s*(d\.)?embedding/);
  });
});

describe("mappers never embed money/secrets", () => {
  it("validateAllMappers passes", () => {
    expect(() => validateAllMappers()).not.toThrow();
  });
  it("no mapper allowlist column matches a forbidden pattern", () => {
    for (const m of SOURCE_MAPPERS) {
      for (const col of m.allowedColumns) {
        for (const pat of FORBIDDEN_COLUMN_PATTERNS) {
          expect(pat.test(col), `${m.sourceTable}.${col} vs ${pat}`).toBe(false);
        }
      }
    }
  });
  it("customers are management-only (staff can never reach them semantically)", () => {
    const customers = SOURCE_MAPPERS.find((m) => m.sourceTable === "customers");
    expect(customers?.managementOnly).toBe(true);
    expect(customers?.visibility).toBe("management");
  });
});

describe("the route's semantic channel is dark-safe and additive", () => {
  it("gates the semantic channel on isEmbeddingConfigured()", () => {
    expect(ROUTE).toMatch(/isEmbeddingConfigured\(\)/);
  });
  it("embeds the query through the governed door, billed to the tenant org", () => {
    expect(ROUTE).toMatch(/governedEmbed\(/);
    expect(ROUTE).toMatch(/feature: "memory\.embedding_query"/);
    expect(ROUTE).toMatch(/orgId,/);
  });
  it("wraps the semantic channel so any failure degrades to keyword (try/catch returning [])", () => {
    expect(ROUTE).toMatch(/async function semanticHits/);
    expect(ROUTE).toMatch(/catch\s*\{\s*return \[\];\s*\}/);
  });
});
