import { requireOrgContext } from "@/server/auth/session";
import { createClient } from "@/lib/supabase/server";
import { fetchAllRows } from "@/lib/supabase/paginate";
import { reportReadFailure, type SupabaseReadError } from "@/lib/supabase/read-failure";
import { CONTACT_ROLES, type ContactRole } from "@/lib/customers/contacts";
import { CustomerContactsClient, type StaffContact } from "./_contacts-client";

/**
 * Staff customer-contacts section. Owns its ACTIVE-org + customer pinned read
 * (RLS admits every org the caller belongs to, so the org pin is the real
 * scope), reads LOUDLY (a failed read renders an explicit error, never a silent
 * "no contacts"), and pages the complete set (F-1) so a customer with a long
 * contact list never has late rows dropped. Renders the interactive client.
 */

type ContactRow = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  role: string;
  notes: string | null;
};

function toStaffContact(row: ContactRow): StaffContact {
  const role = (CONTACT_ROLES as readonly string[]).includes(row.role)
    ? (row.role as ContactRole)
    : "other";
  return {
    id: row.id,
    name: row.name,
    email: row.email ?? null,
    phone: row.phone ?? null,
    role,
    notes: row.notes ?? null,
  };
}

export async function CustomerContactsSection({ customerId }: { customerId: string }) {
  const { ctx } = await requireOrgContext();
  const supabase = await createClient();

  const { data, error } = await fetchAllRows<ContactRow>((from, to) =>
    supabase
      .from("customer_contacts" as never)
      .select("id, name, email, phone, role, notes" as never)
      .eq("org_id" as never, ctx.org.id as never)
      .eq("customer_id" as never, customerId as never)
      // Stable total order for paging (name, then the unique id tiebreaker).
      // "Primary first" is applied in TS below so it doesn't need a SQL CASE.
      .order("name" as never, { ascending: true })
      .order("id" as never, { ascending: true })
      .range(from, to) as never,
  );

  if (error) {
    reportReadFailure("customer detail: contacts", error as SupabaseReadError);
    return (
      <section
        id="contacts"
        className="rounded-xl border border-red-200 bg-red-50 p-6 shadow-sm"
      >
        <h2 className="text-base font-semibold text-red-800">Contacts</h2>
        <p className="mt-1 text-sm text-red-700">
          Couldn&apos;t load this customer&apos;s contacts. This panel is NOT
          saying there are none — refresh to try again.
        </p>
      </section>
    );
  }

  const contacts = (data ?? [])
    .map(toStaffContact)
    // Primary contact first, everyone else in the read's name order.
    .sort((a, b) =>
      a.role === "primary" ? -1 : b.role === "primary" ? 1 : 0,
    );
  return (
    <CustomerContactsClient customerId={customerId} initialContacts={contacts} />
  );
}
