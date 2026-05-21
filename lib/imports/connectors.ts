/**
 * Migration OS — third-party connector catalogue.
 *
 * v2 lists the connectors we plan to support natively (Sage, Xero,
 * QuickBooks, Buildertrend). Native API connectors aren't built yet —
 * each connector advertises whether it's "coming_soon" or "available"
 * and points the operator at the file-export upload path in the
 * meantime.
 *
 * Server/client-safe — no imports beyond the type level.
 */

export type ConnectorStatus = "available" | "coming_soon";

export type Connector = {
  /** Stable lower-snake identifier. */
  id: string;
  /** Human-facing brand name. */
  name: string;
  /** Short one-liner: what the operator can do today. */
  blurb: string;
  /** Where the brand is in the build queue. */
  status: ConnectorStatus;
  /** File types we accept from this source today (informational). */
  exportHints: string[];
  /** Optional URL to the vendor's export documentation. */
  docs?: string;
};

export const CONNECTORS: ReadonlyArray<Connector> = [
  {
    id: "sage",
    name: "Sage",
    blurb:
      "Upload a Sage Accounts CSV/Excel export — customers, quotes, invoices.",
    status: "coming_soon",
    exportHints: ["CSV", "Excel"],
    docs: "https://help.sageone.com/en_uk/business/exporting-data.html",
  },
  {
    id: "xero",
    name: "Xero",
    blurb:
      "Upload a Xero export (Contacts, Invoices, Quotes) and we'll map it in.",
    status: "coming_soon",
    exportHints: ["CSV", "Excel"],
    docs: "https://central.xero.com/s/article/Export-data",
  },
  {
    id: "quickbooks",
    name: "QuickBooks",
    blurb: "Upload a QuickBooks Online or Desktop CSV/Excel export.",
    status: "coming_soon",
    exportHints: ["CSV", "Excel", "IIF"],
    docs: "https://quickbooks.intuit.com/learn-support/en-uk/help-article/export-data/export-reports/L9eK8nT4M",
  },
  {
    id: "buildertrend",
    name: "Buildertrend",
    blurb:
      "Upload a Buildertrend customer/job export. Connector planned for v3.",
    status: "coming_soon",
    exportHints: ["CSV"],
  },
] as const;
