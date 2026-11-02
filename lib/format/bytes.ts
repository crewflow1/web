/**
 * Canonical human-readable byte-size formatter for file/document listings.
 *
 * Consolidates three byte-identical-in-spirit copies that had drifted across
 * the documents page, the customer-portal document list, and the job-documents
 * client. Uses the most defensive of the three signatures (accepts
 * null/undefined and non-positive sizes, returning "" so callers can
 * conditionally render a " · size" suffix without their own guard).
 *
 * Binary units (1 KB = 1024 B), matching the previous implementations exactly:
 *   < 1 KB            → "N B"
 *   < 1 MB            → "N KB"  (rounded)
 *   >= 1 MB           → "N.N MB" (one decimal)
 */
export function formatBytes(n: number | null | undefined): string {
  if (!n || n <= 0) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
