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
 * wrapped in double quotes when it contains a comma, a newline, or a double
 * quote, and any embedded double quotes are doubled. `null` / `undefined`
 * serialise to an empty field; everything else is stringified via `String`.
 */
export function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (s.includes(",") || s.includes("\n") || s.includes('"')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}
