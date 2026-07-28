/**
 * Migration OS — the date an imported row actually happened on.
 *
 * `finances.created_at` and `invoices.created_at` are plain writable
 * timestamptz columns, NOT NULL with `default now()`. The mapper already pulls
 * the source file's own date column into `mapped.created_at` — COST_FIELDS maps
 * "date" / "expense date" / "created", INVOICE_FIELDS maps "invoice date" /
 * "date" / "created" (lib/imports/detect.ts) — but the commit path dropped it
 * on the floor, so every row of a two-year expense history was stamped with the
 * moment the migration ran.
 *
 * That is not a cosmetic loss. `finances.created_at` is what the VAT-quarter
 * figures filter on (app/api/tax/quarterly-pdf/route.ts bounds the quarter with
 * gte/lte on it; app/(app)/tax/page.tsx bounds the tax year the same way), so
 * imported history landed entirely in the CURRENT quarter and every historical
 * quarter read as empty. An operator migrating two years of books to file a VAT
 * return would have filed the wrong numbers.
 *
 * One helper owns the decision, and it distinguishes three cases that the
 * commit path must not collapse into each other:
 *
 *   ABSENT    → no value. The caller omits the key entirely so `default now()`
 *               applies. It must NOT pass an explicit null: the column is NOT
 *               NULL and a null fails the row.
 *   VALID     → an explicit instant, pinned to midnight UTC.
 *   MALFORMED → a row-level error. The file gave a date and we could not read
 *               it, which is not the same as giving none; silently substituting
 *               `now()` would file that cost in the wrong quarter, which is the
 *               exact defect this module exists to fix.
 */

/**
 * The outcome of reading a source row's date.
 *
 * `ok: true` with no `value` is the ABSENT case — deliberately `undefined`
 * rather than `null` so a spread (`...(d.value ? { created_at: d.value } : {})`)
 * leaves the column alone.
 */
export type ImportedDate =
  | { ok: true; value?: string }
  | { ok: false; reason: string };

/**
 * Resolve a mapped `created_at` cell to a value Postgres can store.
 *
 * The mapper normalises dates to a bare `YYYY-MM-DD` (normaliseDate), which is
 * anchored here to midnight UTC EXPLICITLY rather than handed to Postgres as a
 * date-only string. A bare date is resolved against the SESSION TimeZone, so
 * the instant a row lands on would depend on a server setting the import has no
 * control over. That is not theoretical — on this schema, with the session set
 * to Asia/Tokyo:
 *
 *   '2024-04-01'::timestamptz              → 2024-03-31 15:00:00 UTC   (Q1)
 *   '2024-04-01T00:00:00.000Z'::timestamptz → 2024-04-01 00:00:00 UTC  (Q2)
 *
 * so a cost dated the first day of Q2 files itself in Q1 for any session ahead
 * of UTC. Pinning the instant makes quarter placement a function of the file
 * alone.
 *
 * Midnight UTC is also what the quarter bounds compare against — `qStart` is a
 * bare `YYYY-MM-DD` and `qEndExclusive` is `…T23:59:59.999Z` — so a cost dated
 * the first day of a quarter lands inside that quarter rather than adjacent to
 * it.
 */
export function importedCreatedAt(value: unknown): ImportedDate {
  if (value === null || value === undefined) return { ok: true };
  if (typeof value !== "string") {
    return { ok: false, reason: malformed(value) };
  }
  const s = value.trim();
  if (!s) return { ok: true };

  // Date-only — the shape mapRow produces.
  const bare = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (bare) {
    const [, y, m, d] = bare;
    const iso = `${y}-${m}-${d}T00:00:00.000Z`;
    const parsed = new Date(iso);
    // Round-trip guard. normaliseDate's DD/MM/YYYY branch assembles the parts
    // without checking them, so a malformed cell can reach here as "2024-13-45";
    // Date also happily rolls "2024-02-31" forward into March. Comparing the
    // parsed instant back to the digits it came from rejects both.
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== s) {
      return { ok: false, reason: malformed(s) };
    }
    return { ok: true, value: iso };
  }

  // A full timestamp — a source that carried a time, or a value that has been
  // through the database once.
  const t = Date.parse(s);
  if (Number.isNaN(t)) return { ok: false, reason: malformed(s) };
  return { ok: true, value: new Date(t).toISOString() };
}

function malformed(v: unknown): string {
  return (
    `Couldn't read "${String(v)}" as a date. This row would otherwise be filed ` +
    `in the current VAT quarter instead of the one it belongs to. Fix the date ` +
    `for this row and re-import it.`
  );
}
