/**
 * Preserve-option helper for reference-picker <select>s (F-1 picker class).
 *
 * THE BUG THIS EXISTS TO KILL. A money/CRM edit form renders an optional
 * reference (a quote's property_id / lead_id, a talk's job_id, …) as a
 * `<select defaultValue={savedId}>` whose <option>s come from a fetched list.
 * If that list does not contain the currently-saved id — because it was
 * truncated at a PostgREST cap, filtered by the selected customer, or filtered
 * to "current" rows only — then NO option matches, the browser silently falls
 * back to the empty `value=''` sentinel, and the next (possibly unrelated) save
 * submits '' → `optionalUuid` coerces it to `undefined` → the server writes the
 * reference as NULL. A valid link is lost with no error and no user intent.
 *
 * `withPreservedOption` guarantees the saved id ALWAYS has a matching option: if
 * it is absent from the list, a placeholder option carrying that exact id is
 * prepended. The browser then keeps the real value, and the save round-trips the
 * same id instead of nulling it. This is defence-in-depth: even when the list is
 * also paged complete, a client-side filter (or a future typeahead/cap) must
 * never be able to drop an out-of-list reference.
 */

/**
 * Return `options` unchanged when `selectedId` is empty or already present;
 * otherwise prepend a placeholder built by `makePreserved(selectedId)` so the
 * saved reference always has a matching <option>.
 */
export function withPreservedOption<T extends { id: string }>(
  options: readonly T[],
  selectedId: string | null | undefined,
  makePreserved: (id: string) => T,
): T[] {
  if (selectedId && !options.some((o) => o.id === selectedId)) {
    return [makePreserved(selectedId), ...options];
  }
  return [...options];
}
