import { beforeAll, expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient, userClient } from "../_harness";

/**
 * Universal customer search — the shared `search_customers` RPC (migration
 * 20261261000000) against real Postgres.
 *
 * Proves the behaviour the whole feature rests on:
 *   - MATCHING: multi-token (every word matches somewhere), partial-anywhere,
 *     case-insensitive, across name / email / address / town, PLUS normalised
 *     postcode (space-insensitive) and formatting-tolerant phone (UK 0 ↔ +44);
 *   - TENANT ISOLATION: a member of org A can never read org B's customers —
 *     neither by asking for org B (42501) nor via a term that only B matches;
 *   - PERMISSION: the RPC mirrors the customers RLS SELECT policy — ANY org
 *     member (incl. a `staff` role) is answered for their own org; anon is
 *     refused (42501);
 *   - PAGINATION: an exact whole-org total travels with a capped page.
 *
 * The RPC is SECURITY DEFINER (bypasses RLS), so this is also the behavioural
 * proof behind the systemic secdef-org-rpc-guard: the first act is the
 * current_org_ids()+42501 membership check.
 */

type Res<T = unknown> = { data: T; error: { message: string; code?: string } | null };
type Rpc = (fn: string, args: Record<string, unknown>) => PromiseLike<Res<SearchRow[]>>;
const rpc = (client: unknown) => client as unknown as { rpc: Rpc };
const svc = () =>
  serviceClient() as unknown as {
    from(t: string): {
      insert(r: Record<string, unknown> | Record<string, unknown>[]): {
        select(c?: string): { single(): PromiseLike<{ data: { id: string } | null; error: unknown }> };
      };
    };
  };

type SearchRow = {
  id: string;
  name: string;
  customer_type: string;
  postcode: string | null;
  total_count: number;
};

const TOKEN = `custsrch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

let orgA = "";
let orgB = "";
const tok: Record<string, string> = {};
const uid: Record<string, string> = {};

const insId = async (table: string, row: Record<string, unknown>): Promise<string> =>
  String((await svc().from(table).insert(row).select("id").single()).data?.id ?? "");

/** Insert many rows (no single-row return). Throws loudly on error. */
async function insMany(table: string, rows: Record<string, unknown>[]): Promise<void> {
  const client = serviceClient() as unknown as {
    from(t: string): { insert(r: Record<string, unknown>[]): PromiseLike<{ error: { message: string } | null }> };
  };
  const { error } = await client.from(table).insert(rows);
  if (error) throw new Error(`insert ${table}: ${error.message}`);
}

async function mkUser(s: string): Promise<{ id: string; token: string }> {
  const email = `${TOKEN}-${s}@example.test`;
  const password = `Pw-${TOKEN}-${s}-${Math.random().toString(36).slice(2)}`;
  const created = await serviceClient().auth.admin.createUser({ email, password, email_confirm: true });
  const id = created.data.user?.id ?? "";
  await svc().from("users").insert({ id, email, full_name: `CS ${s}` }).select("id").single();
  const token = (await anonClient().auth.signInWithPassword({ email, password })).data.session?.access_token ?? "";
  if (!id || !token) throw new Error(`mint ${s}`);
  return { id, token };
}

/** Search org A as the owner member; returns the matched names (lowercased). */
async function namesA(args: Record<string, unknown>): Promise<string[]> {
  const res = await rpc(userClient(tok.ownerA ?? "")).rpc("search_customers", { p_org_id: orgA, ...args });
  expect(res.error, `search failed: ${res.error?.message}`).toBeNull();
  return (res.data ?? []).map((r) => r.name);
}

describeIntegration("rls · search_customers RPC (20261261 · universal customer search)", () => {
  beforeAll(async () => {
    orgA = await insId("organizations", { name: `CS A ${TOKEN}`, slug: `${TOKEN}-a` });
    orgB = await insId("organizations", { name: `CS B ${TOKEN}`, slug: `${TOKEN}-b` });
    for (const who of ["ownerA", "staffA", "ownerB"]) {
      const u = await mkUser(who);
      uid[who] = u.id;
      tok[who] = u.token;
    }
    await svc().from("memberships").insert({ org_id: orgA, user_id: uid.ownerA, role: "owner" }).select("user_id").single();
    await svc().from("memberships").insert({ org_id: orgA, user_id: uid.staffA, role: "staff" }).select("user_id").single();
    await svc().from("memberships").insert({ org_id: orgB, user_id: uid.ownerB, role: "owner" }).select("user_id").single();

    // Org A customers — a deliberate spread of the match dimensions.
    await insMany("customers", [
      {
        org_id: orgA,
        name: "John Smith",
        email: "john@example.com",
        phone: "+44 7700 900123",
        customer_type: "individual",
        address_line1: "12 Malone Road",
        city: "Belfast",
        county: "Antrim",
        postcode: "BT9 1AB",
      },
      {
        org_id: orgA,
        name: "Smithson Builders Ltd",
        email: "ops@smithson.co",
        phone: "028 9024 1234",
        customer_type: "business",
        address_line1: "5 Lisburn Road",
        city: "Belfast",
        county: "Antrim",
        postcode: "BT9 7GF",
      },
      {
        org_id: orgA,
        name: "Mary O'Hara",
        email: "mary@ohara.ie",
        phone: "07700 900999",
        customer_type: "individual",
        address_line1: "Apartment 4, The Mill",
        city: "Lisburn",
        county: "Down",
        postcode: "BT27 4RT",
      },
    ]);

    // Org B customers — the cross-tenant probes. "John Smith" shares a name a
    // term in A's tests hits; "Zeta Unique" holds a phone number NO org-A
    // customer has, so a phone-only search from A must never surface it.
    await insMany("customers", [
      {
        org_id: orgB,
        name: "John Smith",
        email: "j2@other.com",
        phone: "07700 900123",
        customer_type: "individual",
        address_line1: "99 Other Street",
        city: "Derry",
        postcode: "BT48 6AA",
      },
      {
        org_id: orgB,
        name: "Zeta Unique",
        email: "zeta@other.com",
        phone: "+44 7000 000999",
        customer_type: "individual",
        address_line1: "1 Canary Wharf",
        city: "London",
        postcode: "E14 5AB",
      },
    ]);
  });

  it("multi-token matches name + street together, not by adjacency in one column", async () => {
    // "smith malone" — surname in `name`, street in `address_line1`.
    expect(await namesA({ p_query: "smith malone" })).toEqual(["John Smith"]);
  });

  it("partial name anywhere, case-insensitive", async () => {
    const n = await namesA({ p_query: "smith" });
    expect(n).toEqual(expect.arrayContaining(["John Smith", "Smithson Builders Ltd"]));
    expect(n).not.toContain("Mary O'Hara");
  });

  it("partial postcode is space-insensitive (BT9 1AB ↔ 'bt91ab')", async () => {
    expect(await namesA({ p_query: "bt91ab" })).toEqual(["John Smith"]);
    // A shorter fragment matches the whole outward-code family, excluding BT27.
    const bt9 = await namesA({ p_query: "bt9" });
    expect(bt9).toEqual(expect.arrayContaining(["John Smith", "Smithson Builders Ltd"]));
    expect(bt9).not.toContain("Mary O'Hara");
  });

  it("phone matching is formatting-tolerant and reconciles 0 ↔ +44", async () => {
    // Stored "+44 7700 900123"; the user types the national 0-form with a space.
    expect(await namesA({ p_query: "07700 900123" })).toEqual(["John Smith"]);
    // The landline, typed in its 0-form, finds the business.
    expect(await namesA({ p_query: "028 9024" })).toEqual(["Smithson Builders Ltd"]);
  });

  it("reconciles the spaced INTERNATIONAL form against a nationally-stored number", async () => {
    // Mary is stored "07700 900999" (national). Written the natural international
    // way WITH SPACES — "+44 7700 900999" — the "+44" tokenises into a country-
    // code fragment whose UK-significant form is empty, so the per-token AND
    // alone cannot match a number that contains no "44". The whole-query phone
    // signature reconciles it. (Staging-acceptance regression: this returned
    // zero before the whole-query phone branch was added to 20261261.)
    expect(await namesA({ p_query: "+44 7700 900999" })).toEqual(["Mary O'Hara"]);
    // The contiguous international form keeps working too.
    expect(await namesA({ p_query: "+447700900999" })).toEqual(["Mary O'Hara"]);
  });

  it("the spaced international phone form stays INSIDE the tenant boundary", async () => {
    // Only org B's "Zeta Unique" holds +44 7000 000999. A phone-only search from
    // org A — even in the spaced international form the new branch broadens —
    // must return nothing: the org_id filter is unconditional.
    expect(await namesA({ p_query: "+44 7000 000999" })).toEqual([]);
    expect(await namesA({ p_query: "07000 000999" })).toEqual([]);
  });

  it("a letter-bearing token never leaks a stray digit into a phone match", async () => {
    // "bt9" contains a 9 but is not a phone token: Mary (…900999) must not match.
    expect(await namesA({ p_query: "bt9" })).not.toContain("Mary O'Hara");
  });

  it("matches by email fragment and by town", async () => {
    expect(await namesA({ p_query: "smithson.co" })).toEqual(["Smithson Builders Ltd"]);
    expect(await namesA({ p_query: "lisburn" })).toEqual(
      expect.arrayContaining(["Smithson Builders Ltd", "Mary O'Hara"]),
    );
  });

  it("the type filter narrows to businesses", async () => {
    expect(await namesA({ p_query: null, p_type: "business" })).toEqual(["Smithson Builders Ltd"]);
  });

  it("an empty query browses the whole org with an EXACT total, and the page is capped", async () => {
    const all = await rpc(userClient(tok.ownerA ?? "")).rpc("search_customers", {
      p_org_id: orgA,
      p_query: null,
      p_limit: 2,
      p_offset: 0,
    });
    expect(all.error).toBeNull();
    expect((all.data ?? []).length).toBe(2); // capped page
    expect(all.data?.[0]?.total_count).toBe(3); // exact whole-org total travels on the row
  });

  it("TENANT ISOLATION — a term that only org B matches returns nothing for org A", async () => {
    // Both orgs have a "John Smith"; searching A must return only A's row, never B's.
    const res = await rpc(userClient(tok.ownerA ?? "")).rpc("search_customers", {
      p_org_id: orgA,
      p_query: "99 other street",
    });
    expect(res.error).toBeNull();
    expect(res.data ?? []).toEqual([]); // B's address is unreachable from A
  });

  it("TENANT ISOLATION — asking for another org is refused (42501), never answered", async () => {
    const res = await rpc(userClient(tok.ownerA ?? "")).rpc("search_customers", {
      p_org_id: orgB,
      p_query: "john",
    });
    expect(res.error, "a non-member must be refused").not.toBeNull();
    expect(String(res.error?.code ?? res.error?.message ?? "")).toMatch(/42501|Forbidden/i);
  });

  it("PERMISSION — a staff member of the org is answered (mirrors customers RLS)", async () => {
    // Customers are member-selectable under RLS; the RPC must not be stricter
    // than the table it fronts (the management-only product framing lives in the
    // app layer, not here).
    const res = await rpc(userClient(tok.staffA ?? "")).rpc("search_customers", {
      p_org_id: orgA,
      p_query: "smith",
    });
    expect(res.error, `staff member must be answered: ${res.error?.message}`).toBeNull();
    expect((res.data ?? []).length).toBeGreaterThan(0);
  });

  it("PERMISSION — anon (no JWT) is refused (42501)", async () => {
    const res = await rpc(anonClient()).rpc("search_customers", { p_org_id: orgA, p_query: "john" });
    expect(res.error, "anon must be refused").not.toBeNull();
    expect(String(res.error?.code ?? res.error?.message ?? "")).toMatch(/42501|Forbidden/i);
  });
});
