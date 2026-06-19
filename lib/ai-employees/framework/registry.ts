/**
 * AI Employee registry — the single source of truth for the workforce
 * (CEO Directive 007, Phase 1).
 *
 * Every specialised employee is instantiated exactly once here and
 * exposed through one immutable, deterministically-ordered list. The
 * roster is "config, not code": adding a future employee means writing
 * one definition file and adding one line below — never another system.
 *
 * PURE: no Supabase / server-only imports. The registry is just the
 * composed SDK; the service layer binds live data onto it via
 * `employee.profile({ row, stats })`.
 */

import type { Department } from "./dimensions";
import type { AIEmployee } from "./base";
import { CEOAI } from "./employees/ceo";
import { CTOAI } from "./employees/cto";
import { SalesAI } from "./employees/sales";
import { MarketingAI } from "./employees/marketing";
import { DesignAI } from "./employees/design";
import { QAAI } from "./employees/qa";
import { DocumentationAI } from "./employees/documentation";
import { ProductAI } from "./employees/product";
import { FinanceAI } from "./employees/finance";
import { SupportAI } from "./employees/support";
import { OperationsAI } from "./employees/operations";

/**
 * The instantiated workforce, sorted by `sortOrder` so the roster
 * renders deterministically (mirrors `ai_employees.sort_order`). Frozen
 * so no consumer can mutate the shared registry.
 */
export const AI_EMPLOYEE_REGISTRY: ReadonlyArray<AIEmployee> = Object.freeze(
  [
    new CEOAI(),
    new CTOAI(),
    new SalesAI(),
    new MarketingAI(),
    new DesignAI(),
    new QAAI(),
    new DocumentationAI(),
    new ProductAI(),
    new FinanceAI(),
    new SupportAI(),
    new OperationsAI(),
  ].sort((a, b) => a.sortOrder - b.sortOrder),
);

/** The full roster, in deterministic display order. */
export function listEmployees(): ReadonlyArray<AIEmployee> {
  return AI_EMPLOYEE_REGISTRY;
}

/** Look up one employee by its stable slug, or `undefined`. */
export function getEmployeeBySlug(slug: string): AIEmployee | undefined {
  return AI_EMPLOYEE_REGISTRY.find((e) => e.slug === slug);
}

/** Every employee in a given department, in roster order. */
export function getEmployeesByDepartment(
  department: Department,
): ReadonlyArray<AIEmployee> {
  return AI_EMPLOYEE_REGISTRY.filter((e) => e.department === department);
}

/** Stable list of every slug — handy for tests and reconciliation. */
export function employeeSlugs(): string[] {
  return AI_EMPLOYEE_REGISTRY.map((e) => e.slug);
}
