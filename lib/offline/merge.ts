/**
 * OFFLINE WRITE — the three-way merge engine.
 *
 * This is the DETERMINISTIC, EXPLAINABLE conflict policy for a queued offline
 * UPDATE. It is a pure module (no I/O, no clock, no randomness) so the policy can
 * be read, unit-tested in isolation, and reasoned about by a reviewer without a
 * database — the merge is a decision about someone's evidence, so it must be
 * inspectable, not buried in a query.
 *
 * ── The three inputs, and why three ──────────────────────────────────────────
 * A queued update knows more than "here are my new values". It knows the values it
 * was EDITING FROM — the row as it stood when the foreman opened the edit form with
 * no signal. That "base" is what lets the merge distinguish two very different
 * situations that a naive last-writer-wins cannot:
 *
 *   base    the field value the offline author started from (rendered into the form)
 *   mine    the field value the offline author submitted
 *   theirs  the field value on the server NOW (an admin may have changed it meanwhile)
 *
 * ── The policy, per field ────────────────────────────────────────────────────
 *   1. I did not change it (mine == base)          -> keep THEIRS. The offline
 *      author never touched this field, so the server's value (possibly a fresh
 *      admin edit) stands. No conflict.
 *   2. Only I changed it (theirs == base)          -> take MINE. This is an OWNED
 *      field: the server never touched it, so the offline author's edit wins.
 *      Last-writer-wins on owned fields — the common, friction-free case.
 *   3. We both changed it, to the SAME value       -> take it. Convergent; no
 *      conflict to surface.
 *   4. We both changed it, to DIFFERENT values     -> DIVERGENT. A genuine conflict:
 *      two people edited the same field to different things while one had no signal.
 *      This is the ONLY case that is surfaced to the user, because it is the only
 *      one where a machine choosing silently would be choosing whose words to lose.
 *
 * A merge is CLEAN when no field is divergent (only cases 1-3 occurred). A clean
 * merge applies automatically. A merge with any divergent field is held as a
 * user-visible conflict in the outbox until the author explicitly resolves it
 * (keep mine, or discard) — see lib/offline/write-queue.ts and the outbox.
 *
 * `preferMineOnConflict` is the "keep mine" resolution: the author has SEEN the
 * divergence and chosen their own value, so case 4 takes mine instead of surfacing.
 * The server still compare-and-swaps against the version the author acknowledged,
 * so a further server change after they looked re-surfaces rather than clobbers.
 *
 * ── Equality is by MEANING, not representation ────────────────────────────────
 * "" (an emptied form field), null (an absent DB column) and undefined (an optional
 * the schema dropped) are the SAME state — "nothing recorded here" — so they must
 * compare equal, or clearing a field the author never meaningfully touched would
 * read as a change and manufacture phantom conflicts. Numbers and other scalars
 * compare by value; the number 0 is a real value, never "absent".
 */

export type MergeFieldConflict = {
  field: string;
  /** The value the offline author started editing from. */
  base: unknown;
  /** The value the offline author submitted. */
  mine: unknown;
  /** The value on the server now. */
  theirs: unknown;
};

export type ThreeWayMergeResult = {
  /** true when no field diverged — the merge may be applied without asking. */
  clean: boolean;
  /**
   * The value chosen for every field. ALWAYS either `theirs` (trusted, from the DB)
   * or `mine` (validated, from the queued payload) — never a base-only value and
   * never anything synthesised. That property is what keeps an untrusted `base`
   * unable to influence WHAT is written, only the CHOICE between two trusted sources.
   */
  merged: Record<string, unknown>;
  /** The divergent fields (case 4). Empty when `clean`. */
  conflicts: MergeFieldConflict[];
};

/**
 * Canonicalise a value for comparison. null / undefined / "" (and whitespace-only
 * strings) all collapse to null — "nothing recorded". Strings are trimmed. Every
 * other type is returned unchanged so 0, false and objects keep their identity.
 */
export function normalizeField(v: unknown): unknown {
  if (v === undefined || v === null) return null;
  if (typeof v === "string") {
    const t = v.trim();
    return t === "" ? null : t;
  }
  return v;
}

/** Meaning-equality (see normalizeField). Objects/arrays compare structurally. */
export function fieldsEqual(a: unknown, b: unknown): boolean {
  const na = normalizeField(a);
  const nb = normalizeField(b);
  if (na === null || nb === null) return na === nb;
  const ta = typeof na;
  if (ta !== typeof nb) return false;
  if (ta === "object") {
    try {
      return JSON.stringify(na) === JSON.stringify(nb);
    } catch {
      return false;
    }
  }
  return na === nb;
}

/**
 * The whole policy, over an explicit field list. `fields` is the set of columns an
 * offline edit is allowed to touch for this entity — passing it explicitly (rather
 * than iterating whatever keys happen to be present) means an attacker cannot widen
 * the merge to a field the entity never exposes by stuffing an extra key into a
 * payload map.
 */
export function threeWayMerge(
  fields: readonly string[],
  base: Record<string, unknown>,
  mine: Record<string, unknown>,
  theirs: Record<string, unknown>,
  opts: { preferMineOnConflict?: boolean } = {},
): ThreeWayMergeResult {
  const merged: Record<string, unknown> = {};
  const conflicts: MergeFieldConflict[] = [];

  for (const f of fields) {
    const b = base[f];
    const m = mine[f];
    const t = theirs[f];
    const mineChanged = !fieldsEqual(m, b);
    const theirsChanged = !fieldsEqual(t, b);

    if (!mineChanged) {
      merged[f] = t; // case 1 — I didn't touch it; keep the server's value
    } else if (!theirsChanged) {
      merged[f] = m; // case 2 — owned field; last-writer-wins, mine
    } else if (fieldsEqual(m, t)) {
      merged[f] = m; // case 3 — convergent
    } else {
      // case 4 — divergent
      conflicts.push({ field: f, base: b, mine: m, theirs: t });
      merged[f] = opts.preferMineOnConflict ? m : t;
    }
  }

  return { clean: conflicts.length === 0, merged, conflicts };
}
