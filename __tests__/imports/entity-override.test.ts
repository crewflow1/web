import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { remapRawToEntity } from "@/lib/imports/detect";

/**
 * Migration OS — sheet-level re-classification (launch-blocker fix,
 * requirements #4 + #5: "add a sheet-level override" and "misclassified rows
 * can be corrected before commit").
 *
 * When a whole sheet is detected as the wrong entity — the customer-as-staff
 * bug being the motivating case — the operator corrects it on the detection
 * screen, before anything is written to live tables. This suite locks down:
 *   (1) the pure correction mechanism (remapRawToEntity) the override reuses —
 *       the SAME path the per-row review flow uses, so mapping can't drift; and
 *   (2) the wiring contract — the server action exists, re-derives via
 *       remapRawToEntity, makes rows commit-ready, is pre-commit-only, and is
 *       plumbed into the wizard with the documented set of target types.
 */

const root = resolve(__dirname, "../..");
const read = (rel: string) => readFileSync(resolve(root, rel), "utf-8");

describe("remapRawToEntity — correcting a misclassified row before commit", () => {
  it("re-maps a name/email/phone raw row to a clean CUSTOMER record", () => {
    // The exact shape that used to be mis-filed as staff. Correcting it to
    // customer must produce a fully-mapped customer the commit step can insert.
    const raw = {
      name: "Acme Ltd",
      email: "info@acme.test",
      phone: "07700900100",
    };
    const remapped = remapRawToEntity(raw, "customer");
    expect(remapped.entity_type).toBe("customer");
    expect(remapped.mapped.name).toBe("Acme Ltd");
    expect(remapped.mapped.email).toBe("info@acme.test");
    expect(remapped.mapped.phone).toBe("07700900100");
  });

  it("re-maps a raw row to STAFF when the operator picks staff (both directions work)", () => {
    const raw = {
      "full name": "Jane Volt",
      email: "jane@x.test",
      "hourly rate": "22.00",
    };
    const remapped = remapRawToEntity(raw, "staff");
    expect(remapped.entity_type).toBe("staff");
    expect(remapped.mapped.full_name).toBe("Jane Volt");
    expect(remapped.mapped.hourly_pay).toBe(22);
  });
});

describe("overrideSheetEntity — server action contract", () => {
  const actions = read("app/(app)/imports/actions.ts");
  const block = actions.slice(
    actions.indexOf("export async function overrideSheetEntity("),
  );

  it("is exported as a server action", () => {
    expect(actions).toMatch(/export async function overrideSheetEntity\(/);
  });

  it("re-derives mapped fields via remapRawToEntity (no bespoke mapping logic)", () => {
    expect(block).toMatch(/remapRawToEntity\(/);
  });

  it("flips re-classified rows to `pending` with verified confidence (clears the commit gate)", () => {
    expect(block).toMatch(/status:\s*"pending"/);
    expect(block).toMatch(/confidence:\s*100/);
  });

  it("only re-classifies an import that is still in `detected` (pre-commit guard)", () => {
    expect(block).toMatch(/status !== "detected"/);
  });
});

describe("wizard wiring — the override control is plumbed into the detection screen", () => {
  const page = read("app/(app)/imports/[id]/page.tsx");

  it("imports and binds the overrideSheetEntity action per detected entity", () => {
    expect(page).toMatch(/overrideSheetEntity/);
    expect(page).toMatch(
      /action=\{overrideSheetEntity\.bind\(null, imp\.id, entity\)\}/,
    );
  });

  it("offers the documented target types, including Expense (→ cost)", () => {
    // Requirement #4: Customer, Staff, Job, Quote, Invoice, Supplier, Expense,
    // Payment. "Expense" is the human-facing label for the `cost` entity.
    for (const label of [
      "Customer",
      "Staff",
      "Job",
      "Quote",
      "Invoice",
      "Supplier",
      "Expense",
      "Payment",
    ]) {
      expect(page).toContain(`label: "${label}"`);
    }
    expect(page).toContain(`value: "cost", label: "Expense"`);
  });
});
