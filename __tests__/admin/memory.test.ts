import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  canEmployeeAccess,
  extractKeywords,
  normalizeTags,
  aggregateMemoryFacets,
  confidenceNote,
  DEPARTMENTS,
} from "@/lib/memory/model";

/**
 * Shared Memory Engine — authorization-boundary + pure-logic contract
 * tests (CEO Directive 002, Phase 2).
 *
 * The directive requires proof that:
 *   1. Unauthenticated users are blocked.
 *   2. Normal (non-allowlisted) customer users are blocked.
 *   3. HQ / super-admin users are allowed AND every write is audited.
 *   4. The permission model + indexing helpers behave to spec.
 *
 * The four mutating server actions (createMemoryAction,
 * updateMemoryAction, togglePinAction, setStatusAction) are the only
 * state-changing entry points — the boundary is proven there: a blocked
 * caller must redirect and perform ZERO writes; an allowed caller must
 * persist the row, snapshot a version, emit a memory event, AND record
 * an admin_activity_log entry.
 *
 * READ-FIRST invariant: there is no action an AI employee can call — the
 * AI surface (getEmployeeMemoryFeed) is read-only and not exercised by a
 * mutating action, so there is nothing here for an AI to write through.
 *
 * Supabase admin is mocked (queue-based chainable stub). redirect is
 * stubbed to throw so we can assert the bounce path — mirroring Next.js,
 * where redirect() halts the action.
 */

// ---------- Supabase admin mock --------------------------------------

type QueueEntry = { data: unknown; error: unknown };

function makeMockSupabase() {
  const insertQ: QueueEntry[] = [];
  const updateQ: QueueEntry[] = [];
  const maybeSingleQ: QueueEntry[] = [];
  const inserts: Array<{ table: string; payload: unknown }> = [];
  const updates: Array<{
    table: string;
    payload: unknown;
    where: Record<string, unknown>;
  }> = [];
  const deletes: Array<{ table: string; where: Record<string, unknown> }> = [];

  // Read-builder methods the service chains; all simply return the chain.
  const passthrough = new Set([
    "select",
    "eq",
    "neq",
    "in",
    "is",
    "not",
    "or",
    "contains",
    "textSearch",
    "gte",
    "lte",
    "lt",
    "order",
    "range",
    "limit",
    "match",
  ]);

  function thenable(settled: QueueEntry): Record<string, unknown> {
    const inner: Record<string, unknown> = {};
    Object.defineProperty(inner, "then", {
      value: (resolve: (v: QueueEntry) => unknown) => resolve(settled),
    });
    return inner;
  }

  function makeChain(table: string): Record<string, unknown> {
    const chain: Record<string, unknown> = {};
    const whereClause: Record<string, unknown> = {};
    for (const m of passthrough) {
      if (m === "eq") {
        chain[m] = (col: string, val: unknown) => {
          whereClause[col] = val;
          return chain;
        };
      } else {
        chain[m] = () => chain;
      }
    }
    // A select(...).eq(...).maybeSingle() read pulls from the maybeSingle
    // queue (used by getMemoryRecord).
    chain.maybeSingle = async () =>
      maybeSingleQ.shift() ?? { data: null, error: null };

    // insert(...) records the write and returns a thenable that also
    // supports .select(...).single()/.maybeSingle() — createMemory does
    // `.insert(payload).select("id").maybeSingle()`.
    chain.insert = (payload: unknown) => {
      inserts.push({ table, payload });
      const settled = insertQ.shift() ?? { data: null, error: null };
      const ic: Record<string, unknown> = {
        select: () => ic,
        single: async () => settled,
        maybeSingle: async () => settled,
      };
      Object.defineProperty(ic, "then", {
        value: (resolve: (v: QueueEntry) => unknown) => resolve(settled),
      });
      return ic;
    };

    // update(payload).eq(col, val) records the mutation + where clause.
    chain.update = (payload: unknown) => ({
      eq: (col: string, val: unknown) => {
        updates.push({ table, payload, where: { [col]: val } });
        return thenable(updateQ.shift() ?? { data: null, error: null });
      },
    });

    // delete().eq(col, val) — replaceChildRows clears child rows wholesale.
    chain.delete = () => ({
      eq: (col: string, val: unknown) => {
        deletes.push({ table, where: { [col]: val } });
        return thenable({ data: null, error: null });
      },
    });

    return chain;
  }

  return {
    client: { from: (table: string) => makeChain(table) },
    inserts,
    updates,
    deletes,
    enqueueMaybeSingle: (e: QueueEntry) => maybeSingleQ.push(e),
    enqueueInsert: (e: QueueEntry) => insertQ.push(e),
    enqueueUpdate: (e: QueueEntry) => updateQ.push(e),
  };
}

const mockAdmin = makeMockSupabase();

// ---------- Module mocks ---------------------------------------------

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => mockAdmin.client,
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

const redirectMock = vi.fn((path: string) => {
  // Mirror Next.js's real redirect by throwing — actions stop executing.
  throw new Error(`REDIRECT:${path}`);
});
vi.mock("next/navigation", () => ({
  redirect: redirectMock,
}));

const requireUserMock = vi.fn();
vi.mock("@/server/auth/session", () => ({
  requireUser: requireUserMock,
}));

const isSuperAdminEmailMock = vi.fn();
vi.mock("@/server/auth/superadmin", () => ({
  isSuperAdminEmail: isSuperAdminEmailMock,
}));

// Late import so all module-level mocks are applied first.
async function loadActions() {
  return await import("@/app/admin/memory/actions");
}

function makeFormData(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

const MEM_ID = "00000000-0000-0000-0000-0000000000a1";

function validCreateForm(): FormData {
  return makeFormData({
    title: "Q3 pricing decision",
    summary: "We are raising prices 12% on the Pro tier.",
    body: "Full rationale, modelling, and rollout plan for the change.",
    memory_type: "company",
    department: DEPARTMENTS[0],
    importance: "high",
    visibility: "public_hq",
    source: "manual",
    status: "active",
    confidence: "85",
    tags: "pricing, q3-launch",
  });
}

function validUpdateForm(): FormData {
  const fd = validCreateForm();
  fd.set("id", MEM_ID);
  fd.set("title", "Q3 pricing decision (revised)");
  return fd;
}

function validPinForm(next: "true" | "false" = "true"): FormData {
  return makeFormData({ id: MEM_ID, next });
}

function validStatusForm(status = "archived"): FormData {
  return makeFormData({ id: MEM_ID, status });
}

/** A minimal "current" row for the load-then-update / load-then-status paths. */
function currentRow(over: Record<string, unknown> = {}) {
  return {
    data: {
      id: MEM_ID,
      version: 1,
      status: "active",
      title: "Q3 pricing decision",
      ...over,
    },
    error: null,
  };
}

beforeEach(() => {
  mockAdmin.inserts.length = 0;
  mockAdmin.updates.length = 0;
  mockAdmin.deletes.length = 0;
  redirectMock.mockClear();
  requireUserMock.mockReset();
  isSuperAdminEmailMock.mockReset();
});

// ---------- 1. Unauthenticated --------------------------------------

describe("authorization — unauthenticated callers are blocked", () => {
  beforeEach(() => {
    // The real requireUser() redirects to /login when there's no session,
    // which throws and halts the action before any write.
    requireUserMock.mockImplementation(() => {
      throw new Error("REDIRECT:/login");
    });
    isSuperAdminEmailMock.mockReturnValue(false);
  });

  it("createMemoryAction bounces to /login without writing", async () => {
    const { createMemoryAction } = await loadActions();
    await expect(createMemoryAction(validCreateForm())).rejects.toThrow(
      /REDIRECT:\/login/,
    );
    expect(mockAdmin.inserts).toHaveLength(0);
    expect(mockAdmin.updates).toHaveLength(0);
  });

  it("updateMemoryAction bounces to /login without writing", async () => {
    const { updateMemoryAction } = await loadActions();
    await expect(updateMemoryAction(validUpdateForm())).rejects.toThrow(
      /REDIRECT:\/login/,
    );
    expect(mockAdmin.inserts).toHaveLength(0);
    expect(mockAdmin.updates).toHaveLength(0);
  });

  it("togglePinAction bounces to /login without writing", async () => {
    const { togglePinAction } = await loadActions();
    await expect(togglePinAction(validPinForm())).rejects.toThrow(
      /REDIRECT:\/login/,
    );
    expect(mockAdmin.updates).toHaveLength(0);
    expect(mockAdmin.inserts).toHaveLength(0);
  });

  it("setStatusAction bounces to /login without writing", async () => {
    const { setStatusAction } = await loadActions();
    await expect(setStatusAction(validStatusForm())).rejects.toThrow(
      /REDIRECT:\/login/,
    );
    expect(mockAdmin.updates).toHaveLength(0);
    expect(mockAdmin.inserts).toHaveLength(0);
  });
});

// ---------- 2. Normal customer (authenticated, not allowlisted) ------

describe("authorization — non-allowlisted customer users are blocked", () => {
  beforeEach(() => {
    requireUserMock.mockResolvedValue({
      id: "cust-1",
      email: "owner@some-tenant.test",
    });
    isSuperAdminEmailMock.mockReturnValue(false);
  });

  it("createMemoryAction redirects to /dashboard without writing", async () => {
    const { createMemoryAction } = await loadActions();
    await expect(createMemoryAction(validCreateForm())).rejects.toThrow(
      /REDIRECT:\/dashboard/,
    );
    expect(isSuperAdminEmailMock).toHaveBeenCalledWith("owner@some-tenant.test");
    expect(mockAdmin.inserts).toHaveLength(0);
    expect(mockAdmin.updates).toHaveLength(0);
  });

  it("updateMemoryAction redirects to /dashboard without writing", async () => {
    const { updateMemoryAction } = await loadActions();
    await expect(updateMemoryAction(validUpdateForm())).rejects.toThrow(
      /REDIRECT:\/dashboard/,
    );
    expect(mockAdmin.inserts).toHaveLength(0);
    expect(mockAdmin.updates).toHaveLength(0);
  });

  it("togglePinAction redirects to /dashboard without writing", async () => {
    const { togglePinAction } = await loadActions();
    await expect(togglePinAction(validPinForm())).rejects.toThrow(
      /REDIRECT:\/dashboard/,
    );
    expect(mockAdmin.updates).toHaveLength(0);
    expect(mockAdmin.inserts).toHaveLength(0);
  });

  it("setStatusAction redirects to /dashboard without writing", async () => {
    const { setStatusAction } = await loadActions();
    await expect(setStatusAction(validStatusForm())).rejects.toThrow(
      /REDIRECT:\/dashboard/,
    );
    expect(mockAdmin.updates).toHaveLength(0);
    expect(mockAdmin.inserts).toHaveLength(0);
  });
});

// ---------- 3. HQ super-admin (allowed) ------------------------------

describe("authorization — HQ super-admin is allowed and audited", () => {
  beforeEach(() => {
    requireUserMock.mockResolvedValue({
      id: "admin-1",
      email: "ceo@crewflow.uk",
    });
    isSuperAdminEmailMock.mockReturnValue(true);
  });

  it("createMemoryAction inserts the record, snapshots v1, events, and audits", async () => {
    // hq_memories insert resolves with the new id (consumed by .maybeSingle()).
    mockAdmin.enqueueInsert({ data: { id: "newmem1" }, error: null });

    const { createMemoryAction } = await loadActions();
    await expect(createMemoryAction(validCreateForm())).rejects.toThrow(
      /REDIRECT:\/admin\/memory\/newmem1\?saved=created/,
    );

    // The single source of truth — hq_memories row.
    const memInsert = mockAdmin.inserts.find((i) => i.table === "hq_memories");
    expect(memInsert).toBeTruthy();
    const mp = memInsert?.payload as Record<string, unknown>;
    expect(mp.title).toBe("Q3 pricing decision");
    expect(mp.memory_type).toBe("company");
    expect(mp.visibility).toBe("public_hq");
    expect(mp.importance).toBe("high");
    expect(mp.status).toBe("active");
    expect(mp.source).toBe("manual");
    expect(mp.department).toBe(DEPARTMENTS[0]);
    expect(mp.confidence).toBe(85);
    expect(mp.version).toBe(1);
    expect(mp.pinned).toBe(false);
    expect(mp.tags).toEqual(["pricing", "q3-launch"]);
    expect(mp.created_by_id).toBe("admin-1");
    expect(mp.created_by_email).toBe("ceo@crewflow.uk");
    // keywords are derived on write (indexing helper) — not empty.
    expect(Array.isArray(mp.keywords)).toBe(true);
    expect((mp.keywords as string[]).length).toBeGreaterThan(0);

    // v1 version snapshot.
    const verInsert = mockAdmin.inserts.find(
      (i) => i.table === "hq_memory_versions",
    );
    expect(verInsert).toBeTruthy();
    expect((verInsert?.payload as { version: number }).version).toBe(1);

    // 'created' event on the memory's own timeline.
    const evInsert = mockAdmin.inserts.find(
      (i) => i.table === "hq_memory_events",
    );
    expect((evInsert?.payload as { event_type: string }).event_type).toBe(
      "created",
    );

    // HQ audit row.
    const audit = mockAdmin.inserts.find(
      (i) => i.table === "admin_activity_log",
    );
    expect(audit).toBeTruthy();
    const ap = audit?.payload as Record<string, unknown>;
    expect(ap.action).toBe("hq_memory.created");
    expect(ap.actor_email).toBe("ceo@crewflow.uk");
    expect(ap.target_table).toBe("hq_memories");
    expect(ap.target_id).toBe("newmem1");
  });

  it("updateMemoryAction bumps the version, snapshots, events, and audits", async () => {
    // getMemoryRecord(id) returns the current (v1) row.
    mockAdmin.enqueueMaybeSingle(currentRow());

    const { updateMemoryAction } = await loadActions();
    await expect(updateMemoryAction(validUpdateForm())).rejects.toThrow(
      new RegExp(`REDIRECT:/admin/memory/${MEM_ID}\\?saved=updated`),
    );

    // hq_memories updated in place, version -> 2, scoped by id.
    const memUpdate = mockAdmin.updates.find((u) => u.table === "hq_memories");
    expect(memUpdate).toBeTruthy();
    const up = memUpdate?.payload as Record<string, unknown>;
    expect(up.title).toBe("Q3 pricing decision (revised)");
    expect(up.version).toBe(2);
    expect(memUpdate?.where).toEqual({ id: MEM_ID });

    // v2 snapshot written.
    const verInsert = mockAdmin.inserts.find(
      (i) => i.table === "hq_memory_versions",
    );
    expect((verInsert?.payload as { version: number }).version).toBe(2);

    // 'updated' event.
    const evInsert = mockAdmin.inserts.find(
      (i) => i.table === "hq_memory_events",
    );
    expect((evInsert?.payload as { event_type: string }).event_type).toBe(
      "updated",
    );

    const audit = mockAdmin.inserts.find(
      (i) => i.table === "admin_activity_log",
    );
    expect((audit?.payload as { action: string }).action).toBe(
      "hq_memory.updated",
    );
  });

  it("togglePinAction pins the memory, events, and audits", async () => {
    const { togglePinAction } = await loadActions();
    await expect(togglePinAction(validPinForm("true"))).rejects.toThrow(
      new RegExp(`REDIRECT:/admin/memory/${MEM_ID}\\?saved=pinned`),
    );

    const memUpdate = mockAdmin.updates.find((u) => u.table === "hq_memories");
    expect((memUpdate?.payload as { pinned: boolean }).pinned).toBe(true);
    expect(memUpdate?.where).toEqual({ id: MEM_ID });

    const evInsert = mockAdmin.inserts.find(
      (i) => i.table === "hq_memory_events",
    );
    expect((evInsert?.payload as { event_type: string }).event_type).toBe(
      "pinned",
    );

    const audit = mockAdmin.inserts.find(
      (i) => i.table === "admin_activity_log",
    );
    expect((audit?.payload as { action: string }).action).toBe(
      "hq_memory.pinned",
    );
  });

  it("togglePinAction unpins (next=false) and audits hq_memory.unpinned", async () => {
    const { togglePinAction } = await loadActions();
    await expect(togglePinAction(validPinForm("false"))).rejects.toThrow(
      new RegExp(`REDIRECT:/admin/memory/${MEM_ID}\\?saved=unpinned`),
    );
    const memUpdate = mockAdmin.updates.find((u) => u.table === "hq_memories");
    expect((memUpdate?.payload as { pinned: boolean }).pinned).toBe(false);
    const audit = mockAdmin.inserts.find(
      (i) => i.table === "admin_activity_log",
    );
    expect((audit?.payload as { action: string }).action).toBe(
      "hq_memory.unpinned",
    );
  });

  it("setStatusAction changes status, events from->to, and audits", async () => {
    // getMemoryRecord(id) returns the current (active) row.
    mockAdmin.enqueueMaybeSingle(currentRow());

    const { setStatusAction } = await loadActions();
    await expect(setStatusAction(validStatusForm("archived"))).rejects.toThrow(
      new RegExp(`REDIRECT:/admin/memory/${MEM_ID}\\?saved=status`),
    );

    const memUpdate = mockAdmin.updates.find((u) => u.table === "hq_memories");
    expect((memUpdate?.payload as { status: string }).status).toBe("archived");

    const evInsert = mockAdmin.inserts.find(
      (i) => i.table === "hq_memory_events",
    );
    const ep = evInsert?.payload as {
      event_type: string;
      detail: { from: string; to: string };
    };
    expect(ep.event_type).toBe("status_changed");
    expect(ep.detail).toEqual({ from: "active", to: "archived" });

    const audit = mockAdmin.inserts.find(
      (i) => i.table === "admin_activity_log",
    );
    const ap = audit?.payload as { action: string; metadata: { status: string } };
    expect(ap.action).toBe("hq_memory.status_changed");
    expect(ap.metadata.status).toBe("archived");
  });

  it("rejects an empty title before any write (create)", async () => {
    const { createMemoryAction } = await loadActions();
    const fd = validCreateForm();
    fd.set("title", ""); // violates min(1)
    await expect(createMemoryAction(fd)).rejects.toThrow(
      /REDIRECT:\/admin\/memory\/new\?error=/,
    );
    expect(mockAdmin.inserts).toHaveLength(0);
    expect(mockAdmin.updates).toHaveLength(0);
  });

  it("rejects an invalid status enum before any write", async () => {
    const { setStatusAction } = await loadActions();
    const fd = validStatusForm("h4x0r"); // not a real status
    await expect(setStatusAction(fd)).rejects.toThrow(
      /REDIRECT:\/admin\/memory\?error=/,
    );
    expect(mockAdmin.updates).toHaveLength(0);
    expect(mockAdmin.inserts).toHaveLength(0);
  });

  it("rejects a non-UUID memory id before any write (update)", async () => {
    const { updateMemoryAction } = await loadActions();
    const fd = validUpdateForm();
    fd.set("id", "not-a-uuid");
    await expect(updateMemoryAction(fd)).rejects.toThrow(
      /REDIRECT:\/admin\/memory\?error=/,
    );
    expect(mockAdmin.inserts).toHaveLength(0);
    expect(mockAdmin.updates).toHaveLength(0);
  });
});

// ---------- 4. Pure model logic --------------------------------------

describe("model — canEmployeeAccess enforces permission-aware reads", () => {
  const emp = { id: "e-1", department: "engineering" };
  const noGrants: ReadonlyArray<{
    grantee_type: "department" | "employee";
    grantee_value: string;
  }> = [];

  it("public_hq is readable by everyone", () => {
    expect(
      canEmployeeAccess({ visibility: "public_hq", department: null }, emp, noGrants),
    ).toBe(true);
  });

  it("system is never surfaced to an AI employee — even with a grant", () => {
    expect(
      canEmployeeAccess({ visibility: "system", department: null }, emp, [
        { grantee_type: "employee", grantee_value: "e-1" },
      ]),
    ).toBe(false);
  });

  it("department visibility matches on department or an explicit grant", () => {
    expect(
      canEmployeeAccess(
        { visibility: "department", department: "engineering" },
        emp,
        noGrants,
      ),
    ).toBe(true);
    expect(
      canEmployeeAccess(
        { visibility: "department", department: "sales" },
        emp,
        noGrants,
      ),
    ).toBe(false);
    expect(
      canEmployeeAccess({ visibility: "department", department: "sales" }, emp, [
        { grantee_type: "department", grantee_value: "engineering" },
      ]),
    ).toBe(true);
  });

  it("private / restricted require an explicit grant", () => {
    expect(
      canEmployeeAccess({ visibility: "private", department: null }, emp, noGrants),
    ).toBe(false);
    expect(
      canEmployeeAccess({ visibility: "private", department: null }, emp, [
        { grantee_type: "employee", grantee_value: "e-1" },
      ]),
    ).toBe(true);
    expect(
      canEmployeeAccess({ visibility: "restricted", department: null }, emp, [
        { grantee_type: "department", grantee_value: "engineering" },
      ]),
    ).toBe(true);
  });

  it("an unknown visibility fails closed", () => {
    expect(
      canEmployeeAccess(
        { visibility: "totally-made-up", department: "engineering" },
        emp,
        noGrants,
      ),
    ).toBe(false);
  });
});

describe("model — extractKeywords indexes searchable tokens", () => {
  it("lowercases, de-dupes, drops stopwords + short tokens", () => {
    expect(extractKeywords(["The Quick Brown Fox", "fox jumps high"])).toEqual([
      "quick",
      "brown",
      "fox",
      "jumps",
      "high",
    ]);
  });

  it("excludes sub-3-character tokens", () => {
    expect(extractKeywords(["ab cd efg"])).toEqual(["efg"]);
  });

  it("honours the cap", () => {
    expect(extractKeywords(["alpha beta gamma delta"], 2)).toEqual([
      "alpha",
      "beta",
    ]);
  });
});

describe("model — normalizeTags cleans free-form tag input", () => {
  it("lowercases, dashes whitespace, and de-dupes", () => {
    expect(normalizeTags("Sales, Pricing  Strategy, sales")).toEqual([
      "sales",
      "pricing-strategy",
    ]);
  });

  it("returns an empty array for empty/nullish input", () => {
    expect(normalizeTags("")).toEqual([]);
    expect(normalizeTags(null)).toEqual([]);
    expect(normalizeTags(undefined)).toEqual([]);
  });

  it("honours the cap", () => {
    expect(normalizeTags("a, b, c", 2)).toEqual(["a", "b"]);
  });
});

describe("model — aggregateMemoryFacets builds the dashboard rollups", () => {
  it("tallies facets, ranks contributors, and zero-fills 14-day growth", () => {
    const rows = [
      {
        memory_type: "company",
        department: DEPARTMENTS[0],
        status: "active",
        importance: "high",
        created_by_email: "a@crewflow.uk",
        created_at: "2026-06-10T00:00:00.000Z",
      },
      {
        memory_type: "company",
        department: DEPARTMENTS[0],
        status: "active",
        importance: "low",
        created_by_email: "a@crewflow.uk",
        created_at: "2026-06-11T00:00:00.000Z",
      },
      {
        memory_type: "product",
        department: DEPARTMENTS[1] ?? DEPARTMENTS[0],
        status: "archived",
        importance: "high",
        created_by_email: "b@crewflow.uk",
        created_at: "2026-06-12T00:00:00.000Z",
      },
    ];
    const f = aggregateMemoryFacets(rows, {
      company: "Company",
      product: "Product",
    });

    expect(f.byType.find((x) => x.key === "company")?.count).toBe(2);
    expect(f.byType[0]).toMatchObject({ key: "company", label: "Company", count: 2 });
    expect(f.byStatus.find((x) => x.key === "active")?.count).toBe(2);
    expect(f.byImportance.find((x) => x.key === "high")?.count).toBe(2);
    expect(f.topContributors[0]).toEqual({ email: "a@crewflow.uk", count: 2 });
    expect(f.growth).toHaveLength(14);
  });
});

describe("model — confidenceNote labels a 0–100 score", () => {
  it("maps score bands to human labels at the boundaries", () => {
    expect(confidenceNote(95)).toBe("Verified");
    expect(confidenceNote(90)).toBe("Verified");
    expect(confidenceNote(89)).toBe("High");
    expect(confidenceNote(75)).toBe("High");
    expect(confidenceNote(74)).toBe("Moderate");
    expect(confidenceNote(50)).toBe("Moderate");
    expect(confidenceNote(49)).toBe("Tentative");
    expect(confidenceNote(0)).toBe("Tentative");
  });
});
