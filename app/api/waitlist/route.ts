import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Public waitlist signup endpoint.
 *
 * The `waitlist` table has RLS enabled with no anon policies. Direct anon
 * INSERT against PostgREST is blocked. This handler accepts a JSON payload,
 * validates it, and writes via the service-role client (bypasses RLS).
 *
 * Returns:
 *   200 { ok: true }                — saved
 *   200 { ok: true, duplicate: true } — already on the list
 *   400 { error, issues }            — validation failure
 *   500 { error }                    — unexpected DB error
 */

const schema = z.object({
  email: z.string().email().max(254),
  company_name: z.string().max(200).optional(),
  phone: z.string().max(50).optional(),
  trade: z.string().max(100).optional(),
  employees: z.string().max(50).optional(),
  source: z.string().max(100).optional(),
});

export async function POST(request: NextRequest) {
  const json = await request.json().catch(() => null);
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", issues: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const supabase = createAdminClient();
  const userAgent = request.headers.get("user-agent")?.slice(0, 500) ?? null;

  const { error } = await supabase.from("waitlist").insert({
    ...parsed.data,
    user_agent: userAgent,
  });

  if (error) {
    // Unique-constraint violation = already signed up. Idempotent UX.
    if (error.code === "23505") {
      return NextResponse.json({ ok: true, duplicate: true });
    }
    console.error("[waitlist] insert failed", error);
    return NextResponse.json({ error: "Failed to save" }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
