import { describe, it, expect } from "vitest";
import { withPreservedOption } from "@/lib/quotes/preserve-option";

/**
 * REGRESSION (F-1 picker-completion class): editing a job/lead whose assignee is
 * BEYOND the staff picker list must NOT null `assigned_to` on an otherwise
 * unrelated save.
 *
 * The launch-blocking bug: jobs/_form.tsx and leads/_form.tsx rendered the
 * assignee <select defaultValue={savedAssignee}> from `listStaffForOrg` /
 * `listStaffForLead`, which read `memberships` with a bare `.limit(500)` (NOT
 * fetchAllRows, unlike the customer siblings in the same files). For an org past
 * the cap the currently-saved assignee had no matching <option>, so the browser
 * fell back to the empty `— Unassigned —` sentinel; updateJob/updateLead then
 * wrote `assigned_to: submitted ?? null` = NULL — a silent reassignment-to-none
 * triggered by ANY save (e.g. editing the notes).
 *
 * The fix has two layers, both asserted here:
 *   1. the readers page the COMPLETE membership set (so the id is present), and
 *   2. `withPreservedOption` injects the saved assignee even when a cap/filter
 *      would exclude it — belt-and-braces so the <select> can never emit ''.
 *
 * These model the browser's <select> contract exactly: a defaultValue round-trips
 * ONLY when a matching <option> exists; otherwise the field submits '' and the
 * server coerces it to null.
 */

type StaffOption = { id: string; full_name: string | null; email: string };

const SAVED_ASSIGNEE = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

/** What a <select> submits: the value iff a matching <option> exists, else ''. */
function submittedSelectValue(options: readonly { id: string }[], desired: string): string {
  return options.some((o) => o.id === desired) ? desired : "";
}

/** What updateJob/updateLead persist: `assigned_to ?? null` from the submitted
 * <select> value (empty string ⇒ null). */
function persistedAssignedTo(submitted: string): string | null {
  return submitted ? submitted : null;
}

describe("assignee picker — a saved assignee beyond the staff list is preserved on an unrelated save", () => {
  it("DEMONSTRATES THE BUG: a saved assignee missing from the options submits '' and persists NULL", () => {
    const cappedStaff: StaffOption[] = [
      { id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", full_name: "Someone Else", email: "x@y.z" },
    ];
    const submitted = submittedSelectValue(cappedStaff, SAVED_ASSIGNEE);
    expect(submitted).toBe(""); // browser could not keep the value
    expect(persistedAssignedTo(submitted)).toBeNull(); // ⇒ assignment silently lost
  });

  it("THE FIX: withPreservedOption injects the saved assignee so the save round-trips it", () => {
    const cappedStaff: StaffOption[] = [
      { id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", full_name: "Someone Else", email: "x@y.z" },
    ];
    const options = withPreservedOption(cappedStaff, SAVED_ASSIGNEE, (id) => ({
      id,
      full_name: "Current assignee",
      email: "",
    }));
    expect(options.some((o) => o.id === SAVED_ASSIGNEE)).toBe(true);
    const submitted = submittedSelectValue(options, SAVED_ASSIGNEE);
    expect(submitted).toBe(SAVED_ASSIGNEE);
    expect(persistedAssignedTo(submitted)).toBe(SAVED_ASSIGNEE); // NOT nulled
  });

  it("is a no-op when the saved assignee is already in the (paged) list", () => {
    const staff: StaffOption[] = [
      { id: SAVED_ASSIGNEE, full_name: "The Assignee", email: "a@b.c" },
    ];
    const options = withPreservedOption(staff, SAVED_ASSIGNEE, () => {
      throw new Error("must not inject when the id is already present");
    });
    expect(options).toHaveLength(1);
    expect(persistedAssignedTo(submittedSelectValue(options, SAVED_ASSIGNEE))).toBe(SAVED_ASSIGNEE);
  });

  it("does not invent an assignee for a genuinely unassigned job", () => {
    const staff: StaffOption[] = [
      { id: "cccccccc-cccc-cccc-cccc-cccccccccccc", full_name: "A", email: "a@b.c" },
    ];
    // No assignee selected: nothing injected, empty submit stays null (correct).
    expect(withPreservedOption(staff, "", () => ({ id: "x", full_name: "", email: "" }))).toEqual(
      staff,
    );
    expect(persistedAssignedTo(submittedSelectValue(staff, ""))).toBeNull();
  });
});
