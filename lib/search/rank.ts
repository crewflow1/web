/**
 * Pure helpers for the global-search palette.
 *
 *  - normaliseQuery   : trim + lowercase
 *  - matchesQuery     : substring + boundary-aware match
 *  - sortHitsByMatch  : prefer exact + prefix matches, then by type priority
 *
 * Kept out of the API route so we can unit-test ranking deterministically.
 */

export type SearchHit = {
  type:
    | "customer"
    | "job"
    | "quote"
    | "invoice"
    | "lead"
    | "staff"
    | "risk_assessment"
    | "permit"
    | "job_document"
    | "snag"
    | "purchase_order"
    | "site_report";
  id: string;
  title: string;
  subtitle: string | null;
  href: string;
};

const TYPE_PRIORITY: Record<SearchHit["type"], number> = {
  customer: 0,
  invoice: 1,
  quote: 2,
  job: 3,
  purchase_order: 4,
  site_report: 5,
  job_document: 6,
  risk_assessment: 7,
  permit: 8,
  snag: 9,
  lead: 10,
  staff: 11,
};

export function normaliseQuery(q: string): string {
  return q.toLowerCase().trim();
}

export function matchesQuery(haystack: string | null, q: string): boolean {
  if (!haystack) return false;
  const h = haystack.toLowerCase();
  const needle = normaliseQuery(q);
  if (needle.length === 0) return false;
  return h.includes(needle);
}

/**
 * 0 = exact match, 1 = prefix match, 2 = substring match, 3 = no match.
 * Lower is better.
 */
export function matchScore(title: string, q: string): number {
  const t = title.toLowerCase();
  const n = normaliseQuery(q);
  if (n.length === 0) return 3;
  if (t === n) return 0;
  if (t.startsWith(n)) return 1;
  if (t.includes(n)) return 2;
  return 3;
}

export function sortHitsByMatch<H extends SearchHit>(hits: H[], q: string): H[] {
  return [...hits].sort((a, b) => {
    const sa = matchScore(a.title, q);
    const sb = matchScore(b.title, q);
    if (sa !== sb) return sa - sb;
    return TYPE_PRIORITY[a.type] - TYPE_PRIORITY[b.type];
  });
}
