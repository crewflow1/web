/**
 * CrewFlow API client — GENERATED, DO NOT EDIT.
 * Regenerate with `npx tsx sdks/generate.ts` (source of truth:
 * lib/public-api/openapi.ts). Edits are overwritten and the
 * spec-consistency test (__tests__/openapi-sdk) will fail on drift.
 */

import type {
  GetMeResponse,
  JobList,
  JobWriteInput,
  PostJobsResponse,
  GetJobsByIdResponse,
  JobUpdateInput,
  PatchJobsByIdResponse,
  CustomerList,
  CustomerWriteInput,
  PostCustomersResponse,
  GetCustomersByIdResponse,
  CustomerUpdateInput,
  PatchCustomersByIdResponse,
  LeadWriteInput,
  PostLeadsResponse,
  InvoiceList,
  GetInvoicesByIdResponse,
  InvoiceUpdateInput,
  PatchInvoicesByIdResponse,
  QuoteList,
  QuoteWriteInput,
  PostQuotesResponse,
  TimeEntryList,
  StaffMemberList,
  ExpenseList,
  ExpenseWriteInput,
  PostExpensesResponse,
  GetExpensesByIdResponse,
  ExpenseUpdateInput,
  PatchExpensesByIdResponse,
  MaterialRequestList,
} from "./types.js";
import { OPERATIONS } from "./operations.js";

/** Default production base URL (from the spec's `servers`). */
export const DEFAULT_BASE_URL = "https://app.crewflow.uk/api/v1";

/** Options for constructing a {@link CrewFlowClient}. */
export interface CrewFlowClientOptions {
  /** Your API key, e.g. `crewflow_sk_...`. Sent as `Authorization: Bearer`. */
  apiKey: string;
  /** Override the base URL (defaults to production). */
  baseUrl?: string;
  /** Inject a fetch implementation (defaults to the global `fetch`). */
  fetch?: typeof fetch;
}

/** Per-call options. */
export interface RequestOptions {
  /** Abort signal for cancellation/timeout. */
  signal?: AbortSignal;
}

/** Thrown on any non-2xx response; carries the status and parsed error body. */
export class CrewFlowApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(status: number, body: unknown, message: string) {
    super(message);
    this.name = "CrewFlowApiError";
    this.status = status;
    this.body = body;
  }
}

/**
 * The CrewFlow public API client. One method per OpenAPI operation, each
 * derived from the spec. Bearer-authenticated with your API key; every
 * request is scoped server-side to the key's organisation.
 */
export class CrewFlowClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: CrewFlowClientOptions) {
    if (!options || typeof options.apiKey !== "string" || options.apiKey.length === 0) {
      throw new Error("CrewFlowClient requires an apiKey.");
    }
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    const f = options.fetch ?? globalThis.fetch;
    if (typeof f !== "function") {
      throw new Error("No fetch implementation available; pass options.fetch.");
    }
    this.fetchImpl = f.bind(globalThis);
  }

  /**
   * GET /me — The identity the API key carries.
   */
  getMe(options?: RequestOptions): Promise<GetMeResponse> {
    return this.request<GetMeResponse>(OPERATIONS.getMe.method, `/me`, undefined, undefined, options);
  }

  /**
   * GET /jobs — List jobs.
   * Requires scope: read:jobs.
   */
  getJobs(query?: { page?: number; per_page?: number }, options?: RequestOptions): Promise<JobList> {
    return this.request<JobList>(OPERATIONS.getJobs.method, `/jobs`, query, undefined, options);
  }

  /**
   * POST /jobs — Create a job.
   * Requires scope: write:jobs.
   */
  postJobs(body: JobWriteInput, options?: RequestOptions): Promise<PostJobsResponse> {
    return this.request<PostJobsResponse>(OPERATIONS.postJobs.method, `/jobs`, undefined, body, options);
  }

  /**
   * GET /jobs/{id} — Fetch a single job by id.
   * Requires scope: read:jobs.
   */
  getJobsById(id: string, options?: RequestOptions): Promise<GetJobsByIdResponse> {
    return this.request<GetJobsByIdResponse>(OPERATIONS.getJobsById.method, `/jobs/${encodeURIComponent(id)}`, undefined, undefined, options);
  }

  /**
   * PATCH /jobs/{id} — Update a job.
   * Requires scope: write:jobs.
   */
  patchJobsById(id: string, body: JobUpdateInput, options?: RequestOptions): Promise<PatchJobsByIdResponse> {
    return this.request<PatchJobsByIdResponse>(OPERATIONS.patchJobsById.method, `/jobs/${encodeURIComponent(id)}`, undefined, body, options);
  }

  /**
   * GET /customers — List customers.
   * Requires scope: read:customers.
   */
  getCustomers(query?: { page?: number; per_page?: number }, options?: RequestOptions): Promise<CustomerList> {
    return this.request<CustomerList>(OPERATIONS.getCustomers.method, `/customers`, query, undefined, options);
  }

  /**
   * POST /customers — Create a customer.
   * Requires scope: write:customers.
   */
  postCustomers(body: CustomerWriteInput, options?: RequestOptions): Promise<PostCustomersResponse> {
    return this.request<PostCustomersResponse>(OPERATIONS.postCustomers.method, `/customers`, undefined, body, options);
  }

  /**
   * GET /customers/{id} — Fetch a single customer by id.
   * Requires scope: read:customers.
   */
  getCustomersById(id: string, options?: RequestOptions): Promise<GetCustomersByIdResponse> {
    return this.request<GetCustomersByIdResponse>(OPERATIONS.getCustomersById.method, `/customers/${encodeURIComponent(id)}`, undefined, undefined, options);
  }

  /**
   * PATCH /customers/{id} — Update a customer.
   * Requires scope: write:customers.
   */
  patchCustomersById(id: string, body: CustomerUpdateInput, options?: RequestOptions): Promise<PatchCustomersByIdResponse> {
    return this.request<PatchCustomersByIdResponse>(OPERATIONS.patchCustomersById.method, `/customers/${encodeURIComponent(id)}`, undefined, body, options);
  }

  /**
   * POST /leads — Capture a lead.
   * Requires scope: write:leads.
   */
  postLeads(body: LeadWriteInput, options?: RequestOptions): Promise<PostLeadsResponse> {
    return this.request<PostLeadsResponse>(OPERATIONS.postLeads.method, `/leads`, undefined, body, options);
  }

  /**
   * GET /invoices — List invoices.
   * Requires scope: read:invoices.
   */
  getInvoices(query?: { page?: number; per_page?: number }, options?: RequestOptions): Promise<InvoiceList> {
    return this.request<InvoiceList>(OPERATIONS.getInvoices.method, `/invoices`, query, undefined, options);
  }

  /**
   * GET /invoices/{id} — Fetch a single invoice by id.
   * Requires scope: read:invoices.
   */
  getInvoicesById(id: string, options?: RequestOptions): Promise<GetInvoicesByIdResponse> {
    return this.request<GetInvoicesByIdResponse>(OPERATIONS.getInvoicesById.method, `/invoices/${encodeURIComponent(id)}`, undefined, undefined, options);
  }

  /**
   * PATCH /invoices/{id} — Update an invoice's status and metadata (never its money).
   * Requires scope: write:invoices.
   */
  patchInvoicesById(id: string, body: InvoiceUpdateInput, options?: RequestOptions): Promise<PatchInvoicesByIdResponse> {
    return this.request<PatchInvoicesByIdResponse>(OPERATIONS.patchInvoicesById.method, `/invoices/${encodeURIComponent(id)}`, undefined, body, options);
  }

  /**
   * GET /quotes — List quotes.
   * Requires scope: read:quotes.
   */
  getQuotes(query?: { page?: number; per_page?: number }, options?: RequestOptions): Promise<QuoteList> {
    return this.request<QuoteList>(OPERATIONS.getQuotes.method, `/quotes`, query, undefined, options);
  }

  /**
   * POST /quotes — Create a draft quote.
   * Requires scope: write:quotes.
   */
  postQuotes(body: QuoteWriteInput, options?: RequestOptions): Promise<PostQuotesResponse> {
    return this.request<PostQuotesResponse>(OPERATIONS.postQuotes.method, `/quotes`, undefined, body, options);
  }

  /**
   * GET /time — List time entries.
   * Requires scope: read:time.
   */
  getTime(query?: { page?: number; per_page?: number }, options?: RequestOptions): Promise<TimeEntryList> {
    return this.request<TimeEntryList>(OPERATIONS.getTime.method, `/time`, query, undefined, options);
  }

  /**
   * GET /staff — List staff (role and join date only — no identity).
   * Requires scope: read:staff.
   */
  getStaff(query?: { page?: number; per_page?: number }, options?: RequestOptions): Promise<StaffMemberList> {
    return this.request<StaffMemberList>(OPERATIONS.getStaff.method, `/staff`, query, undefined, options);
  }

  /**
   * GET /expenses — List expenses.
   * Requires scope: read:expenses.
   */
  getExpenses(query?: { page?: number; per_page?: number }, options?: RequestOptions): Promise<ExpenseList> {
    return this.request<ExpenseList>(OPERATIONS.getExpenses.method, `/expenses`, query, undefined, options);
  }

  /**
   * POST /expenses — Record an expense.
   * Requires scope: write:expenses.
   */
  postExpenses(body: ExpenseWriteInput, options?: RequestOptions): Promise<PostExpensesResponse> {
    return this.request<PostExpensesResponse>(OPERATIONS.postExpenses.method, `/expenses`, undefined, body, options);
  }

  /**
   * GET /expenses/{id} — Fetch a single expense by id.
   * Requires scope: read:expenses.
   */
  getExpensesById(id: string, options?: RequestOptions): Promise<GetExpensesByIdResponse> {
    return this.request<GetExpensesByIdResponse>(OPERATIONS.getExpensesById.method, `/expenses/${encodeURIComponent(id)}`, undefined, undefined, options);
  }

  /**
   * PATCH /expenses/{id} — Update an expense.
   * Requires scope: write:expenses.
   */
  patchExpensesById(id: string, body: ExpenseUpdateInput, options?: RequestOptions): Promise<PatchExpensesByIdResponse> {
    return this.request<PatchExpensesByIdResponse>(OPERATIONS.patchExpensesById.method, `/expenses/${encodeURIComponent(id)}`, undefined, body, options);
  }

  /**
   * GET /materials — List material requests.
   * Requires scope: read:materials.
   */
  getMaterials(query?: { page?: number; per_page?: number }, options?: RequestOptions): Promise<MaterialRequestList> {
    return this.request<MaterialRequestList>(OPERATIONS.getMaterials.method, `/materials`, query, undefined, options);
  }

  /** Execute one request, applying auth, query, body and error mapping. */
  private async request<T>(
    method: string,
    path: string,
    query: Record<string, unknown> | undefined,
    body: unknown,
    options: RequestOptions | undefined,
  ): Promise<T> {
    const url = new URL(this.baseUrl + path);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
      }
    }
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.apiKey}`,
      accept: "application/json",
    };
    if (body !== undefined) headers["content-type"] = "application/json";
    const response = await this.fetchImpl(url.toString(), {
      method: method.toUpperCase(),
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: options?.signal,
    });
    const text = await response.text();
    let parsed: unknown = undefined;
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    if (!response.ok) {
      throw new CrewFlowApiError(
        response.status,
        parsed,
        `CrewFlow API ${method.toUpperCase()} ${path} failed with ${response.status}`,
      );
    }
    return parsed as T;
  }
}
