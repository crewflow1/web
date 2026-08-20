import { afterAll, beforeAll, expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient, userClient } from "../_harness";

/**
 * SYSTEMIC SECURITY DEFINER org-RPC membership-guard (real Postgres).
 *
 * WHY THIS TEST EXISTS
 * --------------------
 * A SECURITY DEFINER function runs with the OWNER's rights and therefore
 * BYPASSES RLS. Under Supabase's default privileges every new public function
 * is granted EXECUTE to anon + authenticated at CREATE time. So a public
 * SECURITY DEFINER function that takes an org (uuid) argument and does NOT
 * authorise the caller against that org is a cross-tenant read primitive:
 * anyone can POST /rest/v1/rpc/<fn> {"target_org":"<victim>"} with the PUBLIC
 * anon key and read across the tenant boundary.
 *
 * Six such functions shipped LIVE unguarded (migration 20261116000000 fixed
 * them by prepending the canonical current_org_ids()+42501 guard already used
 * by next_invoice_number / next_quote_number):
 *   next_po_number, next_certificate_number, next_grn_number,
 *   next_material_request_number  — leaked each victim org's document counter;
 *   cis_statement_ledger_fingerprint,
 *   cis_monthly_return_ledger_fingerprint  — a SHA-256 ledger oracle.
 *
 * The failure mode of a fix-the-six-we-found approach is a SILENT MISS: the
 * seventh such function ships next month and nothing notices. This test is the
 * missing systemic gate. It introspects the WHOLE CLASS — every public
 * SECURITY DEFINER function EXECUTE-able by anon or authenticated that takes a
 * uuid argument — and asserts each is EITHER:
 *   (a) membership-guarded: its body references public.current_org_ids() AND
 *       raises 42501 (the canonical guard), or
 *   (b) present in the explicit ALLOWLIST below, with an honest, verified reason.
 *
 * A NEW unguarded secdef-uuid function therefore FAILS CI until the author
 * either adds the canonical guard or allowlists it with a justification —
 * turning "did we remember to guard it?" from tribal memory into a gate.
 *
 * WHERE THE INTROSPECTION LIVES
 * -----------------------------
 * supabase-js cannot run arbitrary SQL, so the class query lives in the
 * catalog-only SECURITY-INVOKER function public._introspect_secdef_org_rpcs()
 * (migration 20261116000000), granted to service_role. It reports, per member,
 * whether its body is guarded (current_org_ids + 42501).
 *
 * The `guarded` predicate deliberately requires the EXACT canonical pair
 * (current_org_ids AND 42501). Functions that authorise by other sound means —
 * a direct memberships lookup, is_org_admin(), current_org_ids() with a
 * non-42501 raise — are genuinely safe but do NOT auto-pass; they must be
 * allowlisted so a human has consciously vouched for each one. That is the
 * strongest posture: the auto-pass lane is a single, well-understood idiom.
 */

// ── The six that migration 20261116000000 fixed. Each MUST be guarded and
//    MUST NOT be allowlisted (a regression would drop the guard). ──
const FIXED_SIX: readonly string[] = [
  "next_po_number",
  "next_certificate_number",
  "next_grn_number",
  "next_material_request_number",
  "cis_statement_ledger_fingerprint",
  "cis_monthly_return_ledger_fingerprint",
];

/**
 * Genuinely-safe class members that do NOT use the canonical current_org_ids()
 * +42501 idiom. Each entry was verified by reading pg_get_functiondef; the
 * reason states exactly why the caller cannot cross the tenant boundary.
 *
 * IMPORTANT: this allowlist may hold ONLY functions that are actually safe.
 * The six fixed functions must NEVER appear here.
 */
const ALLOWLIST: ReadonlyMap<string, string> = new Map<string, string>([
  // The membership primitives themselves — they ARE the check. Each reads the
  // CALLER's own membership via auth.uid(); anon has no auth.uid() so they
  // return false and disclose nothing about any org.
  [
    "is_org_member",
    "membership primitive: checks the CALLER's own membership via auth.uid(); returns false for anon; leaks nothing.",
  ],
  [
    "is_org_admin",
    "admin membership primitive: checks the CALLER's own owner/admin membership via auth.uid() (with impersonation scoping); returns false for anon; leaks nothing.",
  ],

  // Membership-guarded via current_org_ids(), but they raise a GENERIC
  // exception rather than 42501, so they miss the canonical auto-pass. A
  // non-member is still denied.
  [
    "next_ptw_number",
    "membership-guarded: target_org checked against current_org_ids(); raises a generic exception (not 42501); a non-member is denied.",
  ],
  [
    "next_ra_number",
    "membership-guarded: target_org checked against current_org_ids(); raises a generic exception (not 42501); a non-member is denied.",
  ],
  [
    "next_variation_number",
    "membership-guarded: the job's org is checked against current_org_ids(); raises a generic exception (not 42501); a non-member is denied.",
  ],
  [
    "marketplace_submit_listing",
    "membership-guarded: requires the caller be an admin of p_org_id (is_org_admin) AND that p_org_id own the listing (v_owner = p_org_id); a non-admin or cross-org caller is refused. Generic exception (not 42501), so misses the canonical auto-pass.",
  ],

  // Interim-valuation RPCs (20261192000000). Both take a valuation uuid, look the
  // row up, DERIVE org_id from that row, and enforce is_org_admin(that org) — a
  // caller passing another org's valuation uuid is refused because they are not an
  // admin of the row's org. They never trust a caller-supplied org, only write
  // within the row's org, and are revoked from anon/authenticated at CREATE +
  // re-granted to authenticated (admin-gated inside). Not cross-tenant primitives.
  [
    "certify_valuation",
    "membership-guarded: derives org_id from the valuation row addressed by the uuid and enforces is_org_admin(that org); a foreign-org uuid is refused. Also takes a per-job advisory lock before the cumulation read.",
  ],
  [
    "generate_valuation_invoice",
    "membership-guarded: derives org_id from the valuation row addressed by the uuid and enforces is_org_admin(that org); a foreign-org uuid is refused. Bills only within the row's org via next_invoice_number + invoices.",
  ],

  // Guarded by a direct memberships lookup on auth.uid() + 42501 — sound, just
  // not via the current_org_ids() helper, so it misses the auto-pass predicate.
  [
    "append_job_photo",
    "membership-guarded via a direct public.memberships lookup on auth.uid() (plus an org-first path check), raising 42501; anon/non-members denied.",
  ],
  [
    "remove_job_photo",
    "membership-guarded via a direct public.memberships lookup on auth.uid(), raising 42501; anon/non-members denied.",
  ],

  // Authorises via is_org_admin() on the resource's own org — owner/admin only.
  [
    "generate_stage_invoice",
    "requires auth.uid() and is_org_admin(stage.org_id) — owner/admin of the stage's own org only; anon/non-admins denied.",
  ],

  // NOTE: material_request_fulfilment_state and purchase_order_receipt_state
  // were formerly allowlisted as "derived-state read helpers" because they only
  // gated the membership check on `auth.uid() is not null` — which let ANON skip
  // it. That is precisely the anon-reachable-secdef-org class this file exists to
  // close, so migration 20261116000000 replaced that gate with the canonical
  // current_org_ids()+42501 guard. They are now canonically guarded (guarded=true)
  // and MUST NOT be allowlisted — they are covered by FIXED_TWO_STATE below.
]);

// The two derived-state helpers hardened in the same migration. Like FIXED_SIX
// they MUST be guarded and MUST NOT be allowlisted.
const FIXED_TWO_STATE: readonly string[] = [
  "purchase_order_receipt_state",
  "material_request_fulfilment_state",
];

type Row = {
  proname: string;
  identity_args: string;
  anon_exec: boolean;
  auth_exec: boolean;
  guarded: boolean;
};

async function secdefOrgRpcs(): Promise<Row[]> {
  const svc = serviceClient() as unknown as {
    rpc: (
      fn: string,
      args: Record<string, unknown>,
    ) => Promise<{ data: unknown; error: { message: string } | null }>;
  };
  const res = await svc.rpc("_introspect_secdef_org_rpcs", {});
  if (res.error) {
    throw new Error(
      `introspection RPC failed: ${res.error.message}. ` +
        "This test needs public._introspect_secdef_org_rpcs() (migration 20261116000000).",
    );
  }
  return (res.data as Row[]) ?? [];
}

describeIntegration("SECURITY DEFINER org-RPC membership guard · systemic", () => {
  it("every anon/authenticated-executable secdef uuid RPC is guarded or allowlisted", async () => {
    const rows = await secdefOrgRpcs();
    expect(
      rows.length,
      "introspection returned no rows — the query or RPC is wrong",
    ).toBeGreaterThan(0);

    const unexplained = rows
      .filter((r) => !r.guarded && !ALLOWLIST.has(r.proname))
      .map((r) => `${r.proname}(${r.identity_args})`);

    expect(
      unexplained,
      `Unguarded, un-allowlisted public SECURITY DEFINER function(s) that take a ` +
        `uuid and are EXECUTE-able by anon/authenticated — a cross-tenant read ` +
        `primitive (SECURITY DEFINER bypasses RLS):\n${unexplained.join("\n")}\n\n` +
        `Fix: PREPEND the canonical guard\n` +
        `  if auth.role() is distinct from 'service_role'\n` +
        `     and <org_arg> not in (select public.current_org_ids()) then\n` +
        `    raise exception 'Forbidden: not a member of this org' using errcode = '42501';\n` +
        `  end if;\n` +
        `(the next_invoice_number / next_quote_number pattern) — OR add it to the ` +
        `ALLOWLIST in this file with an honest, verified reason.`,
    ).toEqual([]);
  });

  it("the fixed functions are guarded and are NOT allowlisted", async () => {
    const rows = await secdefOrgRpcs();
    const byName = new Map(rows.map((r) => [r.proname, r]));
    for (const fn of [...FIXED_SIX, ...FIXED_TWO_STATE]) {
      const row = byName.get(fn);
      expect(row, `${fn} is missing from the class — did its signature change?`).toBeDefined();
      expect(
        row?.guarded,
        `${fn} is NOT guarded — migration 20261116000000 did not apply, or a later ` +
          `CREATE OR REPLACE dropped the current_org_ids()+42501 guard.`,
      ).toBe(true);
      expect(
        ALLOWLIST.has(fn),
        `${fn} must never be allowlisted — it is a fixed, actively-guarded function.`,
      ).toBe(false);
    }
  });

  it("the allowlist has no stale entries (every entry is still an unguarded class member)", async () => {
    const rows = await secdefOrgRpcs();
    const present = new Map(rows.map((r) => [r.proname, r]));
    const stale = [...ALLOWLIST.keys()].filter((name) => {
      const row = present.get(name);
      // Stale if it left the class entirely, or if it is now canonically
      // guarded (in which case it no longer needs an allowlist entry).
      return !row || row.guarded;
    });
    expect(
      stale,
      `Allowlisted function(s) that are no longer unguarded class members — remove ` +
        `them from the ALLOWLIST (they were dropped, re-signatured, or are now ` +
        `canonically guarded):\n${stale.join("\n")}`,
    ).toEqual([]);
  });
});

/**
 * EFFECT verification for the six — the authoritative check.
 *
 * A body-string introspection proves the guard is PRESENT; this proves it
 * WORKS along the exact path an attacker (anon over PostgREST) and the app
 * (service_role) actually use. anon must be denied 42501; service_role (whose
 * JWT carries role=service_role, which the guard's `auth.role()` reads) must
 * succeed. This mirrors the C37/C39 introspect-RPC lockdown guard.
 */
const RANDOM_ORG = "00000000-0000-4000-8000-0000deadbeef";
const RANDOM_UUID = "00000000-0000-4000-8000-0000cafebabe";
const PROBE_MONTH = "2026-04-05"; // an arbitrary UK CIS tax-month-end date

// The six, with the args PostgREST needs to resolve each signature.
const SIX_PROBES: ReadonlyArray<{ fn: string; args: Record<string, unknown> }> = [
  { fn: "next_po_number", args: { target_org: RANDOM_ORG } },
  { fn: "next_certificate_number", args: { target_org: RANDOM_ORG } },
  { fn: "next_grn_number", args: { target_org: RANDOM_ORG } },
  { fn: "next_material_request_number", args: { target_org: RANDOM_ORG } },
  {
    fn: "cis_statement_ledger_fingerprint",
    args: {
      p_org_id: RANDOM_ORG,
      p_supplier_id: RANDOM_UUID,
      p_tax_month_end: PROBE_MONTH,
    },
  },
  {
    fn: "cis_monthly_return_ledger_fingerprint",
    args: { p_org_id: RANDOM_ORG, p_tax_month_end: PROBE_MONTH },
  },
];

async function rpcAs(
  client: ReturnType<typeof serviceClient>,
  fn: string,
  args: Record<string, unknown>,
): Promise<{ data: unknown; error: { code?: string; message: string } | null }> {
  return (
    client as unknown as {
      rpc: (
        fn: string,
        args: Record<string, unknown>,
      ) => Promise<{
        data: unknown;
        error: { code?: string; message: string } | null;
      }>;
    }
  ).rpc(fn, args);
}

describeIntegration(
  "SECURITY DEFINER org-RPC membership guard · effect (anon denied, service_role allowed)",
  () => {
    for (const { fn, args } of SIX_PROBES) {
      it(`${fn}: anon is DENIED 42501 for a foreign org`, async () => {
        const res = await rpcAs(anonClient(), fn, args);
        expect(
          res.error,
          `anon must NOT be able to call ${fn} for an arbitrary org — SECURITY ` +
            `DEFINER bypasses RLS, so a null error here means the membership guard ` +
            `is missing and this is a live cross-tenant read primitive.`,
        ).not.toBeNull();
        expect(
          res.error?.code,
          `expected 42501 insufficient_privilege from ${fn}`,
        ).toBe("42501");
      });
    }

    it("service_role can still call next_po_number (guard bypassed by role claim)", async () => {
      const res = await rpcAs(serviceClient(), "next_po_number", {
        target_org: RANDOM_ORG,
      });
      expect(
        res.error,
        "service_role MUST retain access — the app allocates document numbers as " +
          "service_role. The guard checks auth.role()='service_role' (the JWT claim), " +
          "so this call must succeed.",
      ).toBeNull();
      expect(
        typeof res.data,
        "next_po_number should return a text number for service_role",
      ).toBe("string");
    });

    it("service_role can still call cis_statement_ledger_fingerprint", async () => {
      const res = await rpcAs(serviceClient(), "cis_statement_ledger_fingerprint", {
        p_org_id: RANDOM_ORG,
        p_supplier_id: RANDOM_UUID,
        p_tax_month_end: PROBE_MONTH,
      });
      expect(
        res.error,
        "service_role MUST retain access to the fingerprint (stored at statement " +
          "issue). The guard checks the service_role JWT claim, so this must succeed.",
      ).toBeNull();
      expect(
        typeof res.data,
        "cis_statement_ledger_fingerprint should return a hex digest string",
      ).toBe("string");
    });
  },
);

/**
 * EFFECT verification for the two derived-state helpers.
 *
 * Unlike the six number fns (which return a value for any org, so service_role
 * with a random org proves the bypass), these run an EXISTENCE check AFTER the
 * guard — so member-success must be proven against a REAL seeded (org, member,
 * PO, material request). anon is denied 42501 by the guard BEFORE the existence
 * check even for the real org (anon's current_org_ids() is empty); a member of
 * the org passes the guard and gets a derived status string.
 */
type InsertChain = {
  insert: (v: unknown) => {
    select: (c: string) => {
      single: () => Promise<{
        data: Record<string, unknown> | null;
        error: { message: string } | null;
      }>;
    };
  };
  delete: () => {
    eq: (k: string, v: unknown) => Promise<{ error: { message: string } | null }>;
  };
};
function table(
  client: ReturnType<typeof serviceClient>,
  name: string,
): InsertChain {
  return (client as unknown as { from: (t: string) => InsertChain }).from(name);
}

describeIntegration(
  "SECURITY DEFINER org-RPC membership guard · effect (state helpers: anon denied, member allowed)",
  () => {
    const T = `secdef-state-${Date.now()}`;
    let orgId = "";
    let userId = "";
    let token = "";
    let poId = "";
    let reqId = "";

    beforeAll(async () => {
      const org = await table(serviceClient(), "organizations")
        .insert({ name: `Secdef State ${T}`, slug: T })
        .select("id")
        .single();
      if (org.error) throw new Error(org.error.message);
      orgId = String(org.data?.id ?? "");

      const email = `${T}@x.test`;
      const created = await serviceClient().auth.admin.createUser({
        email,
        password: `Pw-${T}`,
        email_confirm: true,
      });
      if (created.error) throw new Error(created.error.message);
      userId = created.data.user?.id ?? "";
      // memberships.user_id references public.users — mirror the auth user in.
      const mirrored = await table(serviceClient(), "users")
        .insert({ id: userId, email, full_name: `Secdef ${T}` })
        .select("id")
        .single();
      if (mirrored.error) throw new Error(mirrored.error.message);
      const mem = await table(serviceClient(), "memberships")
        .insert({ user_id: userId, org_id: orgId, role: "owner" })
        .select("user_id")
        .single();
      if (mem.error) throw new Error(mem.error.message);
      const s = await anonClient().auth.signInWithPassword({
        email,
        password: `Pw-${T}`,
      });
      if (s.error) throw new Error(s.error.message);
      token = s.data.session?.access_token ?? "";
      expect(token, "test setup: member token").not.toBe("");

      const po = await table(serviceClient(), "purchase_orders")
        .insert({ org_id: orgId, number: "PO-0001", subtotal: 100, vat_total: 20 })
        .select("id")
        .single();
      if (po.error) throw new Error(po.error.message);
      poId = String(po.data?.id ?? "");

      const req = await table(serviceClient(), "material_requests")
        .insert({
          org_id: orgId,
          number: "MR-0001",
          priority: "normal",
          requested_by: userId,
          created_by: userId,
        })
        .select("id")
        .single();
      if (req.error) throw new Error(req.error.message);
      reqId = String(req.data?.id ?? "");
    });

    afterAll(async () => {
      if (userId) await serviceClient().auth.admin.deleteUser(userId);
      if (orgId) await table(serviceClient(), "organizations").delete().eq("id", orgId);
    });

    it("purchase_order_receipt_state: anon DENIED 42501, member ALLOWED", async () => {
      const anon = await rpcAs(anonClient(), "purchase_order_receipt_state", {
        p_po_id: poId,
        p_org_id: orgId,
      });
      expect(
        anon.error,
        "anon must be denied — the membership check no longer gates on auth.uid()",
      ).not.toBeNull();
      expect(anon.error?.code, "expected 42501").toBe("42501");

      const mem = await rpcAs(userClient(token), "purchase_order_receipt_state", {
        p_po_id: poId,
        p_org_id: orgId,
      });
      expect(mem.error, mem.error?.message).toBeNull();
      expect(typeof mem.data, "member should get a receipt-state string").toBe(
        "string",
      );
    });

    it("material_request_fulfilment_state: anon DENIED 42501, member ALLOWED", async () => {
      const anon = await rpcAs(anonClient(), "material_request_fulfilment_state", {
        p_request_id: reqId,
        p_org_id: orgId,
        p_fulfilled: [],
      });
      expect(
        anon.error,
        "anon must be denied — the membership check no longer gates on auth.uid()",
      ).not.toBeNull();
      expect(anon.error?.code, "expected 42501").toBe("42501");

      const mem = await rpcAs(
        userClient(token),
        "material_request_fulfilment_state",
        { p_request_id: reqId, p_org_id: orgId, p_fulfilled: [] },
      );
      expect(mem.error, mem.error?.message).toBeNull();
      expect(typeof mem.data, "member should get a fulfilment-state string").toBe(
        "string",
      );
    });
  },
);

/**
 * PRIVILEGE LOCKDOWN GUARD for public._introspect_secdef_org_rpcs().
 *
 * The introspection RPC lists the tenant-isolation attack surface, so — exactly
 * like _introspect_bare_cross_tenant_fks (20261113/20261114) — it must be
 * service_role only. Its migration does `revoke all ... from public` +
 * `grant ... to service_role`, but Supabase default privileges also grant
 * role-specific EXECUTE to anon + authenticated at CREATE time, which
 * `revoke ... from public` does NOT strip. This pins the boundary via the
 * authoritative execution path so a future CREATE OR REPLACE cannot silently
 * re-expose it.
 */
describeIntegration(
  "_introspect_secdef_org_rpcs · privilege lockdown (service_role only)",
  () => {
    let userToken = "";
    let userId = "";
    const T = `secdef-introspect-acl-${Date.now()}`;

    beforeAll(async () => {
      const email = `${T}@x.test`;
      const created = await serviceClient().auth.admin.createUser({
        email,
        password: `Pw-${T}`,
        email_confirm: true,
      });
      if (created.error) throw new Error(created.error.message);
      userId = created.data.user?.id ?? "";
      const s = await anonClient().auth.signInWithPassword({
        email,
        password: `Pw-${T}`,
      });
      if (s.error) throw new Error(s.error.message);
      userToken = s.data.session?.access_token ?? "";
      expect(userToken, "test setup: authenticated token").not.toBe("");
    });

    afterAll(async () => {
      if (userId) await serviceClient().auth.admin.deleteUser(userId);
    });

    it("anon is DENIED the introspection RPC", async () => {
      const res = await rpcAs(anonClient(), "_introspect_secdef_org_rpcs", {});
      expect(
        res.error,
        "anon must NOT execute the introspection RPC — it discloses the " +
          "secdef org-RPC attack surface.",
      ).not.toBeNull();
      expect(res.error?.code, "expected 42501").toBe("42501");
    });

    it("service_role is ALLOWED the introspection RPC", async () => {
      const res = await rpcAs(serviceClient(), "_introspect_secdef_org_rpcs", {});
      expect(res.error, "service_role must retain EXECUTE (the guard test calls it)").toBeNull();
      expect(
        (res.data as unknown[])?.length ?? 0,
        "service_role call returned no rows — the RPC or its grant is wrong",
      ).toBeGreaterThan(0);
    });
  },
);
