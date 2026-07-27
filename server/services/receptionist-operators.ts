import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import type { ReassignmentOperator } from "@/lib/receptionist/conversation-reassignment-view";

// =====================================================================
// THE CONVERSATION WORK REASSIGNMENT SURFACE — SERVER OPERATOR ROSTER READER (CEO Directive #018, R54: CONVERSATION
// WORK REASSIGNMENT SURFACE).
//
// R54's reassignment surface transfers ownership of a held Conversation Worklist item to ANOTHER authorised operator.
// To do that the surface must offer a DESTINATION — the other operators of the SAME organisation the current owner may
// hand the item to. This module is that roster's READ layer: the SINGLE authorised query surface for the organisation's
// authorised operators, projected into the {@link ReassignmentOperator} shape the pure view core consumes.
//
// IT IS READ-ONLY, AND ORGANISATION-SCOPED. It records nothing, decides no reassignment, and names NO write primitive of
// ANY engine: there is provably no execution path here. It SELECTs the org's `memberships` (each joined to its `users`
// row for the display name + email) and maps them through a pure projection. The `org_id` filter is MANDATORY on the
// query, so one organisation can never read another's operators — the destination roster is confined to the viewer's own
// organisation, exactly as every receptionist read is. It never claims, reassigns, releases, dispatches or notifies —
// it only answers "who are the authorised operators of this organisation?".
//
// The reassignment RUNTIME (R52) remains the sole authority over recording a transfer, and its SECURITY DEFINER writer
// independently guards that the source operator actually HOLDS the item; this reader only supplies the candidate
// destinations the surface may offer. Confining the destinations to the org roster makes "transfer to another AUTHORISED
// operator" structural at the surface, and the runtime's ownership guard makes the transfer itself valid.
// =====================================================================

/**
 * The authorised operators of ONE organisation — the destination roster the reassignment surface offers, one
 * {@link ReassignmentOperator} per membership (id + denormalised email + display name). Org-scoped: the `org_id` filter
 * is MANDATORY, so one org can never read another's operators. Rows without a joined user are dropped (a membership must
 * resolve a real operator to be a valid destination).
 *
 * READ-ONLY: it SELECTs the org's memberships and projects them; it records nothing and decides no reassignment. The R52
 * runtime remains authoritative over recording a transfer (and over guarding that the source operator holds the item);
 * this only reads back who the org's operators are.
 */
export async function listOrgOperators(input: {
  org_id: string;
}): Promise<ReassignmentOperator[]> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("memberships")
    .select("user:users ( id, full_name, email )")
    .eq("org_id", input.org_id)
    .limit(500);
  if (error) {
    throw new Error("memberships read failed: " + error.message);
  }
  return (data ?? [])
    .map((row) => row.user)
    .filter((u): u is { id: string; full_name: string | null; email: string } => !!u?.id)
    .map((u) => ({
      operatorId: u.id,
      operatorEmail: u.email,
      operatorName: u.full_name,
    }));
}
