import { afterAll, beforeAll, expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient } from "../_harness";

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

  // Derived-state read helpers. Authenticated callers are org-checked via
  // current_org_ids(). The anon path is gated behind an existence check that
  // needs BOTH the resource uuid AND its matching org_id (two unguessable
  // uuids), and returns only a derived status string — not a counter high-water
  // or a stable ledger oracle (the six's class). Not enumerable by anon.
  [
    "material_request_fulfilment_state",
    "derived-state read helper: authenticated callers org-checked via current_org_ids(); anon must supply a matching (request_id, org_id) uuid pair to read a single derived status string — not enumerable, no counter/oracle leak.",
  ],
  [
    "purchase_order_receipt_state",
    "derived-state read helper: authenticated callers org-checked via current_org_ids(); anon must supply a matching (po_id, org_id) uuid pair to read a single derived status string — not enumerable, no counter/oracle leak.",
  ],
]);

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

  it("the six fixed functions are guarded and are NOT allowlisted", async () => {
    const rows = await secdefOrgRpcs();
    const byName = new Map(rows.map((r) => [r.proname, r]));
    for (const fn of FIXED_SIX) {
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
