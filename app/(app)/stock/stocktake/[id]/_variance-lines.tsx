import { formatQuantity } from "@/lib/stock/movements";
import type { StocktakeLinePosition } from "@/lib/stocktake/schema";

/**
 * The count sheet — expected (frozen), counted, and the derived variance per
 * line. Presentation only; every judgement (variance, state) is decided in
 * lib/stocktake/schema and passed in.
 *
 * THE ACCOUNTING BOUNDARY: quantities only. No value column, because stock has
 * no value in this milestone (D1 undecided).
 */
function VarianceCell({ variance }: { variance: number | null }) {
  if (variance === null) return <span className="text-slate-400">—</span>;
  if (variance === 0) return <span className="text-slate-500">0</span>;
  const body = formatQuantity(Math.abs(variance));
  return (
    <span className={`font-semibold tabular-nums ${variance > 0 ? "text-emerald-700" : "text-amber-700"}`}>
      {variance > 0 ? `+${body}` : `−${body}`}
    </span>
  );
}

export function VarianceLines({
  positions,
  posted,
}: {
  positions: StocktakeLinePosition[];
  posted: boolean;
}) {
  if (positions.length === 0) {
    return <p className="px-4 py-6 text-sm text-slate-500">Nothing to count at this place.</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-sm">
        <thead>
          <tr className="border-b border-slate-100 text-left text-xs uppercase tracking-wide text-slate-500">
            <th className="px-4 py-2 font-medium">Item</th>
            <th className="px-4 py-2 text-right font-medium">Expected</th>
            <th className="px-4 py-2 text-right font-medium">Counted</th>
            <th className="px-4 py-2 text-right font-medium">{posted ? "Posted" : "Variance"}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {positions.map((p) => (
            <tr key={p.id}>
              <td className="px-4 py-2.5">
                <span className="font-medium text-slate-900">{p.name}</span>
                <span className="ml-1 text-xs text-slate-400">{p.unit}</span>
                {p.barcode ? (
                  <span className="ml-2 text-xs text-slate-400 tabular-nums">{p.barcode}</span>
                ) : null}
              </td>
              <td className="px-4 py-2.5 text-right tabular-nums text-slate-600">
                {formatQuantity(p.expected)}
              </td>
              <td className="px-4 py-2.5 text-right tabular-nums text-slate-900">
                {p.counted === null ? <span className="text-slate-400">—</span> : formatQuantity(p.counted)}
              </td>
              <td className="px-4 py-2.5 text-right">
                <VarianceCell variance={posted ? p.postedVariance : p.variance} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
