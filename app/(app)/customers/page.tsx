import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getRequestI18n } from "@/server/i18n/request";
import { requireManagementRole } from "@/server/auth/session";
import { EmptyState } from "../_components/empty-state";
import { formatAddressOneLine, customerToAddress } from "@/lib/address";
import {
  PAGE_SIZE,
  parsePage,
  offsetForPage,
  pageWindow,
  customerSearchOr,
} from "@/lib/customers/list";

/**
 * Customers list.
 *
 * Server-component fetch under user JWT — RLS limits the rows to the
 * caller's org automatically. We still resolve org context (via getRequestI18n) so the
 * page redirects to /onboarding if the user has no org yet.
 *
 * Paginated server-side (`.range()` + an EXACT count) so an org with
 * hundreds of customers shows the true total and every row is reachable.
 * The earlier 200-row fetch cap limited BOTH the list and the headline count,
 * so a 598-customer org rendered "200 customers" with rows 201–598 unreachable.
 * Search runs server-side across the whole table (name/email/phone), not just
 * the rows on the current page — a match on row 550 is found from page 1.
 *
 * Renders a card list on mobile (<sm:) and a table on tablet/desktop.
 */

type SP = Promise<{ page?: string; q?: string; type?: string }>;

/** The only two type filters the list honours; anything else = no filter. */
const CUSTOMER_TYPE_FILTERS = ["individual", "business"] as const;
type CustomerTypeFilter = (typeof CUSTOMER_TYPE_FILTERS)[number];

function parseTypeFilter(raw: string | undefined): CustomerTypeFilter | null {
  return CUSTOMER_TYPE_FILTERS.includes(raw as CustomerTypeFilter)
    ? (raw as CustomerTypeFilter)
    : null;
}

export default async function CustomersPage({
  searchParams,
}: {
  searchParams: SP;
}) {
  const { ctx, t } = await getRequestI18n();
  // Sales/customers (carries financial rollups) is owner/admin only (nav
  // ADMIN_ROLES); staff reach customer/site detail through their assigned job.
  requireManagementRole(ctx);
  const sp = await searchParams;
  const page = parsePage(sp.page);
  const offset = offsetForPage(page);
  const term = (sp.q ?? "").trim();
  const typeFilter = parseTypeFilter(sp.type);

  const supabase = await createClient();
  let query = supabase
    .from("customers")
    .select(
      // country is intentionally omitted from the displayed list: it defaults
      // to "United Kingdom" on every row, so including it would just append
      // ", United Kingdom" to every one-line address. Search still spans the
      // street/town/postcode columns (CUSTOMER_SEARCH_COLUMNS) regardless.
      "id, name, email, phone, customer_type, address_line1, address_line2, city, county, postcode, created_at",
      { count: "exact" },
    )
    // ACTIVE-org pin. RLS's `current_org_ids()` admits EVERY org the viewer
    // belongs to, so a dual-org member's address book listed BOTH companies'
    // customers and the exact count paginated over the blend.
    .eq("org_id", ctx.org.id)
    // Secondary `id` sort is a STABLE tiebreaker: a bulk import can insert many
    // rows with identical created_at, and without a deterministic tiebreaker
    // PostgREST may order ties differently between page requests — duplicating
    // or skipping rows across page boundaries. id is unique, so paging is exact.
    .order("created_at", { ascending: false })
    .order("id", { ascending: false });

  if (typeFilter) {
    // Applied BEFORE .range() so the exact count reflects the filtered set.
    query = query.eq("customer_type", typeFilter);
  }

  const orFilter = customerSearchOr(term);
  if (orFilter) {
    // Applied BEFORE .range() ⇒ searches every customer, then paginates the
    // matches. The exact count below reflects matches, not the whole table.
    query = query.or(orFilter);
  }

  const { data: customers, count, error } = await query.range(
    offset,
    offset + PAGE_SIZE - 1,
  );

  if (error) {
    console.error("[customers] list failed", error);
  }
  const rows = customers ?? [];
  const totalCount = count ?? 0;
  const { totalPages, from, to } = pageWindow(totalCount, offset, rows.length);

  // Preserve the active search + type filter across pagination links.
  const baseQuery: Record<string, string> = {
    ...(term ? { q: term } : {}),
    ...(typeFilter ? { type: typeFilter } : {}),
  };

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">{t("customers.title")}</h1>
          <p className="mt-1 text-sm text-slate-600">
            {term
              ? `${totalCount} matching “${term}”`
              : typeFilter === "business"
                ? `${totalCount} ${totalCount === 1 ? "business" : "businesses"}`
                : typeFilter === "individual"
                  ? `${totalCount} individual${totalCount === 1 ? "" : "s"}`
                  : `${totalCount} ${totalCount === 1 ? "customer" : "customers"}`}
          </p>
        </div>
        <Link
          href="/customers/new"
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-slate-800"
        >
          {t("customers.action.new")}
        </Link>
      </header>

      {/* Search runs server-side across ALL customers, not just this page. */}
      <form
        method="GET"
        className="flex flex-wrap items-end gap-3 rounded-lg border border-slate-200 bg-white p-4 shadow-sm"
      >
        <div className="min-w-[12rem] flex-1">
          <label
            htmlFor="customer-search"
            className="block text-xs font-medium text-slate-700"
          >
            Search
          </label>
          <input
            id="customer-search"
            type="search"
            name="q"
            defaultValue={term}
            placeholder="Name, address, postcode, email, or phone"
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm"
          />
        </div>
        <div>
          <label
            htmlFor="customer-type"
            className="block text-xs font-medium text-slate-700"
          >
            Type
          </label>
          <select
            id="customer-type"
            name="type"
            defaultValue={typeFilter ?? ""}
            className="mt-1 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm"
          >
            <option value="">All types</option>
            <option value="individual">Individuals</option>
            <option value="business">Businesses</option>
          </select>
        </div>
        <button
          type="submit"
          className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white"
        >
          Search
        </button>
        {term || typeFilter ? (
          <Link
            href="/customers"
            className="text-sm font-medium text-slate-600 hover:text-slate-900"
          >
            Clear
          </Link>
        ) : null}
      </form>

      {totalCount === 0 && !term ? (
        <div className="rounded-lg border border-slate-200 bg-white shadow-sm">
          <EmptyState
            icon="👥"
            title={t("customers.empty.title")}
            body={t("customers.empty.body")}
            primary={{ href: "/customers/new", label: t("customers.empty.primary") }}
          />
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-lg border border-slate-200 bg-white p-8 text-center text-sm text-slate-600 shadow-sm">
          {term ? (
            <p>No customers match “{term}”.</p>
          ) : (
            <p>No customers on this page.</p>
          )}
          <Link
            href="/customers"
            className="mt-2 inline-block font-medium text-slate-700 underline hover:text-slate-900"
          >
            {term ? "Clear search" : "Back to start"}
          </Link>
        </div>
      ) : (
        <>
          {/* Mobile: stacked card list */}
          <ul className="space-y-2 sm:hidden">
            {rows.map((c) => (
              <li
                key={c.id}
                className="rounded-lg border border-slate-200 bg-white shadow-sm"
              >
                <Link
                  href={`/customers/${c.id}`}
                  className="block px-4 py-3"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="flex items-center gap-2 truncate text-base font-semibold text-slate-900">
                        <span className="truncate">{c.name}</span>
                        {c.customer_type === "business" ? (
                          <span className="shrink-0 rounded-full bg-indigo-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-indigo-800">
                            Business
                          </span>
                        ) : null}
                      </p>
                      {formatAddressOneLine(customerToAddress(c)) ? (
                        <p className="mt-0.5 truncate text-xs text-slate-600">
                          {formatAddressOneLine(customerToAddress(c))}
                        </p>
                      ) : null}
                      {c.email ? (
                        <p className="mt-0.5 truncate text-xs text-slate-600">
                          {c.email}
                        </p>
                      ) : null}
                      {c.phone ? (
                        <p className="mt-0.5 truncate text-xs text-slate-600">
                          {c.phone}
                        </p>
                      ) : null}
                    </div>
                    <span
                      aria-hidden
                      className="shrink-0 self-center text-slate-500"
                    >
                      ›
                    </span>
                  </div>
                </Link>
              </li>
            ))}
          </ul>

          {/* Tablet + desktop: table */}
          <div className="hidden overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm sm:block">
            <table className="min-w-full divide-y divide-slate-200">
              <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-3">Name</th>
                  <th className="px-4 py-3">Address</th>
                  <th className="px-4 py-3">Email</th>
                  <th className="px-4 py-3">Phone</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 bg-white text-sm">
                {rows.map((c) => (
                  <tr key={c.id} className="hover:bg-slate-50">
                    <td className="px-4 py-3 font-medium text-slate-900">
                      <span className="inline-flex items-center gap-2">
                        {c.name}
                        {c.customer_type === "business" ? (
                          <span className="rounded-full bg-indigo-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-indigo-800">
                            Business
                          </span>
                        ) : null}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-slate-600">
                      {formatAddressOneLine(customerToAddress(c)) || "—"}
                    </td>
                    <td className="px-4 py-3 text-slate-600">
                      {c.email ?? "—"}
                    </td>
                    <td className="px-4 py-3 text-slate-600">
                      {c.phone ?? "—"}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Link
                        href={`/customers/${c.id}`}
                        className="text-sm font-medium text-slate-700 hover:text-slate-900"
                      >
                        Edit →
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Pagination — "Showing A–B of N" makes the 200-per-page cap explicit. */}
          <nav className="flex flex-wrap items-center justify-between gap-2 text-sm text-slate-600">
            <span>
              Showing {from}–{to} of {totalCount}
            </span>
            {totalPages > 1 ? (
              <div className="flex items-center gap-2">
                {page > 1 ? (
                  <Link
                    href={{
                      pathname: "/customers",
                      query: { ...baseQuery, page: page - 1 },
                    }}
                    className="rounded border border-slate-300 px-3 py-1.5 hover:bg-slate-100"
                  >
                    ← Previous
                  </Link>
                ) : null}
                <span>
                  Page {page} of {totalPages}
                </span>
                {page < totalPages ? (
                  <Link
                    href={{
                      pathname: "/customers",
                      query: { ...baseQuery, page: page + 1 },
                    }}
                    className="rounded border border-slate-300 px-3 py-1.5 hover:bg-slate-100"
                  >
                    Next →
                  </Link>
                ) : null}
              </div>
            ) : null}
          </nav>
        </>
      )}
    </div>
  );
}
