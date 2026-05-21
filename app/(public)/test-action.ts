"use server";

/**
 * Diagnostic-only minimal server action. Zero imports, zero env access.
 * If this still 500s, the action-dispatch infrastructure itself is broken.
 * Delete after the demo flow is verified.
 */
export async function testAction(): Promise<{ ok: true; ts: number }> {
  console.log("[test-action] hit");
  return { ok: true, ts: Date.now() };
}
