import { describe, it, expect } from "vitest";
import { decideByteSource } from "@/lib/blueprints/byte-source";

/** The offline fallback decision — online-first, cache only when the fetch fails. */
describe("decideByteSource", () => {
  it("prefers online when the fetch succeeds", () => {
    expect(decideByteSource({ preferOffline: false, fetchOk: true, cacheHit: false })).toBe("online");
    expect(decideByteSource({ preferOffline: false, fetchOk: true, cacheHit: true })).toBe("online");
  });
  it("falls back to cache only when the fetch fails and a copy exists", () => {
    expect(decideByteSource({ preferOffline: false, fetchOk: false, cacheHit: true })).toBe("offline");
    expect(decideByteSource({ preferOffline: false, fetchOk: false, cacheHit: false })).toBe("error");
  });
  it("preferOffline uses the cache fast-path when cached", () => {
    expect(decideByteSource({ preferOffline: true, fetchOk: true, cacheHit: true })).toBe("offline");
  });
  it("preferOffline with no cache still uses a working network (onLine can lie)", () => {
    expect(decideByteSource({ preferOffline: true, fetchOk: true, cacheHit: false })).toBe("online");
    expect(decideByteSource({ preferOffline: true, fetchOk: false, cacheHit: false })).toBe("error");
  });
});
