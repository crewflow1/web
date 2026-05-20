/**
 * Shared schema for payment + bank-reconciliation forms.
 * Server/client-safe.
 */

import { z } from "zod";

const optionalString = (max: number) =>
  z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.string().trim().max(max).optional(),
  );

export const PAYMENT_SOURCES = ["manual", "bank_csv"] as const;
export type PaymentSource = (typeof PAYMENT_SOURCES)[number];

export const addPaymentSchema = z.object({
  amount: z.coerce
    .number()
    .positive("Amount must be greater than zero")
    .max(10_000_000),
  paid_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD"),
  reference: optionalString(200),
  notes: optionalString(2000),
});
export type AddPaymentInput = z.infer<typeof addPaymentSchema>;

// Bank reconciliation
export const BANK_MATCH_STATUSES = [
  "unmatched",
  "suggested",
  "confirmed",
  "ignored",
] as const;
export type BankMatchStatus = (typeof BANK_MATCH_STATUSES)[number];

/**
 * Parsed bank CSV row. We accept a permissive shape — banks differ in
 * column ordering — and let the parser normalise on the server side.
 */
export type BankCsvRow = {
  posted_at: string; // YYYY-MM-DD
  amount: number; // positive = incoming
  description: string | null;
  reference: string | null;
};

/**
 * Confidence-scored match between a bank line and an invoice.
 * Pure: no DB calls; tests run against this directly.
 */
export function scoreInvoiceMatch(
  line: { amount: number; description: string | null; reference: string | null; posted_at: string },
  invoice: {
    id: string;
    number: string;
    total: number;
    sent_at: string | null;
    customer_name: string | null;
  },
): number {
  // Only consider incoming money.
  if (line.amount <= 0) return 0;

  let score = 0;
  // Amount match — most important signal.
  const delta = Math.abs(line.amount - invoice.total);
  if (delta < 0.01) score += 60;
  else if (delta < 1) score += 40;
  else if (delta < invoice.total * 0.05) score += 20; // within 5%
  else return 0; // amount totally off → not a match

  // Invoice number in reference / description (substring, case-insensitive).
  const ref = (line.reference ?? "").toLowerCase();
  const desc = (line.description ?? "").toLowerCase();
  const num = invoice.number.toLowerCase();
  if (ref.includes(num) || desc.includes(num)) score += 30;

  // Customer name in description.
  const cname = (invoice.customer_name ?? "").toLowerCase().trim();
  if (cname.length >= 3 && desc.includes(cname)) score += 10;

  // Date proximity to sent_at (within 60 days = small boost).
  if (invoice.sent_at) {
    const sent = new Date(invoice.sent_at).getTime();
    const posted = new Date(line.posted_at).getTime();
    const daysApart = Math.abs(posted - sent) / 86_400_000;
    if (daysApart <= 60) score += 5;
  }

  return Math.min(score, 100);
}

/**
 * Parse a bank CSV — supports the common UK retail/business bank
 * shapes by column-name heuristics. Pure function for testability.
 *
 * Required columns (case-insensitive): date, amount, description.
 * Optional: reference / details / payee.
 *
 * Throws on malformed input — caller catches + surfaces to the operator.
 */
export function parseBankCsv(csvText: string): BankCsvRow[] {
  const lines = csvText.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) throw new Error("CSV looks empty — need a header row + at least one data row");

  const header = parseCsvLine(lines[0]!).map((h) => h.toLowerCase().trim());
  const idx = (names: string[]): number => {
    for (const n of names) {
      const i = header.indexOf(n);
      if (i >= 0) return i;
    }
    return -1;
  };
  const iDate = idx(["date", "transaction date", "posted", "posted at"]);
  const iAmount = idx(["amount", "value", "credit", "money in", "amount (gbp)"]);
  const iDebit = idx(["debit", "money out"]);
  const iDesc = idx(["description", "details", "narrative", "payee"]);
  const iRef = idx(["reference", "ref"]);
  if (iDate < 0) throw new Error("CSV is missing a date column");
  if (iAmount < 0 && iDebit < 0)
    throw new Error("CSV is missing an amount / credit / debit column");

  const out: BankCsvRow[] = [];
  for (let li = 1; li < lines.length; li++) {
    const cells = parseCsvLine(lines[li]!);
    if (cells.length === 0) continue;
    const rawDate = cells[iDate]?.trim() ?? "";
    const posted_at = normaliseDate(rawDate);
    if (!posted_at) continue;
    let amount = 0;
    if (iAmount >= 0) amount = parseNum(cells[iAmount]);
    if (iDebit >= 0) {
      const debit = parseNum(cells[iDebit]);
      if (debit) amount -= debit;
    }
    if (Number.isNaN(amount)) continue;
    out.push({
      posted_at,
      amount: Math.round(amount * 100) / 100,
      description: cells[iDesc]?.trim() || null,
      reference: iRef >= 0 ? cells[iRef]?.trim() || null : null,
    });
  }
  return out;
}

function parseCsvLine(line: string): string[] {
  // Minimal RFC-4180-ish: respects double quotes + doubled-quote escape.
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += c;
      }
    } else {
      if (c === '"') {
        inQuotes = true;
      } else if (c === ",") {
        out.push(cur);
        cur = "";
      } else {
        cur += c;
      }
    }
  }
  out.push(cur);
  return out;
}

function parseNum(s: string | undefined): number {
  if (!s) return 0;
  const n = Number(s.replace(/[£$,\s]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function normaliseDate(s: string): string | null {
  // Accept YYYY-MM-DD, DD/MM/YYYY, DD-MM-YYYY.
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m1 = s.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})$/);
  if (m1) {
    const d = m1[1]!.padStart(2, "0");
    const mo = m1[2]!.padStart(2, "0");
    return `${m1[3]}-${mo}-${d}`;
  }
  return null;
}
