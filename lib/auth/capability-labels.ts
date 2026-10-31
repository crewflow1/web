import type { CapAction, CapModule } from "@/lib/auth/capability-rules";

/**
 * Human-readable labels for the owner-facing admin permission editor (R3 UI).
 *
 * Customers never see the technical module/action codes — these labels are the
 * plain-English surface. Keep them aligned with CAP_MODULES / CAP_ACTIONS; the
 * admin-capability-model test pins that every taxonomy key has a label here, so
 * a new module can't ship without a label.
 */

export const MODULE_LABELS: Record<CapModule, string> = {
  jobs: "Jobs & projects",
  quotes: "Quotes & estimates",
  sales: "Sales",
  customers: "Customers",
  leads: "Leads",
  price_book: "Price book",
  invoices: "Invoices",
  payments: "Payments",
  expenses: "Expenses",
  costs: "Costs",
  cis: "CIS (subcontractors)",
  tax: "VAT & tax",
  reports: "Reports & insights",
  cash: "Cash position",
  operations: "Operations",
  assets: "Assets & equipment",
  fleet: "Fleet & vehicles",
  stock: "Stock",
  suppliers: "Suppliers",
  purchase_orders: "Purchase orders",
  sites: "Sites",
  materials: "Materials",
  staff: "Staff & team",
  rota: "Rota & scheduling",
  payroll: "Payroll",
  leave: "Leave & holidays",
  site_safety: "Site safety (RAMS)",
  documents: "Documents",
  inbox: "Inbox (customer messages)",
  settings: "Settings",
  integrations: "Integrations",
  marketplace: "Marketplace",
  ai: "AI features",
};

/**
 * Presentation grouping — owners scan by area of the business, not an
 * alphabetical code list. Every CAP_MODULE appears in exactly one group (pinned
 * by test). Order within groups is deliberate (most-used first).
 */
export const MODULE_GROUPS: ReadonlyArray<{ label: string; modules: CapModule[] }> = [
  { label: "Work", modules: ["jobs", "operations", "sites", "site_safety", "documents"] },
  { label: "Sales & customers", modules: ["leads", "customers", "sales", "quotes", "price_book", "inbox"] },
  { label: "Money", modules: ["invoices", "payments", "expenses", "costs", "cash", "cis", "tax", "reports"] },
  { label: "Supply", modules: ["suppliers", "purchase_orders", "materials", "stock", "assets", "fleet"] },
  { label: "People", modules: ["staff", "rota", "leave", "payroll"] },
  { label: "Admin", modules: ["settings", "integrations", "marketplace", "ai"] },
];

export const ACTION_LABELS: Record<CapAction, string> = {
  view: "View",
  create: "Create",
  edit: "Edit",
  approve: "Approve",
  delete: "Delete",
  export: "Export",
  manage: "Manage",
};

export const ACTION_HINTS: Record<CapAction, string> = {
  view: "See this area and its records",
  create: "Add new records",
  edit: "Change existing records",
  approve: "Approve or sign off",
  delete: "Permanently remove records",
  export: "Download or export data",
  manage: "Full control of this area — includes view, create, edit, approve, delete and export",
};
