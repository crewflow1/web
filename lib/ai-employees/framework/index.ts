/**
 * AI Employee Framework — public barrel (CEO Directive 007, Phase 1).
 *
 * One import path for the whole "Employee SDK": the six-dimension
 * contracts, the abstract base + factory, and the instantiated registry.
 * Consumers (service layer, HQ pages, tests) import from
 * `@/lib/ai-employees/framework` and nothing deeper.
 */

// 1. The six-dimension type contracts (+ re-exported model vocabulary).
export * from "./dimensions";

// 2. The reusable base abstraction + config-only factory.
export {
  AIEmployee,
  defineEmployee,
  type AIEmployeeDefinition,
  type ProfileBinding,
} from "./base";

// 3. The single-source-of-truth registry + lookups.
export {
  AI_EMPLOYEE_REGISTRY,
  listEmployees,
  getEmployeeBySlug,
  getEmployeesByDepartment,
  employeeSlugs,
} from "./registry";

// 4. The named specialised employees (the directive's required hierarchy:
//    AIEmployee → CEOAI, CTOAI, SalesAI, …). Exported for nominal typing
//    and direct instantiation where a caller wants a specific role.
export { CEOAI } from "./employees/ceo";
export { CTOAI } from "./employees/cto";
export { SalesAI } from "./employees/sales";
export { MarketingAI } from "./employees/marketing";
export { DesignAI } from "./employees/design";
export { QAAI } from "./employees/qa";
export { DocumentationAI } from "./employees/documentation";
export { ProductAI } from "./employees/product";
export { FinanceAI } from "./employees/finance";
export { SupportAI } from "./employees/support";
export { OperationsAI } from "./employees/operations";
