import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { describeIntegration, serviceClient } from "../_harness";
import { generateApiKey } from "@/lib/api-auth/keygen";

/**
 * Public API v1 — Open-API expansion (customers / invoices / quotes + the
 * OpenAPI spec) — end-to-end against real Postgres.
 *
 * The live-DB counterpart to the source pins in
 * __tests__/security/public-api-expansion.test.ts: it drives the actual route
 * HANDLERS with real api_keys rows across TWO orgs, proving org isolation, the
 * per-resource scope gate, the dark-flag 404, and the DTO allowlist against the
 * database — not just the source.
 *
 * THE FLAG: every v1 route is dark behind FEATURE_PUBLIC_API_JOBS. This suite
 * mocks lib/public-api/flag so each test controls the surface explicitly, and
 * one test per resource flips it OFF to prove the dark 404.
 */

const flagState = { enabled: true };
vi.mock("@/lib/public-api/flag", () => ({
  isPublicApiJobsEnabled: () => flagState.enabled,
}));

type Res<T> = { data: T | null; error: { message: string; code?: string } | null };
type Row = Record<string, unknown>;
interface Ins extends PromiseLike<Res<Row[]>> {
  select(columns?: string): { single(): PromiseLike<Res<Row>> };
}
interface Table {
  insert(rows: Row | Row[]): Ins;
}
const db = (client: unknown) => client as unknown as { from(t: string): Table };

/** Build a params context for an item ([id]) route handler. */
const itemCtx = (id: string) => ({ params: Promise.resolve({ id }) });

const TOKEN = `it-pubapix-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describeIntegration("public API v1 · expansion · isolation, scope, dark flag", () => {
  const svc = () => db(serviceClient());

  let orgA = "";
  let orgB = "";
  let custA = "";
  let custB = "";

  // Plaintext keys presented in the Authorization header.
  let keyA_all = ""; // org A, all read scopes
  let keyA_jobsonly = ""; // org A, only read:jobs — 403 on the new surfaces
  let keyA_revoked = ""; // org A, all scopes, revoked
  let keyB_all = ""; // org B, all read scopes
  let keyA_write = ""; // org A, expense + invoice write scopes

  // Captured fixture ids for the write / by-id flows.
  let invoiceA = "";
  let expenseA = "";
  let expenseB = "";

  async function makeOrg(name: string, slug: string): Promise<string> {
    const r = await svc().from("organizations").insert({ name, slug }).select("id").single();
    expect(r.error, r.error?.message).toBeNull();
    return String(r.data?.id ?? "");
  }

  async function makeCustomer(org: string): Promise<string> {
    const r = await svc()
      .from("customers")
      .insert({ org_id: org, name: `${TOKEN} Customer`, city: "London", postcode: "SW1A 1AA" })
      .select("id")
      .single();
    expect(r.error, r.error?.message).toBeNull();
    return String(r.data?.id ?? "");
  }

  async function makeInvoice(org: string, num: string): Promise<string> {
    // `total` is a STORED GENERATED column (amount + vat_total) — never inserted.
    const r = await svc()
      .from("invoices")
      .insert({ org_id: org, number: num, amount: 100, vat_total: 20, status: "draft" })
      .select("id")
      .single();
    expect(r.error, r.error?.message).toBeNull();
    return String(r.data?.id ?? "");
  }

  async function makeQuote(org: string, customer: string, num: string): Promise<string> {
    const r = await svc()
      .from("quotes")
      .insert({
        org_id: org,
        customer_id: customer,
        number: num,
        subtotal: 100,
        vat_total: 20,
        total: 120,
        cost_labour: 55, // an INTERNAL cost input (feeds generated cost_total) — must never surface
      })
      .select("id")
      .single();
    expect(r.error, r.error?.message).toBeNull();
    return String(r.data?.id ?? "");
  }

  // A real auth user mirrored into public.users + a membership — needed for the
  // time_entries (user_id NOT NULL) and staff (memberships) fixtures.
  async function makeUserInOrg(org: string, role: string): Promise<string> {
    const email = `${TOKEN}-${Math.random().toString(36).slice(2, 8)}@probe.test`;
    const created = await serviceClient().auth.admin.createUser({
      email,
      password: `Pw!${crypto.randomUUID()}`,
      email_confirm: true,
    });
    expect(created.error, created.error?.message).toBeNull();
    const id = String(created.data.user?.id ?? "");
    const mirrored = await svc().from("users").insert({ id, email, full_name: `${TOKEN} ${role}` }).select("id").single();
    expect(mirrored.error, mirrored.error?.message).toBeNull();
    const m = await svc().from("memberships").insert({ org_id: org, user_id: id, role }).select("user_id").single();
    expect(m.error, m.error?.message).toBeNull();
    return id;
  }

  async function makeTimeEntry(org: string, user: string): Promise<string> {
    const r = await svc()
      .from("time_entries")
      .insert({
        org_id: org,
        user_id: user,
        started_at: new Date().toISOString(),
        // gps + note set so the DTO's exclusion of them is proven against real data.
        gps_lat: 51.5,
        gps_lng: -0.12,
        note: `${TOKEN} internal note`,
      })
      .select("id")
      .single();
    expect(r.error, r.error?.message).toBeNull();
    return String(r.data?.id ?? "");
  }

  async function makeExpense(org: string): Promise<string> {
    // `vat_total` is a STORED GENERATED column — never inserted.
    const r = await svc()
      .from("finances")
      .insert({ org_id: org, amount: 200, vat_rate: 20, category: "materials", notes: `${TOKEN} internal` })
      .select("id")
      .single();
    expect(r.error, r.error?.message).toBeNull();
    return String(r.data?.id ?? "");
  }

  async function makeMaterialRequest(org: string, num: string): Promise<string> {
    const r = await svc()
      .from("material_requests")
      .insert({ org_id: org, number: num, status: "draft", priority: "normal", notes: `${TOKEN} internal` })
      .select("id")
      .single();
    expect(r.error, r.error?.message).toBeNull();
    return String(r.data?.id ?? "");
  }

  async function mintKey(
    org: string,
    scopes: string[],
    opts: { revoked?: boolean } = {},
  ): Promise<string> {
    const k = generateApiKey();
    const r = await svc()
      .from("api_keys")
      .insert({
        org_id: org,
        name: `${TOKEN}-${scopes.join("+") || "noscope"}`,
        key_prefix: k.keyPrefix,
        key_hash: k.keyHash,
        scopes,
        revoked_at: opts.revoked ? new Date().toISOString() : null,
      })
      .select("id")
      .single();
    expect(r.error, r.error?.message).toBeNull();
    return k.plaintext;
  }

  const ALL_SCOPES = [
    "read:jobs",
    "read:customers",
    "read:invoices",
    "read:quotes",
    "read:time",
    "read:staff",
    "read:expenses",
    "read:materials",
  ];
  const WRITE_SCOPES = ["read:expenses", "write:expenses", "read:invoices", "write:invoices"];

  const req = (path: string, plaintext?: string) =>
    new Request(`https://app.crewflow.uk/api/v1/${path}`, {
      headers: plaintext ? { authorization: `Bearer ${plaintext}` } : {},
    });

  const bodyReq = (path: string, plaintext: string, method: string, body: unknown) =>
    new Request(`https://app.crewflow.uk/api/v1/${path}`, {
      method,
      headers: { authorization: `Bearer ${plaintext}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  beforeAll(async () => {
    orgA = await makeOrg("PubAPIx Probe A", `${TOKEN}-a`);
    orgB = await makeOrg("PubAPIx Probe B", `${TOKEN}-b`);
    custA = await makeCustomer(orgA);
    custB = await makeCustomer(orgB);
    invoiceA = await makeInvoice(orgA, `${TOKEN}-A-INV-1`);
    await makeInvoice(orgB, `${TOKEN}-B-INV-1`);
    await makeQuote(orgA, custA, `${TOKEN}-A-QUO-1`);
    await makeQuote(orgB, custB, `${TOKEN}-B-QUO-1`);
    // Breadth-wave fixtures: a user+membership per org (time + staff), an
    // expense per org, and a material request per org.
    const userA = await makeUserInOrg(orgA, "staff");
    await makeUserInOrg(orgB, "staff");
    await makeTimeEntry(orgA, userA);
    expenseA = await makeExpense(orgA);
    expenseB = await makeExpense(orgB);
    await makeMaterialRequest(orgA, `${TOKEN}-A-MR-1`);
    await makeMaterialRequest(orgB, `${TOKEN}-B-MR-1`);
    keyA_all = await mintKey(orgA, ALL_SCOPES);
    keyA_jobsonly = await mintKey(orgA, ["read:jobs"]);
    keyA_revoked = await mintKey(orgA, ALL_SCOPES, { revoked: true });
    keyB_all = await mintKey(orgB, ALL_SCOPES);
    keyA_write = await mintKey(orgA, WRITE_SCOPES);
  });

  afterAll(async () => {
    // Org teardown cascades api_keys + customers + invoices + quotes + the
    // breadth-wave rows (time_entries, finances, material_requests, memberships).
    for (const id of [orgA, orgB]) {
      if (id) await serviceClient().from("organizations").delete().eq("id", id);
    }
  });

  // Each resource: the endpoint path, its scope, the DTO allowlist, and the
  // forbidden keys that must never appear on a returned row.
  const RESOURCES = [
    {
      name: "customers",
      allow: ["id", "name", "city", "county", "postcode", "country", "created_at", "updated_at"],
      forbidden: ["email", "phone", "address_line1", "notes", "portal_token", "org_id"],
    },
    {
      name: "invoices",
      allow: [
        "id",
        "number",
        "status",
        "amount",
        "vat_total",
        "total",
        "due_date",
        "sent_at",
        "paid_at",
        "created_at",
        "updated_at",
      ],
      forbidden: ["customer_id", "job_id", "quote_id", "notes", "org_id"],
    },
    {
      name: "quotes",
      allow: [
        "id",
        "number",
        "status",
        "currency",
        "subtotal",
        "vat_total",
        "total",
        "valid_until",
        "sent_at",
        "accepted_at",
        "declined_at",
        "created_at",
        "updated_at",
      ],
      forbidden: ["cost_total", "cost_labour", "public_token", "customer_id", "org_id"],
    },
    {
      name: "time",
      allow: ["id", "started_at", "ended_at", "created_at", "updated_at"],
      forbidden: ["user_id", "job_id", "gps_lat", "gps_lng", "note", "breaks", "org_id"],
    },
    {
      name: "staff",
      allow: ["id", "role", "created_at"],
      forbidden: ["user_id", "org_id", "email", "full_name"],
    },
    {
      name: "expenses",
      allow: ["id", "amount", "currency", "vat_rate", "vat_total", "category", "created_at", "updated_at"],
      forbidden: ["job_id", "receipt_url", "notes", "org_id"],
    },
    {
      name: "materials",
      allow: ["id", "number", "status", "priority", "needed_by", "submitted_at", "decided_at", "created_at", "updated_at"],
      forbidden: ["job_id", "requested_by", "decided_by", "notes", "rejection_reason", "org_id"],
    },
  ] as const;

  // Static imports (not a templated dynamic import — vite cannot analyse those).
  async function handlerFor(name: string): Promise<(r: Request) => Promise<Response>> {
    switch (name) {
      case "customers":
        return (await import("@/app/api/v1/customers/route")).GET;
      case "invoices":
        return (await import("@/app/api/v1/invoices/route")).GET;
      case "quotes":
        return (await import("@/app/api/v1/quotes/route")).GET;
      case "time":
        return (await import("@/app/api/v1/time/route")).GET;
      case "staff":
        return (await import("@/app/api/v1/staff/route")).GET;
      case "expenses":
        return (await import("@/app/api/v1/expenses/route")).GET;
      case "materials":
        return (await import("@/app/api/v1/materials/route")).GET;
      default:
        throw new Error(`no handler for ${name}`);
    }
  }

  for (const r of RESOURCES) {
    it(`${r.name}: a key for org A lists ONLY org A's rows, with just the allowlisted fields`, async () => {
      flagState.enabled = true;
      const GET = await handlerFor(r.name);
      const res = await GET(req(r.name, keyA_all));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: Array<Record<string, unknown>> };
      expect(body.data.length).toBeGreaterThan(0);
      for (const row of body.data) {
        expect(Object.keys(row).sort()).toEqual([...r.allow].sort());
        for (const f of r.forbidden) expect(row).not.toHaveProperty(f);
      }
    });

    it(`${r.name}: org A's key cannot see org B's rows (cross-org isolation)`, async () => {
      flagState.enabled = true;
      // Fetch with org B's key, collect its row ids, then prove org A's key
      // returns none of them.
      const GET = await handlerFor(r.name);
      const bBody = (await (await GET(req(r.name, keyB_all))).json()) as {
        data: Array<{ id: string }>;
      };
      const bIds = new Set(bBody.data.map((x) => x.id));
      expect(bIds.size).toBeGreaterThan(0);
      const aBody = (await (await GET(req(r.name, keyA_all))).json()) as {
        data: Array<{ id: string }>;
      };
      for (const row of aBody.data) expect(bIds.has(row.id)).toBe(false);
    });

    it(`${r.name}: a key without the resource scope → 403 (read:jobs-only)`, async () => {
      flagState.enabled = true;
      const GET = await handlerFor(r.name);
      const res = await GET(req(r.name, keyA_jobsonly));
      expect(res.status).toBe(403);
    });

    it(`${r.name}: a missing key → 401`, async () => {
      flagState.enabled = true;
      const GET = await handlerFor(r.name);
      const res = await GET(req(r.name));
      expect(res.status).toBe(401);
    });

    it(`${r.name}: an invalid key → 401`, async () => {
      flagState.enabled = true;
      const GET = await handlerFor(r.name);
      const res = await GET(req(r.name, "crewflow_sk_notarealkeyatall000000000000000000"));
      expect(res.status).toBe(401);
    });

    it(`${r.name}: a REVOKED key → 401`, async () => {
      flagState.enabled = true;
      const GET = await handlerFor(r.name);
      const res = await GET(req(r.name, keyA_revoked));
      expect(res.status).toBe(401);
    });

    it(`${r.name}: flag OFF → 404 (dark), even with a valid, fully-scoped key`, async () => {
      flagState.enabled = false;
      const GET = await handlerFor(r.name);
      const res = await GET(req(r.name, keyA_all));
      expect(res.status).toBe(404);
      flagState.enabled = true;
    });
  }

  it("quotes: the internal cost (cost_labour → generated cost_total) is NEVER returned in the DTO", async () => {
    flagState.enabled = true;
    const GET = await handlerFor("quotes");
    const body = (await (await GET(req("quotes", keyA_all))).json()) as {
      data: Array<Record<string, unknown>>;
    };
    for (const row of body.data) {
      expect(row).not.toHaveProperty("cost_total");
      expect(row).not.toHaveProperty("cost_labour");
      // Deterministic belt-and-braces (the old substring check flaked on random
      // UUIDs containing "55"): NO cost_* key of any kind, and the inserted cost
      // value never appears among the returned values.
      expect(Object.keys(row).some((k) => k.startsWith("cost"))).toBe(false);
      expect(Object.values(row)).not.toContain(55);
    }
  });

  // -------------------------------------------------------------------------
  // Write flows — expenses (create + PATCH) and invoices (PATCH), org-pinned
  // and idempotent.
  // -------------------------------------------------------------------------

  it("expenses: POST records a cost in the KEY'S org, returned through the read allowlist", async () => {
    flagState.enabled = true;
    const { POST } = await import("@/app/api/v1/expenses/route");
    const res = await POST(bodyReq("expenses", keyA_write, "POST", { amount: 75, vat_rate: 20, category: "fuel" }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data.amount).toBe(75);
    // vat_total is the generated column, surfaced read-only.
    expect(body.data.vat_total).toBe(15);
    for (const f of ["job_id", "notes", "org_id", "receipt_url"]) {
      expect(body.data).not.toHaveProperty(f);
    }
  });

  it("expenses: write:expenses is DISTINCT — a read-only key cannot POST", async () => {
    flagState.enabled = true;
    const { POST } = await import("@/app/api/v1/expenses/route");
    const res = await POST(bodyReq("expenses", keyA_all, "POST", { amount: 10 }));
    expect(res.status).toBe(403);
  });

  it("expenses: a cross-org job_id is refused (422), never attached", async () => {
    flagState.enabled = true;
    const { POST } = await import("@/app/api/v1/expenses/route");
    // A random uuid that is not a job in org A → clean reference error.
    const res = await POST(bodyReq("expenses", keyA_write, "POST", { amount: 10, job_id: crypto.randomUUID() }));
    expect(res.status).toBe(422);
  });

  it("expenses: PATCH is org-pinned and IDEMPOTENT — same body twice → same state", async () => {
    flagState.enabled = true;
    const { PATCH } = await import("@/app/api/v1/expenses/[id]/route");
    const patch = () => PATCH(bodyReq(`expenses/${expenseA}`, keyA_write, "PATCH", { category: "plant-hire", amount: 300 }), itemCtx(expenseA));
    const first = await patch();
    expect(first.status).toBe(200);
    const b1 = (await first.json()) as { data: Record<string, unknown> };
    const second = await patch();
    expect(second.status).toBe(200);
    const b2 = (await second.json()) as { data: Record<string, unknown> };
    expect(b2.data).toEqual(b1.data);
    expect(b2.data.category).toBe("plant-hire");
    expect(b2.data.amount).toBe(300);
  });

  it("expenses: org B's expense is a 404 to org A's key on the by-id PATCH (no cross-org write / oracle)", async () => {
    flagState.enabled = true;
    const { PATCH } = await import("@/app/api/v1/expenses/[id]/route");
    const res = await PATCH(bodyReq(`expenses/${expenseB}`, keyA_write, "PATCH", { category: "x" }), itemCtx(expenseB));
    expect(res.status).toBe(404);
  });

  it("invoices: PATCH updates status idempotently and never a money column", async () => {
    flagState.enabled = true;
    const { PATCH } = await import("@/app/api/v1/invoices/[id]/route");
    const patch = () => PATCH(bodyReq(`invoices/${invoiceA}`, keyA_write, "PATCH", { status: "sent" }), itemCtx(invoiceA));
    const first = await patch();
    expect(first.status).toBe(200);
    const b1 = (await first.json()) as { data: Record<string, unknown> };
    expect(b1.data.status).toBe("sent");
    const second = await patch();
    const b2 = (await second.json()) as { data: Record<string, unknown> };
    expect(b2.data).toEqual(b1.data);
    // The billed amount is untouched by the status PATCH.
    expect(b2.data.amount).toBe(100);
  });

  it("invoices: the derived 'overdue' status is rejected at validation (422)", async () => {
    flagState.enabled = true;
    const { PATCH } = await import("@/app/api/v1/invoices/[id]/route");
    const res = await PATCH(bodyReq(`invoices/${invoiceA}`, keyA_write, "PATCH", { status: "overdue" }), itemCtx(invoiceA));
    expect(res.status).toBe(422);
  });

  it("invoices: write:invoices is DISTINCT — a read-only key cannot PATCH", async () => {
    flagState.enabled = true;
    const { PATCH } = await import("@/app/api/v1/invoices/[id]/route");
    const res = await PATCH(bodyReq(`invoices/${invoiceA}`, keyA_all, "PATCH", { status: "sent" }), itemCtx(invoiceA));
    expect(res.status).toBe(403);
  });

  it("expenses/invoices by-id PATCH: flag OFF → 404 (dark), even with a valid write key", async () => {
    flagState.enabled = false;
    const { PATCH: patchExp } = await import("@/app/api/v1/expenses/[id]/route");
    const { PATCH: patchInv } = await import("@/app/api/v1/invoices/[id]/route");
    expect((await patchExp(bodyReq(`expenses/${expenseA}`, keyA_write, "PATCH", { category: "z" }), itemCtx(expenseA))).status).toBe(404);
    expect((await patchInv(bodyReq(`invoices/${invoiceA}`, keyA_write, "PATCH", { status: "sent" }), itemCtx(invoiceA))).status).toBe(404);
    flagState.enabled = true;
  });

  it("openapi.json: flag OFF → 404, flag ON → 200 OpenAPI 3.1 (no key required, no tenant data)", async () => {
    const { GET } = await import("@/app/api/v1/openapi.json/route");
    flagState.enabled = false;
    expect((await GET(req("openapi.json"))).status).toBe(404);
    flagState.enabled = true;
    const res = await GET(req("openapi.json"));
    expect(res.status).toBe(200);
    const doc = (await res.json()) as { openapi: string; paths: Record<string, unknown> };
    expect(doc.openapi).toBe("3.1.0");
    for (const p of [
      "/customers",
      "/invoices",
      "/invoices/{id}",
      "/quotes",
      "/time",
      "/staff",
      "/expenses",
      "/expenses/{id}",
      "/materials",
    ]) {
      expect(doc.paths[p], `spec missing ${p}`).toBeTruthy();
    }
  });
});
