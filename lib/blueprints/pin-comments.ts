import { z } from "zod";

/**
 * Blueprint Pin Comments — pure domain (schemas + threading tree builder).
 *
 * A pin can carry a threaded discussion: a flat list of comment rows, each
 * optionally replying to another comment on the SAME pin. This module owns the
 * pure, DOM-free logic (validation + turning the flat rows into a nested tree)
 * so it is unit-testable under vitest's node environment. All tenant/org
 * scoping lives in the DB (RLS + composite FKs) and the service layer — never
 * here.
 */

// ── the comment row shape (what the UI consumes) ─────────────────────────────
export type PinComment = {
  id: string;
  pin_id: string;
  parent_comment_id: string | null;
  body: string;
  author_id: string | null;
  created_at: string;
  /** Joined display name of the author (from users). null when unknown. */
  author_name?: string | null;
};

/** A comment plus its (recursively) nested replies. */
export type PinCommentNode = PinComment & { replies: PinCommentNode[] };

/**
 * Build a reply tree from a flat, chronologically-ordered comment list.
 *
 * Deterministic: siblings keep the input order (which the service supplies as
 * created_at asc, id tiebreak). A reply whose parent is absent from the set
 * (parent deleted, or a foreign/cross-pin id that slipped through) is promoted
 * to a ROOT rather than dropped — a comment must never silently vanish. A
 * parent-chain cycle can never form because the DB only lets a reply point at
 * an EXISTING earlier comment, but the builder is still cycle-safe: each node
 * is placed exactly once by id.
 */
export function buildCommentTree(comments: readonly PinComment[]): PinCommentNode[] {
  const nodes = new Map<string, PinCommentNode>();
  for (const c of comments) nodes.set(c.id, { ...c, replies: [] });

  const roots: PinCommentNode[] = [];
  for (const c of comments) {
    const node = nodes.get(c.id)!;
    const parent = c.parent_comment_id ? nodes.get(c.parent_comment_id) : undefined;
    if (parent && parent.id !== node.id) parent.replies.push(node);
    else roots.push(node);
  }
  return roots;
}

/** Total comments across the tree (roots + all nested replies). */
export function countComments(nodes: readonly PinCommentNode[]): number {
  return nodes.reduce((n, node) => n + 1 + countComments(node.replies), 0);
}

// ── zod input schemas (server actions validate against these) ────────────────
const uuid = z.string().uuid();

/** Post a comment on a pin, optionally as a reply to another comment. */
export const createPinCommentSchema = z.object({
  pin_id: uuid,
  body: z.string().trim().min(1, "Write something first.").max(2000),
  parent_comment_id: uuid.optional().or(z.literal("").transform(() => undefined)),
});
export type CreatePinCommentInput = z.infer<typeof createPinCommentSchema>;
