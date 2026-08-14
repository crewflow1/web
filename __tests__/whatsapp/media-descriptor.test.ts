import { describe, it, expect } from "vitest";
import {
  parseMediaDescriptor,
  normalizeMetaMessages,
} from "@/lib/comms/providers/meta-whatsapp";

/**
 * The inbound-media DESCRIPTOR parse (P2). Pure edge logic — no bytes are
 * fetched here, this is metadata only. The one thing the download pipeline
 * cannot work without is a media id, so a media object with no id must yield no
 * descriptor (and therefore has_media=false), never a fetch handle to nowhere.
 */

const base = {
  messaging_product: "whatsapp",
  metadata: { display_phone_number: "+441234", phone_number_id: "PNID_1" },
  contacts: [{ wa_id: "447700900123", profile: { name: "Jane" } }],
};
const envelope = (value: Record<string, unknown>) =>
  ({ object: "whatsapp_business_account", entry: [{ id: "waba", changes: [{ field: "messages", value }] }] }) as never;

describe("parseMediaDescriptor — metadata only, id is mandatory", () => {
  it("parses an image descriptor with mime, sha256, caption", () => {
    const d = parseMediaDescriptor(
      "image",
      { id: "MEDIA_1", mime_type: "image/jpeg", sha256: "abc123", caption: "the leak" },
      "the leak",
    );
    expect(d).toEqual({
      media_id: "MEDIA_1",
      message_type: "image",
      mime_type: "image/jpeg",
      declared_sha256: "abc123",
      filename: null,
      caption: "the leak",
      is_voice_note: false,
    });
  });

  it("flags a voice note (audio + voice:true) and NOT a plain audio file", () => {
    const voice = parseMediaDescriptor("audio", { id: "V1", mime_type: "audio/ogg", voice: true }, null);
    const file = parseMediaDescriptor("audio", { id: "A1", mime_type: "audio/mp4" }, null);
    expect(voice?.is_voice_note).toBe(true);
    expect(file?.is_voice_note).toBe(false);
  });

  it("captures a document filename", () => {
    const d = parseMediaDescriptor("document", { id: "D1", mime_type: "application/pdf", filename: "quote.pdf" }, null);
    expect(d?.filename).toBe("quote.pdf");
  });

  it("returns null when there is no media id (nothing to fetch)", () => {
    expect(parseMediaDescriptor("image", { mime_type: "image/jpeg" }, null)).toBeNull();
    expect(parseMediaDescriptor("image", null, null)).toBeNull();
  });
});

describe("normalizeMetaMessages — media field, has_media follows a real id", () => {
  it("attaches a media descriptor and keeps the placeholder text unchanged", () => {
    const [m] = normalizeMetaMessages(
      envelope({ ...base, messages: [{ id: "wamid.1", from: "447700900123", type: "image", image: { id: "MEDIA_1", caption: "the leak", mime_type: "image/jpeg" } }] }),
    );
    expect(m?.has_media).toBe(true);
    expect(m?.raw_text).toBe("[image] the leak");
    expect(m?.media?.media_id).toBe("MEDIA_1");
    expect(m?.media?.message_type).toBe("image");
  });

  it("has_media is FALSE and media is null when a media object carries no id", () => {
    const [m] = normalizeMetaMessages(
      envelope({ ...base, messages: [{ id: "wamid.2", from: "447700900123", type: "image", image: { caption: "no id" } }] }),
    );
    // Still summarised for the lead, but no fetch handle exists.
    expect(m?.raw_text).toBe("[image] no id");
    expect(m?.has_media).toBe(false);
    expect(m?.media).toBeNull();
  });

  it("text messages carry no media", () => {
    const [m] = normalizeMetaMessages(
      envelope({ ...base, messages: [{ id: "wamid.3", from: "447700900123", type: "text", text: { body: "hello" } }] }),
    );
    expect(m?.has_media).toBe(false);
    expect(m?.media).toBeNull();
  });
});
