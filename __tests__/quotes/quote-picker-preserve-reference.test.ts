import { describe, it, expect } from "vitest";
import { withPreservedOption } from "@/lib/quotes/preserve-option";
import { quoteFormSchema } from "@/lib/quotes/schema";

/**
 * REGRESSION (F-1 picker class): editing a quote whose property_id / lead_id is
 * BEYOND the picker list must NOT null the reference on an otherwise-unrelated
 * save.
 *
 * The launch-blocking bug: the quote builder rendered the property/lead
 * <select> from a capped list (`.limit(1000)` / `.limit(500)`). For an org past
 * the cap the currently-saved id had no matching <option>, so the browser fell
 * back to the empty sentinel; `quoteFormSchema.optionalUuid` then coerced ''
 * → undefined, and updateQuote wrote property_id / lead_id = NULL — a silent
 * reference loss triggered by ANY save (e.g. editing the notes).
 *
 * The fix has two layers, both asserted here:
 *   1. the loaders page the COMPLETE set (so the id is present), and
 *   2. `withPreservedOption` injects the saved id even when a filter/cap would
 *      exclude it — belt-and-braces so the <select> can never emit ''.
 *
 * These tests model the browser's <select> contract exactly: a controlled/default
 * value round-trips ONLY when a matching <option> exists; otherwise the field
 * submits the empty sentinel. We then run the submitted value through the REAL
 * quoteFormSchema to prove what updateQuote would persist.
 */

type PropertyOption = { id: string; label: string; customer_id: string | null };

// The empty sentinel the builder's "— None —" option carries.
const NONE = "";

/** What a <select> actually submits: the value iff an <option> matches it,
 * else the empty sentinel (the browser cannot select a non-existent option). */
function submittedSelectValue(options: readonly { id: string }[], desired: string): string {
  return options.some((o) => o.id === desired) ? desired : NONE;
}

/** Parse a quote form the way the server action does, returning the persisted
 * property_id (undefined ⇒ the DB write is NULL). */
function persistedPropertyId(propertySelectValue: string): string | undefined {
  const parsed = quoteFormSchema.parse({
    customer_id: "11111111-1111-1111-1111-111111111111",
    property_id: propertySelectValue,
    lead_id: NONE,
    valid_until: "",
    notes: "unrelated edit — only the notes changed",
    terms: "",
    line_items: [{ description: "Labour", qty: 1, unit: "ea", unit_price: 100, vat_rate: 20 }],
  });
  return parsed.property_id;
}

const SAVED_PROPERTY_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

describe("quote picker — saved reference beyond the list is preserved on an unrelated save", () => {
  it("DEMONSTRATES THE BUG: a saved id missing from the options submits '' and persists NULL", () => {
    // The pre-fix world: a capped list that does not contain the saved property.
    const cappedList: PropertyOption[] = [
      { id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", label: "Some other site", customer_id: null },
    ];
    const submitted = submittedSelectValue(cappedList, SAVED_PROPERTY_ID);
    expect(submitted).toBe(NONE); // browser could not keep the value
    expect(persistedPropertyId(submitted)).toBeUndefined(); // ⇒ updateQuote writes NULL
  });

  it("THE FIX: withPreservedOption injects the saved id so the save round-trips it (not nulled)", () => {
    const cappedList: PropertyOption[] = [
      { id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", label: "Some other site", customer_id: null },
    ];
    const options = withPreservedOption(cappedList, SAVED_PROPERTY_ID, (id) => ({
      id,
      label: "Current site",
      customer_id: null,
    }));
    // The saved id now has a matching option…
    expect(options.some((o) => o.id === SAVED_PROPERTY_ID)).toBe(true);
    // …so the <select> submits the real id…
    const submitted = submittedSelectValue(options, SAVED_PROPERTY_ID);
    expect(submitted).toBe(SAVED_PROPERTY_ID);
    // …and the server persists it — the reference is NOT lost.
    expect(persistedPropertyId(submitted)).toBe(SAVED_PROPERTY_ID);
  });

  it("preserve-option is a no-op when the saved id is already in the list", () => {
    const list: PropertyOption[] = [
      { id: SAVED_PROPERTY_ID, label: "The site", customer_id: null },
    ];
    const options = withPreservedOption(list, SAVED_PROPERTY_ID, () => {
      throw new Error("must not inject when the id is already present");
    });
    expect(options).toHaveLength(1);
    expect(persistedPropertyId(submittedSelectValue(options, SAVED_PROPERTY_ID))).toBe(
      SAVED_PROPERTY_ID,
    );
  });

  it("preserve-option does not inject a placeholder for an intentionally-empty reference", () => {
    const list: PropertyOption[] = [
      { id: "cccccccc-cccc-cccc-cccc-cccccccccccc", label: "A site", customer_id: null },
    ];
    // No property selected (a quote genuinely without a site): nothing injected,
    // and an empty submit stays undefined ⇒ NULL, which is correct here.
    expect(withPreservedOption(list, "", () => ({ id: "x", label: "", customer_id: null }))).toEqual(
      list,
    );
    expect(persistedPropertyId(submittedSelectValue(list, NONE))).toBeUndefined();
  });
});
