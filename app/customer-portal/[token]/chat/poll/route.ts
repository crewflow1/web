import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadCustomerByPortalToken } from "@/app/customer-portal/_helpers";
import { readPortalChatMessages } from "../_chat-reads";

export const runtime = "nodejs";
// A poll must always reflect the latest rows — never a cached snapshot.
export const dynamic = "force-dynamic";

/**
 * MP Phase 8 "Live Chat" — the polling read endpoint.
 *
 *   GET /customer-portal/[token]/chat/poll
 *   GET /customer-portal/[token]/chat/poll?after=<iso-8601>
 *
 * This is how the customer's chat panel tails staff replies: HONEST near-real-
 * time polling (every ~4s, client-side), NOT a websocket, NOT a push stream.
 * Each call returns the customer's chat messages newer than `after`.
 *
 * SECURITY MODEL, in order:
 *   1. TOKEN CHOKEPOINT — the token is validated (regex) then resolved through
 *      the ONE authority (loadCustomerByPortalToken). An unknown / malformed /
 *      expired token gets an empty, non-revealing 404 JSON — it never discloses
 *      whether a customer or thread exists.
 *   2. STRICT SCOPING — the read is pinned to (org_id, customer_id, channel=
 *      'chat') by the shared read layer, on the RLS-bypassing admin client. A
 *      customer can only ever tail their OWN one thread.
 *   3. CUSTOMER-SAFE PROJECTION — rows come back as {id, direction, body,
 *      created_at, auto_generated} only. created_by, provider_id,
 *      failure_reason, to_addr, status and internal notes are never selected and
 *      never returned.
 *   4. PRIVATE — `Cache-Control: private, no-store`; nothing identity-bearing in
 *      the response envelope.
 */

const TOKEN_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const PRIVATE_HEADERS = { "Cache-Control": "private, no-store" } as const;

type Ctx = { params: Promise<{ token: string }> };

export async function GET(request: NextRequest, { params }: Ctx) {
  const { token } = await params;

  if (!TOKEN_RE.test(token)) {
    return NextResponse.json({ error: "Not found" }, { status: 404, headers: PRIVATE_HEADERS });
  }

  const loaded = await loadCustomerByPortalToken(token);
  if (!loaded) {
    return NextResponse.json({ error: "Not found" }, { status: 404, headers: PRIVATE_HEADERS });
  }
  const { customer } = loaded;

  // `after` is an optional ISO cursor; a malformed value is ignored (treated as
  // "from the beginning") rather than erroring the poll.
  const rawAfter = request.nextUrl.searchParams.get("after");
  const after =
    rawAfter && !Number.isNaN(Date.parse(rawAfter)) ? rawAfter : null;

  const admin = createAdminClient();
  // Loud reads: a query failure throws here and surfaces as a 500 (captured by
  // instrumentation), never a silently-empty thread that looks "all caught up".
  const messages = await readPortalChatMessages(admin, {
    orgId: customer.org_id,
    customerId: customer.id,
    after,
  });

  return NextResponse.json({ messages }, { headers: PRIVATE_HEADERS });
}
