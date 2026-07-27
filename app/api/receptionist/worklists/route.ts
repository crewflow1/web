import { NextResponse, type NextRequest } from "next/server";
import { requireOrgContext } from "@/server/auth/session";
import { queryOrgWorklist } from "@/server/services/receptionist-worklist-read-surface";
import {
  parseWorklistQuery,
  WorklistQueryError,
} from "@/lib/receptionist/conversation-worklist-api";

// =====================================================================
// THE CONVERSATION WORKLIST API — HTTP ROUTE HANDLER (CEO Directive #018, R40: CONVERSATION WORKLIST
// API).
//
// R40 establishes the canonical Conversation Worklist API — the single authorised APPLICATION INTERFACE
// for querying Conversation Worklists. Its pure request contract
// (`lib/receptionist/conversation-worklist-api.ts`) translates an untrusted query string into a validated
// {@link WorklistQuery}; its read surface (R39) answers that query over an org's derived worklists. This
// module is the HTTP endpoint that joins them: `GET /api/receptionist/worklists` — authenticate the
// caller, resolve their organisation from the SESSION, parse the query, read a bounded page, return JSON.
//
// IT AUTHENTICATES, THEN SCOPES BY THE SESSION's ORGANISATION — NEVER BY THE REQUEST. Every request is
// gated by `requireOrgContext()`, the single auth + org chokepoint: it redirects an unauthenticated /
// org-less / access-pending caller before any worklist is read. The organisation the read is scoped to is
// taken ONLY from the resolved context (`ctx.org.id`) — the request contract parses NO org identifier, so
// there is no client-supplied org to honour even by accident. Organisation isolation is therefore
// STRUCTURAL: a caller cannot read another organisation's worklist because neither this handler nor its
// contract has the vocabulary to express that request. `requireOrgContext()` runs OUTSIDE the try/catch
// so its redirect propagates to Next intact (a swallowed redirect would surface as a misleading 500).
//
// IT READS WORKLISTS ONLY — IT ASSIGNS, DISPATCHES AND EXECUTES NOTHING. The handler exposes a single
// verb — GET — and its ONLY data path is the R39 read surface (`queryOrgWorklist`): it derives no
// worklist, opens no database client, names no ledger or view, and reaches no operational system. It
// assigns nobody, dispatches nothing, notifies no one, enqueues into nothing, schedules nothing and
// retries nothing (all EXPLICIT R40 non-goals). The Worklist Read Surface remains the authoritative query
// path and the Worklist Engine the authoritative derivation; this endpoint only exposes them over HTTP.
//
// IT NEVER SILENTLY COERCES AN UNSAFE QUERY. A malformed query string ({@link WorklistQueryError} — an
// unknown view, an out-of-range page, a non-boolean flag) is a CLIENT error mapped to a 400 with the
// contract's own message; any other failure is logged and returned as an opaque 500. A well-formed
// request always yields a bounded page — the API never returns an unbounded worklist.
//
// Query parameters (all optional; an absent parameter takes its safe default):
//   • view            one of prioritised | human_review | recovery | escalation  (default: prioritised)
//   • priority        comma-separated coordination priorities (critical | elevated | routine)
//   • mode            comma-separated coordination modes (finalising | remediating | escalating)
//   • category        comma-separated worklist categories (human_review | recovery | escalation)
//   • requires_human  "true" | "false"
//   • conversation_id a single conversation identifier
//   • limit           page size, 1..200                                          (default: 50)
//   • offset          entries to skip, >= 0                                       (default: 0)
// =====================================================================

/**
 * `GET /api/receptionist/worklists` — read a bounded, stably-ordered page of the caller's organisation's
 * Conversation Worklists. Authenticates and resolves the organisation from the SESSION (never the
 * request), parses the query string into a validated {@link WorklistQuery}, and answers it through the
 * R39 read surface. Returns `{ ok: true, view, items, total, limit, offset, has_more }` on success, a 400
 * `{ ok: false, error }` for a malformed query, and an opaque 500 for any other failure. Read-only: it
 * reads worklists and executes nothing.
 */
export async function GET(request: NextRequest) {
  // Auth + org resolution runs OUTSIDE the try so a redirect (unauthenticated / no org / access-pending)
  // propagates to Next intact rather than being swallowed into a 500.
  const { ctx } = await requireOrgContext();

  try {
    const query = parseWorklistQuery(request.nextUrl.searchParams);
    // Org is taken ONLY from the session context — never from the request. The parsed query carries no
    // org, so the read can only ever be scoped to the caller's own organisation.
    const page = await queryOrgWorklist({ org_id: ctx.org.id, ...query });
    return NextResponse.json({ ok: true, ...page });
  } catch (error) {
    if (error instanceof WorklistQueryError) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 400 });
    }
    console.error("[receptionist/worklists] unhandled error", error);
    return NextResponse.json(
      { ok: false, error: "Worklist temporarily unavailable" },
      { status: 500 },
    );
  }
}
