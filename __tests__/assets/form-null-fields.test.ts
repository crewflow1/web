import { describe, it, expect } from "vitest";
import { createInspectionSchema } from "@/lib/assets/inspection";
import { reportCaseSchema } from "@/lib/assets/maintenance";

/**
 * Regression: FormData.get() returns NULL for a field the form does not render. Both the "new
 * inspection" form (no due date / re-inspection input) and the "report fault" form (no supplier
 * select in a company without suppliers) submitted nulls for optional fields, the schemas rejected
 * them, and the whole action failed for EVERY user ("Please check the … details").
 */
const ASSET = "11111111-1111-4111-8111-111111111111";
const form = (entries: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) fd.set(k, v);
  return fd;
};

describe("asset forms accept the nulls FormData.get() returns for un-rendered optional fields", () => {
  it("new inspection: only title (+ blank kind / notes) is submitted", () => {
    const fd = form({ asset_id: ASSET, title: "Pre-use check", kind: "", notes: "" });
    const parsed = createInspectionSchema.safeParse({
      asset_id: fd.get("asset_id"),
      title: fd.get("title"),
      kind: fd.get("kind"),
      safety_critical: fd.get("safety_critical") ?? false,
      notes: fd.get("notes"),
      due_at: fd.get("due_at"), // null — not in the form
      reinspection_of: fd.get("reinspection_of"), // null — not in the form
    });
    expect(parsed.success, JSON.stringify(parsed.success ? null : parsed.error.issues)).toBe(true);
  });

  it("report fault: no supplier / source-inspection field in the form", () => {
    const fd = form({ asset_id: ASSET, title: "Cracked guard", case_type: "breakdown", priority: "medium", description: "" });
    const parsed = reportCaseSchema.safeParse({
      asset_id: fd.get("asset_id"),
      case_type: fd.get("case_type"),
      priority: fd.get("priority"),
      title: fd.get("title"),
      description: fd.get("description"),
      source_inspection_id: fd.get("source_inspection_id"), // null
      supplier_id: fd.get("supplier_id"), // null
      out_of_service: fd.get("out_of_service") === "on",
      reinspection_required: fd.get("reinspection_required") === "on",
    });
    expect(parsed.success, JSON.stringify(parsed.success ? null : parsed.error.issues)).toBe(true);
  });

  it("a required field is still required (null title is refused)", () => {
    expect(createInspectionSchema.safeParse({ asset_id: ASSET, title: null }).success).toBe(false);
  });
});
