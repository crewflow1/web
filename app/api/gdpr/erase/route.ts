import { NextResponse } from "next/server";
import { requireOrgContext } from "@/server/auth/session";
import { isSuperAdminEmail } from "@/server/auth/superadmin";
import { eraseOrg, gdprErasureEnabled } from "@/server/services/gdpr-erase";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * GDPR RIGHT-TO-ERASURE (Art. 17) — DESTRUCTIVE. HIGHEST SAFETY BAR.
 * ═════════════════════════════════════════════════════════════════════════════
 *
 *   POST /api/gdpr/erase   body: { "confirm": "<org-slug>" }
 *
 * Permanently erases the requesting organisation's personal data: statutory
 * records (financial / tax / payroll / CIS / pension) are ANONYMISED IN PLACE
 * (PII scrubbed, statutory figures kept), everything else is HARD-DELETED, and
 * every org-prefixed storage object is removed. This is the destructive mirror
 * of GET /api/gdpr/export — and unlike export, it CHANGES YOUR ACCOUNT
 * IRREVERSIBLY.
 *
 * ── THREE INDEPENDENT LOCKS, ALL REQUIRED (cannot fire accidentally) ──────────
 *   1. FEATURE FLAG — `FEATURE_GDPR_ERASURE='true'` (server-only env, DEFAULT
 *      OFF). While off this route 503s BEFORE any auth or DB work: the capability
 *      is inert / DARK. The flag is NEVER inlined into a client bundle.
 *   2. OWNER (or SUPER-ADMIN) — not merely an admin. `requireOrgContext()` then
 *      an explicit `role === 'owner'` OR CrewFlow super-admin check. Anyone else
 *      is refused 403. Erasing a whole org is an ownership act.
 *   3. CONFIRMATION TOKEN — the body's `confirm` MUST equal the org's slug. A
 *      missing/mismatched token is refused 400 BEFORE the service runs, and the
 *      DB primitive re-verifies it a second time (belt-and-braces).
 *
 * ── EXECUTION MODEL ──────────────────────────────────────────────────────────
 * The service removes storage bytes via the Storage API, then calls the
 * single-transaction, service_role-only `gdpr_erase_org` primitive (fail-closed
 * + idempotent). The primitive writes the append-only `gdpr_erasure_log`
 * accountability row itself. Response is `private, no-store`.
 *
 * ── SCOPE NOTE ───────────────────────────────────────────────────────────────
 * This erases DATA. Whether to also suspend/close the org shell (login, billing
 * offboarding) is a separate product/policy step and is intentionally NOT done
 * here — the org row is retained to hold the anonymised statutory records for
 * their legal retention window.
 */
export const runtime = "nodejs";

export async function POST(request: Request) {
  // LOCK 1 — feature flag. Fail BEFORE any auth/DB so the capability is fully
  // inert while dark.
  if (!gdprErasureEnabled()) {
    return NextResponse.json(
      { error: "Data erasure is not enabled." },
      { status: 503, headers: { "Cache-Control": "private, no-store" } },
    );
  }

  const { ctx, user } = await requireOrgContext();

  // LOCK 2 — owner or super-admin only.
  const isOwner = ctx.membership.role === "owner";
  const isSuperAdmin = isSuperAdminEmail(user.email);
  if (!isOwner && !isSuperAdmin) {
    return NextResponse.json(
      { error: "Only the organisation owner may erase the organisation's data." },
      { status: 403, headers: { "Cache-Control": "private, no-store" } },
    );
  }

  // LOCK 3 — confirmation token must equal the org slug.
  let confirm = "";
  try {
    const body = (await request.json()) as { confirm?: unknown };
    confirm = typeof body?.confirm === "string" ? body.confirm : "";
  } catch {
    confirm = "";
  }
  if (!confirm || confirm !== ctx.org.slug) {
    return NextResponse.json(
      {
        error:
          "Confirmation required: send { confirm: \"<org-slug>\" } matching this organisation's slug.",
      },
      { status: 400, headers: { "Cache-Control": "private, no-store" } },
    );
  }

  const summary = await eraseOrg({
    orgId: ctx.org.id,
    confirm,
    requestedBy: user.id,
  });

  return NextResponse.json(
    { ok: true, ...summary },
    {
      status: 200,
      headers: {
        "Cache-Control": "private, no-store",
        "X-Gdpr-Erase-Deleted-Rows": String(summary.deletedRows),
        "X-Gdpr-Erase-Anonymised-Rows": String(summary.anonymisedRows),
        "X-Gdpr-Erase-Storage-Objects": String(summary.storageObjectsDeleted),
      },
    },
  );
}
