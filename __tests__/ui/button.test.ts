import { describe, it, expect } from "vitest";
import { buttonClass } from "@/components/ui/button";

describe("buttonClass", () => {
  it("defaults to primary + md", () => {
    const cls = buttonClass();
    expect(cls).toContain("bg-slate-900");
    expect(cls).toContain("text-white");
    expect(cls).toContain("px-4");
    expect(cls).toContain("py-2");
  });

  it("secondary uses outline + white background", () => {
    const cls = buttonClass("secondary", "md");
    expect(cls).toContain("border-slate-300");
    expect(cls).toContain("bg-white");
    expect(cls).not.toContain("bg-slate-900");
  });

  it("ghost has no shadow", () => {
    const cls = buttonClass("ghost", "md");
    expect(cls).toContain("bg-transparent");
    expect(cls).toContain("shadow-none");
  });

  it("destructive uses red border + text", () => {
    const cls = buttonClass("destructive", "sm");
    expect(cls).toContain("border-red-300");
    expect(cls).toContain("text-red-700");
  });

  it("sm uses smaller padding + text", () => {
    const cls = buttonClass("primary", "sm");
    expect(cls).toContain("px-3");
    expect(cls).toContain("py-1.5");
    expect(cls).toContain("text-xs");
  });

  it("lg uses larger padding + text", () => {
    const cls = buttonClass("primary", "lg");
    expect(cls).toContain("px-6");
    expect(cls).toContain("py-3");
    expect(cls).toContain("text-base");
  });

  it("appends extra classes", () => {
    const cls = buttonClass("primary", "md", "w-full mt-2");
    expect(cls).toContain("w-full");
    expect(cls).toContain("mt-2");
    expect(cls).toContain("bg-slate-900");
  });

  it("always includes focus-visible ring", () => {
    const cls = buttonClass("primary", "md");
    expect(cls).toContain("focus-visible:ring-2");
  });

  it("output is a trimmed single line", () => {
    const cls = buttonClass("primary", "md");
    expect(cls).toBe(cls.trim());
    expect(cls.split("\n").length).toBe(1);
  });
});
