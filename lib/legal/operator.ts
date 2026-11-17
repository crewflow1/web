/**
 * Sole-trader business-name disclosure (Companies Act 2006 Part 41).
 *
 * CrewFlow is a trading name of an individual. Business documents (invoices,
 * receipts, written orders, demands for payment) must show the individual's
 * name and an address for service. Those details are CONFIGURATION, never
 * source: nothing here hard-codes them, and when either is unset the
 * disclosure is `null` and callers render NOTHING (never a placeholder).
 *
 * Server-safe, no secrets, never throws.
 */

export type OperatorDisclosure = { line: string };

function clean(v: string | undefined): string {
  return (v ?? "").replace(/\s+/g, " ").trim();
}

export function operatorDisclosure(): OperatorDisclosure | null {
  try {
    const name = clean(process.env.CREWFLOW_OPERATOR_LEGAL_NAME);
    const address = clean(process.env.CREWFLOW_OPERATOR_SERVICE_ADDRESS);
    if (!name || !address) return null;
    const vat = clean(process.env.CREWFLOW_OPERATOR_VAT_NUMBER);
    const end = /[.!?]$/.test(address) ? "" : ".";
    return {
      line: `CrewFlow is a trading name of ${name}, ${address}${end}${vat ? ` VAT no. ${vat}` : ""}`,
    };
  } catch {
    return null;
  }
}
