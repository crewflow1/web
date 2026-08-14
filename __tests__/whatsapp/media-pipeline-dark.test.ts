import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Media download — DARK REFUSAL and refuse-before-fetch. The one guarantee that
 * matters while WhatsApp is dark: no byte crosses the network without BOTH
 * switches on (feature flag + access token). A refusal is RECORDED (a row), but
 * `fetch` is never called. Proven by counting fetch calls, not by reading code.
 */

const h = vi.hoisted(() => ({
  inserts: [] as Array<Record<string, unknown>>,
  existing: null as Record<string, unknown> | null,
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(() => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: h.existing, error: null }),
          }),
        }),
      }),
      insert: (row: Record<string, unknown>) => {
        h.inserts.push(row);
        return { select: () => ({ single: async () => ({ data: { id: "media-row-1" }, error: null }) }) };
      },
      update: () => ({ eq: async () => ({ error: null }) }),
    }),
    storage: { from: () => ({ upload: async () => ({ error: null }), remove: async () => ({ error: null }) }) },
  })),
}));

import {
  downloadInboundWhatsAppMedia,
  isWhatsAppMediaFetchConfigured,
  whatsAppMediaRefusalReason,
} from "@/server/services/whatsapp-media-pipeline";
import type { WhatsAppMediaDescriptor } from "@/lib/comms/providers/meta-whatsapp";

const media: WhatsAppMediaDescriptor = {
  media_id: "MEDIA_1",
  message_type: "image",
  mime_type: "image/jpeg",
  declared_sha256: "abc",
  filename: null,
  caption: null,
  is_voice_note: false,
};

describe("media download — refuse-before-fetch", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    h.inserts.length = 0;
    h.existing = null;
    fetchSpy = vi.fn(() => Promise.reject(new Error("fetch must NOT be called while dark")));
    vi.stubGlobal("fetch", fetchSpy);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("refuses with feature_dark when the flag is off — and never fetches", async () => {
    vi.stubEnv("NEXT_PUBLIC_FEATURE_WHATSAPP", "false");
    vi.stubEnv("WHATSAPP_ACCESS_TOKEN", "tok-present");
    expect(isWhatsAppMediaFetchConfigured()).toBe(false);
    expect(whatsAppMediaRefusalReason()).toBe("feature_dark");

    const r = await downloadInboundWhatsAppMedia({ orgId: "org-1", wamid: "w1", media });
    expect(r.status).toBe("refused");
    if (r.status === "refused") expect(r.reason).toBe("feature_dark");
    expect(fetchSpy).not.toHaveBeenCalled();
    // The intent WAS recorded as a refused row.
    expect(h.inserts[0]?.status).toBe("refused");
    expect(h.inserts[0]?.refused_reason).toBe("feature_dark");
  });

  it("refuses with no_credential when the flag is on but no token — and never fetches", async () => {
    vi.stubEnv("NEXT_PUBLIC_FEATURE_WHATSAPP", "true");
    vi.stubEnv("WHATSAPP_ACCESS_TOKEN", "");
    expect(whatsAppMediaRefusalReason()).toBe("no_credential");

    const r = await downloadInboundWhatsAppMedia({ orgId: "org-1", wamid: "w1", media });
    expect(r.status).toBe("refused");
    if (r.status === "refused") expect(r.reason).toBe("no_credential");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("is idempotent: an already-stored media id returns duplicate without fetch", async () => {
    vi.stubEnv("NEXT_PUBLIC_FEATURE_WHATSAPP", "true");
    vi.stubEnv("WHATSAPP_ACCESS_TOKEN", "tok-present");
    h.existing = { id: "media-row-1", status: "stored", storage_path: "org-1/w1/MEDIA_1.jpg" };

    const r = await downloadInboundWhatsAppMedia({ orgId: "org-1", wamid: "w1", media });
    expect(r.status).toBe("duplicate");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
