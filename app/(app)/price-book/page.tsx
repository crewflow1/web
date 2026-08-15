import Link from "next/link";
import { requireOrgContext } from "@/server/auth/session";
import { formatPence } from "@/lib/money";
import {
  listPriceBookItems,
  listQuoteTemplates,
} from "@/lib/pricing/queries";
import {
  createPriceBookItem,
  setPriceBookItemActive,
  deletePriceBookItem,
  renameQuoteTemplate,
  deleteQuoteTemplate,
} from "./actions";
import {
  PriceBookItemForm,
  InlineActionButton,
  TemplateRenameForm,
} from "./_forms";

/**
 * /pricing — the estimating price-book / rate-library + saved quote templates.
 *
 * Reads are ORG-PINNED to the active org (ctx.org.id) and paged (F-1) inside the
 * query helpers; RLS is the backstop. Money is stored as integer pence and
 * rendered via formatPence. Every member can maintain the library (the
 * customers/quotes posture); a hard DELETE is admin-only, so a non-admin sees
 * archive/restore instead.
 */

export const dynamic = "force-dynamic";

export default async function PricingPage() {
  const { ctx } = await requireOrgContext();
  const isAdmin = ctx.membership.role === "owner" || ctx.membership.role === "admin";

  const [items, templates] = await Promise.all([
    listPriceBookItems(ctx.org.id, { includeArchived: true }),
    listQuoteTemplates(ctx.org.id),
  ]);

  const active = items.filter((i) => i.active);
  const archived = items.filter((i) => !i.active);

  return (
    <div className="mx-auto max-w-5xl space-y-8">
      <header>
        <h1 className="text-2xl font-bold text-slate-900">Price book</h1>
        <p className="mt-1 text-sm text-slate-600">
          Your curated rate library. Add priced items once, then pick them when
          building a quote — no more typing the same lines from memory.
        </p>
      </header>

      {/* Add item ------------------------------------------------------- */}
      <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-base font-semibold text-slate-900">Add a price-book item</h2>
        <div className="mt-4">
          <PriceBookItemForm
            action={createPriceBookItem}
            submitLabel="Add item"
            pendingLabel="Adding…"
            resetOnSuccess
          />
        </div>
      </section>

      {/* Active items --------------------------------------------------- */}
      <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-base font-semibold text-slate-900">
          Rate library <span className="text-sm font-normal text-slate-500">({active.length} active)</span>
        </h2>
        {active.length === 0 ? (
          <p className="mt-4 text-sm text-slate-500">No active items yet. Add your first above.</p>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-2 py-2">Description</th>
                  <th className="px-2 py-2">Code</th>
                  <th className="px-2 py-2">Category</th>
                  <th className="px-2 py-2">Unit</th>
                  <th className="px-2 py-2 text-right">Unit price</th>
                  <th className="px-2 py-2 text-right">VAT</th>
                  <th className="px-2 py-2 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {active.map((it) => (
                  <tr key={it.id} className="align-middle">
                    <td className="px-2 py-2 font-medium text-slate-900">{it.description}</td>
                    <td className="px-2 py-2 text-slate-600">{it.code || "—"}</td>
                    <td className="px-2 py-2 text-slate-600">{it.category || "—"}</td>
                    <td className="px-2 py-2 text-slate-600">{it.unit}</td>
                    <td className="px-2 py-2 text-right font-medium text-slate-900">{formatPence(it.unit_price)}</td>
                    <td className="px-2 py-2 text-right text-slate-600">{it.vat_rate}%</td>
                    <td className="px-2 py-2 text-right">
                      <div className="flex items-center justify-end gap-1.5">
                        <Link
                          href={`/price-book/${it.id}`}
                          className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
                        >
                          Edit
                        </Link>
                        <InlineActionButton
                          action={setPriceBookItemActive}
                          hidden={{ id: it.id, active: "false" }}
                          label="Archive"
                        />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Archived ------------------------------------------------------- */}
      {archived.length > 0 ? (
        <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="text-base font-semibold text-slate-900">
            Archived <span className="text-sm font-normal text-slate-500">({archived.length})</span>
          </h2>
          <p className="mt-1 text-sm text-slate-600">
            Hidden from the quote picker. Restore an item to offer it again.
          </p>
          <div className="mt-4 overflow-x-auto">
            <table className="min-w-full text-sm">
              <tbody className="divide-y divide-slate-100">
                {archived.map((it) => (
                  <tr key={it.id} className="align-middle">
                    <td className="px-2 py-2 text-slate-700">{it.description}</td>
                    <td className="px-2 py-2 text-right text-slate-600">{formatPence(it.unit_price)}</td>
                    <td className="px-2 py-2 text-right">
                      <div className="flex items-center justify-end gap-1.5">
                        <InlineActionButton
                          action={setPriceBookItemActive}
                          hidden={{ id: it.id, active: "true" }}
                          label="Restore"
                        />
                        {isAdmin ? (
                          <InlineActionButton
                            action={deletePriceBookItem}
                            hidden={{ id: it.id }}
                            label="Delete"
                            confirm="Permanently delete this item? This can't be undone."
                            className="rounded-md border border-red-200 bg-white px-2.5 py-1 text-xs font-medium text-red-700 hover:bg-red-50"
                          />
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {/* Saved quote templates ----------------------------------------- */}
      <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-base font-semibold text-slate-900">
          Saved quote templates <span className="text-sm font-normal text-slate-500">({templates.length})</span>
        </h2>
        <p className="mt-1 text-sm text-slate-600">
          A reusable multi-line scope of works by job type. Save one from any
          quote (open a quote → “Save as template”), then apply it to a new quote.
        </p>
        {templates.length === 0 ? (
          <p className="mt-4 text-sm text-slate-500">
            No templates yet. Build a quote you’ll repeat, then save its lines as a template.
          </p>
        ) : (
          <ul className="mt-4 space-y-4">
            {templates.map((t) => (
              <li key={t.id} className="rounded-lg border border-slate-200 p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="font-medium text-slate-900">{t.name}</p>
                    <p className="text-xs text-slate-500">
                      {t.job_type ? `${t.job_type} · ` : ""}
                      {t.line_count} line{t.line_count === 1 ? "" : "s"}
                    </p>
                  </div>
                  <InlineActionButton
                    action={deleteQuoteTemplate}
                    hidden={{ id: t.id }}
                    label="Delete"
                    confirm={`Delete the template “${t.name}”?`}
                    className="rounded-md border border-red-200 bg-white px-2.5 py-1 text-xs font-medium text-red-700 hover:bg-red-50"
                  />
                </div>
                <div className="mt-3 border-t border-slate-100 pt-3">
                  <TemplateRenameForm
                    action={renameQuoteTemplate.bind(null, t.id)}
                    initial={{ name: t.name, job_type: t.job_type }}
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
