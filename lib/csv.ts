/**
 * Shared CSV serialisation — the ONE authoritative owner of how CrewFlow
 * turns a value into a safe CSV field.
 *
 * Every export surface (invoices export, finances export, HQ analytics)
 * previously carried its own byte-identical `csvEscape`. That triplication
 * is now a single function here: one place to reason about quoting, one
 * place to change if the rules ever move. Adding a new export route reuses
 * this — it never copies a fourth escaper.
 *
 * Pure by design — no SDK, no `server-only`, no Node builtins — so any
 * context (route handler, server component, unit test) can import it,
 * exactly like `textCostUsd`. That keeps the escaper unit-testable in
 * isolation and free of a server bundle.
 *
 * Quoting follows the usual CSV convention (RFC 4180 style): a field is
 * wrapped in double quotes when it contains a comma, a newline, a carriage
 * return, or a double quote, and any embedded double quotes are doubled.
 * `null` / `undefined` serialise to an empty field; everything else is
 * stringified via `String`.
 *
 * FORMULA-INJECTION NEUTRALISATION (OWASP CSV injection): a spreadsheet
 * (Excel / Sheets / LibreOffice) interprets a cell that begins with `=`, `+`,
 * `-`, `@`, a tab, or a carriage return as a FORMULA. A lower-privileged user
 * who sets, say, a supplier name to `=HYPERLINK("http://evil","click")` would
 * otherwise have that execute when a higher-privileged admin opens the export.
 * We prepend a neutralising apostrophe to such cells — EXCEPT plain numbers
 * (e.g. a negative amount `-100.00`), which a spreadsheet treats as a value,
 * not a formula, and which MUST survive numerically in financial exports.
 * This is the single chokepoint, so every export surface is protected at once.
 */
const FORMULA_TRIGGER = /^[=+\-@\t\r]/;
const PLAIN_NUMBER = /^-?\d+(?:\.\d+)?$/;

export function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return "";
  let s = String(value);
  if (FORMULA_TRIGGER.test(s) && !PLAIN_NUMBER.test(s.trim())) {
    s = `'${s}`;
  }
  if (s.includes(",") || s.includes("\n") || s.includes("\r") || s.includes('"')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}
