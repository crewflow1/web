/**
 * CrewFlow API client — GENERATED, DO NOT EDIT.
 * Regenerate with `npx tsx sdks/generate.ts` (source of truth:
 * lib/public-api/openapi.ts). Edits are overwritten and the
 * spec-consistency test (__tests__/openapi-sdk) will fail on drift.
 */

/** An HTTP method used by the API. */
export type HttpMethod = "get" | "post" | "put" | "patch" | "delete";

/** One operation the API exposes: its method, templated path and scopes. */
export interface OperationDescriptor {
  readonly method: HttpMethod;
  readonly path: string;
  readonly scopes: readonly string[];
}

/** Every operation, keyed by operationId — the typed path map the client drives. */
export const OPERATIONS = {
  getMe: { method: "get", path: "/me", scopes: [] },
  getJobs: { method: "get", path: "/jobs", scopes: ["read:jobs"] },
  postJobs: { method: "post", path: "/jobs", scopes: ["write:jobs"] },
  getJobsById: { method: "get", path: "/jobs/{id}", scopes: ["read:jobs"] },
  patchJobsById: { method: "patch", path: "/jobs/{id}", scopes: ["write:jobs"] },
  getCustomers: { method: "get", path: "/customers", scopes: ["read:customers"] },
  postCustomers: { method: "post", path: "/customers", scopes: ["write:customers"] },
  getCustomersById: { method: "get", path: "/customers/{id}", scopes: ["read:customers"] },
  patchCustomersById: { method: "patch", path: "/customers/{id}", scopes: ["write:customers"] },
  postLeads: { method: "post", path: "/leads", scopes: ["write:leads"] },
  getInvoices: { method: "get", path: "/invoices", scopes: ["read:invoices"] },
  getInvoicesById: { method: "get", path: "/invoices/{id}", scopes: ["read:invoices"] },
  patchInvoicesById: { method: "patch", path: "/invoices/{id}", scopes: ["write:invoices"] },
  getQuotes: { method: "get", path: "/quotes", scopes: ["read:quotes"] },
  postQuotes: { method: "post", path: "/quotes", scopes: ["write:quotes"] },
  getTime: { method: "get", path: "/time", scopes: ["read:time"] },
  getStaff: { method: "get", path: "/staff", scopes: ["read:staff"] },
  getExpenses: { method: "get", path: "/expenses", scopes: ["read:expenses"] },
  postExpenses: { method: "post", path: "/expenses", scopes: ["write:expenses"] },
  getExpensesById: { method: "get", path: "/expenses/{id}", scopes: ["read:expenses"] },
  patchExpensesById: { method: "patch", path: "/expenses/{id}", scopes: ["write:expenses"] },
  getMaterials: { method: "get", path: "/materials", scopes: ["read:materials"] },
} as const satisfies Record<string, OperationDescriptor>;

/** The set of operationIds this client implements. */
export type OperationId = keyof typeof OPERATIONS;
