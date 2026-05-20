import { describe, it, expect } from "vitest";
import { buttonClass } from "@/components/ui/button";

describe("buttonClass", () => {
  it("defaults to primary + md when called with no args", () => {
    const cls = buttonClass();
    expect(cls).toContain("bg-slate-900");
    expect(cls).toContain("text-white");
    expect(cls).toContain("px-4");
    expect(cls).toContain("py-2");
    expect(cls).toContain("text-sm");
  });

  it("emits secondary variant classes", () => {
    const cls = buttonClass("secondary", "md");
    expect(cls).toContain("border-slate-300");
    expect(cls).toContain("bg-white");
    expect(cls).toContain("text-slate-700");
    expect(cls).not.toContain("bg-slate-900");
  });

  it("emits ghost variant classes (no shadow)", () => {
    const cls = buttonClass("ghost", "md");
    expect(cls).toContain("bg-transparent");
    expect(cls).toContain("shadow-none");
  });

  it("emits destructive variant classes", () => {
    const cls = buttonClass("destructive", "sm");
    expect(cls).toContain("border-red-300");
    expect(cls).toContain("text-red-700");
  });

  it("size sm uses smaller padding + text", () => {
    const cls = buttonClass("primary", "sm");
    expect(cls).toContain("px-3");
    expect(cls).toContain("py-1.5");
    expect(cls).toContain("text-xs");
  });

  it("size lg uses larger padding + text", () => {
    const cls = buttonClass("primary", "lg");
    expect(cls).toContain("px-6");
    expect(cls).toContain("py-3");
    expect(cls).toContain("text-base");
  });

  it("appends extra classes when provided", () => {
    const cls = buttonClass("primary", "md", "w-full mt-2");
    expect(cls).toContain("w-full");
    expect(cls).toContain("mt-2");
    expect(cls).toContain("bg-slate-900");
  });

  it("always includes focus-visible accessibility classes", () => {
    const cls = buttonClass("primary", "md");
    expect(cls).toContain("focus-visible:ring-2");
    expect(cls).toContain("focus-visible:ring-slate-900");
  });

  it("returns a single-line trimmed string (no leading/trailing whitespace)", () => {
    const cls = buttonClass("primary", "md");
    expect(cls).toBe(cls.trim());
    expect(cls.split("\n").length).toBe(1);
  });
});
