/**
 * CrewFlow API client — GENERATED, DO NOT EDIT.
 * Regenerate with `npx tsx sdks/generate.ts` (source of truth:
 * lib/public-api/openapi.ts). Edits are overwritten and the
 * spec-consistency test (__tests__/openapi-sdk) will fail on drift.
 */

// Component schemas (from components.schemas), in spec order.
export interface Job {
  id?: string | null;
  status?: string | null;
  scheduled_date?: string | null;
  site_postcode?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface JobList {
  data: Job[];
  pagination: {
    page: number;
    per_page: number;
    has_more: boolean;
  };
}

export interface Customer {
  id?: string | null;
  name?: string | null;
  city?: string | null;
  county?: string | null;
  postcode?: string | null;
  country?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface CustomerList {
  data: Customer[];
  pagination: {
    page: number;
    per_page: number;
    has_more: boolean;
  };
}

export interface Invoice {
  id?: string | null;
  number?: string | null;
  status?: string | null;
  amount?: number | null;
  vat_total?: number | null;
  total?: number | null;
  due_date?: string | null;
  sent_at?: string | null;
  paid_at?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface InvoiceList {
  data: Invoice[];
  pagination: {
    page: number;
    per_page: number;
    has_more: boolean;
  };
}

export interface Quote {
  id?: string | null;
  number?: string | null;
  status?: string | null;
  currency?: string | null;
  subtotal?: number | null;
  vat_total?: number | null;
  total?: number | null;
  valid_until?: string | null;
  sent_at?: string | null;
  accepted_at?: string | null;
  declined_at?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface QuoteList {
  data: Quote[];
  pagination: {
    page: number;
    per_page: number;
    has_more: boolean;
  };
}

export interface Lead {
  id?: string | null;
  source?: string | null;
  service?: string | null;
  status?: string | null;
  urgency?: string | null;
  estimated_value?: number | null;
  postcode?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface TimeEntry {
  id?: string | null;
  started_at?: string | null;
  ended_at?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface TimeEntryList {
  data: TimeEntry[];
  pagination: {
    page: number;
    per_page: number;
    has_more: boolean;
  };
}

export interface StaffMember {
  id?: string | null;
  role?: string | null;
  created_at?: string | null;
}

export interface StaffMemberList {
  data: StaffMember[];
  pagination: {
    page: number;
    per_page: number;
    has_more: boolean;
  };
}

export interface Expense {
  id?: string | null;
  amount?: number | null;
  currency?: string | null;
  vat_rate?: number | null;
  vat_total?: number | null;
  category?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface ExpenseList {
  data: Expense[];
  pagination: {
    page: number;
    per_page: number;
    has_more: boolean;
  };
}

export interface MaterialRequest {
  id?: string | null;
  number?: string | null;
  status?: string | null;
  priority?: string | null;
  needed_by?: string | null;
  submitted_at?: string | null;
  decided_at?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface MaterialRequestList {
  data: MaterialRequest[];
  pagination: {
    page: number;
    per_page: number;
    has_more: boolean;
  };
}

export interface CustomerWriteInput {
  name: string;
  email?: string;
  phone?: string;
  address_line1?: string;
  address_line2?: string;
  city?: string;
  county?: string;
  postcode?: string;
  country?: string;
  notes?: string;
}

/** At least one field must be provided. Omitted fields are left unchanged. */
export interface CustomerUpdateInput {
  name?: string;
  email?: string;
  phone?: string;
  address_line1?: string;
  address_line2?: string;
  city?: string;
  county?: string;
  postcode?: string;
  country?: string;
  notes?: string;
}

/** At least one of contact_email or contact_phone is required. */
export interface LeadWriteInput {
  contact_name: string;
  contact_email?: string;
  contact_phone?: string;
  source: "phone" | "web" | "referral" | "walk_in" | "social" | "repeat" | "portal" | "other";
  service?: string;
  urgency?: "low" | "normal" | "high" | "urgent";
  postcode?: string;
  estimated_value?: number;
  notes?: string;
  customer_id?: string;
}

export interface JobWriteInput {
  status?: "new" | "in-progress" | "completed" | "blocked";
  scheduled_date?: string;
  customer_id?: string;
  notes?: string;
  site_address_line1?: string;
  site_address_line2?: string;
  site_city?: string;
  site_county?: string;
  site_postcode?: string;
  site_country?: string;
}

/** At least one field must be provided. Omitted fields are left unchanged. */
export interface JobUpdateInput {
  status?: "new" | "in-progress" | "completed" | "blocked";
  scheduled_date?: string;
  customer_id?: string;
  notes?: string;
  site_address_line1?: string;
  site_address_line2?: string;
  site_city?: string;
  site_county?: string;
  site_postcode?: string;
  site_country?: string;
}

export interface QuoteLineItemInput {
  description: string;
  qty: number;
  unit?: string;
  unit_price: number;
  vat_rate: 0 | 5 | 20;
}

/** Totals (subtotal, vat_total, total) are computed server-side from the line items — never send them. */
export interface QuoteWriteInput {
  customer_id: string;
  property_id?: string;
  lead_id?: string;
  valid_until?: string;
  notes?: string;
  terms?: string;
  line_items: QuoteLineItemInput[];
}

/** Record a cost. vat_total is computed server-side (amount * vat_rate) and can never be sent. Currency is fixed to GBP. */
export interface ExpenseWriteInput {
  amount: number;
  vat_rate?: 0 | 5 | 20;
  category?: string;
  notes?: string;
  job_id?: string;
}

/** At least one field must be provided. Omitted fields are left unchanged. job_id and vat_total are not updatable. */
export interface ExpenseUpdateInput {
  amount?: number;
  vat_rate?: 0 | 5 | 20;
  category?: string;
  notes?: string;
}

/** Update invoice status and metadata. Money columns (amount, vat_total, total, number) are not writable. 'overdue' is derived, not stored, and is rejected. At least one field must be provided. */
export interface InvoiceUpdateInput {
  status?: "draft" | "sent" | "awaiting_payment" | "partially_paid" | "paid";
  due_date?: string;
  notes?: string;
}

// Synthesized response envelopes for operations with inline bodies.
export type GetMeResponse = {
  org_id?: string;
  key_prefix?: string;
  scopes?: string[];
};

export type PostJobsResponse = {
  data?: Job;
};

export type GetJobsByIdResponse = {
  data?: Job;
};

export type PatchJobsByIdResponse = {
  data?: Job;
};

export type PostCustomersResponse = {
  data?: Customer;
};

export type GetCustomersByIdResponse = {
  data?: Customer;
};

export type PatchCustomersByIdResponse = {
  data?: Customer;
};

export type PostLeadsResponse = {
  data?: Lead;
};

export type GetInvoicesByIdResponse = {
  data?: Invoice;
};

export type PatchInvoicesByIdResponse = {
  data?: Invoice;
};

export type PostQuotesResponse = {
  data?: Quote;
};

export type PostExpensesResponse = {
  data?: Expense;
};

export type GetExpensesByIdResponse = {
  data?: Expense;
};

export type PatchExpensesByIdResponse = {
  data?: Expense;
};
