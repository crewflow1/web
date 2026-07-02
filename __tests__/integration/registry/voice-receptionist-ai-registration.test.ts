import { expect, it } from "vitest";
import { describeIntegration, serviceClient } from "../_harness";
import {
  resolveAuthorityFromRegistry,
  type GrantReadClient,
} from "@/server/sdk/registry-parity";

/**
 * The AI Receptionist Programme — R1 (registry registration) real-Postgres proof.
 *
 * CEO Directive #018. The Receptionist (employee #26, Voice Receptionist AI) is the
 * first customer-facing AI employee and the reference implementation for every one
 * that follows. R1 registers it in the Capability Registry and NOTHING else — data
 * only, no behaviour. This suite proves that registration end-to-end against the LIVE
 * runtime resolver (the same code the SDK read path runs), not against the migration
 * text:
 *
 *   1. the identity row is seeded (support division, isolated memory);
 *   2. the runtime resolver serves it FROM the registry (a grant exists — it does not
 *      stand on the default-deny floor), and serves it LOCKED and approval-gated;
 *   3. the served token set is EXACTLY read + draft + memory — and carries NO send,
 *      commit, book or dispatch token, so the Tier-T3 safety contract ("captures and
 *      routes; never commits, quotes or books") is provable by ABSENCE.
 *
 * Runs only against a live DB (describeIntegration): skipped locally with no database,
 * FAILED loudly in CI if the database is missing.
 *
 * ai_employees / hq_capability_grants are service-role-only HQ internals not in the
 * generated Database types, so — like the sibling registry suites — the typed client is
 * cast to the minimal surface exercised here.
 */

const SLUG = "voice-receptionist-ai";
const DEPARTMENT = "support";

// The exact authority the deny-floor grant seeds, sorted (the validate trigger stores
// tokens sorted-distinct; we sort again so the assertion is order-independent).
const SAFE_TOKENS = [
  "draft",
  "memory",
  "read",
  "recall_memory",
  "submit_for_approval",
  "write_memory",
] as const;

// A representative set of BINDING / EXTERNAL acts the Receptionist must never hold: a
// spoken word to a caller is irreversible, so it may capture and route but never send,
// commit, book, dispatch or move money. None of these may appear in the served set.
const FORBIDDEN_TOKENS = [
  "send",
  "send_email",
  "dispatch",
  "commit",
  "book",
  "book_appointment",
  "place_order",
  "move_money",
] as const;

type QueryResult<T> = { data: T | null; error: { message: string } | null };
type Term<T> = PromiseLike<QueryResult<T>>;
type Filterable<T> = Term<T> & {
  eq(column: string, value: unknown): Filterable<T>;
  select(columns?: string): Filterable<T>;
  maybeSingle(): Term<T>;
};
type EmployeeRow = {
  slug: string;
  department: string;
  memory_scope: string;
  status: string;
  name: string;
};
type DbClient = {
  from(table: string): { select(columns: string): Filterable<EmployeeRow> };
};

const svc = (): DbClient => serviceClient() as unknown as DbClient;
const grantClient = (): GrantReadClient => serviceClient() as unknown as GrantReadClient;

describeIntegration("AI Receptionist · R1 registry registration (Directive #018)", () => {
  it("seeds the Voice Receptionist identity row (support division, isolated memory)", async () => {
    const res = await svc()
      .from("ai_employees")
      .select("slug, department, memory_scope, status, name")
      .eq("slug", SLUG)
      .maybeSingle();
    expect(res.error, res.error?.message).toBeNull();
    const emp = res.data;
    expect(emp, "the Receptionist identity row must be seeded").not.toBeNull();
    if (!emp) return;
    expect(emp.name).toBe("Voice Receptionist AI");
    expect(emp.department).toBe(DEPARTMENT);
    expect(emp.memory_scope).toBe("isolated");
  });

  it("the runtime resolver serves it FROM the registry — LOCKED and approval-gated", async () => {
    const authority = await resolveAuthorityFromRegistry(grantClient(), {
      slug: SLUG,
      department: DEPARTMENT,
    });
    // A grant exists, so the resolver composes from the registry — it is NOT stranded on
    // the default-deny floor (source "none").
    expect(authority.source).toBe("registry");
    // The deny-floor posture: execution locked, every act approval-gated, memory isolated.
    expect(authority.canExecute).toBe(false);
    expect(authority.requiresApproval).toBe(true);
    expect(authority.memoryScope).toBe("isolated");
  });

  it("grants EXACTLY the safe read+draft+memory set — no send, commit or book", async () => {
    const authority = await resolveAuthorityFromRegistry(grantClient(), {
      slug: SLUG,
      department: DEPARTMENT,
    });
    // Exact-set equality is the strong invariant: anything beyond the safe set — including
    // any binding token — would fail here by construction.
    expect([...authority.tokens].sort()).toEqual([...SAFE_TOKENS]);
    // And the T3 contract stated positively: no binding / external act is ever served.
    for (const forbidden of FORBIDDEN_TOKENS) {
      expect(authority.tokens, `must not hold the binding token "${forbidden}"`).not.toContain(
        forbidden,
      );
    }
  });
});
