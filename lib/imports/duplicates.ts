/**
 * Migration OS — duplicate detection.
 *
 * For each entity type, define the signal we use to fingerprint a row,
 * then compare incoming `mapped` payloads against existing rows.
 *
 * Pure: takes mapped-incoming + existing rows; returns suggested merges.
 */

export type DuplicateMatch = {
  target_id: string;
  reason: string;
  score: number; // 0 to 100
};

function norm(s: string | null | undefined): string {
  return (s ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Compare UK-style phone numbers, treating `07700 900 222` and
 * `+44 7700 900 222` as equivalent. Strips non-digits then compares
 * the last 10 digits — robust to +44 / 0 / formatting variations.
 */
function phonesMatch(a: string, b: string): boolean {
  const da = a.replace(/\D/g, "");
  const db = b.replace(/\D/g, "");
  if (!da || !db) return false;
  if (da === db) return true;
  const tailA = da.slice(-10);
  const tailB = db.slice(-10);
  return tailA.length === 10 && tailA === tailB;
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const prev: number[] = new Array(b.length + 1).fill(0).map((_, i) => i);
  const cur: number[] = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(cur[j - 1]! + 1, prev[j]! + 1, prev[j - 1]! + cost);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = cur[j]!;
  }
  return prev[b.length]!;
}

function nameSimilarity(a: string, b: string): number {
  const A = norm(a);
  const B = norm(b);
  if (!A || !B) return 0;
  if (A === B) return 100;
  const d = levenshtein(A, B);
  const maxLen = Math.max(A.length, B.length);
  return Math.max(0, Math.round((1 - d / maxLen) * 100));
}

// ---------------------------------------------------------------------------
// Customer
// ---------------------------------------------------------------------------

export function findCustomerDuplicate(
  incoming: { name?: unknown; email?: unknown; phone?: unknown },
  existing: Array<{ id: string; name: string; email?: string | null; phone?: string | null }>,
): DuplicateMatch | null {
  const inName = String(incoming.name ?? "");
  const inEmail = String(incoming.email ?? "").toLowerCase();
  const inPhone = String(incoming.phone ?? "").replace(/\D/g, "");
  if (!inName && !inEmail && !inPhone) return null;

  let best: DuplicateMatch | null = null;
  for (const c of existing) {
    if (inEmail && c.email && c.email.toLowerCase() === inEmail) {
      return { target_id: c.id, reason: "matching email", score: 100 };
    }
    if (inPhone && c.phone && phonesMatch(c.phone, inPhone)) {
      return { target_id: c.id, reason: "matching phone", score: 95 };
    }
    if (inName) {
      const score = nameSimilarity(inName, c.name);
      if (score >= 85 && (!best || score > best.score)) {
        best = { target_id: c.id, reason: `name match (${score}%)`, score };
      }
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Invoice
// ---------------------------------------------------------------------------

export function findInvoiceDuplicate(
  incoming: { number?: unknown },
  existing: Array<{ id: string; number: string }>,
): DuplicateMatch | null {
  const inNum = String(incoming.number ?? "").trim();
  if (!inNum) return null;
  for (const inv of existing) {
    if (inv.number.trim().toLowerCase() === inNum.toLowerCase()) {
      return { target_id: inv.id, reason: "matching invoice number", score: 100 };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Staff (by email)
// ---------------------------------------------------------------------------

export function findStaffDuplicate(
  incoming: { email?: unknown; full_name?: unknown },
  existing: Array<{ id: string; email: string; full_name: string | null }>,
): DuplicateMatch | null {
  const inEmail = String(incoming.email ?? "").toLowerCase();
  const inName = String(incoming.full_name ?? "");
  if (inEmail) {
    for (const u of existing) {
      if (u.email.toLowerCase() === inEmail) {
        return { target_id: u.id, reason: "matching email", score: 100 };
      }
    }
  }
  if (inName) {
    let best: DuplicateMatch | null = null;
    for (const u of existing) {
      const score = nameSimilarity(inName, u.full_name ?? "");
      if (score >= 90 && (!best || score > best.score)) {
        best = { target_id: u.id, reason: `name match (${score}%)`, score };
      }
    }
    return best;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Lead — by email then phone then name
// ---------------------------------------------------------------------------

export function findLeadDuplicate(
  incoming: { name?: unknown; email?: unknown; phone?: unknown },
  existing: Array<{ id: string; email: string | null; phone: string | null }>,
): DuplicateMatch | null {
  const inEmail = String(incoming.email ?? "").toLowerCase();
  const inPhone = String(incoming.phone ?? "").replace(/\D/g, "");
  if (inEmail) {
    for (const l of existing) {
      if (l.email && l.email.toLowerCase() === inEmail) {
        return { target_id: l.id, reason: "matching email", score: 100 };
      }
    }
  }
  if (inPhone) {
    for (const l of existing) {
      if (l.phone && phonesMatch(l.phone, inPhone)) {
        return { target_id: l.id, reason: "matching phone", score: 90 };
      }
    }
  }
  return null;
}
