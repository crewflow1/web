import Link from "next/link";
import type { ReportDocument } from "@/lib/reports/documents";

/**
 * Shared server-rendered view for a ReportDocument — the SAME document the PDF
 * and CSV render, so the page can never disagree with its own export. Each
 * section becomes a card with a horizontally-scrollable table (readable on a
 * phone: the table scrolls inside its own container, the page never does).
 */

export function ReportView({ doc }: { doc: ReportDocument }) {
  const key = doc.key;
  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-3">
            <Link
              href="/reports"
              className="text-xs font-medium text-slate-500 hover:text-slate-700"
            >
              ← Reports
            </Link>
          </div>
          <h1 className="mt-1 text-2xl font-bold text-slate-900">{doc.title}</h1>
          <p className="mt-1 max-w-2xl text-sm text-slate-600">{doc.subtitle}</p>
        </div>
        <div className="flex items-center gap-2">
          <a
            href={`/api/reports/${key}/export?format=pdf`}
            className="rounded-md border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-700 shadow-sm hover:bg-slate-50"
            target="_blank"
            rel="noopener noreferrer"
          >
            Export PDF
          </a>
          <a
            href={`/api/reports/${key}/export?format=csv`}
            className="rounded-md border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-700 shadow-sm hover:bg-slate-50"
            target="_blank"
            rel="noopener noreferrer"
          >
            Export CSV
          </a>
        </div>
      </header>

      {doc.sections.map((section, i) => (
        <section
          key={i}
          className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm"
        >
          <h2 className="text-sm font-semibold text-slate-900">{section.title}</h2>
          {section.note ? (
            <p className="mt-0.5 text-xs text-slate-500">{section.note}</p>
          ) : null}

          {section.rows.length === 0 ? (
            <p className="mt-4 text-sm text-slate-500">{section.empty ?? "No data"}</p>
          ) : (
            <div className="mt-4 overflow-x-auto">
              <table className="w-full min-w-[32rem] text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-left">
                    {section.columns.map((c, ci) => (
                      <th
                        key={ci}
                        className={`px-2 py-2 text-xs font-semibold uppercase tracking-wide text-slate-500 ${
                          c.align === "right" ? "text-right" : "text-left"
                        }`}
                      >
                        {c.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {section.rows.map((row, ri) => (
                    <tr key={ri} className="border-b border-slate-100 last:border-0">
                      {row.map((cell, ci) => (
                        <td
                          key={ci}
                          className={`px-2 py-2 text-slate-700 ${
                            cell.align === "right" ? "text-right tabular-nums" : "text-left"
                          }`}
                        >
                          {cell.text}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ))}

      <p className="text-xs text-slate-500">
        Generated {doc.generatedAt.slice(0, 19).replace("T", " ")} UTC. All figures
        are scoped to your current organisation and computed from the same
        authorities as the rest of the app.
      </p>
    </div>
  );
}
