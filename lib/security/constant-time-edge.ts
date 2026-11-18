/**
 * Edge-safe constant-time string equality — the Edge-runtime sibling of
 * `constantTimeEqual` in ./constant-time.ts (which hashes with node:crypto and
 * therefore cannot load in the Edge middleware).
 *
 * The loop always runs over the EXPECTED secret's full length and folds every
 * code-unit difference (plus the length difference) into one accumulator, so the
 * time taken does not depend on how much of the presented value is correct.
 * Null / undefined / empty on either side never matches (an unset secret fails
 * closed). Callers should bound the presented value's length before calling.
 */
export function constantTimeEqualEdge(
  provided: string | null | undefined,
  expected: string | null | undefined,
): boolean {
  if (typeof provided !== "string" || typeof expected !== "string") return false;
  if (provided.length === 0 || expected.length === 0) return false;
  let diff = provided.length ^ expected.length;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ provided.charCodeAt(i % provided.length);
  }
  return diff === 0;
}
