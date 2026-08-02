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

const TOKEN = `it-pubapix-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describeIntegration("public API v1 · expansion · isolation, scope, dark flag", () => {
  const svc = () => db(serviceClient());

  let orgA = "";
  let orgB = "";
  let custA = "";
  let custB = "";

  // Plaintext keys presented in the Authorization header.
  let keyA_all = ""; // org A, all four read scopes
  let keyA_jobsonly = ""; // org A, only read:jobs — 403 on the new surfaces
  let keyA_revoked = ""; // org A, all scopes, revoked
  let keyB_all = ""; // org B, all four read scopes

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

  const ALL_SCOPES = ["read:jobs", "read:customers", "read:invoices", "read:quotes"];

  const req = (path: string, plaintext?: string) =>
    new Request(`https://app.crewflow.uk/api/v1/${path}`, {
      headers: plaintext ? { authorization: `Bearer ${plaintext}` } : {},
    });

  beforeAll(async () => {
    orgA = await makeOrg("PubAPIx Probe A", `${TOKEN}-a`);
    orgB = await makeOrg("PubAPIx Probe B", `${TOKEN}-b`);
    custA = await makeCustomer(orgA);
    custB = await makeCustomer(orgB);
    await makeInvoice(orgA, `${TOKEN}-A-INV-1`);
    await makeInvoice(orgB, `${TOKEN}-B-INV-1`);
    await makeQuote(orgA, custA, `${TOKEN}-A-QUO-1`);
    await makeQuote(orgB, custB, `${TOKEN}-B-QUO-1`);
    keyA_all = await mintKey(orgA, ALL_SCOPES);
    keyA_jobsonly = await mintKey(orgA, ["read:jobs"]);
    keyA_revoked = await mintKey(orgA, ALL_SCOPES, { revoked: true });
    keyB_all = await mintKey(orgB, ALL_SCOPES);
  });

  afterAll(async () => {
    // Org teardown cascades api_keys + customers + invoices + quotes.
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

  it("openapi.json: flag OFF → 404, flag ON → 200 OpenAPI 3.1 (no key required, no tenant data)", async () => {
    const { GET } = await import("@/app/api/v1/openapi.json/route");
    flagState.enabled = false;
    expect((await GET(req("openapi.json"))).status).toBe(404);
    flagState.enabled = true;
    const res = await GET(req("openapi.json"));
    expect(res.status).toBe(200);
    const doc = (await res.json()) as { openapi: string; paths: Record<string, unknown> };
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.paths["/customers"]).toBeTruthy();
    expect(doc.paths["/invoices"]).toBeTruthy();
    expect(doc.paths["/quotes"]).toBeTruthy();
  });
});
