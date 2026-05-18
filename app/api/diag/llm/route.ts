import { NextResponse } from "next/server";

/**
 * TEMPORARY diagnostic — fires a minimal Anthropic call against claude-haiku-4-5
 * with the production key and returns exactly what came back. Used to locate
 * the Phase 6 "summary=null, cache=disabled" root cause.
 *
 * REMOVE THIS FILE in the follow-up cleanup PR.
 */
export const dynamic = "force-dynamic";

type Probe = {
  stage: string;
  ok: boolean;
  detail?: unknown;
};

export async function GET() {
  const probes: Probe[] = [];

  const key = process.env.ANTHROPIC_API_KEY;
  probes.push({
    stage: "env",
    ok: !!key,
    detail: { length: key?.length ?? 0, prefix_ok: key?.startsWith("sk-ant-") ?? false },
  });
  if (!key) return NextResponse.json({ probes, summary: null });

  let Anthropic;
  try {
    const mod = await import("@anthropic-ai/sdk");
    Anthropic = mod.default;
    probes.push({ stage: "sdk_import", ok: true });
  } catch (e) {
    probes.push({ stage: "sdk_import", ok: false, detail: String(e) });
    return NextResponse.json({ probes, summary: null });
  }

  let client;
  try {
    client = new Anthropic({ apiKey: key });
    probes.push({ stage: "client_construct", ok: true });
  } catch (e) {
    probes.push({ stage: "client_construct", ok: false, detail: String(e) });
    return NextResponse.json({ probes, summary: null });
  }

  let summary: string | null = null;
  try {
    const msg = await client.messages.create(
      {
        model: "claude-haiku-4-5",
        max_tokens: 100,
        messages: [{ role: "user", content: "Reply with exactly: PING_OK" }],
      },
      { signal: AbortSignal.timeout(8000) },
    );
    const block = msg.content[0];
    probes.push({
      stage: "messages_create",
      ok: true,
      detail: {
        stop_reason: msg.stop_reason,
        model_used: msg.model,
        usage: msg.usage,
        block_type: block?.type,
        block_text_preview: block && block.type === "text" ? block.text.slice(0, 100) : null,
      },
    });
    if (block && block.type === "text") summary = block.text.trim() || null;
  } catch (e) {
    const err = e as { name?: string; message?: string; status?: number; error?: unknown };
    probes.push({
      stage: "messages_create",
      ok: false,
      detail: {
        name: err?.name ?? null,
        message: err?.message ?? String(e),
        status: err?.status ?? null,
        body: err?.error ?? null,
      },
    });
  }

  return NextResponse.json({ probes, summary });
}
