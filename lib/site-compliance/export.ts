/**
 * Muster export helpers — pure, deterministic serialisation of a MusterRoll into
 * the flat person list the PDF renders and the CSV file. No IO, so the row order
 * and CSV escaping (the bits that must be exactly right on a fire register) are
 * unit-testable. Workers are listed before visitors; within each group the
 * roll's own stable arrival-time order is preserved.
 */

import type { MusterRoll } from "./muster";

export type MusterPerson = {
  name: string;
  kind: "Worker" | "Visitor";
  company: string | null;
  /** HH:MM (UTC) of clock-in / sign-in. */
  onSince: string;
};

function hhmmUTC(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString().slice(11, 16);
}

/** Flatten a roll into the ordered person list (workers first, then visitors). */
export function musterPeople(roll: MusterRoll): MusterPerson[] {
  const workers: MusterPerson[] = roll.workers.map((w) => ({
    name: w.name,
    kind: "Worker",
    company: w.company,
    onSince: hhmmUTC(w.clockedInAt),
  }));
  const visitors: MusterPerson[] = roll.visitors.map((v) => ({
    name: v.name,
    kind: "Visitor",
    company: v.company,
    onSince: hhmmUTC(v.signedInAt),
  }));
  return [...workers, ...visitors];
}

/** RFC-4180 field escape: quote when the value holds a comma, quote or newline. */
function csvField(v: string): string {
  if (/[",\n\r]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
  return v;
}

/**
 * Serialise a roll to CSV. Header row + one row per present person, plus a
 * leading metadata comment-free preamble is deliberately omitted (a clean CSV
 * imports into any spreadsheet). Site/generated stamps ride in the filename.
 */
export function musterToCsv(roll: MusterRoll, meta: { siteName: string; generatedAt: string }): string {
  const rows: string[][] = [["Name", "Type", "Company", "On since (UTC)"]];
  for (const p of musterPeople(roll)) {
    rows.push([p.name, p.kind, p.company ?? "", p.onSince]);
  }
  const body = rows.map((r) => r.map((c) => csvField(c)).join(",")).join("\r\n");
  // A single header comment line as the first CSV row would break parsers; the
  // context instead lives in the download filename (see the route).
  void meta;
  return `${body}\r\n`;
}

/** A filesystem-safe slug for the download filename. */
export function musterFilename(siteName: string, generatedAt: string, ext: "pdf" | "csv"): string {
  const slug = siteName.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "site";
  const stamp = `${generatedAt.slice(0, 10)}-${generatedAt.slice(11, 13)}${generatedAt.slice(14, 16)}`;
  return `muster-${slug}-${stamp}.${ext}`;
}
