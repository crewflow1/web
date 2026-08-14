import { describe, it, expect } from "vitest";
import {
  buildCommentTree,
  countComments,
  createPinCommentSchema,
  type PinComment,
} from "@/lib/blueprints/pin-comments";

const PIN = "11111111-1111-1111-1111-111111111111";
const c = (id: string, parent: string | null, created = "2026-08-14T00:00:00Z"): PinComment => ({
  id,
  pin_id: PIN,
  parent_comment_id: parent,
  body: `body ${id}`,
  author_id: null,
  created_at: created,
});

describe("buildCommentTree — flat rows to a reply tree", () => {
  it("nests replies under their parent, preserving input order for siblings", () => {
    const tree = buildCommentTree([
      c("a", null),
      c("b", "a"),
      c("c", null),
      c("d", "a"),
    ]);
    expect(tree.map((n) => n.id)).toEqual(["a", "c"]);
    const a = tree.find((n) => n.id === "a")!;
    expect(a.replies.map((n) => n.id)).toEqual(["b", "d"]);
  });

  it("nests arbitrarily deep", () => {
    const tree = buildCommentTree([c("a", null), c("b", "a"), c("d", "b")]);
    const a = tree[0]!;
    expect(a.replies[0]!.id).toBe("b");
    expect(a.replies[0]!.replies[0]!.id).toBe("d");
  });

  it("promotes an orphan (missing parent) to a root rather than dropping it", () => {
    const tree = buildCommentTree([c("a", null), c("orphan", "gone")]);
    expect(tree.map((n) => n.id).sort()).toEqual(["a", "orphan"]);
  });

  it("is cycle-safe: a self-parent becomes a root, never an infinite loop", () => {
    const tree = buildCommentTree([c("self", "self")]);
    expect(tree.map((n) => n.id)).toEqual(["self"]);
    expect(tree[0]!.replies).toEqual([]);
  });

  it("counts every node across the tree", () => {
    const tree = buildCommentTree([c("a", null), c("b", "a"), c("d", "b"), c("e", null)]);
    expect(countComments(tree)).toBe(4);
  });

  it("never drops or duplicates a comment (count == input length)", () => {
    const input = [c("a", null), c("b", "a"), c("c", "b"), c("d", null), c("orphan", "x")];
    expect(countComments(buildCommentTree(input))).toBe(input.length);
  });
});

describe("createPinCommentSchema", () => {
  it("requires a non-empty body", () => {
    expect(createPinCommentSchema.safeParse({ pin_id: PIN, body: "" }).success).toBe(false);
    expect(createPinCommentSchema.safeParse({ pin_id: PIN, body: "hi" }).success).toBe(true);
  });
  it("caps the body at 2000 chars", () => {
    expect(createPinCommentSchema.safeParse({ pin_id: PIN, body: "x".repeat(2001) }).success).toBe(false);
  });
  it("treats an empty parent id as absent (a root comment)", () => {
    const parsed = createPinCommentSchema.parse({ pin_id: PIN, body: "hi", parent_comment_id: "" });
    expect(parsed.parent_comment_id).toBeUndefined();
  });
  it("rejects a non-uuid pin id", () => {
    expect(createPinCommentSchema.safeParse({ pin_id: "nope", body: "hi" }).success).toBe(false);
  });
});
