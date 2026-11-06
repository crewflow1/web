import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { DEFAULT_LIMITS, enforce } from "@/lib/security/rate-limit";
import { parsePublicLead } from "@/lib/public-lead/schema";
import { emitNotifications } from "@/server/services/notifications-service";

/**
 * Public per-company lead capture — POST /api/public/lead.
 *
 * UNAUTHENTICATED. A prospective customer submits the `/l/[slug]` enquiry form
 * for ONE construction company; CrewFlow drops the enquiry straight into that
 * company's CRM pipeline (`leads`, source "web", status "new"), where it shows in
 * Sales → Leads. Mirrors the proven /api/demo posture (plain API route,
 * never-throws, always-JSON, IP rate-limited, idempotent).
 *
 * SECURITY:
 *   - org is resolved SERVER-SIDE from the URL slug; the client never supplies
 *     an org id — no cross-tenant write is possible.
 *   - strict schema (no mass-assignment); `status`/`source`/`org_id` are set here.
 *   - honeypot (`website`) → fake 200, no write (a bot learns nothing).
 *   - mandatory consent; IP rate limit; same-contact dedupe within 5 min.
 *   - service-role insert is server-only; no secret ever reaches the client.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FIVE_MIN_MS = 5 * 60 * 1000;

function norm(s: string | null | undefined): string {
  return (s ?? "").trim().toLowerCase();
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  // 5 submissions per IP per 10 minutes (same as the demo funnel).
  const rl = enforce(request, "public_lead", DEFAULT_LIMITS.demo_booking);
  if (rl) return rl as unknown as NextResponse;

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Request body must be valid JSON." }, { status: 400 });
  }

  const parsed = parsePublicLead(payload);
  if (!parsed.ok) {
    return NextResponse.json(
      { ok: false, error: "Please fix the highlighted fields.", fieldErrors: parsed.fieldErrors },
      { status: 400 },
    );
  }

  // Honeypot filled → pretend success, write nothing.
  if (parsed.spam) return NextResponse.json({ ok: true });

  const d = parsed.data;

  let admin: ReturnType<typeof createAdminClient>;
  try {
    admin = createAdminClient();
  } catch (e) {
    console.error("[public-lead] admin init failed", e);
    return NextResponse.json(
      { ok: false, error: "The enquiry service is temporarily unavailable. Please try again shortly." },
      { status: 503 },
    );
  }

  // Resolve the company from the slug — SERVER-SIDE. Unknown slug → 404.
  const orgRes = await admin
    .from("organizations")
    .select("id, name")
    .eq("slug", d.orgSlug)
    .maybeSingle();
  if (orgRes.error) {
    console.error("[public-lead] org lookup failed", orgRes.error.message);
    return NextResponse.json({ ok: false, error: "Could not reach the company right now." }, { status: 503 });
  }
  const org = orgRes.data as { id: string; name: string } | null;
  if (!org) {
    return NextResponse.json({ ok: false, error: "This enquiry link is not valid." }, { status: 404 });
  }

  const email = d.email || null;
  const phone = d.phone || null;

  // Idempotency: absorb a double-submit (same company + same contact) in 5 min.
  try {
    const sinceIso = new Date(Date.now() - FIVE_MIN_MS).toISOString();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const recent = await (admin as any)
      .from("leads")
      .select("id, contact_email, contact_phone")
      .eq("org_id", org.id)
      .eq("source", "web")
      .gte("created_at", sinceIso)
      // Bounded dedup sample: the most recent web leads in the 5-min window.
      // A genuine double-submit lands within seconds; the public form is IP
      // rate-limited (5 / 10 min), so this cap is never reached in practice and
      // dedup-on-sample is the intended behaviour (keeps the read honest for F-1).
      .order("created_at", { ascending: false })
      .limit(200);
    const dup = (recent.data ?? []).some(
      (r: { contact_email: string | null; contact_phone: string | null }) =>
        (email && norm(r.contact_email) === norm(email)) ||
        (phone && norm(r.contact_phone) === norm(phone)),
    );
    if (dup) return NextResponse.json({ ok: true, deduped: true });
  } catch {
    // dedupe is best-effort; never block a genuine enquiry on it.
  }

  const nowIso = new Date().toISOString();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ins = await (admin as any)
    .from("leads")
    .insert({
      org_id: org.id,
      source: "web",
      status: "new",
      contact_name: d.name,
      contact_email: email,
      contact_phone: phone,
      service: d.service || null,
      postcode: d.postcode || null,
      notes: d.message,
      first_contact_at: nowIso,
      last_activity_at: nowIso,
    })
    .select("id")
    .single();

  if (ins.error) {
    console.error("[public-lead] insert failed", ins.error.message);
    return NextResponse.json(
      { ok: false, error: "We couldn't submit your enquiry. Please try again." },
      { status: 500 },
    );
  }

  // Reliable owner notification. Drop the enquiry onto the org's notification
  // bus (in-app bell + email / push / SMS, each per the admin's own channel
  // preference, all best-effort inside emitNotifications). Omitting
  // audience_scope keeps the DB default 'admins' — a lead is commercial, so
  // only owners/admins are alerted, never the whole crew.
  //
  // NO DUPLICATE ALERTS BY CONSTRUCTION: this runs ONLY after a genuine new
  // row is inserted. The dedupe gate above returns early for a same-contact
  // re-submit within 5 min (and the honeypot path returns before any insert),
  // so one enquiry → at most one lead row → exactly one notification.
  const leadId = String((ins.data as { id: string }).id);
  try {
    await emitNotifications([
      {
        org_id: org.id,
        user_id: null,
        audience: "customer",
        type: "lead.web_enquiry",
        category: "system",
        priority: "medium",
        title: `New website enquiry — ${d.name}`,
        body: [d.service || null, d.postcode || null, d.message]
          .filter(Boolean)
          .join(" · ")
          .slice(0, 500),
        action_url: `/leads/${leadId}`,
        source_module: "lead",
        source_id: leadId,
        metadata: { source: "web" },
      },
    ]);
  } catch (e) {
    // emitNotifications is itself best-effort; this guard only covers a
    // synchronous build error. A failed alert must never fail the enquiry.
    console.error("[public-lead] owner notification failed", e);
  }

  return NextResponse.json({ ok: true });
}
