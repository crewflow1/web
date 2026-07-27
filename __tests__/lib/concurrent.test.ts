import { describe, it, expect } from "vitest";
import { mapWithConcurrency } from "@/lib/async/concurrent";

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

describe("mapWithConcurrency", () => {
  it("preserves input → output order regardless of completion order", async () => {
    const input = [30, 10, 20, 5, 15];
    const out = await mapWithConcurrency(input, 2, async (n) => {
      await tick(n); // larger inputs resolve later
      return n * 2;
    });
    expect(out).toEqual([60, 20, 40, 10, 30]);
  });

  it("never runs more than `limit` mappers at once", async () => {
    let inFlight = 0;
    let peak = 0;
    const input = Array.from({ length: 20 }, (_, i) => i);

    await mapWithConcurrency(input, 3, async (n) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await tick(2);
      inFlight--;
      return n;
    });

    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBe(3); // and it actually saturates the pool
  });

  it("processes every item exactly once", async () => {
    const seen: number[] = [];
    const input = Array.from({ length: 50 }, (_, i) => i);
    await mapWithConcurrency(input, 5, async (n) => {
      seen.push(n);
      return n;
    });
    expect(seen.sort((a, b) => a - b)).toEqual(input);
  });

  it("handles an empty list without spinning up workers", async () => {
    let calls = 0;
    const out = await mapWithConcurrency([], 4, async (n) => {
      calls++;
      return n;
    });
    expect(out).toEqual([]);
    expect(calls).toBe(0);
  });

  it("works when limit exceeds the item count", async () => {
    const out = await mapWithConcurrency([1, 2], 10, async (n) => n + 1);
    expect(out).toEqual([2, 3]);
  });

  it("rejects an invalid limit", async () => {
    await expect(mapWithConcurrency([1], 0, async (n) => n)).rejects.toThrow(
      /positive integer/,
    );
  });
});
