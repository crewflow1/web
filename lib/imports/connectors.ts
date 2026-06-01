/**
 * Migration OS — third-party connector catalogue.
 *
 * Every brand has a working GUIDED flow today: the operator exports CSV/XLSX
 * (or a ZIP of them) from the source tool and uploads it; the import engine
 * detects, maps, validates and commits with one-click rollback. Native API
 * sync is a separate Phase-2 effort, so there are no "coming soon" blockers.
 *
 * Server/client-safe — no imports beyond the type level.
 */

export type ConnectorStatus = "available" | "guided";

export type Connector = {
  /** Stable lower-snake identifier. */
  id: string;
  /** Human-facing brand name. */
  name: string;
  /** Short one-liner: what the operator can do today. */
  blurb: string;
  /** "available" (native) or "guided" (export → upload). */
  status: ConnectorStatus;
  /** File types we accept from this source today (informational). */
  exportHints: string[];
  /** Ordered, copy-ready steps to produce the export. */
  steps: string[];
  /** Optional URL to the vendor's export documentation. */
  docs?: string;
};

export const CONNECTORS: ReadonlyArray<Connector> = [
  {
    id: "sage",
    name: "Sage",
    blurb:
      "Export your Sage Accounts data (customers, quotes, invoices) and upload it here.",
    status: "guided",
    exportHints: ["CSV", "Excel", "ZIP"],
    steps: [
      "In Sage, open Contacts / Sales and choose Export.",
      "Export Customers, Invoices and Quotes as CSV or Excel.",
      "Upload the file(s) here — or zip them together and upload the ZIP.",
    ],
    docs: "https://help.sageone.com/en_uk/business/exporting-data.html",
  },
  {
    id: "xero",
    name: "Xero",
    blurb:
      "Export Contacts, Invoices and Quotes from Xero and upload them — we map them in.",
    status: "guided",
    exportHints: ["CSV", "Excel", "ZIP"],
    steps: [
      "In Xero, go to Contacts → Export, and Business → Invoices/Quotes → Export.",
      "Save each as CSV or Excel.",
      "Upload the file(s) here, or a single ZIP containing them all.",
    ],
    docs: "https://central.xero.com/s/article/Export-data",
  },
  {
    id: "quickbooks",
    name: "QuickBooks",
    blurb:
      "Export customers, invoices and items from QuickBooks and upload them.",
    status: "guided",
    exportHints: ["CSV", "Excel", "ZIP"],
    steps: [
      "In QuickBooks, open Reports → Customer Contact List / Invoice List.",
      "Export each report to CSV or Excel.",
      "Upload the file(s) here, or zip them and upload the ZIP.",
    ],
    docs: "https://quickbooks.intuit.com/learn-support/en-uk/help-article/export-data/export-reports/L9eK8nT4M",
  },
  {
    id: "buildertrend",
    name: "Buildertrend",
    blurb: "Export your Buildertrend customers and jobs and upload them here.",
    status: "guided",
    exportHints: ["CSV", "Excel", "ZIP"],
    steps: [
      "In Buildertrend, open Customers / Jobs and use the Export option.",
      "Save the export as CSV or Excel.",
      "Upload the file(s) here, or a ZIP of multiple exports.",
    ],
  },
] as const;
