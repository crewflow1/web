/**
 * Neutralise a free-text search term before it is interpolated into a
 * PostgREST `ilike` pattern or an `.or()` filter string.
 *
 * Two classes of character are stripped (replaced with a space, so adjacent
 * words don't fuse):
 *
 *   1. Control characters (`\p{Cc}` — the C0/C1 control codes). These are
 *      never meaningful in a search box and are a source of log-injection and
 *      odd-byte filter bugs. We use the Unicode property class rather than a
 *      literal `\x00-\x1F` range so the regex stays clear of ESLint's
 *      `no-control-regex` rule. Letters/digits in any language are preserved
 *      (important for names like "José" or "Müller").
 *
 *   2. PostgREST structural / wildcard characters (`% _ , ( ) *`). These are
 *      the real injection vector: an unescaped `,` opens a new OR branch in a
 *      `.or()` list, `()` groups sub-filters, and `% _ *` broaden an `ilike`
 *      match. After stripping, the remaining term still matches literally.
 *
 * Whitespace is collapsed and trimmed. Returns "" when nothing searchable is
 * left — callers should treat that as "no filter" (show the unfiltered list)
 * rather than building a filter that matches everything or nothing.
 */
export function sanitizeSearchTerm(term: string | undefined | null): string {
  return (term ?? "")
    .replace(/\p{Cc}/gu, " ")
    .replace(/[%_,()*]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
